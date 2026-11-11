import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.api.deps import DB, AdminUser, CurrentUser, ManagerUser
from app.core.enums import TicketPriority
from app.core.labels import enum_options
from app.models import Category, SlaPolicy, Team
from app.schemas.catalog import (
    CategoryCreate,
    CategoryOut,
    CategoryUpdate,
    SlaPolicyOut,
    SlaPolicyUpdate,
)
from app.services.sla import DEFAULT_SLA_MINUTES
from app.services.workflow import workflow_metadata

router = APIRouter(tags=["catalog"])


@router.get("/meta")
async def meta() -> dict:
    """Status, transições, prioridades e rótulos. Público (o app lê antes do login)."""
    return {**workflow_metadata(), **enum_options()}


async def _load_category(db: DB, category_id: uuid.UUID) -> Category:
    category = await db.scalar(
        select(Category).where(Category.id == category_id).execution_options(populate_existing=True)
    )
    if category is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Categoria não encontrada")
    return category


async def _check_category_refs(
    db: DB, parent_id: uuid.UUID | None, team_id: uuid.UUID | None, self_id: uuid.UUID | None
) -> None:
    if parent_id is not None:
        if parent_id == self_id:
            raise HTTPException(422, "Uma categoria não pode ser pai dela mesma")
        if await db.get(Category, parent_id) is None:
            raise HTTPException(422, "Categoria pai não encontrada")
    if team_id is not None and await db.get(Team, team_id) is None:
        raise HTTPException(422, "Grupo não encontrado")


@router.get("/categories", response_model=list[CategoryOut])
async def list_categories(db: DB, _: CurrentUser) -> list[Category]:
    categories = list(await db.scalars(select(Category)))
    return sorted(categories, key=lambda c: c.full_name.lower())


@router.post("/categories", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
async def create_category(body: CategoryCreate, db: DB, _: ManagerUser) -> Category:
    await _check_category_refs(db, body.parent_id, body.default_team_id, None)
    category = Category(**body.model_dump(), is_active=True)
    db.add(category)
    await db.commit()
    return await _load_category(db, category.id)


@router.patch("/categories/{category_id}", response_model=CategoryOut)
async def update_category(
    category_id: uuid.UUID, body: CategoryUpdate, db: DB, _: ManagerUser
) -> Category:
    category = await _load_category(db, category_id)
    fields = body.model_dump(exclude_unset=True)
    await _check_category_refs(
        db,
        fields.get("parent_id", category.parent_id),
        fields.get("default_team_id", category.default_team_id),
        category.id,
    )
    for key, value in fields.items():
        setattr(category, key, value)
    await db.commit()
    return await _load_category(db, category.id)


@router.get("/sla-policies", response_model=list[SlaPolicyOut])
async def list_sla(db: DB, _: CurrentUser) -> list[SlaPolicyOut]:
    stored = {p.priority: p for p in await db.scalars(select(SlaPolicy))}
    out = []
    for priority in TicketPriority:
        if priority in stored:
            out.append(SlaPolicyOut.model_validate(stored[priority]))
        else:
            response, resolution = DEFAULT_SLA_MINUTES[priority]
            out.append(
                SlaPolicyOut(
                    priority=priority, response_minutes=response, resolution_minutes=resolution
                )
            )
    return out


@router.put("/sla-policies/{priority}", response_model=SlaPolicyOut)
async def set_sla(
    priority: TicketPriority, body: SlaPolicyUpdate, db: DB, _: AdminUser
) -> SlaPolicy:
    if body.resolution_minutes < body.response_minutes:
        raise HTTPException(422, "O prazo de solução não pode ser menor que o de resposta")
    policy = await db.scalar(select(SlaPolicy).where(SlaPolicy.priority == priority))
    if policy is None:
        policy = SlaPolicy(priority=priority)
        db.add(policy)
    policy.response_minutes = body.response_minutes
    policy.resolution_minutes = body.resolution_minutes
    await db.commit()
    return policy
