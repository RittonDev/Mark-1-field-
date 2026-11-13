"""Respostas de erro e endurecimento HTTP: 500 com CORS e em JSON, erro de banco legível,
validação em português, registro repetido com motivo, limite de corpo, cabeçalhos e logs."""

import logging

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy.exc import DataError

from app.core.config import Settings, settings
from app.main import INTERNAL_ERROR, RedactTokens
from app.services import company as company_svc
from tests.conftest import World, requires_db

API = settings.API_PREFIX


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
