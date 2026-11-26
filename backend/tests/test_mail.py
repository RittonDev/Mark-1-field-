"""E-mails transacionais: endereços que recebem, os 3 modelos, a mensagem SMTP, a configuração e a
fila (sem envio configurado, entrega, novas tentativas, falha, prazo vencido e retenção).

Nada sai para a rede: o SMTP é um smtplib de mentira e a fila usa o provedor da fixture `mail_box`.
"""

import json
import re
import smtplib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.config import Settings, settings
from app.core.enums import AccountTokenPurpose, EmailStatus, EmailTemplate, UserRole
from app.core.security import hash_password
from app.models import AccountToken, EmailOutbox, TechnicianApplication, User
from app.services import account, mail, mail_templates
from app.services.errors import CodedError
from tests.conftest import MailBox, requires_db

COMPANY = "Empresa Exemplo"
FOOTER = (
    "Mensagem automática: este endereço não recebe respostas. Para falar com a central, use o "
    "WhatsApp."
)


# ------------------------------------------------------------------ sem banco


def test_sendable_addresses() -> None:
    assert mail.sendable("alfa@exemplo.com")
    assert mail.sendable(" Tecnico.Alfa@Exemplo.com ")
    for bad in ("fc-12@importado.invalid", "tecnico", "a@b", "x@exemplo.local", "", None):
        assert not mail.sendable(bad), bad


def test_templates_texts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "WEB_URL", "https://central.exemplo.com/")
    link = mail_templates.verify_url("abc_DEF-123")
    assert link == "https://central.exemplo.com/validar-email#token=abc_DEF-123"
    password_link = mail_templates.password_url("xyz")
    assert password_link == "https://central.exemplo.com/definir-senha#token=xyz"

    intros = {
        "signup": "Recebemos sua ficha de cadastro de técnico parceiro da Empresa Exemplo. "
        "Confirme que este e-mail é seu:",
        "change": "Você pediu para trocar o e-mail de acesso ao app da Empresa Exemplo. Confirme o "
        "novo e-mail; até lá, você continua entrando com o e-mail atual:",
        "check": "Confirme que este e-mail é seu para o cadastro de técnico parceiro da Empresa "
        "Exemplo:",
    }
    for reason, intro in intros.items():
        r = mail_templates.verify_email(
            name="Tecnico Alfa", company=COMPANY, reason=reason, link=link
        )
        assert r.subject == "Confirme seu e-mail"
        assert r.text == (
            f"Olá, Tecnico.\n\n{intro}\n\n{link}\n\nO link vale por 72 horas e só pode ser usado "
            f"uma vez. Se não foi você, ignore este e-mail.\n\n{COMPANY}\n{FOOTER}\n"
        )
        assert "Confirmar e-mail" in r.html and "#token=abc_DEF-123" in r.html
        assert FOOTER in r.html

    # Boas-vindas sem senha: o link de criar a senha (72 h); sem TECH_APP_URL, pedir à central.
    w = mail_templates.welcome(
        name="Tecnico Alfa", company=COMPANY, email="alfa@exemplo.com", password_link=password_link
    )
    assert w.subject == "Cadastro aprovado: boas-vindas à Empresa Exemplo"
    assert "- E-mail: alfa@exemplo.com" in w.text
    assert f"- Senha: crie a sua neste link, que vale por 72 horas: {password_link}" in w.text
    assert "- App: peça o link à central pelo WhatsApp." in w.text
    assert "Confirme também" not in w.text
    assert "1. Entre no app e confira seus dados em Perfil › Configurações." in w.text
    assert "Dúvidas sobre o trabalho? Fale com a central pelo WhatsApp." in w.text
    assert w.text.endswith(f"{COMPANY}\n{FOOTER}\n")
    elo = w.text.split("O Elo\n", 1)[1].split("\n\n", 1)[0]
    assert "Bronze, Prata, Ouro e Diamante" in elo
    assert not re.search(r"\d", elo), "o Elo sem números"
    # Com a senha da ficha e o e-mail não validado: o link de validar; com TECH_APP_URL, o app.
    w2 = mail_templates.welcome(
        name="Tecnico Alfa",
        company=COMPANY,
        email="alfa@exemplo.com",
        verify_link=link,
        app_url="https://app.exemplo.com",
    )
    assert "- Senha: a que você criou na ficha de cadastro." in w2.text
    assert "- App: https://app.exemplo.com" in w2.text
    assert f"Confirme também o seu e-mail: {link}" in w2.text

    for origin, intro in (
        (
            "self",
            "Recebemos um pedido para criar uma nova senha do app da Empresa Exemplo. Use "
            "este link:",
        ),
        (
            "central",
            "A central da Empresa Exemplo enviou este link para você criar uma nova senha do app:",
        ),
    ):
        p = mail_templates.password_reset(
            name="Tecnico Alfa", company=COMPANY, origin=origin, link=password_link
        )
        assert p.subject == "Criar uma nova senha"
        assert p.text.startswith(f"Olá, Tecnico.\n\n{intro}\n\n{password_link}\n\n")
        assert "O link vale por 2 horas e só pode ser usado uma vez." in p.text
        assert "Se você não esperava este e-mail, ignore: sua senha continua a mesma." in p.text
        assert "Criar nova senha" in p.html
    # Sem nome, só "Olá."; o HTML escapa o que vem de fora.
    blank = mail_templates.password_reset(name="", company=COMPANY, origin="x", link="https://x")
    assert blank.text.startswith("Olá.\n\nRecebemos um pedido")
    evil = mail_templates.verify_email(
        name="<script>alert(1)</script>", company=COMPANY, reason="check", link="https://x/#t=1"
    )
    assert "<script>" not in evil.html


def test_smtp_message_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "MAIL_FROM", "nao-responda@exemplo.com")
    monkeypatch.setattr(settings, "MAIL_FROM_NAME", "Central Ação")
    rendered = mail_templates.verify_email(
        name="Alfa", company=COMPANY, reason="check", link="https://x/#token=1"
    )
    message = mail.build_message(rendered, "alfa@exemplo.com")
    assert str(message["From"]) == "Central Ação <nao-responda@exemplo.com>"
    assert message["To"] == "alfa@exemplo.com"
    assert message["Reply-To"] is None, "o remetente não recebe resposta"
    assert message["Auto-Submitted"] == "auto-generated"
    assert message["X-Auto-Response-Suppress"] == "All"
    assert message["Message-ID"].endswith("@exemplo.com>")
    assert message.get_content_type() == "multipart/alternative"
    assert message.get_body(("plain",)).get_content() == rendered.text
    assert message.get_body(("html",)).get_content() == rendered.html
    message.as_bytes()  # serializa (nome com acento)
    # Sem MAIL_FROM_NAME, o nome da empresa.
    monkeypatch.setattr(settings, "MAIL_FROM_NAME", None)
    assert str(mail.build_message(rendered, "a@exemplo.com")["From"]).startswith(
        f"{settings.COMPANY_NAME} <"
    )


class FakeSMTP:
    """smtplib.SMTP de mentira: anota os passos; `refuse` faz o envio falhar."""

    calls: list[str] = []
    refuse: Exception | None = None

    def __init__(self, host: str, port: int, timeout: float = 0, **_: object) -> None:
        FakeSMTP.calls.append(f"connect {host}:{port}")

    def starttls(self, context: object = None) -> None:
        FakeSMTP.calls.append("starttls")

    def login(self, user: str, password: str) -> None:
        FakeSMTP.calls.append(f"login {user}")

    def send_message(self, message: object) -> None:
        if FakeSMTP.refuse is not None:
            raise FakeSMTP.refuse
        FakeSMTP.calls.append("send")

    def quit(self) -> None:
        FakeSMTP.calls.append("quit")
        raise smtplib.SMTPServerDisconnected("fechou")  # o QUIT que falha não reenvia


async def test_smtp_errors_are_classified(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mail.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(settings, "MAIL_FROM", "nao-responda@exemplo.com")
    provider = mail.SmtpProvider(
        host="smtp.exemplo.com",
        port=587,
        username="usuario",
        password="segredo-de-teste",
        security="starttls",
        timeout=5,
    )
    rendered = mail_templates.verify_email(name="A", company=COMPANY, reason="check", link="l")
    message = mail.build_message(rendered, "alfa@exemplo.com")
    FakeSMTP.calls, FakeSMTP.refuse = [], None
    await provider.send(message)
    assert FakeSMTP.calls == [
        "connect smtp.exemplo.com:587",
        "starttls",
        "login usuario",
        "send",
        "quit",
    ]
    cases: list[tuple[Exception, bool]] = [
        (smtplib.SMTPRecipientsRefused({"alfa@exemplo.com": (550, b"no")}), True),
        (smtplib.SMTPRecipientsRefused({"alfa@exemplo.com": (450, b"later")}), False),
        (smtplib.SMTPSenderRefused(553, b"no", "nao-responda@exemplo.com"), True),
        (smtplib.SMTPDataError(554, b"rejected"), True),
        (smtplib.SMTPDataError(451, b"later"), False),
        (smtplib.SMTPAuthenticationError(535, b"auth"), False),
        (TimeoutError(), False),
        (ConnectionRefusedError(), False),
    ]
    for error, permanent in cases:
        FakeSMTP.refuse = error
        with pytest.raises(mail.MailError) as caught:
            await provider.send(message)
        assert caught.value.permanent is permanent, error
        assert "alfa@exemplo.com" not in str(caught.value), "o erro não leva o endereço"


def test_production_refuses_plain_smtp() -> None:
    secret = "s" * 40
    with pytest.raises(ValueError, match="SMTP_SECURITY=none"):
        Settings(ENVIRONMENT="production", JWT_SECRET=secret, SMTP_SECURITY="none")
    assert Settings(ENVIRONMENT="development", SMTP_SECURITY="none").SMTP_SECURITY == "none"
    with pytest.raises(ValueError, match="MAIL_FROM"):
        Settings(MAIL_FROM="Empresa <nao-responda@exemplo.com>")
    configured = Settings(
        SMTP_HOST="smtp.exemplo.com", MAIL_FROM="nao-responda@exemplo.com", SMTP_SECURITY=" SSL "
    )
    assert configured.mail_enabled and configured.SMTP_SECURITY == "ssl"
    assert not Settings(SMTP_HOST="smtp.exemplo.com", MAIL_FROM="").mail_enabled
    assert not Settings(SMTP_HOST="", MAIL_FROM="nao-responda@exemplo.com").mail_enabled
    assert Settings(TECH_APP_URL="  ").tech_app_url is None


async def test_coded_errors_answer_with_the_code() -> None:
    from app.main import _coded_error

    response = await _coded_error(None, account.LinkGone(account.VERIFY_LINK_GONE))  # type: ignore[arg-type]
    assert response.status_code == 410
    assert json.loads(response.body) == {"detail": account.VERIFY_LINK_GONE, "code": "LINK_GONE"}
    error = CodedError("O envio de e-mail está desligado", code=mail.MAIL_DISABLED, status_code=503)
    response = await _coded_error(None, error)  # type: ignore[arg-type]
    assert response.status_code == 503
    assert json.loads(response.body)["code"] == "MAIL_DISABLED"


# ------------------------------------------------------------------ fila (com banco)


def _maker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def _tech(
    db: AsyncSession, email: str = "tecnico.alfa@exemplo.com", **fields: object
) -> User:
    user = User(
        id=uuid.uuid4(),
        name="Tecnico Alfa",
        email=email,
        password_hash=hash_password("senha-teste-123"),
        role=UserRole.TECHNICIAN,
        is_active=True,
        **fields,
    )
    db.add(user)
    await db.flush()
    return user


async def _verify(db: AsyncSession, user: User, reason: str = "check") -> EmailOutbox:
    row, _ = await mail.enqueue(
        db,
        template=EmailTemplate.VERIFY_EMAIL,
        to_email=user.email,
        user=user,
        context={"name": user.name, "reason": reason},
    )
    assert row is not None
    await db.commit()
    return row


@requires_db
async def test_not_configured_keeps_pending_then_expired(engine: AsyncEngine) -> None:
    async with _maker(engine)() as db:
        user = await _tech(db)
        row, status = await mail.enqueue(
            db,
            template=EmailTemplate.VERIFY_EMAIL,
            to_email=" Tecnico.Alfa@Exemplo.com ",
            user=user,
            context={"name": user.name, "reason": "check"},
        )
        assert status == "not_configured" and row is not None
        assert row.to_email == "tecnico.alfa@exemplo.com"
        assert mail.queued(row, status).model_dump() == {
            "status": "not_configured",
            "to": "tecnico.alfa@exemplo.com",
        }
        # O mesmo e-mail ainda na fila não duplica.
        again, _ = await mail.enqueue(
            db, template=EmailTemplate.VERIFY_EMAIL, to_email=user.email, user=user
        )
        assert again is row
        # Endereço que não recebe: nada entra.
        none, skipped = await mail.enqueue(
            db, template=EmailTemplate.VERIFY_EMAIL, to_email="fc-1@importado.invalid", user=user
        )
        assert (none, skipped) == (None, "not_sendable")
        assert mail.queued(none, skipped).model_dump() == {"status": "not_sendable", "to": None}
        await db.commit()
        assert await mail.deliver_pending(db) == 0
        await db.refresh(row)
        assert row.status == EmailStatus.PENDING and row.attempts == 0
        assert await db.scalar(select(AccountToken)) is None, "sem envio, nenhum link nasce"
        row.send_by = datetime.now(UTC) - timedelta(seconds=1)
        await db.commit()
        await mail.deliver_pending(db)
        await db.refresh(row)
        assert row.status == EmailStatus.EXPIRED


@requires_db
async def test_delivers_once_and_records(engine: AsyncEngine, mail_box: MailBox) -> None:
    async with _maker(engine)() as db:
        user = await _tech(db)
        row = await _verify(db, user, "change")
        assert await mail.deliver_pending(db) == 1
        assert await mail.deliver_pending(db) == 0
        await db.refresh(row)
        assert (row.status, row.attempts, row.last_error) == (EmailStatus.SENT, 1, None)
        assert row.sent_at is not None
        assert len(mail_box.messages) == 1
        assert mail_box.messages[0]["To"] == "tecnico.alfa@exemplo.com"
        assert "trocar o e-mail" in mail_box.texts()[0]
        # O link nasceu no envio: só o hash fica no banco; nem a fila guarda o token.
        [raw] = mail_box.tokens()
        [token] = list(await db.scalars(select(AccountToken)))
        assert token.token_hash == account.hash_token(raw) and raw not in token.token_hash
        assert (token.purpose, token.reason) == (AccountTokenPurpose.VERIFY_EMAIL, "change")
        assert token.user_id == user.id and token.email == "tecnico.alfa@exemplo.com"
        assert raw not in json.dumps(row.context)
        # Depois de enviado, um pedido novo é outro e-mail.
        again = await _verify(db, user)
        assert again.id != row.id


@requires_db
async def test_retry_backoff_then_failed(engine: AsyncEngine, mail_box: MailBox) -> None:
    async with _maker(engine)() as db:
        user = await _tech(db)
        row = await _verify(db, user)
        waits = []
        for attempt in range(1, 6):
            mail_box.provider.fail = mail.MailError("SMTPDataError 451")
            before = datetime.now(UTC)
            assert await mail.deliver_pending(db) == 0
            await db.refresh(row)
            assert row.attempts == attempt and row.last_error == "SMTPDataError 451"
            if attempt < 5:
                assert row.status == EmailStatus.PENDING
                waits.append(round((row.next_attempt_at - before).total_seconds() / 60))
                row.next_attempt_at = datetime.now(UTC) - timedelta(seconds=1)
                await db.commit()
        assert waits == [1, 5, 15, 60]
        assert row.status == EmailStatus.FAILED
        assert mail_box.messages == []
        # O link criado em cada tentativa foi desfeito com a falha.
        assert await db.scalar(select(AccountToken)) is None


@requires_db
async def test_permanent_error_fails_at_once(engine: AsyncEngine, mail_box: MailBox) -> None:
    async with _maker(engine)() as db:
        user = await _tech(db, must_change_password=True)
        await mail.enqueue(
            db,
            template=EmailTemplate.WELCOME,
            to_email=user.email,
            user=user,
            context={"name": user.name, "email": user.email},
        )
        await db.commit()
        assert await mail.deliver_pending(db) == 1
        [welcome_raw] = mail_box.tokens()
        row, _ = await mail.enqueue(
            db,
            template=EmailTemplate.PASSWORD_RESET,
            to_email=user.email,
            user=user,
            context={"name": user.name, "origin": "self"},
        )
        assert row is not None
        await db.commit()
        mail_box.provider.fail = mail.MailError("Destinatário recusado (550)", permanent=True)
        assert await mail.deliver_pending(db) == 0
        await db.refresh(row)
        assert (row.status, row.attempts) == (EmailStatus.FAILED, 1)
        assert row.last_error == "Destinatário recusado (550)"
        # O link novo (que revogaria o da boas-vindas) foi desfeito com a falha: o antigo vale.
        token = await account.peek(db, welcome_raw, AccountTokenPurpose.RESET_PASSWORD)
        assert token.reason == "welcome"
        assert await db.scalar(select(AccountToken).where(AccountToken.reason == "self")) is None


@requires_db
async def test_overdue_rows_are_not_sent(engine: AsyncEngine, mail_box: MailBox) -> None:
    async with _maker(engine)() as db:
        user = await _tech(db)
        row = await _verify(db, user)
        row.send_by = datetime.now(UTC) - timedelta(seconds=1)
        await db.commit()
        assert await mail.deliver_pending(db) == 0
        await db.refresh(row)
        assert row.status == EmailStatus.EXPIRED
        assert mail_box.messages == []


@requires_db
async def test_welcome_variants_and_the_current_login(
    engine: AsyncEngine, mail_box: MailBox
) -> None:
    async with _maker(engine)() as db:
        no_password = await _tech(db, must_change_password=True)
        unverified = await _tech(db, email="beta@exemplo.com")
        verified = await _tech(db, email="gama@exemplo.com", email_verified_at=datetime.now(UTC))
        for user in (no_password, unverified, verified):
            await mail.enqueue(
                db,
                template=EmailTemplate.WELCOME,
                to_email=user.email,
                user=user,
                context={"name": user.name, "email": user.email},
            )
        await db.commit()
        # A central trocou o e-mail depois da aprovação: a boas-vindas vai para o login novo e
        # mostra ele em "Como entrar".
        unverified.email = "beta.nova@exemplo.com"
        await account.central_email_changed(db, unverified, None)
        await db.commit()
        # As 3 boas-vindas e a validação do e-mail novo.
        assert await mail.deliver_pending(db) == 4
        sent = {
            (m["To"], str(m["Subject"]).split(":")[0]): text
            for m, text in zip(mail_box.messages, mail_box.texts(), strict=True)
        }
        alfa = sent[("tecnico.alfa@exemplo.com", "Cadastro aprovado")]
        assert "/definir-senha#token=" in alfa and "Confirme também" not in alfa
        beta = sent[("beta.nova@exemplo.com", "Cadastro aprovado")]
        assert "- E-mail: beta.nova@exemplo.com" in beta and "beta@exemplo.com" not in beta
        assert "- Senha: a que você criou na ficha de cadastro." in beta
        assert "Confirme também o seu e-mail:" in beta and "/validar-email#token=" in beta
        gama = sent[("gama@exemplo.com", "Cadastro aprovado")]
        assert "#token=" not in gama
        assert ("beta.nova@exemplo.com", "Confirme seu e-mail") in sent
        reasons = sorted(
            (t.purpose.value, t.reason) for t in await db.scalars(select(AccountToken))
        )
        assert reasons == [
            ("reset_password", "welcome"),
            ("verify_email", "check"),
            ("verify_email", "check"),
        ]


@requires_db
async def test_purge_old_rows_and_tokens(engine: AsyncEngine, mail_box: MailBox) -> None:
    async with _maker(engine)() as db:
        application = TechnicianApplication(
            id=uuid.uuid4(),
            status="pending",
            full_name="Tecnico Alfa",
            email="tecnico.alfa@exemplo.com",
            phone="(11) 99999-0000",
            document="12345678909",
            city="Cidade Exemplo",
            state="SP",
            service_areas=[],
            skills=[],
            has_vehicle=False,
            has_driver_license=False,
            coverage_area="Cidade Exemplo",
            availability=[],
            privacy_consent_at=datetime.now(UTC),
            privacy_version="2026-11-25",
        )
        db.add(application)
        await db.flush()
        old_row, _ = await mail.enqueue(
            db,
            template=EmailTemplate.VERIFY_EMAIL,
            to_email=application.email,
            application=application,
            context={"name": application.full_name, "reason": "signup"},
        )
        await db.commit()
        await mail.deliver_pending(db)
        token = await db.scalar(select(AccountToken))
        assert token is not None and token.application_id == application.id
        assert token.user_id is None and token.reason == "signup"
        assert "Recebemos sua ficha" in mail_box.texts()[0]
        user = await _tech(db, email="novo@exemplo.com")
        recent = await _verify(db, user)
        long_ago = datetime.now(UTC) - timedelta(days=200)
        assert old_row is not None
        old_row.created_at = long_ago
        token.expires_at = long_ago
        await db.commit()
        assert await mail.purge_old(db) == 2
        await db.commit()
        assert [r.id for r in await db.scalars(select(EmailOutbox))] == [recent.id]
        assert await db.scalar(select(AccountToken)) is None
