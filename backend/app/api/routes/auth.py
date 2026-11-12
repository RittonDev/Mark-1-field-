import uuid

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse
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
from app.models.user import TICKET_MANAGER_ROLES, User
from app.schemas.auth import (
    AuthProviders,
    ChangePasswordRequest,
    LoginRequest,
    RefreshRequest,
    SsoExchange,
    TokenResponse,
)
from app.schemas.user import UserOut
from app.services import entra, login_guard

router = APIRouter(prefix="/auth", tags=["auth"])

# Hash qualquer, só para o login de e-mail inexistente gastar o mesmo tempo do bcrypt.
_TIMING_HASH = hash_password("maxxchamados-tempo-constante")

MICROSOFT_REQUIRED = "Analistas e gestores entram com a conta Microsoft da empresa."


def _tokens(user: User, channel: str | None) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(str(user.id), user.role.value),
        refresh_token=create_refresh_token(str(user.id), channel),
        expires_in=settings.ACCESS_TOKEN_MINUTES * 60,
        user=UserOut.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: DB, request: Request) -> TokenResponse:
    email = body.email.strip().lower()
    # IP já resolvido pelo uvicorn (--proxy-headers só confia no proxy configurado).
    ip = request.client.host if request.client else None
    try:
        await login_guard.check(email, ip)
    except login_guard.LoginBlocked as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, str(exc), headers={"Retry-After": str(exc.retry_after)}
        ) from exc
    user = await db.scalar(select(User).where(func.lower(User.email) == email))
    if user is None:
        # Mesmo tempo de resposta de uma senha errada: não revela quais e-mails existem.
        verify_password(body.password, _TIMING_HASH)
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        await login_guard.failed(email, ip)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "E-mail ou senha inválidos")
    await login_guard.succeeded(email)
    # Só depois da senha correta, para não revelar o papel de quem errou a senha.
    if not channel_allows(body.channel, user.role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, CHANNEL_DENIED_MESSAGE[body.channel or ""])
    if entra.staff_must_use_microsoft(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, MICROSOFT_REQUIRED)
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


# ------------------------------------------------------------ login Microsoft


@router.get("/providers", response_model=AuthProviders)
async def providers() -> AuthProviders:
    """Opções da tela de login (o botão Microsoft só aparece se estiver configurado)."""
    return AuthProviders(
        microsoft=settings.entra_enabled,
        password_for_staff=not (settings.entra_enabled and settings.ENTRA_ENFORCE_FOR_STAFF),
        microsoft_domains=sorted(settings.entra_domains) if settings.entra_enabled else [],
    )


_SSO_COOKIE_PATH = f"{settings.API_PREFIX}/auth/microsoft"


@router.get("/microsoft/start", include_in_schema=False)
async def microsoft_start() -> RedirectResponse:
    if not settings.entra_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Login Microsoft não configurado")
    data = entra.start()
    response = RedirectResponse(data.url, status_code=status.HTTP_302_FOUND)
    response.set_cookie(
        entra.STATE_COOKIE,
        data.cookie,
        max_age=int(entra.STATE_TTL.total_seconds()),
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
        path=_SSO_COOKIE_PATH,
    )
    return response


@router.get("/microsoft/callback", include_in_schema=False)
async def microsoft_callback(
    request: Request,
    db: DB,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    web = settings.WEB_URL.rstrip("/")
    try:
        if error:
            raise entra.SsoError("cancelled" if error == "access_denied" else "provider_error")
        saved = entra.read_state(request.cookies.get(entra.STATE_COOKIE), state)
        tokens = await entra.exchange_code(code or "", saved["verifier"])
        claims = await entra.validate_id_token(str(tokens.get("id_token", "")), saved["nonce"])
        user = await entra.resolve_user(db, claims)
        await db.commit()
        # Fragmento (#): não vai para servidor nenhum nem para logs de acesso.
        target = f"{web}/login/microsoft#code={entra.handoff_token(user)}"
    except entra.SsoError as exc:
        await db.rollback()
        target = f"{web}/login?sso_error={exc.code}"
    response = RedirectResponse(target, status_code=status.HTTP_302_FOUND)
    response.delete_cookie(entra.STATE_COOKIE, path=_SSO_COOKIE_PATH)
    return response


@router.post("/microsoft/exchange", response_model=TokenResponse)
async def microsoft_exchange(body: SsoExchange, db: DB) -> TokenResponse:
    """Troca o código de uso único (60 s) da volta do login Microsoft pelos tokens."""
    try:
        payload = decode_token(body.code, "sso_handoff")
        user = await db.get(User, uuid.UUID(payload["sub"]))
    except (InvalidToken, KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Login expirado. Tente de novo.") from exc
    if not await entra.consume_once(str(payload.get("jti", ""))):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Login expirado. Tente de novo.")
    if user is None or not user.is_active or user.role not in TICKET_MANAGER_ROLES:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Acesso não permitido")
    user.last_login_at = utcnow()
    await db.commit()
    return _tokens(user, "web")
