"""Respostas de erro e endurecimento HTTP: 500 com CORS e em JSON, erro de banco legível (pelo
SQLSTATE, sem os valores no log), validação em português, registro repetido com motivo, limite de
corpo, cabeçalhos e logs."""

import logging
import re

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy.exc import DataError, DBAPIError, IntegrityError

from app.core.config import Settings, settings
from app.db.session import engine as app_engine
from app.main import DATA_ERROR, INTERNAL_ERROR, RedactTokens
from app.services import company as company_svc
from tests.conftest import World, requires_db

API = settings.API_PREFIX


class _DriverError(Exception):
    """O erro do driver como o adaptador do asyncpg entrega: com o SQLSTATE em `sqlstate`."""

    def __init__(self, message: str, sqlstate: str | None) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate


@requires_db
async def test_unhandled_error_keeps_cors_and_json(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Um erro inesperado chega à web como erro (com CORS), e não como "sem conexão"."""

    async def broken(*_: object) -> None:
        raise RuntimeError("falha inesperada")

    monkeypatch.setattr(company_svc, "profile", broken)
    origin = settings.cors_origin_list[0]
    r = await client.get(
        f"{API}/settings/company", headers={**world.analyst.headers, "Origin": origin}
    )
    assert r.status_code == 500
    assert r.json() == {"detail": INTERNAL_ERROR}
    assert r.headers["access-control-allow-origin"] == origin


@requires_db
async def test_database_value_errors_are_422(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def too_long(*_: object) -> None:
        raise DataError("UPDATE x", {}, Exception("value too long for type character varying"))

    monkeypatch.setattr(company_svc, "profile", too_long)
    r = await client.get(f"{API}/settings/company", headers=world.analyst.headers)
    assert r.status_code == 422
    assert "fora do tamanho ou do formato" in r.json()["detail"]


@requires_db
async def test_database_errors_by_sqlstate(
    client: AsyncClient,
    world: World,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """O asyncpg entrega os erros de valor do banco (SQLSTATE da classe 22) como DBAPIError
    genérico: o mesmo 422 do DataError. Outro SQLSTATE (ou nenhum) segue como erro não tratado:
    500 "Erro interno" com CORS e o mesmo log. IntegrityError e DataError seguem nos deles."""
    origin = settings.cors_origin_list[0]
    headers = {**world.analyst.headers, "Origin": origin}
    url = f"{API}/settings/company"
    raised: list[Exception] = []

    async def broken(*_: object) -> None:
        raise raised[-1]

    monkeypatch.setattr(company_svc, "profile", broken)

    for sqlstate in ("22001", "22P05"):
        raised.append(DBAPIError("UPDATE x", {}, _DriverError("valor recusado", sqlstate)))
        r = await client.get(url, headers=headers)
        assert (r.status_code, r.json()) == (422, {"detail": DATA_ERROR}), sqlstate
        assert r.headers["access-control-allow-origin"] == origin

    for sqlstate in ("57014", "23505", None):
        raised.append(DBAPIError("SELECT x", {}, _DriverError("outro erro", sqlstate)))
        caplog.clear()
        with caplog.at_level(logging.INFO):
            r = await client.get(url, headers=headers)
        assert (r.status_code, r.json()) == (500, {"detail": INTERNAL_ERROR}), sqlstate
        assert r.headers["access-control-allow-origin"] == origin
        [record] = [rec for rec in caplog.records if rec.name == "maxxchamados"]
        assert (record.levelno, record.getMessage()) == (
            logging.ERROR,
            f"Erro não tratado em GET {url}",
        )
        assert record.exc_info is not None and record.exc_info[1] is raised[-1]

    duplicate = Exception('duplicate key value violates unique constraint "uq_teams_name"')
    raised.append(IntegrityError("INSERT x", {}, duplicate))
    r = await client.get(url, headers=headers)
    assert (r.status_code, r.json()) == (409, {"detail": "Já existe um grupo com este nome"})
    raised.append(DataError("UPDATE x", {}, _DriverError("valor recusado", "57014")))
    r = await client.get(url, headers=headers)
    assert (r.status_code, r.json()) == (422, {"detail": DATA_ERROR})


@requires_db
async def test_nul_in_a_text_is_422_and_saves_nothing(client: AsyncClient, world: World) -> None:
    """U+0000 num texto que vai ao banco como está (a região que atende): o Postgres recusa
    (SQLSTATE 22021, DBAPIError genérico no asyncpg) e a resposta é o 422 de valor fora do
    formato, não o 500, sem gravar nada."""
    me = f"{API}/me/profile"
    r = await client.patch(me, json={"coverage_area": "Zona\u0000Sul"}, headers=world.tech.headers)
    assert (r.status_code, r.json()) == (422, {"detail": DATA_ERROR})
    assert (await client.get(me, headers=world.tech.headers)).json()["coverage_area"] is None


def test_database_errors_hide_the_values() -> None:
    """O erro do banco (e o log dele) não leva os valores do SQL: nome, contato, formação, PIX."""
    assert app_engine.sync_engine.hide_parameters is True


@requires_db
async def test_validation_messages_in_portuguese(client: AsyncClient, world: World) -> None:
    r = await client.post(
        f"{API}/portal/requests",
        json={"location_id": world.location_id, "title": "ab"},
        headers=world.requester.headers,
    )
    assert r.status_code == 422
    issue = r.json()["detail"][0]
    # O formato de sempre ({loc, msg, type}), com o texto em português e o nome do campo.
    assert issue["loc"] == ["body", "title"]
    assert issue["msg"] == "Informe pelo menos 3 caracteres"
    assert issue["label"] == "Título"
    assert "input" not in issue  # o valor enviado não volta (nem senha, nem arquivo)

    r = await client.post(
        f"{API}/portal/requests", json={"title": "Sem loja"}, headers=world.requester.headers
    )
    assert r.json()["detail"][0]["msg"] == "Campo obrigatório"
    r = await client.get(f"{API}/tickets/nao-e-um-id", headers=world.analyst.headers)
    assert r.status_code == 422
    assert r.json()["detail"][0]["msg"] == "Identificador inválido"
    # Campos do login e dos cadastros também vêm com o nome que a pessoa vê (o app mostra).
    r = await client.post(
        f"{API}/auth/change-password",
        json={"current_password": "qualquer", "new_password": "curta"},
        headers=world.tech.headers,
    )
    issue = r.json()["detail"][0]
    assert (issue["msg"], issue["label"]) == ("Informe pelo menos 8 caracteres", "Nova senha")


@requires_db
async def test_duplicate_records_say_what_repeated(client: AsyncClient, world: World) -> None:
    from app.core.documents import cnpj_with_check_digits

    body = {"name": "Rede Exemplo", "document": cnpj_with_check_digits("112223330001")}
    first = await client.post(f"{API}/customers", json=body, headers=world.analyst.headers)
    assert first.status_code == 201, first.text
    again = await client.post(
        f"{API}/customers", json={**body, "name": "Outra"}, headers=world.analyst.headers
    )
    assert again.status_code == 409
    assert again.json()["detail"] == "Já existe um cliente com este CPF/CNPJ"


@requires_db
async def test_body_size_limit(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MAX_UPLOAD_MB", 1)
    big = b"x" * (3 * 1024 * 1024)
    # Com o tamanho declarado: recusado antes de ler o corpo.
    r = await client.post(
        f"{API}/auth/login", content=big, headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 413
    assert r.json()["detail"] == "Arquivo ou envio maior que 1 MB"

    # Sem o tamanho declarado (envio em partes): conta os bytes enquanto lê.
    async def chunks():  # noqa: ANN202
        for _ in range(3):
            yield b"x" * (1024 * 1024)

    r = await client.post(
        f"{API}/auth/login", content=chunks(), headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 413


@requires_db
async def test_security_headers(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    r = await client.get(f"{API}/auth/me", headers=world.analyst.headers)
    assert r.headers["cache-control"] == "no-store"
    assert "strict-transport-security" not in r.headers
    public = await client.get(f"{API}/public/onboarding/catalog")
    assert public.headers["x-robots-tag"] == "noindex, nofollow"
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    r = await client.get(f"{API}/auth/me", headers=world.analyst.headers)
    assert r.headers["strict-transport-security"].startswith("max-age=")


def test_public_link_tokens_are_redacted_from_logs() -> None:
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/1.1" %d',
        ("10.0.0.1:5000", "POST", "/api/v1/public/quotes/AbC123.sig-xyz/approve", 200),
        None,
    )
    assert RedactTokens().filter(record)
    assert "AbC123" not in record.getMessage()
    assert "/api/v1/public/quotes/***/approve" in record.getMessage()
    catalog = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        "GET /api/v1/public/onboarding/catalog",
        None,
        None,
    )
    assert RedactTokens().filter(catalog)
    assert catalog.getMessage() == "GET /api/v1/public/onboarding/catalog"


def test_production_settings_refuse_open_cors() -> None:
    with pytest.raises(ValidationError):
        Settings(ENVIRONMENT="production", JWT_SECRET="s" * 40, CORS_ORIGINS="*")
    ok = Settings(
        ENVIRONMENT="production", JWT_SECRET="s" * 40, CORS_ORIGINS="https://app.exemplo.com"
    )
    assert ok.cors_origin_list == ["https://app.exemplo.com"]
    # Produção: só a lista. Desenvolvimento: também localhost e a rede local, nunca a internet.
    assert ok.cors_origin_regex is None
    dev = Settings(ENVIRONMENT="development")
    pattern = re.compile(dev.cors_origin_regex or "")
    for origin in ("http://192.168.15.6:8081", "http://10.0.0.5:8081", "http://localhost:8081"):
        assert pattern.fullmatch(origin), origin
    for origin in ("https://exemplo.com", "http://192.168.15.6.exemplo.com", "http://8.8.8.8"):
        assert not pattern.fullmatch(origin), origin
