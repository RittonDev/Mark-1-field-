import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, or_, select

from app.api.deps import DB, AdminUser, CurrentUser, ManagerUser, StaffUser
from app.core.enums import UserRole
from app.core.security import hash_password
from app.models import Team, Ticket, User
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

router = APIRouter(tags=["users"])


async def _email_taken(db: DB, email: str, exclude: uuid.UUID | None = None) -> bool:
    stmt = select(User.id).where(func.lower(User.email) == email.lower())
    if exclude is not None:
        stmt = stmt.where(User.id != exclude)
    return await db.scalar(stmt) is not None


async def _check_team(db: DB, team_id: uuid.UUID | None) -> None:
    if team_id is not None and await db.get(Team, team_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Grupo não encontrado")


@router.get("/users", response_model=list[UserOut])
async def list_users(
    db: DB,
    _: StaffUser,
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
    db: DB, _: StaffUser, team_id: uuid.UUID | None = None
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
async def create_user(body: UserCreate, db: DB, _: AdminUser) -> User:
    if await _email_taken(db, body.email):
        raise HTTPException(status.HTTP_409_CONFLICT, "E-mail já cadastrado")
    await _check_team(db, body.team_id)
    user = User(
        name=body.name.strip(),
        email=body.email.lower(),
        password_hash=hash_password(body.password),
        role=body.role,
        phone=body.phone,
        job_title=body.job_title,
        team_id=body.team_id,
        is_active=True,
    )
    db.add(user)
    await db.commit()
    return await db.get(User, user.id, populate_existing=True)  # type: ignore[return-value]


@router.get("/users/{user_id}", response_model=UserOut)
async def get_user(user_id: uuid.UUID, db: DB, current: CurrentUser) -> User:
    if not current.is_staff and current.id != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sem permissão")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Usuário não encontrado")
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(user_id: uuid.UUID, body: UserUpdate, db: DB, admin: AdminUser) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Usuário não encontrado")
    fields = body.model_dump(exclude_unset=True)
    if "email" in fields and fields["email"]:
        if await _email_taken(db, fields["email"], exclude=user_id):
            raise HTTPException(status.HTTP_409_CONFLICT, "E-mail já cadastrado")
        fields["email"] = fields["email"].lower()
    if "team_id" in fields:
        await _check_team(db, fields["team_id"])
    if user.id == admin.id and (
        fields.get("is_active") is False
        or fields.get("role")
        not in (
            None,
            UserRole.ADMIN,
        )
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Você não pode remover o próprio acesso de admin"
        )
    password = fields.pop("password", None)
    if password:
        user.password_hash = hash_password(password)
    for key, value in fields.items():
        setattr(user, key, value)
    await db.commit()
    return await db.get(User, user.id, populate_existing=True)  # type: ignore[return-value]


@router.get("/teams", response_model=list[TeamOut])
async def list_teams(db: DB, _: CurrentUser) -> list[Team]:
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
