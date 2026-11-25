"""E-mails transacionais: fila no banco (email_outbox), envio por SMTP e o registro do que saiu.

Três modelos (services/mail_templates.py): validar o e-mail, boas-vindas e nova senha. Quem pede
chama `enqueue` na transação dele e, depois do commit, `mail.deliver_soon([row.id])` (ou
`mail.deliver_after_commit(db, ids)` antes do commit): a entrega sai logo, numa sessão própria; o
que falhar fica para a rotina da fila (main._mail_loop, a cada MAIL_RETRY_SECONDS:
`deliver_pending`). Chame pelo módulo (`mail.deliver_soon`, `mail.get_provider`): os testes trocam
os dois (tests/conftest.py: `_mail_off` e `mail_box`).

- O link de uso único nasce na hora do envio (services/account.mint): nem a fila guarda o token.
  Falhou o envio, o link criado é desfeito junto (SAVEPOINT), inclusive a revogação dos anteriores.
- Sem SMTP configurado (settings.mail_enabled falso) nada sai: a linha entra "pending" e vence em
  `send_by` ("Não enviado"); a central segue com o WhatsApp e a senha provisória.
- Erro temporário (conexão, tempo, 4xx, autenticação): nova tentativa em 1, 5, 15 e 60 minutos;
  na 5ª, "failed". Recusa permanente do servidor (5xx no remetente, no destinatário ou nos dados):
  "failed" na hora.
- O log leva só o id e o modelo (nunca o endereço nem o link). Cabeçalhos sem Reply-To, com
  Auto-Submitted: o remetente não recebe resposta.
"""

import asyncio
import contextlib
import logging
import re
import smtplib
import ssl
import uuid
from datetime import timedelta
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from typing import Any, Protocol

from sqlalchemy import delete, event, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.enums import AccountTokenPurpose, EmailStatus, EmailTemplate
from app.db.base import utcnow
from app.models import AccountToken, EmailOutbox, User
from app.schemas.account import EmailQueued, EmailQueuedStatus
from app.services import mail_templates
from app.services.mail_templates import Rendered

log = logging.getLogger(__name__)

# Prazo para sair: depois disso o e-mail vence (um link de 2 h que chega um dia depois não serve).
SEND_BY: dict[EmailTemplate, timedelta] = {
    EmailTemplate.VERIFY_EMAIL: timedelta(hours=72),
    EmailTemplate.WELCOME: timedelta(days=7),
    EmailTemplate.PASSWORD_RESET: timedelta(hours=2),
}
# Espera depois da 1ª, 2ª, 3ª e 4ª falha temporária; a 5ª dá "failed".
BACKOFF_MINUTES = (1, 5, 15, 60)
MAX_ATTEMPTS = 5
# O registro dos e-mails fica 180 dias (aviso de privacidade); os tokens, 30 dias depois de vencer.
LOG_RETENTION_DAYS = 180
TOKEN_RETENTION_DAYS = 30
ERROR_MAX = 500

# Recebe e-mail: "@", domínio com ponto e sem os finais dos endereços de mentira (importados).
_SENDABLE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
_UNDELIVERABLE = re.compile(r"\.(invalid|local)$")


class MailError(Exception):
    """O envio não saiu. `permanent`: não adianta tentar de novo (o servidor recusou de vez)."""

    def __init__(self, message: str, *, permanent: bool = False) -> None:
        super().__init__(message)
        self.permanent = permanent


class MailProvider(Protocol):
    configured: bool

    async def send(self, message: EmailMessage) -> None: ...


class DisabledProvider:
    """Sem SMTP: nada sai (a fila fica "pending" até vencer)."""

    configured = False

    async def send(self, message: EmailMessage) -> None:
        raise MailError("Envio de e-mail desligado")


class SmtpProvider:
    """SMTP pela biblioteca padrão, numa thread (o smtplib bloqueia)."""

    configured = True

    def __init__(
        self,
        *,
        host: str,
        port: int,
        username: str | None,
        password: str | None,
        security: str,
        timeout: float,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.security = security
        self.timeout = timeout

    async def send(self, message: EmailMessage) -> None:
        await run_in_threadpool(self._send, message)

    def _send(self, message: EmailMessage) -> None:
        context = ssl.create_default_context()
        try:
            if self.security == "ssl":
                client: smtplib.SMTP = smtplib.SMTP_SSL(
                    self.host, self.port, timeout=self.timeout, context=context
                )
            else:
                client = smtplib.SMTP(self.host, self.port, timeout=self.timeout)
            try:
                if self.security == "starttls":
                    client.starttls(context=context)
                if self.username:
                    client.login(self.username, self.password or "")
                client.send_message(message)
            finally:
                # O QUIT que falha depois do envio não faz o e-mail sair de novo.
                with contextlib.suppress(Exception):
                    client.quit()
        except smtplib.SMTPRecipientsRefused as exc:
            codes = [code for code, _ in exc.recipients.values()]
            permanent = bool(codes) and all(code >= 500 for code in codes)
            raise MailError(
                f"Destinatário recusado ({_codes(codes)})", permanent=permanent
            ) from None
        except (smtplib.SMTPSenderRefused, smtplib.SMTPDataError) as exc:
            name = exc.__class__.__name__
            raise MailError(f"{name} {exc.smtp_code}", permanent=exc.smtp_code >= 500) from None
        except smtplib.SMTPResponseException as exc:  # autenticação e as outras respostas
            raise MailError(f"{exc.__class__.__name__} {exc.smtp_code}") from None
        except (smtplib.SMTPException, OSError) as exc:  # conexão, tempo, TLS
            raise MailError(exc.__class__.__name__) from None


def _codes(codes: list[int]) -> str:
    return ", ".join(str(code) for code in codes) or "sem código"


def get_provider() -> MailProvider:
    """O SMTP de settings, ou o desligado sem SMTP_HOST e MAIL_FROM."""
    if not settings.mail_enabled:
        return DisabledProvider()
    return SmtpProvider(
        host=str(settings.SMTP_HOST),
        port=settings.SMTP_PORT,
        username=settings.SMTP_USERNAME or None,
        password=settings.SMTP_PASSWORD or None,
        security=settings.SMTP_SECURITY,
        timeout=settings.SMTP_TIMEOUT_SECONDS,
    )


def sendable(email: str | None) -> bool:
    """O endereço recebe mensagens (= isSendableEmail de lib/constants.ts): "@", domínio com ponto
    e não termina em .invalid nem .local (os e-mails de mentira dos importados)."""
    value = (email or "").strip().lower()
    return bool(_SENDABLE.fullmatch(value)) and not _UNDELIVERABLE.search(value)


def _id_of(value: Any) -> uuid.UUID | None:
    if value is None or isinstance(value, uuid.UUID):
        return value
    return value.id


async def enqueue(
    db: AsyncSession,
    *,
    template: EmailTemplate,
    to_email: str,
    user: Any = None,
    application: Any = None,
    context: dict[str, Any] | None = None,
    created_by: Any = None,
) -> tuple[EmailOutbox | None, EmailQueuedStatus]:
    """Põe o e-mail na fila (na transação de quem chama; o commit é dele). Endereço que não recebe
    mensagens: nada entra ("not_sendable"). O mesmo e-mail ainda na fila (modelo, alvo e endereço):
    devolve a mesma linha, sem duplicar, e a próxima tentativa passa a ser agora. Sem envio
    configurado a linha entra assim mesmo e o status é "not_configured" (ela vence sem sair).
    `user`, `application` e `created_by`: o objeto ou o id."""
    address = (to_email or "").strip().lower()
    if not sendable(address):
        return None, "not_sendable"
    user_id, application_id = _id_of(user), _id_of(application)
    if user_id is None and application_id is None:
        raise ValueError("O e-mail precisa de um alvo: o usuário ou a ficha")
    status: EmailQueuedStatus = "queued" if get_provider().configured else "not_configured"
    now = utcnow()
    existing = await db.scalar(
        select(EmailOutbox)
        .where(
            EmailOutbox.template == template,
            EmailOutbox.status == EmailStatus.PENDING,
            EmailOutbox.to_email == address,
            EmailOutbox.send_by >= now,
            EmailOutbox.user_id.is_(None) if user_id is None else EmailOutbox.user_id == user_id,
            EmailOutbox.application_id.is_(None)
            if application_id is None
            else EmailOutbox.application_id == application_id,
        )
        .order_by(EmailOutbox.created_at.desc())
        .limit(1)
    )
    if existing is not None:
        if existing.next_attempt_at > now:
            existing.next_attempt_at = now
            await db.flush()
        return existing, status
    row = EmailOutbox(
        id=uuid.uuid4(),
        template=template,
        to_email=address,
        user_id=user_id,
        application_id=application_id,
        context=dict(context or {}),
        status=EmailStatus.PENDING,
        attempts=0,
        next_attempt_at=now,
        send_by=now + SEND_BY[template],
        created_by_id=_id_of(created_by),
        created_at=now,
    )
    db.add(row)
    await db.flush()
    return row, status


def queued(row: EmailOutbox | None, status: EmailQueuedStatus) -> EmailQueued:
    """A resposta das rotas que pedem e-mail (EmailQueued)."""
    return EmailQueued(status=status, to=row.to_email if row is not None else None)


# Tarefas de entrega em andamento: a referência fica aqui até acabarem (o asyncio guarda só uma
# referência fraca).
_TASKS: set[asyncio.Task[None]] = set()


def deliver_soon(ids: list[uuid.UUID]) -> None:
    """Depois do commit da rota: manda já, numa sessão própria, sem segurar a resposta. Sem envio
    configurado, nada. Falha fica só no log: a rotina da fila tenta de novo."""
    wanted = [i for i in ids if i is not None]
    if not wanted or not get_provider().configured:
        return
    try:
        task = asyncio.get_running_loop().create_task(_deliver_new_session(wanted))
    except RuntimeError:  # fora de um loop (script): fica para a rotina da fila
        return
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


def deliver_after_commit(db: AsyncSession, ids: list[uuid.UUID]) -> None:
    """Para quem pede o e-mail sem cuidar do commit: `deliver_soon(ids)` quando esta sessão gravar
    (nada se ela desfizer)."""
    wanted = [i for i in ids if i is not None]
    if not wanted:
        return

    def _after_commit(_session: Any) -> None:
        try:
            deliver_soon(wanted)
        except Exception:
            log.exception("Falha ao agendar o envio de e-mail")

    event.listen(db.sync_session, "after_commit", _after_commit, once=True)


async def _deliver_new_session(ids: list[uuid.UUID]) -> None:
    from app.db.session import SessionLocal  # a sessão da API (os testes não passam por aqui)

    try:
        async with SessionLocal() as db:
            await deliver_pending(db, ids)
    except Exception:
        log.exception("Falha ao enviar e-mail agora (a fila tenta de novo)")


async def deliver_pending(
    db: AsyncSession, ids: list[uuid.UUID] | None = None, limit: int = 50
) -> int:
    """Vence os atrasados (mesmo sem envio configurado) e manda os pendentes, um por transação (com
    commit), até `limit`; com `ids`, só esses. Várias instâncias da API não pegam a mesma linha
    (FOR UPDATE SKIP LOCKED). Só faz commit (nunca rollback): numa sessão com
    expire_on_commit=False, como a da API e a dos testes, os objetos de quem chamou continuam
    carregados. Devolve quantos saíram."""
    now = utcnow()
    await db.execute(
        update(EmailOutbox)
        .where(EmailOutbox.status == EmailStatus.PENDING, EmailOutbox.send_by < now)
        .values(status=EmailStatus.EXPIRED)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    provider = get_provider()
    if not provider.configured:
        return 0
    sent = 0
    for _ in range(limit):
        now = utcnow()
        stmt = select(EmailOutbox.id).where(
            EmailOutbox.status == EmailStatus.PENDING,
            EmailOutbox.next_attempt_at <= now,
            EmailOutbox.send_by >= now,
        )
        if ids is not None:
            stmt = stmt.where(EmailOutbox.id.in_(ids))
        row_id = await db.scalar(
            stmt.order_by(EmailOutbox.created_at, EmailOutbox.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        if row_id is None:
            await db.commit()  # só a consulta: nada a gravar
            break
        row = await db.get(EmailOutbox, row_id, populate_existing=True)
        if row is not None and await _deliver_one(db, provider, row):
            sent += 1
        await db.commit()
    return sent


async def _deliver_one(db: AsyncSession, provider: MailProvider, row: EmailOutbox) -> bool:
    """Monta (cria o link), manda e anota. True quando saiu."""
    try:
        async with db.begin_nested():
            rendered = await _render(db, row)
            await provider.send(build_message(rendered, row.to_email))
    except MailError as exc:
        await db.refresh(row)
        _failed(row, str(exc), permanent=exc.permanent)
        log.warning("E-mail %s (%s) não saiu: %s", row.id, row.template.value, _safe_reason(exc))
        return False
    except Exception as exc:
        await db.refresh(row)
        _failed(row, exc.__class__.__name__, permanent=False)
        log.exception("Falha ao montar ou enviar o e-mail %s (%s)", row.id, row.template.value)
        return False
    row.status = EmailStatus.SENT
    row.sent_at = utcnow()
    row.attempts += 1
    row.last_error = None
    log.info("E-mail %s (%s) enviado", row.id, row.template.value)
    return True


def _safe_reason(exc: MailError) -> str:
    """O motivo para o log: os textos do MailError daqui não levam endereço nem link."""
    return f"{exc}{' (permanente)' if exc.permanent else ''}"


def _failed(row: EmailOutbox, reason: str, *, permanent: bool) -> None:
    row.attempts += 1
    row.last_error = reason[:ERROR_MAX] or "Falha no envio"
    if permanent or row.attempts >= MAX_ATTEMPTS:
        row.status = EmailStatus.FAILED
        return
    wait = BACKOFF_MINUTES[min(row.attempts, len(BACKOFF_MINUTES)) - 1]
    row.next_attempt_at = utcnow() + timedelta(minutes=wait)


async def _render(db: AsyncSession, row: EmailOutbox) -> Rendered:
    """O texto do e-mail, com o link de uso único criado agora (só o hash fica no banco)."""
    from app.services import account, company  # account usa este módulo: import tardio

    company_name = (await company.profile(db)).name
    ctx = row.context or {}
    name = ctx.get("name")
    if row.template == EmailTemplate.VERIFY_EMAIL:
        reason = str(ctx.get("reason") or "check")
        raw = await account.mint(
            db,
            purpose=AccountTokenPurpose.VERIFY_EMAIL,
            email=row.to_email,
            user=row.user_id if row.application_id is None else None,
            application=row.application_id,
            reason=reason,
            hours=account.VERIFY_HOURS,
            created_by=row.created_by_id,
        )
        return mail_templates.verify_email(
            name=name, company=company_name, reason=reason, link=mail_templates.verify_url(raw)
        )
    user = await db.get(User, row.user_id) if row.user_id is not None else None
    if user is None:
        raise MailError("E-mail sem o técnico", permanent=True)
    if row.template == EmailTemplate.PASSWORD_RESET:
        origin = str(ctx.get("origin") or "self")
        raw = await account.mint(
            db,
            purpose=AccountTokenPurpose.RESET_PASSWORD,
            email=row.to_email,
            user=user,
            reason=origin,
            hours=account.RESET_HOURS,
            created_by=row.created_by_id,
        )
        return mail_templates.password_reset(
            name=name, company=company_name, origin=origin, link=mail_templates.password_url(raw)
        )
    password_link = verify_link = None
    if user.must_change_password:
        raw = await account.mint(
            db,
            purpose=AccountTokenPurpose.RESET_PASSWORD,
            email=row.to_email,
            user=user,
            reason="welcome",
            hours=account.WELCOME_PASSWORD_HOURS,
            created_by=row.created_by_id,
        )
        password_link = mail_templates.password_url(raw)
    elif user.email_verified_at is None:
        raw = await account.mint(
            db,
            purpose=AccountTokenPurpose.VERIFY_EMAIL,
            email=row.to_email,
            user=user,
            reason="check",
            hours=account.VERIFY_HOURS,
            created_by=row.created_by_id,
        )
        verify_link = mail_templates.verify_url(raw)
    return mail_templates.welcome(
        name=name or user.name,
        company=company_name,
        email=str(ctx.get("email") or row.to_email),
        password_link=password_link,
        verify_link=verify_link,
        app_url=settings.tech_app_url,
    )


def build_message(rendered: Rendered, to_email: str) -> EmailMessage:
    """A mensagem: remetente que não recebe resposta (sem Reply-To), Auto-Submitted, texto e
    HTML."""
    sender = (settings.MAIL_FROM or "").strip()
    if not sender:
        raise MailError("MAIL_FROM não configurado")
    username, _, domain = sender.rpartition("@")
    message = EmailMessage()
    message["From"] = Address(
        display_name=(settings.MAIL_FROM_NAME or "").strip() or settings.COMPANY_NAME,
        username=username,
        domain=domain,
    )
    message["To"] = to_email
    message["Subject"] = rendered.subject
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = make_msgid(domain=domain)
    message["Auto-Submitted"] = "auto-generated"
    message["X-Auto-Response-Suppress"] = "All"
    message.set_content(rendered.text)
    message.add_alternative(rendered.html, subtype="html")
    return message


async def purge_old(db: AsyncSession) -> int:
    """Rotina (main._JOBS): apaga o registro dos e-mails com mais de 180 dias e os tokens vencidos
    há mais de 30. Sem commit (a rotina grava). Devolve quantas linhas saíram."""
    now = utcnow()
    mails = await db.execute(
        delete(EmailOutbox)
        .where(EmailOutbox.created_at < now - timedelta(days=LOG_RETENTION_DAYS))
        .execution_options(synchronize_session=False)
    )
    tokens = await db.execute(
        delete(AccountToken)
        .where(AccountToken.expires_at < now - timedelta(days=TOKEN_RETENTION_DAYS))
        .execution_options(synchronize_session=False)
    )
    return int(getattr(mails, "rowcount", 0) or 0) + int(getattr(tokens, "rowcount", 0) or 0)
