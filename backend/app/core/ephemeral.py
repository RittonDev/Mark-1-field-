"""Estado efêmero compartilhado: contadores com janela, marcas de uso único e revogações.

Com REDIS_URL fica no Redis e vale para todas as instâncias da API; sem Redis (ou se ele cair)
fica na memória do processo. Nada aqui é dado permanente: toda chave tem prazo para sumir.
"""

import logging
import time
from dataclasses import dataclass
from typing import Any

from app.core.config import settings

log = logging.getLogger(__name__)

# Acima disso, cada gravação na memória limpa antes as chaves vencidas.
_PRUNE_ABOVE = 5000


@dataclass
class _Entry:
    value: str
    expires_at: float


_memory: dict[str, _Entry] = {}
_redis: Any = None
# Ligado por reset_memory (testes): tudo na memória, sem o Redis compartilhado.
_memory_only = False


def _client() -> Any:
    global _redis
    if _memory_only or not settings.REDIS_URL:
        return None
    if _redis is None:
        from redis import asyncio as aioredis

        _redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis


def _warn() -> None:
    log.warning("Redis indisponível para o estado compartilhado; usando a memória do processo")


def _mem_get(key: str, now: float) -> _Entry | None:
    entry = _memory.get(key)
    if entry is not None and entry.expires_at <= now:
        _memory.pop(key, None)
        return None
    return entry


def _mem_put(key: str, value: str, ttl: int, now: float) -> None:
    if len(_memory) > _PRUNE_ABOVE:
        for stale in [k for k, e in _memory.items() if e.expires_at <= now]:
            _memory.pop(stale, None)
    _memory[key] = _Entry(value, now + max(1, ttl))


async def incr(key: str, window: int) -> tuple[int, int]:
    """Soma 1 no contador da janela; devolve (contagem, segundos até a janela acabar)."""
    redis = _client()
    if redis is not None:
        try:
            count = int(await redis.incr(key))
            ttl = int(await redis.ttl(key))
            # Sempre com prazo: uma chave sem expiração viraria bloqueio para sempre.
            if count == 1 or ttl < 0:
                await redis.expire(key, window)
                ttl = window
            return count, max(1, ttl)
        except Exception:
            _warn()
    now = time.monotonic()
    entry = _mem_get(key, now)
    if entry is None:
        _mem_put(key, "1", window, now)
        return 1, window
    entry.value = str(int(entry.value) + 1)
    return int(entry.value), max(1, int(entry.expires_at - now))


async def count(key: str) -> tuple[int, int]:
    """Contagem atual da janela e os segundos que faltam (0, 0 sem contagem)."""
    redis = _client()
    if redis is not None:
        try:
            value = await redis.get(key)
            if value is None:
                return 0, 0
            return int(value), max(1, int(await redis.ttl(key)))
        except Exception:
            _warn()
    now = time.monotonic()
    entry = _mem_get(key, now)
    if entry is None:
        return 0, 0
    return int(entry.value), max(1, int(entry.expires_at - now))


async def set_once(key: str, value: str, ttl: int) -> str | None:
    """Grava só se a chave ainda não existir. Devolve o valor que já estava lá (None: gravou)."""
    redis = _client()
    if redis is not None:
        try:
            if await redis.set(key, value, nx=True, ex=max(1, ttl)):
                return None
            current = await redis.get(key)
            return current if current is not None else ""
        except Exception:
            _warn()
    now = time.monotonic()
    entry = _mem_get(key, now)
    if entry is not None:
        return entry.value
    _mem_put(key, value, ttl, now)
    return None


async def put(key: str, value: str, ttl: int) -> None:
    redis = _client()
    if redis is not None:
        try:
            await redis.set(key, value, ex=max(1, ttl))
            return
        except Exception:
            _warn()
    _mem_put(key, value, ttl, time.monotonic())


async def get(key: str) -> str | None:
    redis = _client()
    if redis is not None:
        try:
            return await redis.get(key)
        except Exception:
            _warn()
    entry = _mem_get(key, time.monotonic())
    return entry.value if entry is not None else None


async def delete(*keys: str) -> None:
    for key in keys:
        _memory.pop(key, None)
    redis = _client()
    if redis is not None and keys:
        try:
            await redis.delete(*keys)
        except Exception:
            _warn()


def reset_memory() -> None:
    """Para os testes: cada um começa sem contagens nem marcas, e o estado fica só na memória do
    processo. No Redis compartilhado, as contagens de um teste (senhas erradas, fichas por IP)
    passariam para o seguinte e para a próxima execução da suíte."""
    global _memory_only
    _memory_only = True
    _memory.clear()
