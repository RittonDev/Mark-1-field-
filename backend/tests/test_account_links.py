"""Links da conta por e-mail (sem login): "Esqueci minha senha", a página "Definir nova senha"
(conferir e gravar) e a validação do e-mail (ficha, troca pedida no app e o login de sempre); o
/meta com `mail_enabled` e a troca de senha no app revogando os links de senha.

Os links saem como na vida real: a fila manda pelo provedor de mentira (`mail_box`) e o token vem do
corpo do e-mail (#token=). Nada fala com a rede.
"""

import hashlib
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.api.routes.auth import FORGOT_MAIL_OFF, FORGOT_SENT
from app.core.config import settings
from app.core.enums import AccountTokenPurpose, EmailStatus, EmailTemplate, UserRole
from app.core.security import hash_password
from app.models import AccountToken, EmailOutbox, TechnicianApplication, User, UserChange
from app.services import account, mail
from tests.conftest import MailBox, requires_db

pytestmark = requires_db

API = settings.API_PREFIX
PASSWORD = "senha-teste-123"
NEW_PASSWORD = "nova-senha-456"
ALFA = "tecnico.alfa@exemplo.com"


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Os avisos em tempo real publicados (profile.changed, onboarding.updated)."""
    from app.services import realtime

    sent: list[dict[str, Any]] = []

    async def publish(event: dict[str, Any]) -> None:
        sent.append(event)

    monkeypatch.setattr(realtime.bus, "publish", publish)
    return sent


def _maker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def _add_user(
    engine: AsyncEngine,
    email: str = ALFA,
    role: UserRole = UserRole.TECHNICIAN,
    **fields: Any,
) -> User:
    async with _maker(engine)() as db:
        user = User(
            id=uuid.uuid4(),
            name="Tecnico Alfa",
            email=email,
            password_hash=hash_password(PASSWORD),
            role=role,
            **{"is_active": True, **fields},
        )
        db.add(user)
        await db.commit()
        return user


async def _reload(engine: AsyncEngine, user_id: uuid.UUID) -> User:
    async with _maker(engine)() as db:
        user = await db.get(User, user_id)
        assert user is not None
        return user


async def _send(
    engine: AsyncEngine,
    box: MailBox,
    template: EmailTemplate,
    *,
    to: str,
    user: Any = None,
    application: Any = None,
    **context: Any,
) -> str:
    """Põe o e-mail na fila, manda (só ele) e devolve o token do link que chegou."""
    async with _maker(engine)() as db:
        row, status = await mail.enqueue(
            db, template=template, to_email=to, user=user, application=application, context=context
        )
        assert row is not None and status == "queued"
        await db.commit()
        assert await mail.deliver_pending(db, [row.id]) == 1
    return box.tokens()[-1]


async def _mint_reset(engine: AsyncEngine, user: User, reason: str = "self") -> str:
    async with _maker(engine)() as db:
        raw = await account.mint(
            db,
            purpose=AccountTokenPurpose.RESET_PASSWORD,
            email=user.email,
            user=user.id,
            reason=reason,
            hours=account.RESET_HOURS,
        )
        await db.commit()
        return raw


async def _history(engine: AsyncEngine, user_id: uuid.UUID) -> list[UserChange]:
    async with _maker(engine)() as db:
        return list(
            await db.scalars(
                select(UserChange)
                .where(UserChange.user_id == user_id)
                .order_by(UserChange.created_at, UserChange.id)
            )
        )


async def _login(client: AsyncClient, email: str, password: str) -> int:
    r = await client.post(
        f"{API}/auth/login", json={"email": email, "password": password, "channel": "mobile"}
    )
    return r.status_code


def _old_access_token(user: User) -> str:
    """Um access emitido um minuto atrás (o da sessão aberta no celular)."""
    now = int(time.time())
    payload = {"sub": str(user.id), "typ": "access", "iat": now - 60, "exp": now + 3600}
    return jwt.encode(
        {**payload, "role": user.role.value}, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM
    )


# ------------------------------------------------------------------ /meta


async def test_meta_tells_if_mail_is_on(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert (await client.get(f"{API}/meta")).json()["mail_enabled"] is False
    monkeypatch.setattr(settings, "SMTP_HOST", "smtp.exemplo.com")
    monkeypatch.setattr(settings, "MAIL_FROM", "nao-responda@exemplo.com")
    assert (await client.get(f"{API}/meta")).json()["mail_enabled"] is True


# ------------------------------------------------------------------ Esqueci minha senha


async def test_forgot_password_answers_the_same(
    client: AsyncClient, engine: AsyncEngine, mail_box: MailBox
) -> None:
    now = datetime.now(UTC)
    tech = await _add_user(engine, email_verified_at=now)
    await _add_user(engine, email="sem.validar@exemplo.com")
    await _add_user(engine, email="sem.acesso@exemplo.com", email_verified_at=now, is_active=False)
    await _add_user(
        engine, email="analista@exemplo.com", role=UserRole.ANALYST, email_verified_at=now
    )
    await _add_user(engine, email="fc-7@importado.invalid", email_verified_at=now)
    for email in (
        "ninguem@exemplo.com",
        "sem.validar@exemplo.com",
        "sem.acesso@exemplo.com",
        "analista@exemplo.com",
        "fc-7@importado.invalid",
        "não é e-mail",
    ):
        r = await client.post(f"{API}/auth/forgot-password", json={"email": email})
        assert r.status_code == 202, (email, r.text)
        assert r.json() == {"detail": FORGOT_SENT}
    async with _maker(engine)() as db:
        assert await db.scalar(select(func.count()).select_from(EmailOutbox)) == 0
    assert mail_box.soon == []

    r = await client.post(
        f"{API}/auth/forgot-password", json={"email": " Tecnico.Alfa@Exemplo.com "}
    )
    assert (r.status_code, r.json()) == (202, {"detail": FORGOT_SENT})
    async with _maker(engine)() as db:
        [row] = list(await db.scalars(select(EmailOutbox)))
    assert (row.template, row.to_email, row.user_id) == (
        EmailTemplate.PASSWORD_RESET,
        ALFA,
        tech.id,
    )
    assert row.context == {"name": "Tecnico Alfa", "origin": "self"}
    assert row.created_by_id is None
    assert mail_box.soon == [row.id], "sai logo depois do commit"
    assert (await client.post(f"{API}/auth/forgot-password", json={})).status_code == 422


async def test_forgot_password_limits_and_mail_off(
    client: AsyncClient, engine: AsyncEngine, mail_box: MailBox, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _add_user(engine, email_verified_at=datetime.now(UTC))
    url = f"{API}/auth/forgot-password"
    # Envio desligado: 503 com o código (a tela manda pedir à central pelo WhatsApp).
    monkeypatch.setattr(settings, "SMTP_HOST", None)
    r = await client.post(url, json={"email": ALFA})
    assert r.status_code == 503
    assert r.json() == {"detail": FORGOT_MAIL_OFF, "code": "MAIL_DISABLED"}
    monkeypatch.setattr(settings, "SMTP_HOST", "smtp.exemplo.com")
    # Até 3 links por e-mail na hora; o excesso some calado (a resposta é a mesma).
    for _ in range(4):
        r = await client.post(url, json={"email": ALFA})
        assert (r.status_code, r.json()) == (202, {"detail": FORGOT_SENT})
        async with _maker(engine)() as db:
            await mail.deliver_pending(db)
    assert len(mail_box.messages) == 3
    assert all("/definir-senha#token=" in text for text in mail_box.texts())
    # Por IP: 10 pedidos na hora (o do envio desligado contou).
    for _ in range(5):
        assert (await client.post(url, json={"email": "ninguem@exemplo.com"})).status_code == 202
    blocked = await client.post(url, json={"email": ALFA})
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) > 0


# ------------------------------------------------------------------ Definir nova senha


async def test_links_are_single_use_and_only_the_hash_is_stored(
    client: AsyncClient, engine: AsyncEngine, mail_box: MailBox
) -> None:
    tech = await _add_user(engine, email_verified_at=datetime.now(UTC))
    assert (
        await client.post(f"{API}/auth/forgot-password", json={"email": ALFA})
    ).status_code == 202
    async with _maker(engine)() as db:
        assert await mail.deliver_pending(db) == 1
        [row] = list(await db.scalars(select(EmailOutbox)))
        [token] = list(await db.scalars(select(AccountToken)))
    [raw] = mail_box.tokens()
    assert f"{settings.WEB_URL.rstrip('/')}/definir-senha#token={raw}" in mail_box.texts()[0]
    # Só o SHA-256 fica no banco; nem a fila guarda o link.
    assert token.token_hash == hashlib.sha256(raw.encode()).hexdigest()
    assert raw not in json.dumps(row.context) and raw not in (row.last_error or "")
    assert (token.purpose, token.reason, token.email) == (
        AccountTokenPurpose.RESET_PASSWORD,
        "self",
        ALFA,
    )
    assert token.expires_at - token.created_at == timedelta(hours=2)

    # Conferir não gasta o link.
    for _ in range(2):
        r = await client.post(f"{API}/auth/password-reset/check", json={"token": raw})
        assert r.status_code == 200, r.text
        assert r.json() == {
            "email": "t***@exemplo.com",
            "name": "Tecnico",
            "kind": "reset",
            "app_url": None,
        }
    r = await client.post(
        f"{API}/auth/password-reset", json={"token": raw, "password": NEW_PASSWORD}
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"email": ALFA, "app_url": None}
    # Uso único.
    gone = {"detail": account.RESET_LINK_GONE, "code": "LINK_GONE"}
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": raw})
    assert (r.status_code, r.json()) == (410, gone)
    r = await client.post(f"{API}/auth/password-reset", json={"token": raw, "password": PASSWORD})
    assert (r.status_code, r.json()) == (410, gone)
    assert await _login(client, ALFA, NEW_PASSWORD) == 200
    # Link vencido ou inventado: o mesmo 410.
    expired = await _mint_reset(engine, tech)
    async with _maker(engine)() as db:
        row_token = await db.scalar(
            select(AccountToken).where(AccountToken.token_hash == account.hash_token(expired))
        )
        assert row_token is not None
        row_token.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db.commit()
    for bad in (expired, "inventado", "x" * 128):
        r = await client.post(f"{API}/auth/password-reset/check", json={"token": bad})
        assert (r.status_code, r.json()) == (410, gone)
    # Senha curta: 422 com o rótulo.
    fresh = await _mint_reset(engine, tech)
    r = await client.post(f"{API}/auth/password-reset", json={"token": fresh, "password": "curta"})
    assert r.status_code == 422


async def test_password_reset_sets_password_and_ends_sessions(
    client: AsyncClient,
    engine: AsyncEngine,
    mail_box: MailBox,
    events: list[dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "TECH_APP_URL", "https://app.exemplo.com")
    # Aprovado sem senha na ficha e com o e-mail validado: a boas-vindas leva o link de criar a
    # senha (72 h).
    tech = await _add_user(engine, must_change_password=True, email_verified_at=datetime.now(UTC))
    raw = await _send(
        engine,
        mail_box,
        EmailTemplate.WELCOME,
        to=ALFA,
        user=tech,
        name=tech.name,
        email=ALFA,
    )
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": raw})
    assert r.json() == {
        "email": "t***@exemplo.com",
        "name": "Tecnico",
        "kind": "create",
        "app_url": "https://app.exemplo.com",
    }
    # Senhas erradas trancaram o login deste IP; o celular estava com uma sessão aberta.
    for _ in range(5):
        assert await _login(client, ALFA, "errada-123") == 401
    assert await _login(client, ALFA, PASSWORD) == 429
    old_session = {"Authorization": f"Bearer {_old_access_token(tech)}"}
    assert (await client.get(f"{API}/auth/me", headers=old_session)).status_code == 200

    r = await client.post(
        f"{API}/auth/password-reset", json={"token": raw, "password": NEW_PASSWORD}
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"email": ALFA, "app_url": "https://app.exemplo.com"}
    saved = await _reload(engine, tech.id)
    assert saved.must_change_password is False
    assert saved.sessions_revoked_at is not None
    assert (await client.get(f"{API}/auth/me", headers=old_session)).status_code == 401
    assert await _login(client, ALFA, NEW_PASSWORD) == 200, "a senha nova destrava o login"
    assert await _login(client, ALFA, PASSWORD) == 401
    [line] = await _history(engine, tech.id)
    assert (line.via, line.actor_id, line.note) == ("link", tech.id, None)
    assert line.changes == [{"field": "password", "from": None, "to": "criada pelo link do e-mail"}]
    [event] = [e for e in events if e["type"] == "profile.changed"]
    assert event["data"] == {"fields": ["password"], "via": "link"}
    assert event["actor_id"] == str(tech.id)

    # Um link de senha mandado depois (pela central): "redefinida", sem validar de novo.
    raw2 = await _send(
        engine,
        mail_box,
        EmailTemplate.PASSWORD_RESET,
        to=ALFA,
        user=tech,
        name=tech.name,
        origin="central",
    )
    assert "A central da" in mail_box.texts()[-1]
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": raw2})
    assert r.json()["kind"] == "reset"
    r = await client.post(f"{API}/auth/password-reset", json={"token": raw2, "password": PASSWORD})
    assert r.status_code == 200, r.text
    assert (await _history(engine, tech.id))[-1].changes == [
        {"field": "password", "from": None, "to": "redefinida pelo link do e-mail"}
    ]

    # A central mandou o link para um login ainda não validado (ela decide): o link chegou nele,
    # então criar a senha também valida o e-mail.
    beta = await _add_user(engine, email="beta@exemplo.com")
    raw3 = await _send(
        engine,
        mail_box,
        EmailTemplate.PASSWORD_RESET,
        to="beta@exemplo.com",
        user=beta,
        name=beta.name,
        origin="central",
    )
    r = await client.post(
        f"{API}/auth/password-reset", json={"token": raw3, "password": NEW_PASSWORD}
    )
    assert r.status_code == 200, r.text
    assert (await _reload(engine, beta.id)).email_verified_at is not None
    [line] = await _history(engine, beta.id)
    assert line.changes == [
        {"field": "email_verified", "from": "pendente", "to": "validado"},
        {"field": "password", "from": None, "to": "redefinida pelo link do e-mail"},
    ]


async def test_password_reset_refused_without_app_access(
    client: AsyncClient, engine: AsyncEngine
) -> None:
    tech = await _add_user(engine, email_verified_at=datetime.now(UTC), is_active=False)
    raw = await _mint_reset(engine, tech, "central")
    # O código próprio: a página mostra "Acesso ao app desativado" (e não "Link vencido").
    cut = {"detail": account.ACCESS_CUT_TEXT, "code": "ACCESS_CUT"}
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": raw})
    assert (r.status_code, r.json()) == (410, cut)
    r = await client.post(
        f"{API}/auth/password-reset", json={"token": raw, "password": NEW_PASSWORD}
    )
    assert (r.status_code, r.json()) == (410, cut)
    # Nada mudou e o link continua como estava: com o acesso de volta, vale.
    async with _maker(engine)() as db:
        token = await db.scalar(
            select(AccountToken).where(AccountToken.token_hash == account.hash_token(raw))
        )
        assert token is not None and token.used_at is None
        user = await db.get(User, tech.id)
        assert user is not None
        user.is_active = True
        await db.commit()
    assert await _history(engine, tech.id) == []
    r = await client.post(
        f"{API}/auth/password-reset", json={"token": raw, "password": NEW_PASSWORD}
    )
    assert r.status_code == 200, r.text

    # O login mudou depois do envio (o link foi para o endereço antigo): não vale.
    raw = await _mint_reset(engine, tech)
    async with _maker(engine)() as db:
        user = await db.get(User, tech.id)
        assert user is not None
        user.email = "outro.endereco@exemplo.com"
        await db.commit()
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": raw})
    assert (r.status_code, r.json()["code"]) == (410, "LINK_GONE")


async def test_change_password_revokes_reset_links(
    client: AsyncClient, engine: AsyncEngine
) -> None:
    tech = await _add_user(engine, email_verified_at=datetime.now(UTC))
    raw = await _mint_reset(engine, tech)
    headers = {"Authorization": f"Bearer {_old_access_token(tech)}"}
    r = await client.post(
        f"{API}/auth/change-password",
        json={"current_password": PASSWORD, "new_password": NEW_PASSWORD},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": raw})
    assert (r.status_code, r.json()["code"]) == (410, "LINK_GONE")


# ------------------------------------------------------------------ validar o e-mail


async def test_verify_check_and_open_again(
    client: AsyncClient, engine: AsyncEngine, mail_box: MailBox, events: list[dict[str, Any]]
) -> None:
    tech = await _add_user(engine)
    raw = await _send(
        engine, mail_box, EmailTemplate.VERIFY_EMAIL, to=ALFA, user=tech, name=tech.name
    )
    assert "Confirme que este e-mail é seu" in mail_box.texts()[-1]
    async with _maker(engine)() as db:
        token = await db.scalar(select(AccountToken))
        assert token is not None
        assert (token.reason, token.expires_at - token.created_at) == ("check", timedelta(hours=72))
    r = await client.post(f"{API}/auth/verify-email", json={"token": raw})
    assert r.status_code == 200, r.text
    assert r.json() == {"email": ALFA, "kind": "check"}
    assert (await _reload(engine, tech.id)).email_verified_at is not None
    [line] = await _history(engine, tech.id)
    assert (line.via, line.actor_id) == ("link", tech.id)
    assert line.changes == [{"field": "email_verified", "from": "pendente", "to": "validado"}]
    assert [e["data"] for e in events] == [{"fields": ["email_verified"], "via": "link"}]
    # Aberto de novo (outra aba, o e-mail no celular): a mesma resposta, sem mudar nada.
    r = await client.post(f"{API}/auth/verify-email", json={"token": raw})
    assert (r.status_code, r.json()) == (200, {"email": ALFA, "kind": "check"})
    assert len(await _history(engine, tech.id)) == 1 and len(events) == 1
    # Inventado: 410 com o texto da validação.
    r = await client.post(f"{API}/auth/verify-email", json={"token": "inventado"})
    assert (r.status_code, r.json()) == (
        410,
        {"detail": account.VERIFY_LINK_GONE, "code": "LINK_GONE"},
    )
    # O link de senha não valida e-mail (e vice-versa).
    reset = await _mint_reset(engine, tech)
    assert (await client.post(f"{API}/auth/verify-email", json={"token": reset})).status_code == 410


async def test_verify_change_switches_the_login(
    client: AsyncClient, engine: AsyncEngine, mail_box: MailBox, events: list[dict[str, Any]]
) -> None:
    new = "alfa.novo@exemplo.com"
    tech = await _add_user(engine, email_pending=new, email_pending_at=datetime.now(UTC))
    # Um link de senha para o endereço antigo e um e-mail de senha ainda na fila.
    old_reset = await _mint_reset(engine, tech)
    async with _maker(engine)() as db:
        queued, _ = await mail.enqueue(
            db,
            template=EmailTemplate.PASSWORD_RESET,
            to_email=ALFA,
            user=tech.id,
            context={"name": tech.name, "origin": "self"},
        )
        assert queued is not None
        await db.commit()
    raw = await _send(
        engine,
        mail_box,
        EmailTemplate.VERIFY_EMAIL,
        to=new,
        user=tech,
        name=tech.name,
        reason="change",
    )
    assert "trocar o e-mail de acesso" in mail_box.texts()[-1]
    assert mail_box.messages[-1]["To"] == new

    r = await client.post(f"{API}/auth/verify-email", json={"token": raw})
    assert r.status_code == 200, r.text
    assert r.json() == {"email": new, "kind": "change"}
    saved = await _reload(engine, tech.id)
    assert (saved.email, saved.email_pending, saved.email_pending_at) == (new, None, None)
    assert saved.email_verified_at is not None
    assert await _login(client, new, PASSWORD) == 200
    assert await _login(client, ALFA, PASSWORD) == 401
    # O link de senha do endereço antigo caiu; o e-mail na fila vai para o login novo.
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": old_reset})
    assert r.status_code == 410
    async with _maker(engine)() as db:
        row = await db.get(EmailOutbox, queued.id)
        assert row is not None and (row.status, row.to_email) == (EmailStatus.PENDING, new)
    [line] = await _history(engine, tech.id)
    assert (line.via, line.actor_id) == ("link", tech.id)
    assert line.changes == [
        {"field": "email", "from": ALFA, "to": new},
        {"field": "email_pending", "from": new, "to": None},
        {"field": "email_verified", "from": "pendente", "to": "validado"},
    ]
    [event] = events
    assert event["data"] == {"fields": ["email", "email_pending", "email_verified"], "via": "link"}
    # Aberto de novo: a mesma resposta.
    r = await client.post(f"{API}/auth/verify-email", json={"token": raw})
    assert (r.status_code, r.json()) == (200, {"email": new, "kind": "change"})


async def test_verify_change_conflict_and_cancelled_request(
    client: AsyncClient, engine: AsyncEngine, mail_box: MailBox
) -> None:
    wanted = "disputado@exemplo.com"
    tech = await _add_user(engine, email_pending=wanted, email_pending_at=datetime.now(UTC))
    raw = await _send(
        engine,
        mail_box,
        EmailTemplate.VERIFY_EMAIL,
        to=wanted,
        user=tech,
        name=tech.name,
        reason="change",
    )
    # Antes do link, o endereço virou o login de outro cadastro.
    await _add_user(engine, email=wanted.upper(), role=UserRole.ANALYST)
    r = await client.post(f"{API}/auth/verify-email", json={"token": raw})
    assert r.status_code == 409
    assert r.json() == {"detail": account.EMAIL_IN_USE_TEXT, "code": "EMAIL_IN_USE"}
    saved = await _reload(engine, tech.id)
    assert (saved.email, saved.email_pending, saved.email_verified_at) == (ALFA, None, None)
    [line] = await _history(engine, tech.id)
    assert line.via == "link"
    assert line.changes == [{"field": "email_pending", "from": wanted, "to": None}]
    # O pedido saiu: o mesmo link não vale mais.
    r = await client.post(f"{API}/auth/verify-email", json={"token": raw})
    assert (r.status_code, r.json()["code"]) == (410, "LINK_GONE")

    # Pedido trocado por outro endereço antes do link: o link do primeiro não vale.
    other = await _add_user(
        engine,
        email="beta@exemplo.com",
        email_pending="beta.um@exemplo.com",
        email_pending_at=datetime.now(UTC),
    )
    first = await _send(
        engine,
        mail_box,
        EmailTemplate.VERIFY_EMAIL,
        to="beta.um@exemplo.com",
        user=other,
        name=other.name,
        reason="change",
    )
    async with _maker(engine)() as db:
        user = await db.get(User, other.id)
        assert user is not None
        user.email_pending = "beta.dois@exemplo.com"
        await db.commit()
    r = await client.post(f"{API}/auth/verify-email", json={"token": first})
    assert (r.status_code, r.json()["code"]) == (410, "LINK_GONE")
    assert (await _reload(engine, other.id)).email == "beta@exemplo.com"


async def _application(engine: AsyncEngine, **fields: Any) -> TechnicianApplication:
    defaults: dict[str, Any] = {
        "status": "pending",
        "full_name": "Tecnico Alfa",
        "email": ALFA,
        "phone": "(11) 99999-0000",
        "document": "12345678909",
        "city": "Cidade Exemplo",
        "state": "SP",
        "service_areas": [],
        "skills": [],
        "has_vehicle": False,
        "has_driver_license": False,
        "coverage_area": "Cidade Exemplo",
        "availability": [],
        "privacy_consent_at": datetime.now(UTC),
        "privacy_version": "2026-11-25",
    }
    async with _maker(engine)() as db:
        application = TechnicianApplication(id=uuid.uuid4(), **{**defaults, **fields})
        db.add(application)
        await db.commit()
        return application


async def test_verify_signup_before_and_after_approval(
    client: AsyncClient, engine: AsyncEngine, mail_box: MailBox, events: list[dict[str, Any]]
) -> None:
    application = await _application(engine)
    raw = await _send(
        engine,
        mail_box,
        EmailTemplate.VERIFY_EMAIL,
        to=ALFA,
        application=application,
        name=application.full_name,
        reason="signup",
    )
    assert "Recebemos sua ficha" in mail_box.texts()[-1]
    r = await client.post(f"{API}/auth/verify-email", json={"token": raw})
    assert r.status_code == 200, r.text
    assert r.json() == {"email": ALFA, "kind": "signup"}
    async with _maker(engine)() as db:
        saved = await db.get(TechnicianApplication, application.id)
        assert saved is not None and saved.email_verified_at is not None
    assert events == [
        {
            "type": "onboarding.updated",
            "application_id": str(application.id),
            "name": "Tecnico Alfa",
            "data": {"action": "email_verified"},
            "audience": {"managers_only": True},
        }
    ]
    r = await client.post(f"{API}/auth/verify-email", json={"token": raw})
    assert (r.status_code, r.json()) == (200, {"email": ALFA, "kind": "signup"})
    assert len(events) == 1, "aberto de novo: nada muda"

    # A ficha já aprovada (o técnico com o mesmo e-mail, sem validar): os dois ficam validados.
    tech = await _add_user(engine, email="beta@exemplo.com")
    approved = await _application(
        engine, email="beta@exemplo.com", status="approved", user_id=tech.id
    )
    raw = await _send(
        engine,
        mail_box,
        EmailTemplate.VERIFY_EMAIL,
        to="beta@exemplo.com",
        application=approved,
        name=approved.full_name,
        reason="signup",
    )
    r = await client.post(f"{API}/auth/verify-email", json={"token": raw})
    assert (r.status_code, r.json()) == (200, {"email": "beta@exemplo.com", "kind": "signup"})
    assert (await _reload(engine, tech.id)).email_verified_at is not None
    [line] = await _history(engine, tech.id)
    assert (line.via, line.changes) == (
        "link",
        [{"field": "email_verified", "from": "pendente", "to": "validado"}],
    )
    assert [e["type"] for e in events[1:]] == ["profile.changed", "onboarding.updated"]


async def test_link_routes_limit_by_ip(client: AsyncClient) -> None:
    for _ in range(10):
        body = {"token": "inventado"}
        assert (await client.post(f"{API}/auth/verify-email", json=body)).status_code == 410
        assert (await client.post(f"{API}/auth/password-reset/check", json=body)).status_code == 410
        r = await client.post(f"{API}/auth/password-reset", json={**body, "password": NEW_PASSWORD})
        assert r.status_code == 410
    blocked = await client.post(f"{API}/auth/verify-email", json={"token": "inventado"})
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) > 0
