"""Busca de CEP para os formulários de endereço (GET /public/cep/{cep}; a rota cuida do limite).

- O ViaCEP responde primeiro e vale: achou, ou "erro" (true ou "true") = o CEP não existe. A
  BrasilAPI é a reserva e só entra quando o ViaCEP falha (tempo, rede, status diferente de 200, JSON
  inválido, resposta sem a cidade ou com uma UF que não existe).
- Cache (core/ephemeral: Redis ou a memória): achou, 7 dias; não achou pelo ViaCEP, 1 dia. O "não
  achou" da reserva não fica guardado (o ViaCEP decide na próxima), nem a falha dos dois.
- Só o CEP sai daqui, e ele não vai para o log: os avisos levam o serviço e o tipo do erro, e o
  main.RedactTokens tira o CEP do caminho da rota e das URLs dos serviços (log do httpx).
- O `complemento` do ViaCEP ("lado ímpar") é do trecho da rua, não da casa: fica fora.
"""

import json
import logging
import re
import unicodedata
from typing import Any

import httpx

from app.core import ephemeral
from app.schemas.cep import CepOut
from app.schemas.onboarding import UFS
from app.services.errors import CodedError

log = logging.getLogger(__name__)

VIACEP_URL = "https://viacep.com.br/ws/{cep}/json/"
BRASILAPI_URL = "https://brasilapi.com.br/api/cep/v2/{cep}"

CACHE_KEY = "maxxchamados:cep:v1:{cep}"
FOUND_TTL = 7 * 24 * 3600
NOT_FOUND_TTL = 24 * 3600

INVALID = "CEP com 8 dígitos"
NOT_FOUND = "CEP não encontrado"
UNAVAILABLE = "Busca de CEP indisponível"
CEP_NOT_FOUND = "CEP_NOT_FOUND"
CEP_UNAVAILABLE = "CEP_UNAVAILABLE"

# Os tamanhos das colunas de endereço (logradouro, bairro e cidade).
_STREET_MAX = 255
_DISTRICT_MAX = 120
_CITY_MAX = 120

_FORMAT = re.compile(r"(\d{5})-?(\d{3})")


class CepNotFound(CodedError):
    """404: o CEP não existe."""

    def __init__(self) -> None:
        super().__init__(NOT_FOUND, CEP_NOT_FOUND, 404)


class CepUnavailable(CodedError):
    """503: os dois serviços falharam (a tela deixa os campos livres)."""

    def __init__(self) -> None:
        super().__init__(UNAVAILABLE, CEP_UNAVAILABLE, 503)


class _Failed(Exception):
    """O serviço não deu uma resposta que sirva."""


def digits(text: str | None) -> str | None:
    """Os 8 números do CEP ("01001-000" ou "01001000", espaços em volta valem); None fora disso."""
    match = _FORMAT.fullmatch((text or "").strip())
    return f"{match[1]}{match[2]}" if match else None


def formatted(cep: str) -> str:
    """O CEP com o hífen ("01001-000")."""
    return f"{cep[:5]}-{cep[5:]}"


def _client() -> httpx.AsyncClient:
    """O cliente HTTP dos dois serviços (os testes trocam por um httpx.MockTransport)."""
    return httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=2.0))


def _text(value: Any, max_len: int) -> str | None:
    """Texto em NFC, sem espaços sobrando; vazio (ou o que não é texto): None."""
    if not isinstance(value, str):
        return None
    return " ".join(unicodedata.normalize("NFC", value).split())[:max_len].strip() or None


def _address(cep: str, street: Any, district: Any, city: Any, state: Any) -> CepOut:
    """O endereço limpo. Sem a cidade ou com uma UF que não existe: _Failed."""
    city_text = _text(city, _CITY_MAX)
    uf = state.strip().upper() if isinstance(state, str) else ""
    if city_text is None or uf not in UFS:
        raise _Failed("Resposta sem a cidade ou com UF inválida")
    return CepOut(
        cep=formatted(cep),
        street=_text(street, _STREET_MAX),
        district=_text(district, _DISTRICT_MAX),
        city=city_text,
        state=uf,
    )


async def _viacep(client: httpx.AsyncClient, cep: str) -> CepOut | None:
    """O endereço; None quando o ViaCEP diz que o CEP não existe."""
    response = await client.get(VIACEP_URL.format(cep=cep))
    if response.status_code != 200:
        raise _Failed(f"Status {response.status_code}")
    data = response.json()
    if not isinstance(data, dict):
        raise _Failed("Resposta fora do formato")
    if data.get("erro") is True or str(data.get("erro")).lower() == "true":
        return None
    return _address(
        cep, data.get("logradouro"), data.get("bairro"), data.get("localidade"), data.get("uf")
    )


async def _brasilapi(client: httpx.AsyncClient, cep: str) -> CepOut | None:
    """O endereço; None quando a BrasilAPI responde 404 (não achou)."""
    response = await client.get(BRASILAPI_URL.format(cep=cep))
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise _Failed(f"Status {response.status_code}")
    data = response.json()
    if not isinstance(data, dict):
        raise _Failed("Resposta fora do formato")
    return _address(
        cep, data.get("street"), data.get("neighborhood"), data.get("city"), data.get("state")
    )


async def _cached(key: str) -> dict[str, Any] | None:
    """O que está guardado para o CEP; None sem nada (ou guardado num formato que não serve)."""
    raw = await ephemeral.get(key)
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _from_cache(cached: dict[str, Any]) -> CepOut | None:
    try:
        return CepOut.model_validate(cached.get("data"))
    except ValueError:  # formato antigo: busca de novo
        return None


async def lookup(cep: str) -> CepOut:
    """O endereço do CEP (os 8 números, ver `digits`). CepNotFound (404) ou CepUnavailable (503)."""
    key = CACHE_KEY.format(cep=cep)
    cached = await _cached(key)
    if cached is not None:
        if not cached.get("found"):
            raise CepNotFound
        hit = _from_cache(cached)
        if hit is not None:
            return hit
    async with _client() as client:
        try:
            found = await _viacep(client, cep)
            authoritative = True
        except Exception as exc:  # tempo, rede, status, JSON ou resposta incompleta: a reserva
            log.warning("ViaCEP sem resposta (%s): tentando a BrasilAPI", exc.__class__.__name__)
            try:
                found = await _brasilapi(client, cep)
            except Exception as again:
                log.warning(
                    "BrasilAPI sem resposta (%s): busca de CEP indisponível",
                    again.__class__.__name__,
                )
                raise CepUnavailable from None
            authoritative = False
    if found is None:
        if authoritative:
            await ephemeral.put(key, json.dumps({"found": False}), NOT_FOUND_TTL)
        raise CepNotFound
    await ephemeral.put(key, json.dumps({"found": True, "data": found.model_dump()}), FOUND_TTL)
    return found
