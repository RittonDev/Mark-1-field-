import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import UserRole
from app.core.security import InvalidToken, decode_token
from app.db.session import get_db
from app.models.user import User

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
    if user.token_revoked(payload):
        raise _unauthorized("Sessão encerrada. Entre novamente.")
    return user


def require_roles(*roles: UserRole):  # noqa: ANN201
    async def dependency(user: Annotated[User, Depends(get_current_user)]) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Sem permissão para esta ação")
        return user

    return dependency


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
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sem permissão para esta ação")
    return user


# Qualquer usuário logado, menos o técnico (ex.: rotas que o solicitante também usa).
NoTechnicianUser = Annotated[User, Depends(_not_technician)]
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]
