import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select

from app.api.deps import DB, CurrentUser
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


def _tokens(user: User) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(str(user.id), user.role.value),
        refresh_token=create_refresh_token(str(user.id)),
        expires_in=settings.ACCESS_TOKEN_MINUTES * 60,
        user=UserOut.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: DB) -> TokenResponse:
    user = await db.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "E-mail ou senha inválidos")
    user.last_login_at = utcnow()
    await db.commit()
    return _tokens(user)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: DB) -> TokenResponse:
    try:
        payload = decode_token(body.refresh_token, "refresh")
        user = await db.get(User, uuid.UUID(payload["sub"]))
    except (InvalidToken, KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão expirada") from exc
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão expirada")
    return _tokens(user)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user
