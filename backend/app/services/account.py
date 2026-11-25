"""Links da conta por e-mail: validar o e-mail e criar uma senha nova (tabela account_tokens).

- Só o SHA-256 do token fica no banco. O token cru nasce na hora do envio (services/mail.py chama
  `mint` ao montar o e-mail) e vai no fragmento da URL (#token=): nem a fila nem o log o veem.
- Uso único: `take` trava a linha (FOR UPDATE), confere e marca o uso; `peek` só confere (a página
  "Definir nova senha" mostra a conta antes de gastar o link). Ausente, usado, revogado ou vencido:
  `LinkGone` (410, code LINK_GONE).
- Prazos: validação 72 h; nova senha 2 h; a primeira senha, pela boas-vindas, 72 h. Um link de senha
  novo revoga os anteriores ainda não usados; os de validação não (qualquer um válido serve).
- Revogar (`revoke`): os de senha ao concluir, ao trocar a senha por qualquer caminho e ao cortar o
  acesso; os de validação quando o pedido de troca é cancelado ou a central troca o e-mail.

As rotas (api/routes/auth.py) dão as respostas e o histórico; aqui ficam os links, a troca de e-mail
pela central (`central_email_changed`) e o aviso `onboarding.updated` à gestão.
"""

import hashlib
import logging
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import AccountTokenPurpose, EmailStatus, EmailTemplate
from app.db.base import utcnow
from app.models import AccountToken, EmailOutbox, User
from app.schemas.account import EmailQueuedStatus
from app.services import mail
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
    await db.execute(
        update(EmailOutbox)
        .where(
            EmailOutbox.user_id == user.id,
            EmailOutbox.status == EmailStatus.PENDING,
            EmailOutbox.template == EmailTemplate.VERIFY_EMAIL,
        )
        .values(status=EmailStatus.EXPIRED)
        .execution_options(synchronize_session=False)
    )
    if mail.sendable(address):
        await db.execute(
            update(EmailOutbox)
            .where(
                EmailOutbox.user_id == user.id,
                EmailOutbox.status == EmailStatus.PENDING,
                EmailOutbox.to_email != address,
            )
            .values(to_email=address)
            .execution_options(synchronize_session=False)
        )
    else:
        await db.execute(
            update(EmailOutbox)
            .where(EmailOutbox.user_id == user.id, EmailOutbox.status == EmailStatus.PENDING)
            .values(status=EmailStatus.EXPIRED)
            .execution_options(synchronize_session=False)
        )
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
