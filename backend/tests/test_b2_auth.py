"""Login e sessões: bcrypt fora do laço de eventos, refresh de uso único com a sessão no servidor,
sair encerrando a sessão, bloqueio de tentativas por origem e a gestão de acessos em Usuários."""

import threading
import time
from datetime import timedelta
from uuid import UUID

import bcrypt
import jwt
import pytest
from httpx import ASGITransport, AsyncClient

from app.core import sessions
from app.core.config import settings
from app.core.security import create_refresh_token, create_token, decode_token
from app.main import app
from app.services import login_guard
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX
PASSWORD = "senha-teste-123"


def old_access(user_id: UUID, role: str) -> dict[str, str]:
    """Access emitido há 10 s: a revogação compara segundos inteiros, e um token do mesmo
    segundo da troca de senha ainda valeria."""
    now = int(time.time())
    payload = {"sub": str(user_id), "typ": "access", "role": role, "iat": now - 10}
    payload["exp"] = now + 3600
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    return {"Authorization": f"Bearer {token}"}


def bearer(tokens: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def login(client: AsyncClient, email: str, password: str = PASSWORD) -> dict:
    r = await client.post(
        f"{API}/auth/login", json={"email": email, "password": password, "channel": "web"}
    )
    assert r.status_code == 200, r.text
    return r.json()


async def test_bcrypt_runs_off_the_event_loop(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O bcrypt (~0,2 s) roda numa thread: login e troca de senha não congelam a API inteira."""
    on_main: list[bool] = []
    real_check, real_hash = bcrypt.checkpw, bcrypt.hashpw

    def checkpw(password: bytes, hashed: bytes) -> bool:
        on_main.append(threading.current_thread() is threading.main_thread())
        return real_check(password, hashed)

    def hashpw(password: bytes, salt: bytes) -> bytes:
        on_main.append(threading.current_thread() is threading.main_thread())
        return real_hash(password, salt)

    monkeypatch.setattr(bcrypt, "checkpw", checkpw)
    monkeypatch.setattr(bcrypt, "hashpw", hashpw)

    tokens = await login(client, "analista@teste.com.br")
    wrong = await client.post(
        f"{API}/auth/login", json={"email": "analista@teste.com.br", "password": "errada"}
    )
    assert wrong.status_code == 401
    changed = await client.post(
        f"{API}/auth/change-password",
        json={"current_password": PASSWORD, "new_password": "outra-senha-forte"},
        headers=bearer(tokens),
    )
    assert changed.status_code == 200, changed.text
    created = await client.post(
        f"{API}/technicians",
        json={"name": "Técnico Novo", "email": "novo.tecnico@teste.com.br"},
        headers=world.supervisor.headers,
    )
    assert created.status_code == 201, created.text
    assert on_main and not any(on_main)


async def test_refresh_is_single_use_and_a_copied_token_ends_the_session(
    client: AsyncClient, world: World
) -> None:
    first = await login(client, "analista@teste.com.br")
    r1 = first["refresh_token"]
    renewed = await client.post(f"{API}/auth/refresh", json={"refresh_token": r1})
    assert renewed.status_code == 200, renewed.text
    second = renewed.json()
    p1, p2 = decode_token(r1, "refresh"), decode_token(second["refresh_token"], "refresh")
    # A sessão e a hora do login seguem nas renovações; o id de uso único muda.
    assert (p2["sid"], p2["auth_time"]) == (p1["sid"], p1["auth_time"])
    assert p2["jti"] != p1["jti"]

    # A resposta se perdeu e o mesmo refresh voltou logo: par novo, da mesma sessão.
    retry = await client.post(f"{API}/auth/refresh", json={"refresh_token": r1})
    assert retry.status_code == 200, retry.text
    assert decode_token(retry.json()["refresh_token"], "refresh")["sid"] == p1["sid"]

    # O refresh volta bem depois de usado (foi copiado): a sessão inteira é encerrada.
    r2 = second["refresh_token"]
    await sessions.use_refresh(sessions.refresh_id(p2, r2), 3600, at=0.0)
    copied = await client.post(f"{API}/auth/refresh", json={"refresh_token": r2})
    assert copied.status_code == 401
    assert copied.json()["detail"] == "Sessão encerrada por segurança. Entre novamente."
    assert (await client.get(f"{API}/auth/me", headers=bearer(second))).status_code == 401
    again = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": retry.json()["refresh_token"]}
    )
    assert again.status_code == 401

    # Outro login (outra sessão) segue normal.
    other = await login(client, "analista@teste.com.br")
    assert (await client.get(f"{API}/auth/me", headers=bearer(other))).status_code == 200


async def test_session_has_a_maximum_age_and_old_tokens_move_to_sessions(
    client: AsyncClient, world: World
) -> None:
    user_id = str(world.analyst.user.id)
    too_old = create_refresh_token(
        user_id, "web", auth_time=int(time.time()) - (settings.SESSION_MAX_DAYS + 1) * 86400
    )
    r = await client.post(f"{API}/auth/refresh", json={"refresh_token": too_old})
    assert r.status_code == 401

    # Refresh de antes das sessões (sem jti nem sid): renova e já volta no formato novo.
    legacy = create_token(user_id, "refresh", timedelta(days=30), {"ch": "web"})
    r = await client.post(f"{API}/auth/refresh", json={"refresh_token": legacy})
    assert r.status_code == 200, r.text
    payload = decode_token(r.json()["refresh_token"], "refresh")
    assert payload["sid"] and payload["jti"] and payload["auth_time"]


async def test_logout_ends_the_session_on_the_server(client: AsyncClient, world: World) -> None:
    tokens = await login(client, "analista@teste.com.br")
    r = await client.post(f"{API}/auth/logout", json={"refresh_token": tokens["refresh_token"]})
    assert r.status_code == 204
    refresh = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert refresh.status_code == 401
    assert (await client.get(f"{API}/auth/me", headers=bearer(tokens))).status_code == 401
    # Token vencido ou inválido: nada a encerrar, e sair nunca falha.
    garbage = await client.post(f"{API}/auth/logout", json={"refresh_token": "x.y.z"})
    assert garbage.status_code == 204


async def test_lockout_is_per_origin_and_inactive_accounts_get_a_clear_message(
    client: AsyncClient, world: World
) -> None:
    email = "tecnico@teste.com.br"
    body = {"email": email, "password": "errada"}
    for _ in range(login_guard.MAX_PER_ACCOUNT):
        assert (await client.post(f"{API}/auth/login", json=body)).status_code == 401
    right = {"email": email, "password": PASSWORD}
    assert (await client.post(f"{API}/auth/login", json=right)).status_code == 429
    # Quem errou de propósito trancou só a origem dele: o dono entra do computador dele.
    other_ip = AsyncClient(
        transport=ASGITransport(app=app, client=("10.0.0.2", 4321)), base_url="http://test"
    )
    async with other_ip:
        assert (await other_ip.post(f"{API}/auth/login", json=right)).status_code == 200

    # Senha certa de conta desativada: diz o motivo; senha errada continua 401.
    r = await client.patch(
        f"{API}/technicians/{world.tech_other.user.id}",
        json={"is_active": False},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    inactive = {"email": "redes@teste.com.br", "password": PASSWORD}
    r = await client.post(f"{API}/auth/login", json=inactive)
    assert r.status_code == 403 and "desativado" in r.json()["detail"]
    inactive["password"] = "errada"
    assert (await client.post(f"{API}/auth/login", json=inactive)).status_code == 401

    # Texto enorme no e-mail não vira chave de contagem: recusado na validação, em português.
    huge = await client.post(f"{API}/auth/login", json={"email": "a" * 300, "password": "x"})
    assert huge.status_code == 422
    assert huge.json()["detail"][0]["msg"] == "No máximo 255 caracteres"


async def test_password_change_has_a_limit_on_wrong_attempts(
    client: AsyncClient, world: World
) -> None:
    url = f"{API}/auth/change-password"
    body = {"current_password": "errada", "new_password": "nova-senha-forte"}
    for _ in range(login_guard.MAX_PASSWORD_CHANGE):
        r = await client.post(url, json=body, headers=world.analyst.headers)
        assert r.status_code == 422 and r.json()["detail"] == "Senha atual incorreta"
    body["current_password"] = PASSWORD
    blocked = await client.post(url, json=body, headers=world.analyst.headers)
    assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) > 0
    assert "trocar a senha" in blocked.json()["detail"]


async def test_admin_password_change_ends_the_user_sessions(
    client: AsyncClient, world: World
) -> None:
    analyst = world.analyst.user
    headers = old_access(analyst.id, "analyst")
    assert (await client.get(f"{API}/auth/me", headers=headers)).status_code == 200
    url = f"{API}/users/{analyst.id}"
    r = await client.patch(url, json={"password": "nova-senha-123"}, headers=world.admin.headers)
    assert r.status_code == 200, r.text
    assert (await client.get(f"{API}/auth/me", headers=headers)).status_code == 401
    assert (await login(client, "analista@teste.com.br", "nova-senha-123"))["user"]["id"]

    # null num campo obrigatório (formulário vazio) não apaga nem quebra: fica como está.
    r = await client.patch(url, json={"name": None, "role": None}, headers=world.admin.headers)
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["role"]) == ("Analista", "analyst")

    # Técnico com senha definida pela central troca no próximo acesso ao app.
    tech = world.tech.user
    r = await client.patch(
        f"{API}/users/{tech.id}", json={"password": "provisoria-123"}, headers=world.admin.headers
    )
    assert r.status_code == 200 and r.json()["must_change_password"] is True
    created = await client.post(
        f"{API}/users",
        json={
            "name": "Técnico Direto",
            "email": "direto@teste.com.br",
            "password": "provisoria-123",
            "role": "technician",
        },
        headers=world.admin.headers,
    )
    assert created.status_code == 201, created.text
    assert created.json()["must_change_password"] is True


async def test_supervisor_manages_analysts_and_portal_users_only(
    client: AsyncClient, world: World
) -> None:
    sup = world.supervisor.headers
    analyst = await client.post(
        f"{API}/users",
        json={
            "name": "Analista Nova",
            "email": "analista.nova@teste.com.br",
            "password": "senha-forte-123",
            "role": "analyst",
        },
        headers=sup,
    )
    assert analyst.status_code == 201, analyst.text
    portal = await client.post(
        f"{API}/users",
        json={
            "name": "Gerente da Loja",
            "email": "gerente@cliente.com.br",
            "password": "senha-forte-123",
            "role": "requester",
            "customer_id": world.customer_id,
        },
        headers=sup,
    )
    assert portal.status_code == 201, portal.text
    admin = await client.post(
        f"{API}/users",
        json={
            "name": "Outro Admin",
            "email": "outro.admin@teste.com.br",
            "password": "senha-forte-123",
            "role": "admin",
        },
        headers=sup,
    )
    assert admin.status_code == 403
    # Não promove analista a gestor nem mexe em quem é admin ou supervisor.
    promote = await client.patch(
        f"{API}/users/{analyst.json()['id']}", json={"role": "supervisor"}, headers=sup
    )
    assert promote.status_code == 403
    edit_admin = await client.patch(
        f"{API}/users/{world.admin.user.id}", json={"name": "Trocado"}, headers=sup
    )
    assert edit_admin.status_code == 403
    # O analista não cuida de usuários (técnicos ficam em Técnicos).
    denied = await client.post(
        f"{API}/users",
        json={
            "name": "Mais Um",
            "email": "mais.um@teste.com.br",
            "password": "senha-forte-123",
            "role": "analyst",
        },
        headers=world.analyst.headers,
    )
    assert denied.status_code == 403
