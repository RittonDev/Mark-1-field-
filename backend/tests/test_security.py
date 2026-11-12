"""Robustez e segurança: bloqueio de tentativa e erro no login, download de anexos sem rodar
código, cabeçalhos de segurança e tokens fora dos logs."""

import logging
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.core.config import settings
from app.main import RedactTokens
from app.services import login_guard
from tests.conftest import World, requires_db
from tests.test_api import create

API = settings.API_PREFIX
PASSWORD = "senha-teste-123"


async def _login(client: AsyncClient, email: str, password: str) -> int:
    r = await client.post(f"{API}/auth/login", json={"email": email, "password": password})
    return r.status_code


@requires_db
async def test_login_blocks_after_repeated_wrong_passwords(client: AsyncClient, world: World) -> None:
    email = "tecnico@teste.com.br"
    # Acertar antes do limite zera a contagem.
    for _ in range(login_guard.MAX_PER_ACCOUNT - 1):
        assert await _login(client, email, "errada") == 401
    assert await _login(client, email, PASSWORD) == 200
    for _ in range(login_guard.MAX_PER_ACCOUNT - 1):
        assert await _login(client, email, "errada") == 401
    assert await _login(client, email, PASSWORD) == 200

    # Passou do limite: bloqueia até mesmo a senha certa, com o tempo de espera.
    for _ in range(login_guard.MAX_PER_ACCOUNT):
        assert await _login(client, email, "errada") == 401
    r = await client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 429
    assert "Muitas tentativas" in r.json()["detail"]
    assert int(r.headers["retry-after"]) > 0

    # Outras contas seguem entrando; e-mail inexistente também é contado (não revela quem existe).
    assert await _login(client, "analista@teste.com.br", PASSWORD) == 200
    for _ in range(login_guard.MAX_PER_ACCOUNT):
        assert await _login(client, "ninguem@teste.com.br", "x") == 401
    assert await _login(client, "ninguem@teste.com.br", "x") == 429


@requires_db
async def test_downloads_do_not_run_code(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    t = await create(client, world, assignee_id=str(world.tech.user.id))

    async def upload(name: str, content: bytes, content_type: str) -> dict:
        r = await client.post(
            f"{API}/tickets/{t['id']}/attachments",
            files={"file": (name, content, content_type)},
            data={"kind": "file"},
            headers=world.analyst.headers,
        )
        assert r.status_code == 201, r.text
        return r.json()

    svg = await upload("desenho.svg", b"<svg onload='alert(1)'/>", "image/svg+xml")
    r = await client.get(svg["download_url"].removeprefix("http://test"))
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"]

    photo = await upload("rack.jpg", b"\xff\xd8fake-jpeg", "image/jpeg")
    r = await client.get(photo["download_url"].removeprefix("http://test"))
    assert r.headers["content-disposition"].startswith("inline")
    assert "sandbox" in r.headers["content-security-policy"]


@requires_db
async def test_security_headers_on_api_responses(client: AsyncClient, world: World) -> None:
    r = await client.get(f"{API}/auth/me", headers=world.analyst.headers)
    assert r.status_code == 200
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["referrer-policy"] == "no-referrer"


def test_tokens_are_redacted_from_logs() -> None:
    record = logging.LogRecord(
        "uvicorn.error",
        logging.INFO,
        __file__,
        1,
        '%s - "WebSocket %s" [accepted]',
        ("172.19.0.1:6099", "/api/v1/ws?token=eyJhbGciOi.abc.def&x=1"),
        None,
    )
    assert RedactTokens().filter(record)
    assert record.getMessage() == '172.19.0.1:6099 - "WebSocket /api/v1/ws?token=***&x=1" [accepted]'
