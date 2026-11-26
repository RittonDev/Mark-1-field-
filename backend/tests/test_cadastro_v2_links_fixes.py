"""Correções da revisão nos links do e-mail, na fila e nos logs do banco (Cadastro V2).

- Impasse entre o link (trava o token e depois o técnico) e o app ou a central (travam o técnico e
  depois os tokens): a rota do link repete uma vez e responde 200 ou 410, nunca 500; o impasse em
  qualquer outra rota é 503 "Outra gravação ao mesmo tempo. Tente de novo", sem traceback.
- Link de senha na fila: sem acesso ao app, vence sem sair; pedido de antes da troca de senha, a
  nova senha vence e a boas-vindas sai sem o link de criar senha.
- Logs dos erros do banco: só o nome da restrição e o SQLSTATE (nunca o valor).
- O primeiro nome que não é nome não volta na conferência do link.

Os impasses são de verdade: uma sessão faz o papel do app ou da central (trava o técnico), a rota
do link chega e espera, e só então a outra sessão pede a linha do link. O banco desfaz o lado que
esperou primeiro: o do link. Dados fictícios.
"""

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import select, text, update
from sqlalchemy.exc import DataError, DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

import app.main as app_main
from app.api.routes import auth as auth_routes
from app.core.config import settings
from app.core.enums import AccountTokenPurpose, EmailStatus, EmailTemplate, UserRole
from app.core.security import create_access_token, hash_password
from app.models import AccountToken, EmailOutbox, User, UserChange
from app.services import account, mail
from app.services import company as company_svc
from tests.conftest import MailBox, World, requires_db

API = settings.API_PREFIX
PASSWORD = "senha-teste-123"
NEW_PASSWORD = "nova-senha-456"
ALFA = "tecnico.alfa@exemplo.com"
CPF = "12345678909"


class _DriverError(Exception):
    """O erro do driver como o adaptador do asyncpg entrega: com o SQLSTATE em `sqlstate`."""

    def __init__(self, message: str, sqlstate: str | None) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate


def _maker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def _add_user(engine: AsyncEngine, email: str = ALFA, **fields: Any) -> User:
    async with _maker(engine)() as db:
        user = User(
            id=uuid.uuid4(),
            password_hash=hash_password(PASSWORD),
            role=UserRole.TECHNICIAN,
            email=email,
            **{"name": "Tecnico Alfa", "is_active": True, **fields},
        )
        db.add(user)
        await db.commit()
        return user


async def _reload(engine: AsyncEngine, user_id: uuid.UUID) -> User:
    async with _maker(engine)() as db:
        user = await db.get(User, user_id)
        assert user is not None
        return user


async def _mint(
    engine: AsyncEngine,
    user: User,
    purpose: AccountTokenPurpose = AccountTokenPurpose.RESET_PASSWORD,
    *,
    email: str | None = None,
    reason: str = "self",
) -> tuple[str, uuid.UUID]:
    """Um link como o do e-mail (o token cru e o id da linha)."""
    async with _maker(engine)() as db:
        raw = await account.mint(
            db,
            purpose=purpose,
            email=email or user.email,
            user=user.id,
            reason=reason,
            hours=account.RESET_HOURS,
        )
        await db.commit()
        token_id = await db.scalar(
            select(AccountToken.id).where(AccountToken.token_hash == account.hash_token(raw))
        )
    assert token_id is not None
    return raw, token_id


async def _history(engine: AsyncEngine, user_id: uuid.UUID) -> list[UserChange]:
    async with _maker(engine)() as db:
        return list(
            await db.scalars(
                select(UserChange)
                .where(UserChange.user_id == user_id)
                .order_by(UserChange.created_at, UserChange.id)
            )
        )


async def _login(client: AsyncClient, email: str, password: str) -> httpx.Response:
    return await client.post(
        f"{API}/auth/login", json={"email": email, "password": password, "channel": "mobile"}
    )


def _bearer(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.role.value)}"}


def _count(monkeypatch: pytest.MonkeyPatch, module: object, name: str) -> list[int]:
    """Conta as chamadas da função assíncrona `module.name` (a rota a chama pelo módulo)."""
    calls: list[int] = []
    real = getattr(module, name)

    async def counted(*args: Any, **kwargs: Any) -> Any:
        calls.append(1)
        return await real(*args, **kwargs)

    monkeypatch.setattr(module, name, counted)
    return calls


def _errors(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]


# ------------------------------------------------------------------ impasse nos links


async def _until_link_waits(engine: AsyncEngine) -> None:
    """Espera (até 10 s) a rota do link parar na trava do técnico (SELECT ... FROM users ... FOR
    UPDATE esperando a outra sessão)."""
    deadline = time.monotonic() + 10
    async with engine.connect() as conn:
        while True:
            waiting = await conn.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                    "AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' "
                    "AND query ILIKE :pattern"
                ),
                {"pattern": "%FROM users%FOR UPDATE%"},
            )
            # O pg_stat_activity fica fixo dentro de uma transação: a próxima leitura é outra.
            await conn.rollback()
            if waiting:
                return
            assert time.monotonic() < deadline, "a rota do link não chegou a esperar o técnico"
            await asyncio.sleep(0.02)


async def _collide(
    engine: AsyncEngine,
    user_id: uuid.UUID,
    link: Callable[[], Awaitable[httpx.Response]],
    other_side: Callable[[AsyncSession], Awaitable[None]],
) -> httpx.Response:
    """A outra gravação trava o técnico (como my_profile.lock ou technician_status._locked); a
    rota do link chega, trava o link e espera o técnico; aí a outra gravação pede a linha do link
    (`other_side`) e grava. O banco desfaz o lado que esperou primeiro (o do link), e a rota
    repete. Devolve a resposta da rota."""
    async with _maker(engine)() as other:
        await other.execute(select(User).where(User.id == user_id).with_for_update())
        task = asyncio.create_task(link())
        try:
            await _until_link_waits(engine)
            await other_side(other)
            await other.commit()
        finally:
            await other.rollback()  # depois do commit não faz nada; numa falha, solta a trava
            response = await asyncio.wait_for(task, timeout=30)
    return response


async def test_verify_link_colliding_with_the_app_is_retried(
    client: AsyncClient,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """O técnico abre o link da troca de e-mail enquanto o app cancela o pedido (trava o técnico
    e revoga o link): 410 do link revogado, não o 500 do impasse."""
    now = datetime.now(UTC)
    wanted = "alfa.novo@exemplo.com"
    user = await _add_user(engine, email_verified_at=now, email_pending=wanted, email_pending_at=now)
    raw, _ = await _mint(
        engine, user, AccountTokenPurpose.VERIFY_EMAIL, email=wanted, reason="change"
    )
    attempts = _count(monkeypatch, auth_routes, "_link_attempt")
    calls = _count(monkeypatch, account, "verify_email")
    caplog.set_level(logging.INFO)

    async def cancel_the_change(other: AsyncSession) -> None:
        # my_profile.cancel_email_change: revoga os links do pedido e limpa o pedido.
        await account.revoke(
            other, user_id=user.id, purpose=AccountTokenPurpose.VERIFY_EMAIL, email=wanted
        )
        await other.execute(
            update(User)
            .where(User.id == user.id)
            .values(email_pending=None, email_pending_at=None)
            .execution_options(synchronize_session=False)
        )

    r = await _collide(
        engine,
        user.id,
        lambda: client.post(f"{API}/auth/verify-email", json={"token": raw}),
        cancel_the_change,
    )
    assert (r.status_code, r.json()) == (
        410,
        {"detail": account.VERIFY_LINK_GONE, "code": "LINK_GONE"},
    )
    assert len(calls) == 2, "o impasse desfez a 1ª vez e a rota repetiu"
    assert len(attempts) == 1, "o limite do IP contou uma vez só"
    assert "Link do e-mail: outra gravação ao mesmo tempo, repetindo uma vez" in caplog.text
    assert _errors(caplog) == []
    saved = await _reload(engine, user.id)
    assert (saved.email, saved.email_pending) == (ALFA, None)


async def test_reset_link_colliding_with_the_central_is_retried(
    client: AsyncClient,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """"Salvar senha" no mesmo instante em que a central corta o acesso (trava o técnico e revoga
    os links de senha): 410, e a senha não muda."""
    user = await _add_user(engine, email_verified_at=datetime.now(UTC))
    raw, _ = await _mint(engine, user)
    attempts = _count(monkeypatch, auth_routes, "_link_attempt")
    calls = _count(monkeypatch, account, "reset_password")
    caplog.set_level(logging.INFO)

    async def cut_access(other: AsyncSession) -> None:
        # technician_status.apply com "cortar acesso".
        await other.execute(
            update(User)
            .where(User.id == user.id)
            .values(is_active=False, sessions_revoked_at=datetime.now(UTC))
            .execution_options(synchronize_session=False)
        )
        await account.revoke(other, user_id=user.id, purpose=AccountTokenPurpose.RESET_PASSWORD)

    r = await _collide(
        engine,
        user.id,
        lambda: client.post(
            f"{API}/auth/password-reset", json={"token": raw, "password": NEW_PASSWORD}
        ),
        cut_access,
    )
    assert (r.status_code, r.json()) == (
        410,
        {"detail": account.RESET_LINK_GONE, "code": "LINK_GONE"},
    )
    assert (len(calls), len(attempts)) == (2, 1)
    assert _errors(caplog) == []
    assert (await _login(client, ALFA, NEW_PASSWORD)).status_code == 401
    assert await _history(engine, user.id) == []


async def test_reset_link_retry_saves_the_password(
    client: AsyncClient,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A outra gravação passa pela linha do link sem mudar nada: a repetição grava a senha, o
    histórico sai uma vez e o login destrava."""
    user = await _add_user(engine, email_verified_at=datetime.now(UTC))
    raw, token_id = await _mint(engine, user)
    calls = _count(monkeypatch, account, "reset_password")
    caplog.set_level(logging.INFO)

    async def touch_the_link(other: AsyncSession) -> None:
        await other.execute(
            update(AccountToken)
            .where(AccountToken.id == token_id)
            .values(created_by_id=AccountToken.created_by_id)
            .execution_options(synchronize_session=False)
        )

    r = await _collide(
        engine,
        user.id,
        lambda: client.post(
            f"{API}/auth/password-reset", json={"token": raw, "password": NEW_PASSWORD}
        ),
        touch_the_link,
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"email": ALFA, "app_url": settings.tech_app_url}
    assert len(calls) == 2
    assert _errors(caplog) == []
    assert (await _login(client, ALFA, NEW_PASSWORD)).status_code == 200
    [line] = await _history(engine, user.id)
    assert line.changes == [
        {"field": "password", "from": None, "to": "redefinida pelo link do e-mail"}
    ]
    async with _maker(engine)() as db:
        token = await db.get(AccountToken, token_id)
        assert token is not None and token.used_at is not None


async def test_link_routes_answer_503_when_the_retry_collides_again(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Repetiu e bateu de novo: o erro segue para o main, que responde 503 com o texto curto (sem
    traceback nem o texto do banco no log)."""
    calls: list[str] = []

    def colliding(sqlstate: str) -> Callable[..., Awaitable[Any]]:
        async def collide(*_: Any, **__: Any) -> Any:
            calls.append(sqlstate)
            raise DBAPIError("UPDATE x", {}, _DriverError("deadlock detected", sqlstate))

        return collide

    monkeypatch.setattr(account, "reset_password", colliding("40P01"))
    monkeypatch.setattr(account, "verify_email", colliding("40001"))
    attempts = _count(monkeypatch, auth_routes, "_link_attempt")
    caplog.set_level(logging.INFO)
    r = await client.post(
        f"{API}/auth/password-reset", json={"token": "qualquer", "password": NEW_PASSWORD}
    )
    assert (r.status_code, r.json()) == (503, {"detail": app_main.CONCURRENT_WRITE})
    r = await client.post(f"{API}/auth/verify-email", json={"token": "qualquer"})
    assert (r.status_code, r.json()) == (503, {"detail": app_main.CONCURRENT_WRITE})
    assert calls == ["40P01", "40P01", "40001", "40001"]
    assert len(attempts) == 2
    assert _errors(caplog) == []
    warnings = [r.getMessage() for r in caplog.records if r.name == "maxxchamados"]
    assert warnings == [
        f"Gravação desfeita pelo banco (SQLSTATE 40P01) em POST {API}/auth/password-reset",
        f"Gravação desfeita pelo banco (SQLSTATE 40001) em POST {API}/auth/verify-email",
    ]
    assert "deadlock detected" not in caplog.text


async def test_deadlock_in_any_route_is_503_without_traceback(
    client: AsyncClient,
    world: World,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def collide(*_: object) -> None:
        raise DBAPIError("UPDATE x", {}, _DriverError("deadlock detected", "40P01"))

    monkeypatch.setattr(company_svc, "profile", collide)
    origin = settings.cors_origin_list[0]
    caplog.set_level(logging.INFO)
    r = await client.get(
        f"{API}/settings/company", headers={**world.analyst.headers, "Origin": origin}
    )
    assert (r.status_code, r.json()) == (503, {"detail": app_main.CONCURRENT_WRITE})
    assert r.headers["access-control-allow-origin"] == origin
    [record] = [rec for rec in caplog.records if rec.name == "maxxchamados"]
    assert (record.levelno, record.exc_info) == (logging.WARNING, None)
    assert record.getMessage() == (
        f"Gravação desfeita pelo banco (SQLSTATE 40P01) em GET {API}/settings/company"
    )


# ------------------------------------------------------------------ logs dos erros do banco


async def test_integrity_log_names_the_constraint_without_the_value(
    engine: AsyncEngine, caplog: pytest.LogCaptureFixture
) -> None:
    """O mesmo CPF gravado em dois cadastros ao mesmo tempo: o índice único barra, a resposta é o
    409 certo e o log fica com o nome da restrição e o SQLSTATE, sem o CPF."""
    await _add_user(engine, cpf=CPF)
    async with _maker(engine)() as db:
        db.add(
            User(
                id=uuid.uuid4(),
                name="Tecnico Beta",
                email="beta@exemplo.com",
                password_hash=hash_password(PASSWORD),
                role=UserRole.TECHNICIAN,
                is_active=True,
                cpf=CPF,
            )
        )
        with pytest.raises(IntegrityError) as caught:
            await db.commit()
        await db.rollback()
    error = caught.value
    assert CPF in str(error.orig), "o texto do banco leva o CPF (o motivo de não ir ao log)"
    caplog.clear()
    with caplog.at_level(logging.INFO):
        response = await app_main._integrity(None, error)  # type: ignore[arg-type]
    assert response.status_code == 409
    assert json.loads(response.body) == {"detail": "Este CPF já está em outro cadastro"}
    [record] = [r for r in caplog.records if r.name == "maxxchamados"]
    assert record.getMessage() == "IntegrityError: uq_users_cpf (SQLSTATE 23505)"
    assert CPF not in caplog.text


async def test_value_errors_log_only_the_sqlstate(
    engine: AsyncEngine, caplog: pytest.LogCaptureFixture
) -> None:
    """Erro de formato de verdade (o Postgres repete o valor no texto) e o DataError: o log leva só
    o SQLSTATE."""
    async with _maker(engine)() as db:
        with pytest.raises(DBAPIError) as caught:
            await db.execute(text("SELECT CAST(CAST(:value AS text) AS uuid)"), {"value": CPF})
    real = caught.value
    assert CPF in str(real.orig)
    made = DataError("UPDATE x", {}, _DriverError(f'valor "{CPF}" recusado', "22001"))
    caplog.clear()
    with caplog.at_level(logging.INFO):
        if isinstance(real, DataError):
            first = await app_main._data_error(None, real)  # type: ignore[arg-type]
        else:
            first = await app_main._dbapi_error(None, real)  # type: ignore[arg-type]
        second = await app_main._data_error(None, made)  # type: ignore[arg-type]
    assert (first.status_code, second.status_code) == (422, 422)
    kind = "DataError" if isinstance(real, DataError) else "DBAPIError"
    assert [r.getMessage() for r in caplog.records if r.name == "maxxchamados"] == [
        f"{kind} (SQLSTATE 22P02)",
        "DataError (SQLSTATE 22001)",
    ]
    assert CPF not in caplog.text


# ------------------------------------------------------------------ links de senha na fila


async def test_queued_reset_link_dies_after_the_password_changes(
    client: AsyncClient, engine: AsyncEngine, world: World, mail_box: MailBox
) -> None:
    """O roteiro da revisão: "Esqueci minha senha" com o SMTP em falha temporária; a central manda
    a senha provisória pelo WhatsApp; o técnico entra e cria a dele; o SMTP volta. O e-mail não
    sai mais (o link desfaria a senha nova) e a central vê "Não enviado"."""
    tech = world.tech.user
    async with _maker(engine)() as db:
        await db.execute(
            update(User)
            .where(User.id == tech.id)
            .values(email_verified_at=datetime.now(UTC))
            .execution_options(synchronize_session=False)
        )
        await db.commit()
    r = await client.post(f"{API}/auth/forgot-password", json={"email": tech.email})
    assert r.status_code == 202, r.text
    [row_id] = mail_box.soon
    mail_box.provider.fail = mail.MailError("SMTPDataError 451")
    async with _maker(engine)() as db:
        assert await mail.deliver_pending(db) == 0
        row = await db.get(EmailOutbox, row_id)
        assert row is not None and (row.status, row.attempts) == (EmailStatus.PENDING, 1)

    r = await client.post(f"{API}/technicians/{tech.id}/reset-password", headers=world.admin.headers)
    assert r.status_code == 200, r.text
    temporary = r.json()["temporary_password"]
    r = await _login(client, tech.email, temporary)
    assert r.status_code == 200, r.text
    mine = "minha-senha-nova-1"
    r = await client.post(
        f"{API}/auth/change-password",
        json={"current_password": temporary, "new_password": mine},
        headers={"Authorization": f"Bearer {r.json()['access_token']}"},
    )
    assert r.status_code == 200, r.text

    async with _maker(engine)() as db:
        row = await db.get(EmailOutbox, row_id)
        assert row is not None
        row.next_attempt_at = datetime.now(UTC)
        await db.commit()
        assert await mail.deliver_pending(db) == 0
        row = await db.get(EmailOutbox, row_id, populate_existing=True)
        assert row is not None
        assert (row.status, row.attempts, row.last_error) == (
            EmailStatus.EXPIRED,
            1,
            mail.REVOKED_AFTER,
        )
        assert await db.scalar(select(AccountToken)) is None, "nenhum link nasceu"
    assert mail_box.messages == []
    r = await client.get(f"{API}/technicians/{tech.id}/emails", headers=world.admin.headers)
    assert r.status_code == 200, r.text
    assert [e["status"] for e in r.json()] == ["expired"]
    assert (await _login(client, tech.email, mine)).status_code == 200


async def test_queued_password_mails_without_app_access_expire(
    engine: AsyncEngine, mail_box: MailBox
) -> None:
    """Nova senha e boas-vindas na fila e, antes de sair, o acesso ao app é cortado (por outra
    sessão): nada sai, nenhum link nasce, e não conta como tentativa."""
    async with _maker(engine)() as db:
        user = User(
            id=uuid.uuid4(),
            name="Tecnico Alfa",
            email=ALFA,
            password_hash=hash_password(PASSWORD),
            role=UserRole.TECHNICIAN,
            is_active=True,
            must_change_password=True,
            email_verified_at=datetime.now(UTC),
        )
        db.add(user)
        await db.flush()
        rows = []
        for template, context in (
            (EmailTemplate.PASSWORD_RESET, {"name": user.name, "origin": "central"}),
            (EmailTemplate.WELCOME, {"name": user.name, "email": user.email}),
        ):
            row, status = await mail.enqueue(
                db, template=template, to_email=user.email, user=user, context=context
            )
            assert row is not None and status == "queued"
            rows.append(row)
        await db.commit()
        # Só o acesso (sem mexer em sessions_revoked_at), gravado por outra sessão: o envio relê o
        # técnico do banco.
        async with engine.begin() as conn:
            await conn.execute(update(User).where(User.id == user.id).values(is_active=False))
        assert await mail.deliver_pending(db) == 0
        for row in rows:
            await db.refresh(row)
            assert (row.status, row.attempts, row.last_error) == (
                EmailStatus.EXPIRED,
                0,
                mail.NO_ACCESS,
            ), row.template
        assert await db.scalar(select(AccountToken)) is None
    assert mail_box.messages == []


async def test_welcome_after_a_temporary_password_goes_without_the_link(
    client: AsyncClient, engine: AsyncEngine, world: World, mail_box: MailBox
) -> None:
    """Aprovado sem senha (e-mail validado) e, antes de a boas-vindas sair, a central gera a senha
    provisória: a boas-vindas sai sem o link de criar senha (ele desfaria a provisória)."""
    async with _maker(engine)() as db:
        user = User(
            id=uuid.uuid4(),
            name="Tecnico Alfa",
            email=ALFA,
            password_hash=hash_password(PASSWORD),
            role=UserRole.TECHNICIAN,
            is_active=True,
            must_change_password=True,
            email_verified_at=datetime.now(UTC),
        )
        db.add(user)
        await db.flush()
        assert mail.sends_password_link(user)
        row, _ = await mail.enqueue(
            db,
            template=EmailTemplate.WELCOME,
            to_email=user.email,
            user=user,
            context={"name": user.name, "email": user.email},
        )
        assert row is not None
        await db.commit()
    r = await client.post(f"{API}/technicians/{user.id}/reset-password", headers=world.admin.headers)
    assert r.status_code == 200, r.text
    async with _maker(engine)() as db:
        assert await mail.deliver_pending(db) == 1
        assert await db.scalar(select(AccountToken)) is None
    [welcome] = mail_box.texts()
    assert "- Senha: a central manda uma senha provisória pelo WhatsApp." in welcome
    assert "#token=" not in welcome and "/definir-senha" not in welcome


async def test_new_reset_request_after_a_password_change_is_a_new_mail(
    client: AsyncClient, engine: AsyncEngine, mail_box: MailBox
) -> None:
    """O pedido que ficou na fila antes da troca de senha não sai mais: um pedido novo não se junta
    a ele (sairia vencido) e vira um e-mail novo, com o link valendo."""
    user = await _add_user(engine, email_verified_at=datetime.now(UTC))
    r = await client.post(f"{API}/auth/forgot-password", json={"email": ALFA})
    assert r.status_code == 202, r.text
    [first_id] = mail_box.soon
    mail_box.provider.fail = mail.MailError("SMTPDataError 451")
    async with _maker(engine)() as db:
        assert await mail.deliver_pending(db) == 0
    r = await client.post(
        f"{API}/auth/change-password",
        json={"current_password": PASSWORD, "new_password": NEW_PASSWORD},
        headers=_bearer(user),
    )
    assert r.status_code == 200, r.text
    r = await client.post(f"{API}/auth/forgot-password", json={"email": ALFA})
    assert r.status_code == 202, r.text
    second_id = mail_box.soon[-1]
    assert second_id != first_id
    async with _maker(engine)() as db:
        first = await db.get(EmailOutbox, first_id)
        assert first is not None
        assert (first.status, first.last_error) == (EmailStatus.EXPIRED, mail.REVOKED_AFTER)
        assert await mail.deliver_pending(db) == 1
    [raw] = mail_box.tokens()
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": raw})
    assert r.status_code == 200, r.text


# ------------------------------------------------------------------ o nome na conferência


async def test_reset_check_leaves_out_a_name_that_is_not_a_name(
    client: AsyncClient, engine: AsyncEngine
) -> None:
    user = await _add_user(
        engine, name="https://golpe.exemplo/entrar Silva", email_verified_at=datetime.now(UTC)
    )
    raw, _ = await _mint(engine, user)
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": raw})
    assert r.status_code == 200, r.text
    assert r.json() == {"email": "t***@exemplo.com", "name": "", "kind": "reset", "app_url": None}


pytestmark = requires_db
