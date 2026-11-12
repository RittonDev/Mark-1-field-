import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select

from app.api.deps import DB, CurrentUser
from app.core.access import CHANNEL_DENIED_MESSAGE, channel_allows, home_channel
from app.core.config import settings
from app.core.security import (
    InvalidToken,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.db.base import utcnow
from app.models.user import User
from app.schemas.auth import ChangePasswordRequest, LoginRequest, RefreshRequest, TokenResponse
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
    if user is None or not user.is_active or user.token_revoked(payload):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão expirada")
    # Se o papel mudou (ex.: técnico virou analista), a sessão no canal antigo termina.
    channel = payload.get("ch")
    if not channel_allows(channel, user.role):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, CHANNEL_DENIED_MESSAGE[channel])
    return _tokens(user, channel)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


@router.post("/change-password", response_model=TokenResponse)
async def change_password(body: ChangePasswordRequest, db: DB, user: CurrentUser) -> TokenResponse:
    """Troca a senha (obrigatória no primeiro acesso com senha provisória).

    Encerra as outras sessões do usuário e devolve tokens novos para este aparelho.
    """
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Senha atual incorreta")
    if body.new_password == body.current_password:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "A nova senha precisa ser diferente da atual"
        )
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    user.sessions_revoked_at = utcnow()
    await db.commit()
    return _tokens(user, home_channel(user.role))
