"""Proteção do login contra tentativa e erro de senha.

Conta as senhas erradas por e-mail e por IP numa janela de tempo. Passou do limite, o login
daquele e-mail (ou daquele IP) fica bloqueado até a janela acabar, mesmo com a senha certa;
acertar a senha zera a contagem do e-mail. Conta também e-mails que não existem, para o bloqueio
não revelar quais contas existem.

Com REDIS_URL a contagem é compartilhada entre as instâncias da API; sem Redis (ou se ele cair),
fica na memória do processo.
"""

import logging
import time
from dataclasses import dataclass

from app.core.config import settings

log = logging.getLogger(__name__)

WINDOW_SECONDS = 15 * 60
MAX_PER_ACCOUNT = 5
# Alto de propósito: atrás de um proxy que o uvicorn não reconhece (FORWARDED_ALLOW_IPS), todo
# mundo chega com o mesmo IP, e um limite baixo trancaria a empresa inteira. A proteção de cada
# conta é o limite por e-mail; o do IP só segura ataque em massa.
MAX_PER_IP = 100
_PREFIX = "maxxchamados:login-fail:"


class LoginBlocked(Exception):
    def __init__(self, retry_after: int) -> None:
        self.retry_after = max(1, retry_after)
        minutes = max(1, -(-self.retry_after // 60))
        super().__init__(
            f"Muitas tentativas de login. Tente de novo em {minutes} "
            f"minuto{'s' if minutes > 1 else ''}."
        )


@dataclass
class _Entry:
    count: int
    expires_at: float


_memory: dict[str, _Entry] = {}
_redis = None


def _client():  # noqa: ANN202
    global _redis
    if not settings.REDIS_URL:
        return None
    if _redis is None:
        from redis import asyncio as aioredis

        _redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis


def _keys(email: str, ip: str | None) -> list[tuple[str, int]]:
    keys = [(f"{_PREFIX}acct:{email.strip().lower()}", MAX_PER_ACCOUNT)]
    if ip:
        keys.append((f"{_PREFIX}ip:{ip}", MAX_PER_IP))
    return keys


def _mem_get(key: str, now: float) -> _Entry | None:
    entry = _memory.get(key)
    if entry is not None and entry.expires_at <= now:
        _memory.pop(key, None)
        return None
    return entry


async def check(email: str, ip: str | None) -> None:
    """Levanta LoginBlocked se o e-mail ou o IP passou do limite de senhas erradas."""
    redis = _client()
    if redis is not None:
        try:
            for key, limit in _keys(email, ip):
                count = int(await redis.get(key) or 0)
                if count >= limit:
                    raise LoginBlocked(int(await redis.ttl(key)))
            return
        except LoginBlocked:
            raise
        except Exception:
            log.warning("Redis indisponível para o controle de login; usando a memória")
    now = time.monotonic()
    for key, limit in _keys(email, ip):
        entry = _mem_get(key, now)
        if entry is not None and entry.count >= limit:
            raise LoginBlocked(int(entry.expires_at - now))


async def failed(email: str, ip: str | None) -> None:
    """Senha errada (ou conta inexistente/inativa): soma na janela."""
    redis = _client()
    if redis is not None:
        try:
            for key, _ in _keys(email, ip):
                count = await redis.incr(key)
                # Sempre com prazo: uma chave sem expiração viraria bloqueio para sempre.
                if count == 1 or await redis.ttl(key) < 0:
                    await redis.expire(key, WINDOW_SECONDS)
            return
        except Exception:
            log.warning("Redis indisponível para o controle de login; usando a memória")
    now = time.monotonic()
    for key, _ in _keys(email, ip):
        entry = _mem_get(key, now)
        if entry is None:
            _memory[key] = _Entry(1, now + WINDOW_SECONDS)
        else:
            entry.count += 1


async def succeeded(email: str) -> None:
    """Login certo: zera a contagem do e-mail (a do IP segue a janela)."""
    key = _keys(email, None)[0][0]
    _memory.pop(key, None)
    redis = _client()
    if redis is not None:
        try:
            await redis.delete(key)
        except Exception:
            log.warning("Redis indisponível para o controle de login")


def reset_memory() -> None:
    """Para os testes: começa cada um sem contagem."""
    _memory.clear()
