import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import DB, SESSION_ENDED, CurrentUser
from app.core import sessions
from app.core.access import CHANNEL_DENIED_MESSAGE, channel_allows, home_channel
from app.core.config import settings
from app.core.enums import AccountTokenPurpose, UserRole
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
from app.db.errors import retryable
from app.models.user import TICKET_MANAGER_ROLES, User
from app.models.user_change import VIA_APP, VIA_LINK
from app.schemas.account import (
    ForgotPasswordIn,
    PasswordResetCheck,
    PasswordResetDone,
    PasswordResetIn,
    TokenIn,
    VerifyEmailResult,
)
from app.schemas.auth import (
    AuthProviders,
    ChangePasswordRequest,
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    SsoExchange,
    TokenResponse,
)
from app.schemas.common import Message
from app.schemas.user import UserOut
from app.services import access as access_svc
from app.services import account, entra, login_guard, mail, user_history
from app.services.errors import CodedError

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Hash qualquer, só para o login de e-mail inexistente gastar o mesmo tempo do bcrypt.
_TIMING_HASH = hash_password("maxxchamados-tempo-constante")

MICROSOFT_REQUIRED = "Analistas e gestores entram com a conta Microsoft da empresa."
INACTIVE = "Seu acesso está desativado. Fale com a central da Maxx."
SESSION_EXPIRED = "Sessão expirada. Entre novamente."
SESSION_COPIED = "Sessão encerrada por segurança. Entre novamente."

# Esqueci minha senha e os links do e-mail (validar o e-mail, definir a senha).
FORGOT_SENT = (
    "Se o e-mail estiver cadastrado e validado, enviamos um link para criar uma nova senha. "
    "Confira também o spam."
)
FORGOT_MAIL_OFF = (
    "O envio de e-mail está desligado. Peça à central pelo WhatsApp para redefinir sua senha"
)
# Pedidos de "Esqueci minha senha" por IP por hora (o limite por e-mail fica em services/account).
FORGOT_PER_IP = 10
# Aberturas de link (as três rotas de token somadas) por IP a cada 10 minutos.
LINKS_PER_IP = 30
LINKS_WINDOW_SECONDS = 600


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


def _blocked(exc: login_guard.LoginBlocked | login_guard.RateLimited) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS, str(exc), headers={"Retry-After": str(exc.retry_after)}
    )


def _ip(request: Request) -> str:
    # IP já resolvido pelo uvicorn (--proxy-headers só confia no proxy configurado).
    return request.client.host if request.client else "sem-ip"


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
    # O acesso efetivo (telas e filas) vai junto no TokenResponse.user.
    await access_svc.attach(db, user)
    return _tokens(user, body.channel)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: DB) -> TokenResponse:
    """Renova a sessão: o refresh usado é trocado por outro (uso único, ver core/sessions.py)."""
    try:
        payload = decode_token(body.refresh_token, "refresh")
        user = await db.get(User, uuid.UUID(payload["sub"]))
    except (InvalidToken, KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, SESSION_EXPIRED) from exc
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, SESSION_EXPIRED)
    # Desativado pela central: diz o motivo (o refresh válido é da própria conta, como a senha certa
    # no login). Com essa mensagem o app apaga do aparelho as OS e os dados de clientes (LGPD).
    if not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, INACTIVE)
    # Se o papel mudou (ex.: técnico virou analista), a sessão no canal antigo termina. Vem antes
    # da revogação: com essa mensagem o app apaga os dados locais do técnico.
    channel = payload.get("ch")
    if not channel_allows(channel, user.role):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, CHANNEL_DENIED_MESSAGE[channel])
    if user.token_revoked(payload):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, SESSION_EXPIRED)
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
    await access_svc.attach(db, user)
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
    senhas atuais erradas seguidas bloqueiam a troca por um tempo (aparelho na mão de outro); a
    tentativa conta antes de conferir (pedidos em paralelo não furam o limite), no mesmo contador
    da senha pedida no Meu cadastro. A do técnico entra no histórico do cadastro: "criada no app"
    (era a provisória) ou "trocada no app".
    """
    try:
        await login_guard.password_attempt(str(user.id))
    except login_guard.LoginBlocked as exc:
        raise _blocked(exc) from exc
    if not await verify_password_async(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Senha atual incorreta")
    await login_guard.password_change_succeeded(str(user.id))
    if body.new_password == body.current_password:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "A nova senha precisa ser diferente da atual"
        )
    was_temporary = user.must_change_password
    user.password_hash = await hash_password_async(body.new_password)
    user.must_change_password = False
    user.sessions_revoked_at = utcnow()
    # Os links de nova senha ainda não usados ("Esqueci minha senha", central, boas-vindas) caem.
    await account.revoke(db, user_id=user.id, purpose=AccountTokenPurpose.RESET_PASSWORD)
    changes: list[dict] = []
    if user.role == UserRole.TECHNICIAN:
        line = user_history.PASSWORD_CREATED if was_temporary else user_history.PASSWORD_CHANGED
        changes = [dict(line)]
        user_history.record(db, user, changes, via=VIA_APP, actor=user)
    await db.commit()
    await user_history.publish_changed(user, changes, via=VIA_APP, actor=user)
    return _tokens(user, home_channel(user.role))


# ------------------------------------------------- esqueci minha senha e links do e-mail
# Sem login. As regras e o histórico ficam em services/account.py; aqui, os limites, o commit e
# os avisos. O token do link chega no corpo (a página o lê do fragmento #token=).


async def _link_attempt(request: Request) -> None:
    """Conta uma abertura de link (validar o e-mail, conferir ou gravar a senha) do IP."""
    try:
        await login_guard.hit("account-link-ip", _ip(request), LINKS_PER_IP, LINKS_WINDOW_SECONDS)
    except login_guard.RateLimited as exc:
        raise _blocked(exc) from exc


async def _apply_link(
    db: AsyncSession, apply: Callable[[], Awaitable[account.LinkOutcome]]
) -> account.LinkOutcome:
    """Faz o que o link pede e grava (commit). O link trava o token e depois o técnico; o app, a
    central e a fila travam o técnico e depois os tokens. Quando os dois se cruzam, o banco desfaz
    um lado (impasse, SQLSTATE 40P01; ou falha de serialização, 40001): aqui a rota desfaz e
    repete uma vez, já com o que a outra gravação deixou (o limite do IP não conta de novo). Se
    acontecer de novo, o erro segue para o main (503 "Outra gravação ao mesmo tempo. Tente de
    novo")."""
    try:
        outcome = await apply()
        await db.commit()
        return outcome
    except DBAPIError as exc:
        if not retryable(exc):
            raise
        log.info("Link do e-mail: outra gravação ao mesmo tempo, repetindo uma vez")
    await db.rollback()
    outcome = await apply()
    await db.commit()
    return outcome


@router.post("/forgot-password", response_model=Message, status_code=status.HTTP_202_ACCEPTED)
async def forgot_password(body: ForgotPasswordIn, db: DB, request: Request) -> Message:
    """Esqueci minha senha (app, sem login): 202 com o mesmo texto, exista ou não o e-mail. O link
    (2 h) só vai para o técnico com acesso ao app e o e-mail de login validado. 429 depois de
    FORGOT_PER_IP pedidos do IP na hora; 503 MAIL_DISABLED com o envio de e-mail desligado (a
    central redefine pelo WhatsApp, com a senha provisória)."""
    try:
        await login_guard.hit("forgot-ip", _ip(request), FORGOT_PER_IP, 3600)
    except login_guard.RateLimited as exc:
        raise _blocked(exc) from exc
    if not settings.mail_enabled:
        raise CodedError(FORGOT_MAIL_OFF, mail.MAIL_DISABLED, status.HTTP_503_SERVICE_UNAVAILABLE)
    row = await account.forgot_password(db, body.email)
    if row is not None:
        await db.commit()
        mail.deliver_soon([row.id])
    return Message(detail=FORGOT_SENT)


@router.post("/password-reset/check", response_model=PasswordResetCheck)
async def password_reset_check(body: TokenIn, db: DB, request: Request) -> PasswordResetCheck:
    """A página "Definir nova senha" ao abrir: confere o link sem gastá-lo e mostra a conta
    (e-mail mascarado, primeiro nome; "" quando a primeira palavra do nome não é um nome), o tipo
    ("create": a primeira senha, pela boas-vindas) e o link do app. 410 LINK_GONE: vencido ou
    usado; 410 ACCESS_CUT: sem acesso ao app."""
    await _link_attempt(request)
    return await account.check_reset(db, body.token)


@router.post("/password-reset", response_model=PasswordResetDone)
async def password_reset(body: PasswordResetIn, db: DB, request: Request) -> PasswordResetDone:
    """Grava a senha nova pelo link (uso único): encerra os acessos abertos, revoga os outros
    links de senha e valida o e-mail de login (o link chegou nele). 410 LINK_GONE: vencido ou
    usado; 410 ACCESS_CUT: sem acesso ao app (nada muda e o link continua como estava). Outra
    gravação ao mesmo tempo no cadastro: repete uma vez (`_apply_link`)."""
    await _link_attempt(request)
    outcome = await _apply_link(db, lambda: account.reset_password(db, body.token, body.password))
    user = outcome.user
    if user is not None:
        # A senha nova destrava o login e a senha pedida no app (as erradas de antes não contam).
        await login_guard.succeeded(user.email, _ip(request))
        await login_guard.password_change_succeeded(str(user.id))
        await user_history.publish_changed(user, outcome.changes, via=VIA_LINK, actor=user)
    return PasswordResetDone(email=outcome.email, app_url=settings.tech_app_url)


@router.post("/verify-email", response_model=VerifyEmailResult)
async def verify_email(body: TokenIn, db: DB, request: Request) -> VerifyEmailResult:
    """A página /validar-email ao abrir: valida o e-mail da ficha ("signup"), o e-mail novo
    pedido no app, que passa a ser o login ("change"), ou o login de sempre ("check"). O mesmo
    link aberto de novo com o e-mail já validado responde igual. 410 LINK_GONE; 409 EMAIL_IN_USE
    quando o e-mail pedido virou o login de outro cadastro (o pedido sai). Outra gravação ao mesmo
    tempo no cadastro: repete uma vez (`_apply_link`)."""
    await _link_attempt(request)
    outcome = await _apply_link(db, lambda: account.verify_email(db, body.token))
    if outcome.user is not None and outcome.changes:
        await user_history.publish_changed(
            outcome.user,
            outcome.changes,
            via=VIA_LINK,
            actor=outcome.user,
            after_reset=outcome.after_reset,
        )
    if outcome.application is not None:
        await account.publish_onboarding_updated(outcome.application, "email_verified")
    if outcome.error is not None:
        raise outcome.error
    return VerifyEmailResult(email=outcome.email, kind=outcome.kind)


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
    await access_svc.attach(db, user)
    return _tokens(user, "web")
