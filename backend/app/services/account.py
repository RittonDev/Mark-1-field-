"""Links da conta por e-mail: validar o e-mail e criar uma senha nova (tabela account_tokens).

- Só o SHA-256 do token fica no banco. O token cru nasce na hora do envio (services/mail.py chama
  `mint` ao montar o e-mail) e vai no fragmento da URL (#token=): nem a fila nem o log o veem.
- Uso único: `take` trava a linha (FOR UPDATE), confere e marca o uso; `peek` só confere (a página
  "Definir nova senha" mostra a conta antes de gastar o link). Ausente, usado, revogado ou vencido:
  `LinkGone` (410, code LINK_GONE).
- Prazos: validação 72 h; nova senha 2 h; a primeira senha, pela boas-vindas, 72 h. Um link de senha
  novo revoga os anteriores ainda não usados; os de validação não (qualquer um válido serve).
- Revogar (`revoke`): os de senha ao concluir, ao trocar a senha por qualquer caminho e ao cortar o
  acesso; os de validação quando o pedido de troca é cancelado; todos quando o login muda (pela
  central ou pelo link da troca pedida no app).

Os links públicos (api/routes/auth.py) usam `forgot_password`, `check_reset`, `reset_password` e
`verify_email`: aqui ficam as regras e o histórico do cadastro (via "link", o técnico pelo e-mail);
a rota grava (commit) e avisa depois (`LinkOutcome`). Também a troca de e-mail pela central
(`central_email_changed`) e o aviso `onboarding.updated` à gestão.
"""

import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import AccountTokenPurpose, EmailStatus, EmailTemplate, UserRole
from app.core.security import hash_password_async
from app.db.base import utcnow
from app.models import AccountToken, EmailOutbox, TechnicianApplication, User
from app.models.user_change import VIA_LINK
from app.schemas.account import EmailQueuedStatus, PasswordResetCheck
from app.services import login_guard, mail, mail_templates
from app.services.errors import CodedError

log = logging.getLogger(__name__)

VERIFY_HOURS = 72
RESET_HOURS = 2
WELCOME_PASSWORD_HOURS = 72

LINK_GONE = "LINK_GONE"
EMAIL_IN_USE = "EMAIL_IN_USE"
RESET_LINK_GONE = (
    "Este link expirou ou já foi usado. Peça outro em “Esqueci minha senha”, no app, ou fale com "
    "a central pelo WhatsApp"
)
VERIFY_LINK_GONE = (
    "Este link de validação expirou ou já foi usado. Peça um novo no app, em Configurações › "
    "Contato, ou à central pelo WhatsApp"
)
# POST /auth/password-reset com o acesso ao app cortado (410, como o link que não vale mais).
ACCESS_CUT = "Seu acesso ao app está desativado. Fale com a central pelo WhatsApp"
EMAIL_IN_USE_TEXT = "Este e-mail já está em uso em outro cadastro. Fale com a central pelo WhatsApp"

# "Esqueci minha senha": links por e-mail por hora (o excesso não sai e a resposta é a mesma).
FORGOT_PER_EMAIL = 3

# Linhas do histórico do cadastro (via "link"): a senha pelo link do e-mail.
PASSWORD_LINK_CREATED: dict[str, Any] = {
    "field": "password",
    "from": None,
    "to": "criada pelo link do e-mail",
}
PASSWORD_LINK_RESET: dict[str, Any] = {
    "field": "password",
    "from": None,
    "to": "redefinida pelo link do e-mail",
}

# Bem mais que o token de verdade (43 caracteres) não é nosso: nem vai ao banco.
_RAW_MAX = 200

ONBOARDING_UPDATED = "onboarding.updated"


class LinkGone(CodedError):
    """410: o link não vale mais (ou nunca valeu)."""

    def __init__(self, message: str = RESET_LINK_GONE) -> None:
        super().__init__(message, LINK_GONE, 410)


class EmailInUse(CodedError):
    """409: o e-mail pedido virou o login de outro usuário antes do link."""

    def __init__(self, message: str = EMAIL_IN_USE_TEXT) -> None:
        super().__init__(message, EMAIL_IN_USE, 409)


def gone_text(purpose: AccountTokenPurpose | str) -> str:
    return VERIFY_LINK_GONE if purpose == AccountTokenPurpose.VERIFY_EMAIL else RESET_LINK_GONE


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def mask_email(email: str) -> str:
    """O e-mail mascarado, "t***@exemplo.com" (como a chave PIX por e-mail: core/pix.mask)."""
    local, at, domain = (email or "").partition("@")
    return f"{local[:1]}***@{domain}" if at else "***"


def _id_of(value: Any) -> uuid.UUID | None:
    if value is None or isinstance(value, uuid.UUID):
        return value
    return value.id


def _same(email: str | None, other: str | None) -> bool:
    """O mesmo endereço, sem diferença de maiúsculas (os links guardam em minúsculas)."""
    left, right = (email or "").strip().lower(), (other or "").strip().lower()
    return bool(left) and left == right


async def mint(
    db: AsyncSession,
    *,
    purpose: AccountTokenPurpose,
    email: str,
    user: Any = None,
    application: Any = None,
    reason: str | None = None,
    hours: int,
    created_by: Any = None,
) -> str:
    """Cria o link e devolve o token cru (só o hash é gravado). Um alvo só: o usuário ou a ficha
    (objeto ou id). Link de senha: revoga os de senha do usuário ainda não usados."""
    user_id, application_id = _id_of(user), _id_of(application)
    if (user_id is None) == (application_id is None):
        raise ValueError("O link tem um alvo: o usuário ou a ficha")
    now = utcnow()
    if purpose == AccountTokenPurpose.RESET_PASSWORD and user_id is not None:
        await revoke(db, user_id=user_id, purpose=AccountTokenPurpose.RESET_PASSWORD)
    raw = secrets.token_urlsafe(32)
    db.add(
        AccountToken(
            id=uuid.uuid4(),
            purpose=purpose,
            reason=reason,
            token_hash=hash_token(raw),
            user_id=user_id,
            application_id=application_id,
            email=(email or "").strip().lower(),
            expires_at=now + timedelta(hours=hours),
            created_by_id=_id_of(created_by),
            created_at=now,
        )
    )
    await db.flush()
    return raw


async def find(
    db: AsyncSession, raw: str, purpose: AccountTokenPurpose, *, lock: bool = False
) -> AccountToken | None:
    """O token pelo valor cru (usado, revogado ou vencido também); None quando não existe."""
    raw = (raw or "").strip()
    if not raw or len(raw) > _RAW_MAX:
        return None
    stmt = select(AccountToken).where(
        AccountToken.token_hash == hash_token(raw), AccountToken.purpose == purpose
    )
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return await db.scalar(stmt)


def usable(token: AccountToken | None, now: datetime | None = None) -> bool:
    """Ainda vale: nem usado, nem revogado, nem vencido."""
    if token is None:
        return False
    return (
        token.used_at is None and token.revoked_at is None and token.expires_at > (now or utcnow())
    )


async def peek(db: AsyncSession, raw: str, purpose: AccountTokenPurpose) -> AccountToken:
    """O link que ainda vale, sem gastá-lo; senão LinkGone."""
    token = await find(db, raw, purpose)
    if token is None or not usable(token):
        raise LinkGone(gone_text(purpose))
    return token


async def take(db: AsyncSession, raw: str, purpose: AccountTokenPurpose) -> AccountToken:
    """Gasta o link: trava a linha até o fim da transação, confere e marca o uso (desfeito junto se
    a rota não gravar). Ausente, usado, revogado ou vencido: LinkGone."""
    token = await find(db, raw, purpose, lock=True)
    if token is None or not usable(token):
        raise LinkGone(gone_text(purpose))
    token.used_at = utcnow()
    await db.flush()
    return token


async def revoke(
    db: AsyncSession,
    *,
    user_id: uuid.UUID | None = None,
    application_id: uuid.UUID | None = None,
    purpose: AccountTokenPurpose | None = None,
    email: str | None = None,
) -> None:
    """Revoga os links ainda não usados do usuário ou da ficha (de um tipo, para um endereço, ou
    todos). Pede pelo menos um alvo ou o endereço."""
    if user_id is None and application_id is None and not email:
        raise ValueError("Revogar pede o usuário, a ficha ou o e-mail")
    stmt = update(AccountToken).where(
        AccountToken.used_at.is_(None), AccountToken.revoked_at.is_(None)
    )
    if user_id is not None:
        stmt = stmt.where(AccountToken.user_id == user_id)
    if application_id is not None:
        stmt = stmt.where(AccountToken.application_id == application_id)
    if purpose is not None:
        stmt = stmt.where(AccountToken.purpose == purpose)
    if email:
        stmt = stmt.where(func.lower(AccountToken.email) == email.strip().lower())
    await db.execute(stmt.values(revoked_at=utcnow()).execution_options(synchronize_session=False))


async def _retarget_queue(db: AsyncSession, user_id: uuid.UUID, address: str) -> None:
    """O login mudou: o que ainda não saiu segue o login novo. As validações na fila vencem (a do
    endereço antigo e a do pedido de troca não servem mais); a boas-vindas e a nova senha passam
    para o endereço novo, ou vencem quando ele não recebe e-mail."""
    pending = (EmailOutbox.user_id == user_id, EmailOutbox.status == EmailStatus.PENDING)
    await db.execute(
        update(EmailOutbox)
        .where(*pending, EmailOutbox.template == EmailTemplate.VERIFY_EMAIL)
        .values(status=EmailStatus.EXPIRED)
        .execution_options(synchronize_session=False)
    )
    if mail.sendable(address):
        await db.execute(
            update(EmailOutbox)
            .where(*pending, EmailOutbox.to_email != address)
            .values(to_email=address)
            .execution_options(synchronize_session=False)
        )
    else:
        await db.execute(
            update(EmailOutbox)
            .where(*pending)
            .values(status=EmailStatus.EXPIRED)
            .execution_options(synchronize_session=False)
        )


async def central_email_changed(
    db: AsyncSession, user: User, actor: User | None
) -> EmailQueuedStatus:
    """A central trocou o e-mail de login (Técnicos ou Usuários; a rota já gravou o novo em
    `user.email` e cuida do histórico e do commit): zera a validação e o pedido de troca do app,
    revoga os links (validação e senha) do usuário, cancela os pedidos de validação na fila,
    passa para o endereço novo o que ainda não saiu (boas-vindas, nova senha) e enfileira a
    validação ("check") para ele, que sai logo depois do commit. Devolve o EmailQueuedStatus."""
    user.email_verified_at = None
    user.email_pending = None
    user.email_pending_at = None
    address = (user.email or "").strip().lower()
    await revoke(db, user_id=user.id)
    await _retarget_queue(db, user.id, address)
    await db.flush()
    row, status = await mail.enqueue(
        db,
        template=EmailTemplate.VERIFY_EMAIL,
        to_email=address,
        user=user,
        context={"name": user.name, "reason": "check"},
        created_by=actor,
    )
    if row is not None and status == "queued":
        mail.deliver_after_commit(db, [row.id])
    return status


async def publish_onboarding_updated(application: Any, action: str) -> None:
    """Depois do commit: avisa a gestão (quem tem Homologação) que a ficha mudou. action:
    "email_verified" | "reopened" | "approved" | "rejected". Falhar o aviso não desfaz nada."""
    from app.services.realtime import bus  # realtime puxa os modelos da OS: import tardio

    try:
        await bus.publish(
            {
                "type": ONBOARDING_UPDATED,
                "application_id": str(application.id),
                "name": application.full_name,
                "data": {"action": action},
                "audience": {"managers_only": True},
            }
        )
    except Exception:
        log.exception("Falha ao avisar a mudança na ficha da homologação")


# ------------------------------------------------------------------ links públicos


@dataclass
class LinkOutcome:
    """O que um link fez, para a rota gravar e avisar depois do commit."""

    # O e-mail da resposta (o login, ou o da ficha) e o tipo do link.
    email: str
    kind: Literal["signup", "change", "check", "reset", "create"]
    # Cadastro do técnico que mudou (histórico via "link" já gravado): `publish_changed`.
    user: User | None = None
    changes: list[dict[str, Any]] = field(default_factory=list)
    after_reset: dict[str, str] | None = None
    # Ficha validada agora: `publish_onboarding_updated(application, "email_verified")`.
    application: TechnicianApplication | None = None
    # A resposta é este erro, depois do commit (o pedido de troca foi limpo e o link, gasto).
    error: CodedError | None = None


async def _locked_user(db: AsyncSession, user_id: uuid.UUID | None) -> User | None:
    """O usuário relido do banco e travado até o fim da transação (o app pode estar gravando o
    mesmo cadastro)."""
    if user_id is None:
        return None
    return await db.scalar(
        select(User)
        .where(User.id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def forgot_password(db: AsyncSession, email: str) -> EmailOutbox | None:
    """Esqueci minha senha: põe na fila o link de nova senha ("self") só para o técnico com acesso
    ao app e o e-mail de login validado (o link prova a posse da caixa; e-mail digitado errado não
    vira porta de entrada) e que recebe mensagens, até FORGOT_PER_EMAIL por hora. A rota responde
    igual em todos os casos. Devolve a linha da fila (o commit é da rota) ou None."""
    address = (email or "").strip().lower()
    if not address:
        return None
    user = await db.scalar(select(User).where(func.lower(User.email) == address))
    if (
        user is None
        or user.role != UserRole.TECHNICIAN
        or not user.is_active
        or user.email_verified_at is None
        or not mail.sendable(user.email)
    ):
        return None
    try:
        await login_guard.hit("forgot-email", address, FORGOT_PER_EMAIL, 3600)
    except login_guard.RateLimited:
        return None
    row, _ = await mail.enqueue(
        db,
        template=EmailTemplate.PASSWORD_RESET,
        to_email=user.email,
        user=user,
        context={"name": user.name, "origin": "self"},
    )
    return row


def _password_kind(token: AccountToken) -> Literal["reset", "create"]:
    """O tipo do link de senha: "create" é o da boas-vindas (a primeira senha)."""
    return "create" if token.reason == "welcome" else "reset"


async def _reset_user(db: AsyncSession, token: AccountToken, *, lock: bool) -> User:
    """O dono do link de senha. O login mudou depois do envio (o link foi para o endereço antigo):
    o link não vale. Sem acesso ao app: 410 com ACCESS_CUT."""
    user = (
        await _locked_user(db, token.user_id)
        if lock
        else (await db.get(User, token.user_id) if token.user_id else None)
    )
    if user is None or not _same(user.email, token.email):
        raise LinkGone(RESET_LINK_GONE)
    if not user.is_active:
        raise LinkGone(ACCESS_CUT)
    return user


async def check_reset(db: AsyncSession, raw: str) -> PasswordResetCheck:
    """A página "Definir nova senha" ao abrir: confere o link sem gastá-lo e mostra a conta (o
    e-mail mascarado e o primeiro nome)."""
    token = await peek(db, raw, AccountTokenPurpose.RESET_PASSWORD)
    user = await _reset_user(db, token, lock=False)
    return PasswordResetCheck(
        email=mask_email(user.email),
        name=mail_templates.first_name(user.name),
        kind=_password_kind(token),
        app_url=settings.tech_app_url,
    )


async def reset_password(db: AsyncSession, raw: str, password: str) -> LinkOutcome:
    """Grava a senha pelo link (gasta o link): sai a senha provisória, os acessos abertos caem
    (sessions_revoked_at), os outros links de senha são revogados e o e-mail de login fica
    validado (o link foi para ele). Histórico via "link", com o técnico como autor. O commit é
    da rota."""
    from app.services import user_history  # usa schemas do Meu cadastro: import tardio

    token = await take(db, raw, AccountTokenPurpose.RESET_PASSWORD)
    user = await _reset_user(db, token, lock=True)
    password_hash = await hash_password_async(password)
    before = await user_history.snapshot(db, user)
    now = utcnow()
    user.password_hash = password_hash
    user.must_change_password = False
    user.sessions_revoked_at = now
    if user.email_verified_at is None:
        user.email_verified_at = now
    await revoke(db, user_id=user.id, purpose=AccountTokenPurpose.RESET_PASSWORD)
    kind = _password_kind(token)
    line = PASSWORD_LINK_CREATED if kind == "create" else PASSWORD_LINK_RESET
    changes = await user_history.track(
        db, user, before, via=VIA_LINK, actor=user, extra=[dict(line)]
    )
    return LinkOutcome(email=user.email, kind=kind, user=user, changes=changes)


async def _mark_verified(db: AsyncSession, user: User, now: datetime) -> list[dict[str, Any]]:
    """O e-mail de login do técnico validado agora (histórico via "link")."""
    from app.services import user_history

    before = await user_history.snapshot(db, user)
    user.email_verified_at = now
    return await user_history.track(db, user, before, via=VIA_LINK, actor=user)


async def _verify_application(db: AsyncSession, token: AccountToken) -> LinkOutcome:
    """signup: valida o e-mail da ficha e, se ela já virou técnico com o mesmo e-mail, o login
    dele também."""
    application = await db.scalar(
        select(TechnicianApplication)
        .where(TechnicianApplication.id == token.application_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if application is None or not _same(application.email, token.email):
        raise LinkGone(VERIFY_LINK_GONE)
    outcome = LinkOutcome(email=application.email, kind="signup")
    if not usable(token):
        # Já validado (o mesmo link aberto de novo, ou outro): a mesma resposta.
        if application.email_verified_at is None:
            raise LinkGone(VERIFY_LINK_GONE)
        return outcome
    now = utcnow()
    token.used_at = now
    if application.email_verified_at is None:
        application.email_verified_at = now
        outcome.application = application
    user = await _locked_user(db, application.user_id)
    if user is not None and _same(user.email, token.email) and user.email_verified_at is None:
        outcome.user = user
        outcome.changes = await _mark_verified(db, user, now)
    await db.flush()
    return outcome


async def _switch_login(db: AsyncSession, user: User, now: datetime) -> list[dict[str, Any]]:
    """change: o e-mail pedido no app passa a ser o login, já validado. Os links que ainda valiam
    (os de senha foram para o endereço antigo) são revogados e a fila segue o login novo."""
    from app.services import user_history

    before = await user_history.snapshot(db, user)
    user.email = (user.email_pending or "").strip().lower()
    user.email_verified_at = now
    user.email_pending = None
    user.email_pending_at = None
    await revoke(db, user_id=user.id)
    await _retarget_queue(db, user.id, user.email)
    return await user_history.track(db, user, before, via=VIA_LINK, actor=user)


async def _drop_pending(db: AsyncSession, user: User) -> list[dict[str, Any]]:
    """change, com o e-mail pedido já sendo o login de outro usuário: o pedido sai (o login
    continua o de antes) e os links e e-mails da validação dele vencem."""
    from app.services import user_history

    before = await user_history.snapshot(db, user)
    pending = user.email_pending
    user.email_pending = None
    user.email_pending_at = None
    await revoke(db, user_id=user.id, purpose=AccountTokenPurpose.VERIFY_EMAIL, email=pending)
    await db.execute(
        update(EmailOutbox)
        .where(
            EmailOutbox.user_id == user.id,
            EmailOutbox.status == EmailStatus.PENDING,
            EmailOutbox.template == EmailTemplate.VERIFY_EMAIL,
            func.lower(EmailOutbox.to_email) == (pending or "").strip().lower(),
        )
        .values(status=EmailStatus.EXPIRED)
        .execution_options(synchronize_session=False)
    )
    return await user_history.track(db, user, before, via=VIA_LINK, actor=user)


async def _verify_user(db: AsyncSession, token: AccountToken) -> LinkOutcome:
    """change (o e-mail novo pedido no app) e check (o login de sempre)."""
    from app.services import user_history

    user = await _locked_user(db, token.user_id)
    if user is None:
        raise LinkGone(VERIFY_LINK_GONE)
    kind: Literal["change", "check"] = "change" if token.reason == "change" else "check"
    login_is_target = _same(user.email, token.email)
    if not usable(token):
        # Já validado (o mesmo link aberto de novo, ou a troca feita por outro): a mesma resposta.
        if login_is_target and user.email_verified_at is not None:
            return LinkOutcome(email=user.email, kind=kind)
        raise LinkGone(VERIFY_LINK_GONE)
    now = utcnow()
    if kind == "change" and _same(user.email_pending, token.email):
        token.used_at = now
        taken = await db.scalar(
            select(User.id)
            .where(func.lower(User.email) == token.email, User.id != user.id)
            .limit(1)
        )
        if taken is not None:
            changes = await _drop_pending(db, user)
            await db.flush()
            return LinkOutcome(
                email=user.email, kind=kind, user=user, changes=changes, error=EmailInUse()
            )
        changes = await _switch_login(db, user, now)
        await db.flush()
        return LinkOutcome(
            email=user.email,
            kind=kind,
            user=user,
            changes=changes,
            after_reset=await user_history.after_reset(db, user, changes),
        )
    if not login_is_target:
        # O pedido de troca foi cancelado ou trocado por outro endereço; o login mudou.
        raise LinkGone(VERIFY_LINK_GONE)
    token.used_at = now
    outcome = LinkOutcome(email=user.email, kind=kind)
    if user.email_verified_at is None:
        outcome.user = user
        outcome.changes = await _mark_verified(db, user, now)
    await db.flush()
    return outcome


async def verify_email(db: AsyncSession, raw: str) -> LinkOutcome:
    """A página /validar-email ao abrir (o link já é o pedido). signup: a ficha; change: o e-mail
    pedido no app vira o login (só se ainda é o pedido; login de outro: o pedido sai e a resposta
    é EmailInUse, 409); check: o login de sempre (só se ainda é ele). O link já usado com o
    e-mail validado responde igual; o resto, LinkGone. O commit é da rota."""
    token = await find(db, raw, AccountTokenPurpose.VERIFY_EMAIL, lock=True)
    if token is None:
        raise LinkGone(VERIFY_LINK_GONE)
    if token.application_id is not None:
        return await _verify_application(db, token)
    return await _verify_user(db, token)
