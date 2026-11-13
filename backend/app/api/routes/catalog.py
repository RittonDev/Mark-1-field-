import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import or_, select

from app.api.deps import DB, AdminUser, ManagerUser, NoTechnicianUser, StaffUser, TicketManagerUser
from app.core.access import channel_metadata
from app.core.enums import TicketPriority
from app.core.labels import enum_options
from app.models import (
    Category,
    Customer,
    ServiceType,
    SlaPolicy,
    Team,
    UnproductiveReason,
    ViolationReason,
)
from app.schemas.catalog import (
    CategoryCreate,
    CategoryOut,
    CategoryUpdate,
    ServiceTypeCreate,
    ServiceTypeOut,
    ServiceTypeUpdate,
    SlaPolicyOut,
    SlaPolicyUpdate,
    UnproductiveReasonCreate,
    UnproductiveReasonOut,
    UnproductiveReasonUpdate,
    ViolationReasonCreate,
    ViolationReasonOut,
    ViolationReasonUpdate,
)
from app.services import durations
from app.services.sla import DEFAULT_SLA_MINUTES
from app.services.workflow import workflow_metadata

router = APIRouter(tags=["catalog"])


@router.get("/meta")
async def meta() -> dict:
    """Status, transições, prioridades e rótulos. Público (o app lê antes do login)."""
    return {
        **workflow_metadata(),
        **enum_options(),
        "access_channels": channel_metadata(),
    }


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
async def list_categories(db: DB, _: NoTechnicianUser) -> list[Category]:
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
async def list_sla(db: DB, _: NoTechnicianUser) -> list[SlaPolicyOut]:
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


# ------------------------------------------------------------------ tipos de serviço


async def _service_types_out(db: DB, types: list[ServiceType]) -> list[ServiceTypeOut]:
    stats = await durations.observed_stats(db, [t.id for t in types])
    out = []
    for t in types:
        observed = stats.get(t.id, {})
        out.append(
            ServiceTypeOut.model_validate(t).model_copy(
                update={
                    **observed,
                    "suggested_minutes": durations.suggested_minutes(
                        t.estimated_minutes,
                        observed.get("observed_median_minutes"),
                        observed.get("observed_count", 0),
                    ),
                }
            )
        )
    return out


async def _load_service_type(db: DB, service_type_id: uuid.UUID) -> ServiceType:
    service_type = await db.scalar(
        select(ServiceType)
        .where(ServiceType.id == service_type_id)
        .execution_options(populate_existing=True)
    )
    if service_type is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tipo de serviço não encontrado")
    return service_type


@router.get("/service-types", response_model=list[ServiceTypeOut])
async def list_service_types(
    db: DB,
    _: TicketManagerUser,
    customer_id: uuid.UUID | None = None,
    q: str | None = None,
    active: bool | None = None,
) -> list[ServiceTypeOut]:
    """Com `customer_id`: os tipos gerais + os do catálogo daquele cliente (para a Nova OS)."""
    stmt = select(ServiceType).order_by(ServiceType.name)
    if customer_id is not None:
        stmt = stmt.where(
            or_(ServiceType.customer_id.is_(None), ServiceType.customer_id == customer_id)
        )
    if active is not None:
        stmt = stmt.where(ServiceType.is_active.is_(active))
    if q:
        stmt = stmt.where(ServiceType.name.ilike(f"%{q.strip()}%"))
    return await _service_types_out(db, list(await db.scalars(stmt)))


async def _check_service_type_refs(
    db: DB, customer_id: uuid.UUID | None, category_id: uuid.UUID | None
) -> None:
    if customer_id is not None and await db.get(Customer, customer_id) is None:
        raise HTTPException(422, "Cliente não encontrado")
    if category_id is not None and await db.get(Category, category_id) is None:
        raise HTTPException(422, "Categoria não encontrada")


@router.post("/service-types", response_model=ServiceTypeOut, status_code=status.HTTP_201_CREATED)
async def create_service_type(
    body: ServiceTypeCreate, db: DB, _: TicketManagerUser
) -> ServiceTypeOut:
    await _check_service_type_refs(db, body.customer_id, body.category_id)
    service_type = ServiceType(**body.model_dump(), is_active=True)
    db.add(service_type)
    await db.commit()
    return (await _service_types_out(db, [await _load_service_type(db, service_type.id)]))[0]


@router.patch("/service-types/{service_type_id}", response_model=ServiceTypeOut)
async def update_service_type(
    service_type_id: uuid.UUID, body: ServiceTypeUpdate, db: DB, _: TicketManagerUser
) -> ServiceTypeOut:
    service_type = await _load_service_type(db, service_type_id)
    fields = body.model_dump(exclude_unset=True)
    await _check_service_type_refs(db, None, fields.get("category_id"))
    for key, value in fields.items():
        setattr(service_type, key, value)
    await db.commit()
    return (await _service_types_out(db, [await _load_service_type(db, service_type_id)]))[0]


@router.post("/service-types/{service_type_id}/apply-observed", response_model=ServiceTypeOut)
async def apply_observed_duration(
    service_type_id: uuid.UUID, db: DB, _: TicketManagerUser
) -> ServiceTypeOut:
    """A estimativa aprende: adota a mediana observada (arredondada a 5 min)."""
    service_type = await _load_service_type(db, service_type_id)
    current = (await _service_types_out(db, [service_type]))[0]
    if current.suggested_minutes is None:
        raise HTTPException(
            422, "Sem sugestão: poucas OS concluídas ou a estimativa já está próxima do real"
        )
    service_type.estimated_minutes = current.suggested_minutes
    await db.commit()
    return (await _service_types_out(db, [await _load_service_type(db, service_type_id)]))[0]


# ------------------------------------------------------------------ motivos de violação


@router.get("/violation-reasons", response_model=list[ViolationReasonOut])
async def list_violation_reasons(
    db: DB, _: StaffUser, active: bool | None = None
) -> list[ViolationReason]:
    stmt = select(ViolationReason).order_by(ViolationReason.name)
    if active is not None:
        stmt = stmt.where(ViolationReason.is_active.is_(active))
    return list(await db.scalars(stmt))


@router.post(
    "/violation-reasons", response_model=ViolationReasonOut, status_code=status.HTTP_201_CREATED
)
async def create_violation_reason(
    body: ViolationReasonCreate, db: DB, _: ManagerUser
) -> ViolationReason:
    reason = ViolationReason(**body.model_dump(), is_active=True)
    db.add(reason)
    await db.commit()
    return reason


@router.patch("/violation-reasons/{reason_id}", response_model=ViolationReasonOut)
async def update_violation_reason(
    reason_id: uuid.UUID, body: ViolationReasonUpdate, db: DB, _: ManagerUser
) -> ViolationReason:
    reason = await db.get(ViolationReason, reason_id)
    if reason is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Motivo não encontrado")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(reason, key, value)
    await db.commit()
    return reason


# ------------------------------------------------------- motivos de visita improdutiva


@router.get("/unproductive-reasons", response_model=list[UnproductiveReasonOut])
async def list_unproductive_reasons(
    db: DB, _: StaffUser, active: bool | None = None
) -> list[UnproductiveReason]:
    stmt = select(UnproductiveReason).order_by(UnproductiveReason.name)
    if active is not None:
        stmt = stmt.where(UnproductiveReason.is_active.is_(active))
    return list(await db.scalars(stmt))


@router.post(
    "/unproductive-reasons",
    response_model=UnproductiveReasonOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_unproductive_reason(
    body: UnproductiveReasonCreate, db: DB, _: TicketManagerUser
) -> UnproductiveReason:
    reason = UnproductiveReason(**body.model_dump(), is_active=True)
    db.add(reason)
    await db.commit()
    return reason


@router.patch("/unproductive-reasons/{reason_id}", response_model=UnproductiveReasonOut)
async def update_unproductive_reason(
    reason_id: uuid.UUID, body: UnproductiveReasonUpdate, db: DB, _: TicketManagerUser
) -> UnproductiveReason:
    reason = await db.get(UnproductiveReason, reason_id)
    if reason is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Motivo não encontrado")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(reason, key, value)
    await db.commit()
    return reason
