"""Sessões de login: rotação do refresh token e encerramento no servidor.

Cada login (senha ou Microsoft) abre uma sessão (`sid`), que segue nos tokens das renovações.
Toda renovação (/auth/refresh) troca o refresh token por outro da mesma sessão e marca o anterior
como usado. Se um refresh já usado volta depois da janela de tolerância (a resposta se perdeu na
rede), alguém copiou o token: a sessão inteira é encerrada e quem tiver qualquer token dela
precisa entrar de novo. Sair (/auth/logout) também encerra a sessão.

O login original (`auth_time`) segue igual nas renovações e limita a duração total da sessão.
"""

import hashlib
import time

from app.core import ephemeral
from app.core.config import settings

_USED = "maxxchamados:refresh-used:"
_REVOKED = "maxxchamados:session-revoked:"


def refresh_id(payload: dict, token: str) -> str:
    """Id de uso único do refresh (tokens antigos, sem jti, usam o hash do próprio token)."""
    jti = payload.get("jti")
    if isinstance(jti, str) and jti:
        return jti
    return hashlib.sha256(token.encode()).hexdigest()[:32]


def max_age_seconds(channel: str | None) -> int:
    days = settings.SESSION_MAX_DAYS_MOBILE if channel == "mobile" else settings.SESSION_MAX_DAYS
    return days * 86400


def reuse_grace_seconds(channel: str | None) -> int:
    """Tolerância para o mesmo refresh voltar (resposta perdida): maior no 4G do técnico."""
    if channel == "mobile":
        return settings.REFRESH_REUSE_GRACE_MOBILE_SECONDS
    return settings.REFRESH_REUSE_GRACE_SECONDS


async def use_refresh(token_id: str, ttl: int, *, at: float | None = None) -> float | None:
    """Marca o refresh como usado. Devolve quando ele foi usado da primeira vez (None: agora).

    `at=0` marca como usado há muito tempo (sair): qualquer uso depois já cai fora da tolerância.
    """
    if ttl <= 0:
        return None  # já venceu: o decode recusa antes de chegar aqui
    first = await ephemeral.set_once(
        f"{_USED}{token_id}", str(time.time() if at is None else at), ttl
    )
    if first is None:
        return None
    try:
        return float(first)
    except ValueError:
        return 0.0


async def revoke(session_id: str | None) -> None:
    """Encerra a sessão: os tokens dela (access e refresh) deixam de valer."""
    if not session_id:
        return
    days = max(
        settings.REFRESH_TOKEN_DAYS, settings.SESSION_MAX_DAYS, settings.SESSION_MAX_DAYS_MOBILE
    )
    await ephemeral.put(f"{_REVOKED}{session_id}", "1", days * 86400)


async def is_revoked(session_id: str | None) -> bool:
    if not session_id:
        return False
    return await ephemeral.get(f"{_REVOKED}{session_id}") is not None
