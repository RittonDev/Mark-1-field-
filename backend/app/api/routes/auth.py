import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select

from app.api.deps import DB, CurrentUser
from app.core.access import CHANNEL_DENIED_MESSAGE, channel_allows
from app.core.config import settings
from app.core.security import (
    InvalidToken,
    create_access_token,
    create_refresh_token,
    decode_token,
    verify_password,
)
from app.db.base import utcnow
from app.models.user import User
from app.schemas.auth import LoginRequest, RefreshRequest, TokenResponse
from app.schemas.user import UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


def _tokens(user: User, channel: str | None) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(str(user.id), user.role.value),
        refresh_token=create_refresh_token(str(user.id), channel),
        expires_in=settings.ACCESS_TOKEN_MINUTES * 60,
        user=UserOut.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: DB) -> TokenResponse:
    user = await db.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "E-mail ou senha inválidos")
    # Só depois da senha correta, para não revelar o papel de quem errou a senha.
    if not channel_allows(body.channel, user.role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, CHANNEL_DENIED_MESSAGE[body.channel or ""])
    user.last_login_at = utcnow()
    await db.commit()
    return _tokens(user, body.channel)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: DB) -> TokenResponse:
    try:
        payload = decode_token(body.refresh_token, "refresh")
        user = await db.get(User, uuid.UUID(payload["sub"]))
    except (InvalidToken, KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão expirada") from exc
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão expirada")
    # Se o papel mudou (ex.: técnico virou analista), a sessão no canal antigo termina.
    channel = payload.get("ch")
    if not channel_allows(channel, user.role):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, CHANNEL_DENIED_MESSAGE[channel])
    return _tokens(user, channel)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user
