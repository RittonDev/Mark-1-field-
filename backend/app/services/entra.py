"""Login Microsoft (Entra ID) para analistas e gestores, via OpenID Connect.

Fluxo "authorization code" com PKCE, feito pela API (cliente confidencial):
1. /auth/microsoft/start guarda state, nonce e o verificador PKCE num cookie assinado e
   redireciona para a Microsoft.
2. /auth/microsoft/callback troca o code pelo id_token e valida assinatura (chaves públicas
   do locatário), emissor, audiência, locatário, nonce e validade.
3. O usuário precisa estar cadastrado (ou ser criado como analista, se
   ENTRA_AUTO_PROVISION_ROLE), ativo, com papel de gestão e e-mail num domínio permitido.
   Convidados (B2B) do locatário não entram: a conta tem que ser da empresa.
4. A API devolve ao site um código de uso único (60 s) no fragmento da URL; o site troca
   esse código pelos tokens. Assim, nenhum token de acesso passa pela URL.
"""

import base64
import hashlib
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import ephemeral
from app.core.config import settings
from app.core.enums import UserRole
from app.core.security import create_token, decode_token, hash_password_async
from app.models.user import TICKET_MANAGER_ROLES, User

# Autocadastro no primeiro login: só como analista (gestor é dado à mão, em Usuários).
AUTO_PROVISION_ROLES = frozenset({UserRole.ANALYST.value})

STATE_COOKIE = "mf_sso"
STATE_TTL = timedelta(minutes=10)
HANDOFF_TTL = timedelta(seconds=60)
_JWKS_TTL = 3600


class SsoError(Exception):
    """Falha no login Microsoft. `code` vira mensagem amigável na tela de login."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _authority() -> str:
    return f"https://login.microsoftonline.com/{settings.ENTRA_TENANT_ID}"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@dataclass
class StartData:
    url: str
    cookie: str


def start() -> StartData:
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    domain = next(iter(sorted(settings.entra_domains)), None)
    params = {
        "client_id": settings.ENTRA_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": settings.ENTRA_REDIRECT_URI,
        "response_mode": "query",
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    if domain:
        params["domain_hint"] = domain
    cookie = create_token(state, "sso_state", STATE_TTL, {"nonce": nonce, "verifier": verifier})
    return StartData(url=f"{_authority()}/oauth2/v2.0/authorize?{urlencode(params)}", cookie=cookie)


def read_state(cookie: str | None, state: str | None) -> dict[str, Any]:
    if not cookie or not state:
        raise SsoError("invalid_state")
    try:
        data = decode_token(cookie, "sso_state")
    except Exception as exc:
        raise SsoError("invalid_state") from exc
    if not secrets.compare_digest(str(data.get("sub")), state):
        raise SsoError("invalid_state")
    return data


async def exchange_code(code: str, verifier: str) -> dict[str, Any]:
    """Troca o code pelo id_token no endpoint de token do locatário."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"{_authority()}/oauth2/v2.0/token",
                data={
                    "client_id": settings.ENTRA_CLIENT_ID,
                    "client_secret": settings.ENTRA_CLIENT_SECRET,
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": settings.ENTRA_REDIRECT_URI,
                    "code_verifier": verifier,
                    "scope": "openid profile email",
                },
            )
        if r.status_code != 200:
            raise SsoError("provider_error")
        data = r.json()
    except (httpx.HTTPError, ValueError) as exc:  # rede fora, tempo esgotado, JSON inválido
        raise SsoError("provider_error") from exc
    if not isinstance(data, dict):
        raise SsoError("provider_error")
    return data


_jwks_cache: dict[str, Any] = {"at": 0.0, "keys": None}


async def fetch_jwks() -> dict[str, Any]:
    if _jwks_cache["keys"] and time.monotonic() - _jwks_cache["at"] < _JWKS_TTL:
        return _jwks_cache["keys"]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{_authority()}/discovery/v2.0/keys")
        r.raise_for_status()
        keys = r.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise SsoError("provider_error") from exc
    _jwks_cache.update(at=time.monotonic(), keys=keys)
    return _jwks_cache["keys"]


def _find_key(jwks: dict[str, Any], kid: str | None) -> dict[str, Any] | None:
    return next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)


async def validate_id_token(id_token: str, nonce: str) -> dict[str, Any]:
    try:
        header = jwt.get_unverified_header(id_token)
        jwks = await fetch_jwks()
        jwk = _find_key(jwks, header.get("kid"))
        if jwk is None:
            # A Microsoft trocou as chaves: busca de novo (uma vez) em vez de esperar o cache.
            _jwks_cache.update(at=0.0, keys=None)
            jwk = _find_key(await fetch_jwks(), header.get("kid"))
        if jwk is None:
            raise SsoError("invalid_token")
        key = jwt.PyJWK(jwk).key
        claims = jwt.decode(
            id_token,
            key,
            algorithms=["RS256"],
            audience=settings.ENTRA_CLIENT_ID,
            issuer=f"https://login.microsoftonline.com/{settings.ENTRA_TENANT_ID}/v2.0",
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            leeway=60,
        )
    except jwt.PyJWTError as exc:
        raise SsoError("invalid_token") from exc
    tenant = str(settings.ENTRA_TENANT_ID).lower()
    # O locatário da conta tem que ser o da empresa (contas pessoais e de outras empresas
    # podem ter qualquer e-mail no preferred_username).
    if str(claims.get("tid", "")).lower() != tenant:
        raise SsoError("wrong_tenant")
    # Convidado (B2B): o token sai com o locatário da empresa, mas a conta é de outro provedor
    # (`idp`) ou marcada como convidada (`acct` = 1). Não é funcionário: não entra.
    idp = str(claims.get("idp") or "").lower()
    if (idp and tenant not in idp) or str(claims.get("acct", "")) == "1":
        raise SsoError("wrong_tenant")
    if not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
        raise SsoError("invalid_token")
    return claims


def _email_of(claims: dict[str, Any]) -> str:
    """O login da conta (preferred_username, o UPN do locatário). O claim `email` é editável pelo
    usuário e a Microsoft não garante que esteja verificado: fica só como último recurso."""
    return str(claims.get("preferred_username") or claims.get("email") or "").strip().lower()


async def resolve_user(db: AsyncSession, claims: dict[str, Any]) -> User:
    email = _email_of(claims)
    oid = str(claims.get("oid") or "")
    if "@" not in email or email.rsplit("@", 1)[1] not in settings.entra_domains:
        raise SsoError("domain_not_allowed")
    user = None
    if oid:
        user = await db.scalar(select(User).where(User.entra_oid == oid))
    if user is None:
        user = await db.scalar(select(User).where(func.lower(User.email) == email))
    if user is None:
        role = (settings.ENTRA_AUTO_PROVISION_ROLE or "").strip().lower()
        if role not in AUTO_PROVISION_ROLES:
            raise SsoError("not_registered")
        user = User(
            id=uuid.uuid4(),
            name=str(claims.get("name") or email.split("@")[0])[:160],
            email=email,
            # Sem senha local utilizável: entra só pela Microsoft.
            password_hash=await hash_password_async(secrets.token_urlsafe(32)),
            role=UserRole(role),
            is_active=True,
        )
        db.add(user)
    if not user.is_active:
        raise SsoError("inactive")
    if user.role not in TICKET_MANAGER_ROLES:
        raise SsoError("role_not_allowed")
    if oid:
        if user.entra_oid and user.entra_oid != oid:
            raise SsoError("account_mismatch")
        user.entra_oid = oid
    await db.flush()
    return user


def handoff_token(user: User) -> str:
    return create_token(
        str(user.id), "sso_handoff", HANDOFF_TTL, {"jti": secrets.token_urlsafe(16)}
    )


def staff_must_use_microsoft(user: User) -> bool:
    """Senha local bloqueada para gestão dos domínios da empresa (quando exigido)."""
    if not (settings.entra_enabled and settings.ENTRA_ENFORCE_FOR_STAFF):
        return False
    domain = user.email.rsplit("@", 1)[-1].lower()
    return user.role in TICKET_MANAGER_ROLES and domain in settings.entra_domains


async def consume_once(jti: str, ttl_seconds: int = 120) -> bool:
    """Garante uso único do código de retorno (Redis entre instâncias; memória sem Redis)."""
    if not jti:
        return False
    return await ephemeral.set_once(f"sso:used:{jti}", "1", ttl_seconds) is None
