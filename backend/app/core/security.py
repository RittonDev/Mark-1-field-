from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import bcrypt
import jwt

from app.core.config import settings

TokenKind = Literal["access", "refresh", "download"]


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


def create_access_token(user_id: str, role: str) -> str:
    return create_token(
        user_id, "access", timedelta(minutes=settings.ACCESS_TOKEN_MINUTES), {"role": role}
    )


def create_refresh_token(user_id: str, channel: str | None = None) -> str:
    """O canal (web/mobile) vai no token para ser revalidado a cada renovação."""
    extra = {"ch": channel} if channel else None
    return create_token(user_id, "refresh", timedelta(days=settings.REFRESH_TOKEN_DAYS), extra)


def create_download_token(attachment_id: str, user_id: str) -> str:
    return create_token(
        attachment_id,
        "download",
        timedelta(minutes=settings.DOWNLOAD_TOKEN_MINUTES),
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
