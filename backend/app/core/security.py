import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import bcrypt
import jwt
from starlette.concurrency import run_in_threadpool

from app.core.config import settings

TokenKind = Literal["access", "refresh", "download", "sso_state", "sso_handoff"]


class InvalidToken(Exception):
    pass


def _pw_bytes(password: str) -> bytes:
    # bcrypt considera no máximo 72 bytes.
    return password.encode("utf-8")[:72]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_pw_bytes(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_pw_bytes(password), password_hash.encode("utf-8"))
    except ValueError:
        return False


# bcrypt é lento de propósito (~0,2 s): nas rotas ele roda fora do laço de eventos, senão cada
# login trava a API inteira (WebSocket, sync do app, todas as telas) durante o cálculo.


async def hash_password_async(password: str) -> str:
    return await run_in_threadpool(hash_password, password)


async def verify_password_async(password: str, password_hash: str) -> bool:
    return await run_in_threadpool(verify_password, password, password_hash)


def create_token(
    subject: str, kind: TokenKind, expires: timedelta, extra: dict[str, Any] | None = None
) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": subject,
        "typ": kind,
        "iat": int(now.timestamp()),
        "exp": int((now + expires).timestamp()),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def new_session_id() -> str:
    return secrets.token_urlsafe(12)


def create_access_token(user_id: str, role: str, session_id: str | None = None) -> str:
    """Com a sessão (`sid`), sair ou um refresh copiado derrubam também o access dela."""
    extra: dict[str, Any] = {"role": role}
    if session_id:
        extra["sid"] = session_id
    return create_token(
        user_id, "access", timedelta(minutes=settings.ACCESS_TOKEN_MINUTES), extra
    )


def create_refresh_token(
    user_id: str,
    channel: str | None = None,
    *,
    session_id: str | None = None,
    auth_time: int | None = None,
) -> str:
    """Refresh de uso único (`jti`), da sessão `sid`, com a hora do login original (`auth_time`,
    mantida nas renovações). O canal (web/mobile) vai no token para ser revalidado a cada
    renovação (ver core/sessions.py)."""
    extra: dict[str, Any] = {
        "jti": secrets.token_urlsafe(16),
        "sid": session_id or new_session_id(),
        "auth_time": auth_time if auth_time is not None else int(datetime.now(UTC).timestamp()),
    }
    if channel:
        extra["ch"] = channel
    return create_token(user_id, "refresh", timedelta(days=settings.REFRESH_TOKEN_DAYS), extra)


def create_download_token(attachment_id: str, user_id: str, minutes: int | None = None) -> str:
    return create_token(
        attachment_id,
        "download",
        timedelta(minutes=minutes or settings.DOWNLOAD_TOKEN_MINUTES),
        {"uid": user_id},
    )


def decode_token(token: str, expected: TokenKind) -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise InvalidToken(str(exc)) from exc
    if payload.get("typ") != expected:
        raise InvalidToken("tipo de token inválido")
    return payload
