import logging
import time
import uuid

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select

from app.api.deps import DB, SESSION_ENDED, CurrentUser
from app.core import sessions
from app.core.access import CHANNEL_DENIED_MESSAGE, channel_allows, home_channel
from app.core.config import settings
from app.core.security import (
    InvalidToken,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    hash_password_async,
    new_session_id,
    verify_password_async,
)
from app.db.base import utcnow
from app.models.user import TICKET_MANAGER_ROLES, User
from app.schemas.auth import (
    AuthProviders,
    ChangePasswordRequest,
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    SsoExchange,
    TokenResponse,
)
from app.schemas.user import UserOut
from app.services import entra, login_guard

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Hash qualquer, só para o login de e-mail inexistente gastar o mesmo tempo do bcrypt.
_TIMING_HASH = hash_password("maxxchamados-tempo-constante")

MICROSOFT_REQUIRED = "Analistas e gestores entram com a conta Microsoft da empresa."
INACTIVE = "Seu acesso está desativado. Fale com a central da Maxx."
SESSION_EXPIRED = "Sessão expirada. Entre novamente."
SESSION_COPIED = "Sessão encerrada por segurança. Entre novamente."


def _tokens(
    user: User, channel: str | None, *, session_id: str | None = None, auth_time: int | None = None
) -> TokenResponse:
    """Par novo de tokens. Sem `session_id` abre uma sessão (login); com ele, renova a mesma."""
    sid = session_id or new_session_id()
    return TokenResponse(
        access_token=create_access_token(str(user.id), user.role.value, sid),
        refresh_token=create_refresh_token(
            str(user.id), channel, session_id=sid, auth_time=auth_time
        ),
        expires_in=settings.ACCESS_TOKEN_MINUTES * 60,
        user=UserOut.model_validate(user),
    )


def _blocked(exc: login_guard.LoginBlocked) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS, str(exc), headers={"Retry-After": str(exc.retry_after)}
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: DB, request: Request) -> TokenResponse:
    email = body.email.strip().lower()
    # IP já resolvido pelo uvicorn (--proxy-headers só confia no proxy configurado).
    ip = request.client.host if request.client else None
    try:
        await login_guard.check(email, ip)
    except login_guard.LoginBlocked as exc:
        raise _blocked(exc) from exc
    user = await db.scalar(select(User).where(func.lower(User.email) == email))
    # Sempre o bcrypt, até para e-mail inexistente: o tempo de resposta não revela quais contas
    # existem nem quais estão desativadas.
    password_ok = await verify_password_async(
        body.password, user.password_hash if user is not None else _TIMING_HASH
    )
    if user is None or not password_ok:
        await login_guard.failed(email, ip)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "E-mail ou senha inválidos")
    await login_guard.succeeded(email, ip)
    # Daqui em diante a senha está certa: dá para dizer o motivo sem revelar nada a terceiros.
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, INACTIVE)
    if not channel_allows(body.channel, user.role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, CHANNEL_DENIED_MESSAGE[body.channel or ""])
    if entra.staff_must_use_microsoft(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, MICROSOFT_REQUIRED)
    user.last_login_at = utcnow()
    await db.commit()
    return _tokens(user, body.channel)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: DB) -> TokenResponse:
    """Renova a sessão: o refresh usado é trocado por outro (uso único, ver core/sessions.py)."""
    try:
        payload = decode_token(body.refresh_token, "refresh")
        user = await db.get(User, uuid.UUID(payload["sub"]))
    except (InvalidToken, KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, SESSION_EXPIRED) from exc
    if user is None or not user.is_active or user.token_revoked(payload):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, SESSION_EXPIRED)
    # Se o papel mudou (ex.: técnico virou analista), a sessão no canal antigo termina.
    channel = payload.get("ch")
    if not channel_allows(channel, user.role):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, CHANNEL_DENIED_MESSAGE[channel])
    session_id = payload.get("sid")
    if await sessions.is_revoked(session_id):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, SESSION_ENDED)
    now = int(time.time())
    # Duração total da sessão contada do login (tokens antigos, sem auth_time: da emissão).
    auth_time = int(payload.get("auth_time") or payload.get("iat") or 0)
    if now - auth_time > sessions.max_age_seconds(channel):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, SESSION_EXPIRED)
    first_use = await sessions.use_refresh(
        sessions.refresh_id(payload, body.refresh_token), int(payload.get("exp", now)) - now
    )
    if first_use is not None and time.time() - first_use > sessions.reuse_grace_seconds(channel):
        # O mesmo refresh voltou bem depois de usado: foi copiado. Encerra a sessão inteira.
        await sessions.revoke(session_id)
        log.warning("Refresh token reutilizado: sessão encerrada (usuário %s)", user.id)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, SESSION_COPIED)
    return _tokens(user, channel, session_id=session_id, auth_time=auth_time)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(body: LogoutRequest) -> Response:
    """Sair: encerra no servidor a sessão do refresh token (o access dela cai junto).

    Não exige access válido: quem sai com o access vencido (ou sem rede para renovar) também
    encerra. Token vencido ou inválido não tem o que encerrar."""
    try:
        payload = decode_token(body.refresh_token, "refresh")
    except InvalidToken:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if payload.get("sid"):
        await sessions.revoke(payload["sid"])
    else:
        # Token de antes das sessões: só ele deixa de renovar.
        remaining = int(payload.get("exp", 0)) - int(time.time())
        await sessions.use_refresh(
            sessions.refresh_id(payload, body.refresh_token), remaining, at=0.0
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


@router.post("/change-password", response_model=TokenResponse)
async def change_password(body: ChangePasswordRequest, db: DB, user: CurrentUser) -> TokenResponse:
    """Troca a senha (obrigatória no primeiro acesso com senha provisória).

    Encerra as outras sessões do usuário e devolve tokens novos para este aparelho. Várias
    senhas atuais erradas seguidas bloqueiam a troca por um tempo (aparelho na mão de outro).
    """
    try:
        await login_guard.check_password_change(str(user.id))
    except login_guard.LoginBlocked as exc:
        raise _blocked(exc) from exc
    if not await verify_password_async(body.current_password, user.password_hash):
        await login_guard.password_change_failed(str(user.id))
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Senha atual incorreta")
    await login_guard.password_change_succeeded(str(user.id))
    if body.new_password == body.current_password:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "A nova senha precisa ser diferente da atual"
        )
    user.password_hash = await hash_password_async(body.new_password)
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
    except Exception:
        # Qualquer outra falha volta à tela de login com aviso (e não para numa página 500).
        log.exception("Falha inesperada na volta do login Microsoft")
        await db.rollback()
        target = f"{web}/login?sso_error=provider_error"
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
