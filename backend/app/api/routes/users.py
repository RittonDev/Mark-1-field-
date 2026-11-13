import logging
import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, or_, select

from app.api.deps import DB, ManagerUser, NoTechnicianUser, TicketManagerUser
from app.core.enums import UserRole
from app.core.security import hash_password_async
from app.db.base import utcnow
from app.models import Customer, Team, Ticket, User
from app.schemas.user import (
    AssignableUser,
    TeamCreate,
    TeamOut,
    TeamUpdate,
    UserCreate,
    UserOut,
    UserUpdate,
)
from app.services.workflow import OPEN_STATUSES

log = logging.getLogger(__name__)

router = APIRouter(tags=["users"])

# O supervisor cuida da equipe de analistas e dos acessos do portal; administradores e
# supervisores só o admin cria, promove ou edita. Técnicos ficam em Técnicos (analistas também).
SUPERVISOR_MANAGES = frozenset({UserRole.ANALYST, UserRole.REQUESTER})
ONLY_ADMIN = "Só o administrador cria ou altera usuários com este papel"
# Mudanças que encerram as sessões abertas do usuário (o token antigo deixa de valer).
REVOKING_FIELDS = frozenset({"password", "email", "role"})
REQUIRED_FIELDS = ("name", "email", "role", "is_active")


def _can_manage(actor: User, role: UserRole) -> bool:
    return actor.role == UserRole.ADMIN or (
        actor.role == UserRole.SUPERVISOR and role in SUPERVISOR_MANAGES
    )


async def _email_taken(db: DB, email: str, exclude: uuid.UUID | None = None) -> bool:
    stmt = select(User.id).where(func.lower(User.email) == email.lower())
    if exclude is not None:
        stmt = stmt.where(User.id != exclude)
    return await db.scalar(stmt) is not None


async def _check_team(db: DB, team_id: uuid.UUID | None) -> None:
    if team_id is not None and await db.get(Team, team_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Grupo não encontrado")


async def _check_customer(
    db: DB, role: UserRole, customer_id: uuid.UUID | None
) -> uuid.UUID | None:
    """Usuário do cliente fica ligado à empresa dele (o portal mostra as solicitações dela).
    Os outros papéis não têm empresa."""
    if role != UserRole.REQUESTER:
        return None
    if customer_id is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Escolha a empresa do cliente: no portal ele vê as solicitações dela",
        )
    if await db.get(Customer, customer_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Cliente não encontrado")
    return customer_id


@router.get("/users", response_model=list[UserOut])
async def list_users(
    db: DB,
    _: TicketManagerUser,
    role: UserRole | None = None,
    team_id: uuid.UUID | None = None,
    q: str | None = None,
    active: bool | None = None,
) -> list[User]:
    stmt = select(User).order_by(User.name)
    if role is not None:
        stmt = stmt.where(User.role == role)
    if team_id is not None:
        stmt = stmt.where(User.team_id == team_id)
    if active is not None:
        stmt = stmt.where(User.is_active.is_(active))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(User.name.ilike(like), User.email.ilike(like)))
    return list(await db.scalars(stmt))


@router.get("/users/assignable", response_model=list[AssignableUser])
async def assignable_users(
    db: DB, _: TicketManagerUser, team_id: uuid.UUID | None = None
) -> list[AssignableUser]:
    load = (
        select(Ticket.assignee_id, func.count().label("n"))
        .where(Ticket.status.in_(OPEN_STATUSES), Ticket.assignee_id.is_not(None))
        .group_by(Ticket.assignee_id)
        .subquery()
    )
    stmt = (
        select(User, func.coalesce(load.c.n, 0))
        .outerjoin(load, load.c.assignee_id == User.id)
        .where(
            User.is_active.is_(True),
            User.role.in_([UserRole.ANALYST, UserRole.TECHNICIAN, UserRole.SUPERVISOR]),
        )
        .order_by(User.name)
    )
    if team_id is not None:
        stmt = stmt.where(User.team_id == team_id)
    rows = (await db.execute(stmt)).all()
    return [
        AssignableUser(
            id=u.id,
            name=u.name,
            role=u.role,
            team_id=u.team_id,
            team_name=u.team.name if u.team else None,
            open_tickets=n,
        )
        for u, n in rows
    ]


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(body: UserCreate, db: DB, actor: ManagerUser) -> User:
    if not _can_manage(actor, body.role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, ONLY_ADMIN)
    if await _email_taken(db, body.email):
        raise HTTPException(status.HTTP_409_CONFLICT, "E-mail já cadastrado")
    await _check_team(db, body.team_id)
    customer_id = await _check_customer(db, body.role, body.customer_id)
    user = User(
        name=body.name.strip(),
        email=body.email.lower(),
        password_hash=await hash_password_async(body.password),
        role=body.role,
        phone=(body.phone or "").strip() or None,
        job_title=(body.job_title or "").strip() or None,
        team_id=body.team_id,
        customer_id=customer_id,
        is_active=True,
        # Técnico com senha escolhida pela central troca no primeiro acesso ao app.
        must_change_password=body.role == UserRole.TECHNICIAN,
    )
    db.add(user)
    await db.commit()
    log.info("Usuários: %s criou %s (%s)", actor.id, user.id, body.role.value)
    return await db.get(User, user.id, populate_existing=True)  # type: ignore[return-value]


@router.get("/users/{user_id}", response_model=UserOut)
async def get_user(user_id: uuid.UUID, db: DB, current: NoTechnicianUser) -> User:
    if not current.is_staff and current.id != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sem permissão")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Usuário não encontrado")
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(user_id: uuid.UUID, body: UserUpdate, db: DB, actor: ManagerUser) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Usuário não encontrado")
    fields = body.model_dump(exclude_unset=True)
    # null num campo obrigatório não apaga nada (o formulário mandou vazio): fica como está.
    for key in REQUIRED_FIELDS:
        if key in fields and fields[key] is None:
            fields.pop(key)
    if not _can_manage(actor, user.role) or not _can_manage(actor, fields.get("role", user.role)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, ONLY_ADMIN)
    if "email" in fields:
        fields["email"] = fields["email"].lower()
        if fields["email"] == user.email.lower():
            fields.pop("email")
        elif await _email_taken(db, fields["email"], exclude=user_id):
            raise HTTPException(status.HTTP_409_CONFLICT, "E-mail já cadastrado")
    if fields.get("role") == user.role:
        fields.pop("role")
    if "team_id" in fields:
        await _check_team(db, fields["team_id"])
    if "customer_id" in fields or "role" in fields:
        fields["customer_id"] = await _check_customer(
            db, fields.get("role", user.role), fields.get("customer_id", user.customer_id)
        )
    if user.id == actor.id and (
        fields.get("is_active") is False or fields.get("role") not in (None, UserRole.ADMIN)
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Você não pode remover o próprio acesso de admin"
        )
    for key in ("phone", "job_title"):
        if key in fields:
            fields[key] = (fields[key] or "").strip() or None
    password = fields.pop("password", None)
    changed = sorted([*fields, *(["password"] if password else [])])
    if password:
        user.password_hash = await hash_password_async(password)
        # Técnico com senha definida pela central troca no próximo acesso ao app.
        if fields.get("role", user.role) == UserRole.TECHNICIAN:
            user.must_change_password = True
    deactivated = fields.get("is_active") is False and user.is_active
    for key, value in fields.items():
        setattr(user, key, value)
    # Senha, e-mail ou papel trocados, ou acesso desativado: quem estava logado sai na hora
    # (ex.: a conta vazou e o admin trocou a senha).
    if deactivated or REVOKING_FIELDS.intersection(changed):
        user.sessions_revoked_at = utcnow()
    await db.commit()
    if changed:
        log.info("Usuários: %s alterou %s (%s)", actor.id, user.id, ", ".join(changed))
    return await db.get(User, user.id, populate_existing=True)  # type: ignore[return-value]


@router.get("/teams", response_model=list[TeamOut])
async def list_teams(db: DB, _: TicketManagerUser) -> list[Team]:
    return list(await db.scalars(select(Team).order_by(Team.name)))


@router.post("/teams", response_model=TeamOut, status_code=status.HTTP_201_CREATED)
async def create_team(body: TeamCreate, db: DB, _: ManagerUser) -> Team:
    team = Team(name=body.name.strip(), description=body.description, is_active=True)
    db.add(team)
    await db.commit()
    return team


@router.patch("/teams/{team_id}", response_model=TeamOut)
async def update_team(team_id: uuid.UUID, body: TeamUpdate, db: DB, _: ManagerUser) -> Team:
    team = await db.get(Team, team_id)
    if team is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Grupo não encontrado")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(team, key, value)
    await db.commit()
    return team
