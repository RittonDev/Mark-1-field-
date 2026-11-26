"""Busca de CEP (GET /public/cep/{cep}): ViaCEP, BrasilAPI de reserva, cache, limites e o log.

Nenhum teste fala com a rede: os dois serviços respondem por um httpx.MockTransport na fábrica
`cep._client`.
"""

import json
import logging

import httpx
import pytest
from httpx import AsyncClient

from app.core import ephemeral
from app.core.config import settings
from app.main import RedactTokens
from app.services import cep
from tests.conftest import World, requires_db

API = settings.API_PREFIX
CEP = "01001000"

VIACEP_FOUND = {
    "cep": "01001-000",
    "logradouro": "  Rua   Exemplo ",
    "complemento": "lado ímpar",
    "unidade": "",
    # O acento decomposto (NFD) e espaços sobrando: sai em NFC, com um espaço só.
    "bairro": " Vila  Esperança ",
    "localidade": " Cidade  Exemplo",
    "uf": "sp",
    "estado": "São Paulo",
    "ibge": "1234567",
    "ddd": "11",
}
FOUND = {
    "cep": "01001-000",
    "street": "Rua Exemplo",
    "district": "Vila Esperança",
    "city": "Cidade Exemplo",
    "state": "SP",
}
BRASILAPI_FOUND = {
    "cep": CEP,
    "state": "SP",
    "city": "Cidade Exemplo",
    "neighborhood": "Bairro Reserva",
    "street": "Avenida Reserva",
    "service": "open-cep",
}


class Services:
    """Os dois serviços de mentira: cada um responde com `viacep`/`brasilapi` (uma resposta, uma
    exceção ou uma função) e conta os pedidos."""

    def __init__(self) -> None:
        self.viacep: object = httpx.Response(200, json=VIACEP_FOUND)
        self.brasilapi: object = httpx.Response(200, json=BRASILAPI_FOUND)
        self.calls: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        self.calls.append(host)
        answer = self.viacep if host == "viacep.com.br" else self.brasilapi
        if isinstance(answer, Exception):
            raise answer
        assert isinstance(answer, httpx.Response)
        return answer


@pytest.fixture
def services(monkeypatch: pytest.MonkeyPatch) -> Services:
    fake = Services()
    monkeypatch.setattr(
        cep, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))
    )
    return fake


# ------------------------------------------------------------------ serviço (sem banco)


def test_digits() -> None:
    assert cep.digits("01001-000") == CEP
    assert cep.digits(" 01001000 ") == CEP
    for bad in ("0100100", "010010000", "01001-0000", "0100a000", "01.001-000", "", None):
        assert cep.digits(bad) is None


async def test_viacep_result_is_normalized(services: Services) -> None:
    found = await cep.lookup(CEP)
    assert found.model_dump() == FOUND
    assert services.calls == ["viacep.com.br"]
    # CEP geral da cidade: sem logradouro e sem bairro.
    services.viacep = httpx.Response(200, json={**VIACEP_FOUND, "logradouro": "", "bairro": "  "})
    general = await cep.lookup("13000000")
    assert (general.street, general.district, general.city) == (None, None, "Cidade Exemplo")
    assert general.cep == "13000-000"


@pytest.mark.parametrize("erro", [True, "true"])
async def test_viacep_not_found_as_text_or_bool(services: Services, erro: object) -> None:
    services.viacep = httpx.Response(200, json={"erro": erro})
    with pytest.raises(cep.CepNotFound) as caught:
        await cep.lookup(CEP)
    assert (caught.value.status_code, caught.value.code) == (404, "CEP_NOT_FOUND")
    assert str(caught.value) == "CEP não encontrado"
    # A reserva não é chamada: o ViaCEP respondeu. E o "não achou" fica guardado.
    assert services.calls == ["viacep.com.br"]
    with pytest.raises(cep.CepNotFound):
        await cep.lookup(CEP)
    assert services.calls == ["viacep.com.br"]


@pytest.mark.parametrize(
    "failure",
    [
        httpx.Response(500, text="erro"),
        httpx.Response(400, text="Bad Request"),
        httpx.Response(200, text="<html>fora do ar</html>"),
        httpx.Response(200, json=["não é um objeto"]),
        httpx.Response(200, json={**VIACEP_FOUND, "uf": "XX"}),
        httpx.Response(200, json={**VIACEP_FOUND, "localidade": ""}),
        httpx.ConnectTimeout("tempo esgotado"),
        httpx.ConnectError("sem rede"),
    ],
)
async def test_brasilapi_only_when_viacep_fails(services: Services, failure: object) -> None:
    services.viacep = failure
    found = await cep.lookup(CEP)
    assert found.model_dump() == {
        "cep": "01001-000",
        "street": "Avenida Reserva",
        "district": "Bairro Reserva",
        "city": "Cidade Exemplo",
        "state": "SP",
    }
    assert services.calls == ["viacep.com.br", "brasilapi.com.br"]


async def test_viacep_says_no_even_if_brasilapi_has_it(services: Services) -> None:
    services.viacep = httpx.Response(200, json={"erro": True})
    with pytest.raises(cep.CepNotFound):
        await cep.lookup(CEP)
    assert "brasilapi.com.br" not in services.calls


async def test_both_down_is_503_and_not_cached(services: Services) -> None:
    services.viacep = httpx.ReadTimeout("tempo esgotado")
    services.brasilapi = httpx.Response(502, text="Bad Gateway")
    with pytest.raises(cep.CepUnavailable) as caught:
        await cep.lookup(CEP)
    assert (caught.value.status_code, caught.value.code) == (503, "CEP_UNAVAILABLE")
    assert str(caught.value) == "Busca de CEP indisponível"
    # Nada guardado: com o ViaCEP de volta, acha.
    services.viacep = httpx.Response(200, json=VIACEP_FOUND)
    assert (await cep.lookup(CEP)).model_dump() == FOUND
    assert services.calls == ["viacep.com.br", "brasilapi.com.br", "viacep.com.br"]


async def test_reserve_not_found_is_not_cached(services: Services) -> None:
    services.viacep = httpx.Response(503, text="manutenção")
    services.brasilapi = httpx.Response(404, json={"message": "CEP não encontrado"})
    with pytest.raises(cep.CepNotFound):
        await cep.lookup(CEP)
    services.viacep = httpx.Response(200, json=VIACEP_FOUND)
    assert (await cep.lookup(CEP)).model_dump() == FOUND


async def test_results_are_cached(services: Services, monkeypatch: pytest.MonkeyPatch) -> None:
    ttls: dict[str, int] = {}
    put = ephemeral.put

    async def spy(key: str, value: str, ttl: int) -> None:
        ttls[key] = ttl
        await put(key, value, ttl)

    monkeypatch.setattr(ephemeral, "put", spy)
    first = await cep.lookup(CEP)
    services.viacep = httpx.ConnectError("fora do ar")
    services.brasilapi = httpx.ConnectError("fora do ar")
    assert await cep.lookup(CEP) == first
    assert services.calls == ["viacep.com.br"]
    assert ttls == {f"maxxchamados:cep:v1:{CEP}": 7 * 24 * 3600}
    stored = json.loads(await ephemeral.get(f"maxxchamados:cep:v1:{CEP}") or "{}")
    assert stored == {"found": True, "data": FOUND}

    services.viacep = httpx.Response(200, json={"erro": "true"})
    with pytest.raises(cep.CepNotFound):
        await cep.lookup("99999999")
    assert ttls["maxxchamados:cep:v1:99999999"] == 24 * 3600


async def test_cep_leaves_the_log(services: Services, caplog: pytest.LogCaptureFixture) -> None:
    redact = RedactTokens()
    access = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:5000", "GET", f"{API}/public/cep/{CEP}", "1.1", 200),
        None,
    )
    redact.filter(access)
    assert CEP not in access.getMessage() and "/public/cep/***" in access.getMessage()
    # O httpx registra a URL de cada pedido (um objeto URL, não texto).
    outgoing = logging.LogRecord(
        "httpx",
        logging.INFO,
        __file__,
        1,
        'HTTP Request: %s %s "%s %d %s"',
        ("GET", httpx.URL(f"https://viacep.com.br/ws/{CEP}/json/"), "HTTP/1.1", 200, "OK"),
        None,
    )
    redact.filter(outgoing)
    assert CEP not in outgoing.getMessage() and "viacep.com.br/ws/***" in outgoing.getMessage()
    other = httpx.URL("https://login.microsoftonline.com/x/discovery/v2.0/keys")
    record = logging.LogRecord("httpx", logging.INFO, __file__, 1, "%s", (other,), None)
    redact.filter(record)
    assert record.args == (other,)  # o que não muda fica como estava

    # De ponta a ponta: o pedido aos dois serviços (o ViaCEP falha) e os avisos daqui.
    services.viacep = httpx.Response(500, text="erro")
    with caplog.at_level(logging.INFO):
        await cep.lookup(CEP)
    assert caplog.records and CEP not in caplog.text and "01001-000" not in caplog.text


# ------------------------------------------------------------------ rota (com banco)


@requires_db
async def test_route_answers_and_errors_have_codes(client: AsyncClient, services: Services) -> None:
    r = await client.get(f"{API}/public/cep/01001-000")
    assert r.status_code == 200, r.text
    assert r.json() == FOUND
    assert r.headers["x-robots-tag"] == "noindex, nofollow"

    services.viacep = httpx.Response(200, json={"erro": True})
    r = await client.get(f"{API}/public/cep/99999999")
    assert r.status_code == 404
    assert r.json() == {"detail": "CEP não encontrado", "code": "CEP_NOT_FOUND"}

    services.viacep = httpx.ConnectError("fora do ar")
    services.brasilapi = httpx.ConnectError("fora do ar")
    r = await client.get(f"{API}/public/cep/88888888")
    assert r.status_code == 503
    assert r.json() == {"detail": "Busca de CEP indisponível", "code": "CEP_UNAVAILABLE"}


@requires_db
@pytest.mark.parametrize("bad", ["123", "0100100a", "01001-0000", "010010000"])
async def test_invalid_cep_is_422(client: AsyncClient, services: Services, bad: str) -> None:
    r = await client.get(f"{API}/public/cep/{bad}")
    assert r.status_code == 422
    assert r.json() == {"detail": "CEP com 8 dígitos"}
    assert services.calls == []


@requires_db
async def test_limits_by_ip_and_by_user(
    client: AsyncClient, world: World, services: Services
) -> None:
    url = f"{API}/public/cep/{CEP}"
    for _ in range(30):
        assert (await client.get(url)).status_code == 200
    blocked = await client.get(url)
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "Muitas tentativas. Tente mais tarde."
    assert int(blocked.headers["retry-after"]) > 0
    # Sessão inválida vale como sem sessão: o limite do IP.
    bogus = {"Authorization": "Bearer nao-e-um-token"}
    assert (await client.get(url, headers=bogus)).status_code == 429

    # Logado, o limite é por pessoa (a central inteira sai pelo mesmo IP).
    for _ in range(120):
        assert (await client.get(url, headers=world.analyst.headers)).status_code == 200
    assert (await client.get(url, headers=world.analyst.headers)).status_code == 429
    # Outra pessoa tem o próprio limite; o técnico (app) também busca logado.
    assert (await client.get(url, headers=world.tech.headers)).status_code == 200
    # Uma busca só aos serviços: o resto veio do cache.
    assert services.calls == ["viacep.com.br"]
