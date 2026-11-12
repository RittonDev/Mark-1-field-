"""Login Microsoft (Entra ID): só gestão cadastrada, do locatário e do domínio da empresa.

A Microsoft é simulada: chave RSA própria do teste no lugar das chaves públicas do locatário
e o endpoint de token devolvendo um id_token assinado por ela.
"""

import time
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import AsyncClient

from app.core.config import settings
from app.core.security import decode_token
from app.services import entra
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX
TENANT = "11111111-2222-3333-4444-555555555555"
CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
JWK = {**jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key(), as_dict=True), "kid": "k1", "use": "sig"}


@pytest.fixture
def microsoft(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Configura o Entra e simula a Microsoft. `claims` muda o que a "Microsoft" devolve."""
    for name, value in {
        "ENTRA_TENANT_ID": TENANT,
        "ENTRA_CLIENT_ID": CLIENT,
        "ENTRA_CLIENT_SECRET": "segredo-de-teste",
        "ENTRA_ALLOWED_DOMAINS": "teste.com.br",
        "WEB_URL": "http://web.test",
    }.items():
        monkeypatch.setattr(settings, name, value)
    sim: dict = {"claims": {}}

    async def fake_exchange(code: str, verifier: str) -> dict:
        assert code == "code-da-microsoft" and verifier
        now = int(time.time())
        claims = {
            "iss": f"https://login.microsoftonline.com/{TENANT}/v2.0",
            "aud": CLIENT,
            "tid": TENANT,
            "sub": "sub-1",
            "oid": "oid-analista",
            "iat": now,
            "exp": now + 600,
            "nonce": sim["nonce"],
            "preferred_username": "Analista@Teste.com.br",
            "name": "Analista",
            **sim["claims"],
        }
        return {"id_token": jwt.encode(claims, KEY, algorithm="RS256", headers={"kid": "k1"})}

    async def fake_jwks() -> dict:
        return {"keys": [JWK]}

    monkeypatch.setattr(entra, "exchange_code", fake_exchange)
    monkeypatch.setattr(entra, "fetch_jwks", fake_jwks)
    return sim


async def sso(client: AsyncClient, sim: dict, **claims: object) -> str:
    """Faz o vaivém com a "Microsoft" e devolve para onde a API mandou o navegador."""
    start = await client.get(f"{API}/auth/microsoft/start")
    assert start.status_code == 302
    url = urlparse(start.headers["location"])
    assert url.netloc == "login.microsoftonline.com" and TENANT in url.path
    query = parse_qs(url.query)
    assert query["code_challenge_method"] == ["S256"]
    state = query["state"][0]
    sim["nonce"] = decode_token(client.cookies[entra.STATE_COOKIE], "sso_state")["nonce"]
    sim["claims"] = claims
    back = await client.get(
        f"{API}/auth/microsoft/callback", params={"code": "code-da-microsoft", "state": state}
    )
    assert back.status_code == 302
    return back.headers["location"]


async def test_microsoft_login(client: AsyncClient, world: World, microsoft: dict) -> None:
    providers = (await client.get(f"{API}/auth/providers")).json()
    assert providers["microsoft"] is True and providers["password_for_staff"] is True

    target = await sso(client, microsoft)
    assert target.startswith("http://web.test/login/microsoft#code=")
    code = target.split("#code=")[1]
    r = await client.post(f"{API}/auth/microsoft/exchange", json={"code": code})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email"] == "analista@teste.com.br"
    # Código de uso único.
    again = await client.post(f"{API}/auth/microsoft/exchange", json={"code": code})
    assert again.status_code == 401

    # Outra conta Microsoft com o mesmo e-mail não assume o usuário já vinculado.
    assert (await sso(client, microsoft, oid="outra-conta")).endswith("sso_error=account_mismatch")


async def test_microsoft_login_rejections(
    client: AsyncClient, world: World, microsoft: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def error_of(**claims: object) -> str:
        return parse_qs(urlparse(await sso(client, microsoft, **claims)).query)["sso_error"][0]

    assert await error_of(tid="99999999-0000-0000-0000-000000000000") == "wrong_tenant"
    assert await error_of(preferred_username="alguem@gmail.com", oid="x1") == "domain_not_allowed"
    assert await error_of(preferred_username="novo@teste.com.br", oid="x2") == "not_registered"
    assert await error_of(preferred_username="tecnico@teste.com.br", oid="x3") == "role_not_allowed"
    assert await error_of(nonce="adulterado") == "invalid_token"

    # Volta sem o state certo (ex.: link forjado): recusado.
    r = await client.get(
        f"{API}/auth/microsoft/callback", params={"code": "code-da-microsoft", "state": "x"}
    )
    assert "sso_error=invalid_state" in r.headers["location"]

    # Com a exigência ligada, a gestão do domínio não entra com senha; o solicitante entra.
    monkeypatch.setattr(settings, "ENTRA_ENFORCE_FOR_STAFF", True)
    body = {"email": "analista@teste.com.br", "password": "senha-teste-123", "channel": "web"}
    assert (await client.post(f"{API}/auth/login", json=body)).status_code == 403
    body["email"] = "cliente@teste.com.br"
    assert (await client.post(f"{API}/auth/login", json=body)).status_code == 200
