"""Login Microsoft: convidado não entra, o login da conta vale mais que o e-mail editável,
autocadastro só como analista, chave nova da Microsoft e falha de rede voltando ao login."""

from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from httpx import AsyncClient

from app.core.config import settings
from app.services import entra
from tests.conftest import World, requires_db
from tests.test_entra import JWK, TENANT, microsoft, sso  # noqa: F401 (fixture)

API = settings.API_PREFIX


def error_of(target: str) -> str:
    return parse_qs(urlparse(target).query)["sso_error"][0]


@requires_db
async def test_guests_and_unverified_emails_do_not_get_in(
    client: AsyncClient, world: World, microsoft: dict  # noqa: F811
) -> None:
    # Convidado (B2B): o token vem com o locatário da empresa, mas a conta é de outro provedor.
    guest = await sso(client, microsoft, idp="https://sts.windows.net/outro-locatario/", oid="g1")
    assert error_of(guest) == "wrong_tenant"
    assert error_of(await sso(client, microsoft, acct=1, oid="g2")) == "wrong_tenant"
    # O claim "email" é editável: vale o login da conta (preferred_username).
    target = await sso(client, microsoft, email="admin@teste.com.br")
    code = target.split("#code=")[1]
    r = await client.post(f"{API}/auth/microsoft/exchange", json={"code": code})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email"] == "analista@teste.com.br"


@requires_db
async def test_auto_provision_only_as_analyst(
    client: AsyncClient,
    world: World,
    microsoft: dict,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "ENTRA_AUTO_PROVISION_ROLE", "admin")
    novo = {"preferred_username": "novo@teste.com.br", "oid": "oid-novo"}
    assert error_of(await sso(client, microsoft, **novo)) == "not_registered"
    monkeypatch.setattr(settings, "ENTRA_AUTO_PROVISION_ROLE", "analyst")
    target = await sso(client, microsoft, **novo)
    r = await client.post(
        f"{API}/auth/microsoft/exchange", json={"code": target.split("#code=")[1]}
    )
    assert r.status_code == 200, r.text
    assert (r.json()["user"]["email"], r.json()["user"]["role"]) == ("novo@teste.com.br", "analyst")


@requires_db
async def test_new_microsoft_key_and_unexpected_failures(
    client: AsyncClient,
    world: World,
    microsoft: dict,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A Microsoft trocou a chave: a primeira lista (do cache) não tem o kid; busca de novo.
    calls: list[int] = []

    async def rotating_jwks() -> dict:
        calls.append(1)
        return {"keys": []} if len(calls) == 1 else {"keys": [JWK]}

    monkeypatch.setattr(entra, "fetch_jwks", rotating_jwks)
    target = await sso(client, microsoft)
    assert target.startswith("http://web.test/login/microsoft#code=") and len(calls) == 2

    # Qualquer falha inesperada volta à tela de login com aviso (e não para numa página 500).
    async def broken(*_: object) -> None:
        raise RuntimeError("banco fora")

    monkeypatch.setattr(entra, "resolve_user", broken)
    assert error_of(await sso(client, microsoft)) == "provider_error"


async def test_network_errors_become_a_friendly_sso_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ENTRA_TENANT_ID", TENANT)

    async def offline(*_: object, **__: object) -> None:
        raise httpx.ConnectError("sem rede")

    monkeypatch.setattr(httpx.AsyncClient, "post", offline)
    monkeypatch.setattr(httpx.AsyncClient, "get", offline)
    with pytest.raises(entra.SsoError) as exchange:
        await entra.exchange_code("codigo", "verificador")
    assert exchange.value.code == "provider_error"
    monkeypatch.setattr(entra, "_jwks_cache", {"at": 0.0, "keys": None})
    with pytest.raises(entra.SsoError) as keys:
        await entra.fetch_jwks()
    assert keys.value.code == "provider_error"
