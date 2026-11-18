import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions, sessions
from app.core.enums import UserRole
from app.core.permissions import Level
from app.core.security import InvalidToken, decode_token
from app.db.session import get_db
from app.models.user import TICKET_MANAGER_ROLES, User
from app.services import access as access_svc

SESSION_ENDED = "Sessão encerrada. Entre novamente."
FORBIDDEN = "Sem permissão para esta ação"
# Regras duras por papel (valem junto com a matriz de acesso): admin e supervisor.
MANAGER_ROLES = frozenset({UserRole.ADMIN, UserRole.SUPERVISOR})

bearer = HTTPBearer(auto_error=False)

DB = Annotated[AsyncSession, Depends(get_db)]


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user(
    db: DB,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> User:
    if creds is None:
        raise _unauthorized("Não autenticado")
    try:
        payload = decode_token(creds.credentials, "access")
        user_id = uuid.UUID(payload["sub"])
    except (InvalidToken, KeyError, ValueError) as exc:
        raise _unauthorized("Token inválido ou expirado") from exc
    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise _unauthorized("Usuário inativo ou inexistente")
    # Senha trocada, acesso desativado, saída da sessão ou refresh copiado (core/sessions.py).
    if user.token_revoked(payload) or await sessions.is_revoked(payload.get("sid")):
        raise _unauthorized(SESSION_ENDED)
    # Acesso efetivo (telas e fila) calculado uma vez por request: as regras de visibilidade
    # leem dele sem ir ao banco. Relido a cada request, a mudança de perfil vale na hora.
    await access_svc.attach(db, user)
    return user


async def optional_user(
    db: AsyncSession, creds: HTTPAuthorizationCredentials | None
) -> User | None:
    """Quem abriu uma página pública, se mandou a sessão (ela não exige login: sem sessão, é o
    cliente). Token inválido, usuário inativo ou sessão encerrada valem como "sem sessão"."""
    if creds is None:
        return None
    try:
        payload = decode_token(creds.credentials, "access")
        user = await db.get(User, uuid.UUID(payload["sub"]))
    except (InvalidToken, KeyError, ValueError):
        return None
    if user is None or not user.is_active or user.token_revoked(payload):
        return None
    if await sessions.is_revoked(payload.get("sid")):
        return None
    return user


def require_roles(*roles: UserRole):  # noqa: ANN201
    async def dependency(user: Annotated[User, Depends(get_current_user)]) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, FORBIDDEN)
        return user

    dependency.roles = frozenset(roles)  # type: ignore[attr-defined]  # inventário das rotas
    return dependency


def require_access(
    *items: str,
    level: Level = "view",
    roles: frozenset[UserRole] | None = TICKET_MANAGER_ROLES,
):  # noqa: ANN201
    """Gate de uma tela do menu (core/permissions.py): o papel (gestão, ou admin e supervisor
    nas regras duras) e o nível pedido em pelo menos um dos itens. Técnico e cliente recebem o
    403 de sempre; a gestão sem o item recebe o 403 MODULE_FORBIDDEN (tela de "sem acesso").

    `roles=None`: rota que o técnico também usa (ex.: os custos da OS no app). Qualquer pessoa
    logada passa pelo papel e só a gestão é conferida na matriz; o resto segue as regras da
    própria rota."""
    unknown = [i for i in items if i not in permissions.ITEM_BY_KEY]
    if not items or unknown:
        raise ValueError(f"Tela desconhecida na guarda: {unknown or items}")

    async def dependency(user: Annotated[User, Depends(get_current_user)]) -> User:
        if roles is not None and user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, FORBIDDEN)
        if roles is not None or user.can_manage_tickets:
            permissions.require_any(user, items, level)
        return user

    # Usados pelo teste de inventário das rotas (tests/test_access_routes.py).
    dependency.access_rule = (items, level)  # type: ignore[attr-defined]
    dependency.roles = frozenset(roles) if roles is not None else None  # type: ignore[attr-defined]
    return dependency


def access_user(
    *items: str, level: Level = "view", roles: frozenset[UserRole] | None = TICKET_MANAGER_ROLES
):  # noqa: ANN201
    """Usuário da rota com a guarda da tela. Ex.: QuotesEdit = access_user("commercial.quotes",
    level="edit")."""
    return Annotated[User, Depends(require_access(*items, level=level, roles=roles))]


CurrentUser = Annotated[User, Depends(get_current_user)]
StaffUser = Annotated[
    User,
    Depends(
        require_roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.ANALYST, UserRole.TECHNICIAN)
    ),
]
# Gestão completa das OS e dos cadastros operacionais (clientes, locais) na web.
TicketManagerUser = Annotated[
    User, Depends(require_roles(UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.ANALYST))
]
ManagerUser = Annotated[User, Depends(require_roles(UserRole.ADMIN, UserRole.SUPERVISOR))]


async def _not_technician(user: Annotated[User, Depends(get_current_user)]) -> User:
    """O técnico é terceiro: no app ele só vê as OS dele (cliente, local, agenda e escopo).
    Cadastros, usuários, painéis, notas e histórico das OS ficam fora do alcance dele."""
    if user.role == UserRole.TECHNICIAN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, FORBIDDEN)
    return user


# Qualquer usuário logado, menos o técnico (ex.: rotas que o solicitante também usa).
NoTechnicianUser = Annotated[User, Depends(_not_technician)]
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]
