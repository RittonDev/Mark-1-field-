import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func, or_, select

from app.api.deps import DB, AdminUser, StaffUser, TicketManagerUser, access_user
from app.core.access import channel_metadata
from app.core.config import settings
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
from app.schemas.tech_profile import (
    TechCatalogItemCreate,
    TechCatalogItemOut,
    TechCatalogItemUpdate,
)
from app.services import durations, technician_catalogs, technician_levels
from app.services.sla import DEFAULT_SLA_MINUTES
from app.services.technician_catalogs import Kind
from app.services.workflow import workflow_metadata

router = APIRouter(tags=["catalog"])

# Categorias, motivos de violação e os catálogos dos técnicos (Ferramental, Áreas de atuação e
# Aptidões) ficam em Configurações; tipos de serviço têm tela própria. O SLA continua só com o
# administrador; os motivos de improdutiva, com toda a gestão.
SettingsEdit = access_user("setup.settings", level="edit")
ServiceTypesEdit = access_user("setup.service_types", level="edit")


@router.get("/meta")
async def meta() -> dict:
    """Status, transições, prioridades e rótulos. Público (o app lê antes do login).
    `mail_enabled`: o envio de e-mail está ligado (SMTP configurado); desligado, a central segue
    pelo WhatsApp e pela senha provisória."""
    return {
        **workflow_metadata(),
        **enum_options(),
        "access_channels": channel_metadata(),
        "mail_enabled": settings.mail_enabled,
    }


async def _load_category(db: DB, category_id: uuid.UUID) -> Category:
    category = await db.scalar(
        select(Category).where(Category.id == category_id).execution_options(populate_existing=True)
    )
    if category is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Categoria não encontrada")
    return category


MAX_CATEGORY_DEPTH = 10
CATEGORY_CYCLE = "A categoria não pode ficar dentro de uma subcategoria dela mesma"


def _clean(fields: dict[str, Any], required: tuple[str, ...]) -> dict[str, Any]:
    """null num campo obrigatório não apaga nada (o formulário mandou vazio); nome sem espaços
    sobrando."""
    for key in required:
        if key in fields and fields[key] is None:
            fields.pop(key)
    if isinstance(fields.get("name"), str):
        fields["name"] = " ".join(fields["name"].split())
    return fields


async def _check_category_refs(
    db: DB, parent_id: uuid.UUID | None, team_id: uuid.UUID | None, self_id: uuid.UUID | None
) -> None:
    if parent_id is not None:
        if parent_id == self_id:
            raise HTTPException(422, "Uma categoria não pode ser pai dela mesma")
        parent = await db.get(Category, parent_id)
        if parent is None:
            raise HTTPException(422, "Categoria pai não encontrada")
        # Subindo a cadeia de pais do novo pai, a própria categoria não pode aparecer (ciclo:
        # "A > B > A" no nome completo).
        node, depth = parent, 0
        while self_id is not None and node is not None and depth < MAX_CATEGORY_DEPTH:
            if node.parent_id == self_id:
                raise HTTPException(422, CATEGORY_CYCLE)
            node = await db.get(Category, node.parent_id) if node.parent_id else None
            depth += 1
    if team_id is not None and await db.get(Team, team_id) is None:
        raise HTTPException(422, "Grupo não encontrado")


async def _check_category_name(
    db: DB, name: str, parent_id: uuid.UUID | None, self_id: uuid.UUID | None
) -> None:
    """Nome repetido no mesmo nível (inclusive na raiz, que o banco não pega: pai nulo)."""
    stmt = select(Category.id).where(
        func.lower(Category.name) == name.lower(),
        Category.parent_id.is_(None) if parent_id is None else Category.parent_id == parent_id,
    )
    if self_id is not None:
        stmt = stmt.where(Category.id != self_id)
    if await db.scalar(stmt.limit(1)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Já existe uma categoria com este nome aqui")


@router.get("/categories", response_model=list[CategoryOut])
async def list_categories(db: DB, _: TicketManagerUser) -> list[Category]:
    categories = list(await db.scalars(select(Category)))
    return sorted(categories, key=lambda c: c.full_name.lower())


@router.post("/categories", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
async def create_category(body: CategoryCreate, db: DB, _: SettingsEdit) -> Category:
    fields = _clean(body.model_dump(), ())
    await _check_category_refs(db, body.parent_id, body.default_team_id, None)
    await _check_category_name(db, fields["name"], body.parent_id, None)
    category = Category(**fields, is_active=True)
    db.add(category)
    await db.commit()
    return await _load_category(db, category.id)


@router.patch("/categories/{category_id}", response_model=CategoryOut)
async def update_category(
    category_id: uuid.UUID, body: CategoryUpdate, db: DB, _: SettingsEdit
) -> Category:
    category = await _load_category(db, category_id)
    fields = _clean(body.model_dump(exclude_unset=True), ("name", "is_active"))
    parent_id = fields.get("parent_id", category.parent_id)
    await _check_category_refs(
        db, parent_id, fields.get("default_team_id", category.default_team_id), category.id
    )
    if "name" in fields or "parent_id" in fields:
        await _check_category_name(db, fields.get("name", category.name), parent_id, category.id)
    for key, value in fields.items():
        setattr(category, key, value)
    await db.commit()
    return await _load_category(db, category.id)


@router.get("/sla-policies", response_model=list[SlaPolicyOut])
async def list_sla(db: DB, _: TicketManagerUser) -> list[SlaPolicyOut]:
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


async def _check_service_type_name(
    db: DB, name: str, customer_id: uuid.UUID | None, self_id: uuid.UUID | None
) -> None:
    """Nome repetido no catálogo do cliente ou entre os gerais (cliente nulo, que o banco não
    pega), sem diferença de maiúsculas."""
    stmt = select(ServiceType.id).where(
        func.lower(ServiceType.name) == name.lower(),
        ServiceType.customer_id.is_(None)
        if customer_id is None
        else ServiceType.customer_id == customer_id,
    )
    if self_id is not None:
        stmt = stmt.where(ServiceType.id != self_id)
    if await db.scalar(stmt.limit(1)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Já existe um tipo de serviço com este nome")


@router.post("/service-types", response_model=ServiceTypeOut, status_code=status.HTTP_201_CREATED)
async def create_service_type(
    body: ServiceTypeCreate, db: DB, _: ServiceTypesEdit
) -> ServiceTypeOut:
    fields = _clean(body.model_dump(), ())
    await _check_service_type_refs(db, body.customer_id, body.category_id)
    await _check_service_type_name(db, fields["name"], body.customer_id, None)
    service_type = ServiceType(**fields, is_active=True)
    db.add(service_type)
    await db.commit()
    return (await _service_types_out(db, [await _load_service_type(db, service_type.id)]))[0]


@router.patch("/service-types/{service_type_id}", response_model=ServiceTypeOut)
async def update_service_type(
    service_type_id: uuid.UUID, body: ServiceTypeUpdate, db: DB, _: ServiceTypesEdit
) -> ServiceTypeOut:
    service_type = await _load_service_type(db, service_type_id)
    fields = _clean(body.model_dump(exclude_unset=True), ("name", "estimated_minutes", "is_active"))
    await _check_service_type_refs(db, None, fields.get("category_id"))
    if "name" in fields:
        await _check_service_type_name(
            db, fields["name"], service_type.customer_id, service_type.id
        )
    for key, value in fields.items():
        setattr(service_type, key, value)
    await db.commit()
    return (await _service_types_out(db, [await _load_service_type(db, service_type_id)]))[0]


@router.post("/service-types/{service_type_id}/apply-observed", response_model=ServiceTypeOut)
async def apply_observed_duration(
    service_type_id: uuid.UUID, db: DB, _: ServiceTypesEdit
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
    db: DB, _: TicketManagerUser, active: bool | None = None
) -> list[ViolationReason]:
    """Motivos de violação de SLA: só a gestão (o técnico é terceiro e não vê nada de SLA)."""
    stmt = select(ViolationReason).order_by(ViolationReason.name)
    if active is not None:
        stmt = stmt.where(ViolationReason.is_active.is_(active))
    return list(await db.scalars(stmt))


@router.post(
    "/violation-reasons", response_model=ViolationReasonOut, status_code=status.HTTP_201_CREATED
)
async def create_violation_reason(
    body: ViolationReasonCreate, db: DB, _: SettingsEdit
) -> ViolationReason:
    reason = ViolationReason(**_clean(body.model_dump(), ()), is_active=True)
    db.add(reason)
    await db.commit()
    return reason


@router.patch("/violation-reasons/{reason_id}", response_model=ViolationReasonOut)
async def update_violation_reason(
    reason_id: uuid.UUID, body: ViolationReasonUpdate, db: DB, _: SettingsEdit
) -> ViolationReason:
    reason = await db.get(ViolationReason, reason_id)
    if reason is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Motivo não encontrado")
    fields = _clean(
        body.model_dump(exclude_unset=True), ("name", "applies_to", "responsibility", "is_active")
    )
    for key, value in fields.items():
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
    reason = UnproductiveReason(**_clean(body.model_dump(), ()), is_active=True)
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
    fields = _clean(body.model_dump(exclude_unset=True), ("name", "responsibility", "is_active"))
    # Vale a classificação atual: as visitas antigas com este motivo passam a contar (ou deixam
    # de contar) no elo dos técnicos, recalculado na próxima rodada da rotina.
    reclassified = fields.get("responsibility", reason.responsibility) != reason.responsibility
    for key, value in fields.items():
        setattr(reason, key, value)
    if reclassified:
        await technician_levels.mark_stale(db)
    await db.commit()
    return reason


# ------------------------------------------------- catálogos de Configurações › Técnicos
# Ferramental (/technician-tools), Áreas de atuação (/technician-areas) e Aptidões
# (/technician-skills), com uma regra só (services/technician_catalogs.py): o técnico guarda os ids
# (users.tool_ids, users.service_areas, users.skills[].skill_id; a ficha da homologação, as áreas e
# as aptidões). Qualquer pessoa da equipe lê, em ordem alfabética: o técnico (o app) só os ativos,
# sem as contagens e com o `active` ignorado; a gestão filtra por `active` e vê `technicians`,
# `applications` e `in_use`. Configurações em Editar inclui, renomeia (vale para todos) e desativa
# (some das escolhas e fica com quem tinha; reativado, volta); exclui só o que nunca foi usado, e o
# usado volta 409 CATALOG_IN_USE ("desative"). Sem ordem manual.


async def _create(db: DB, kind: Kind, body: TechCatalogItemCreate) -> TechCatalogItemOut:
    item = await technician_catalogs.create(db, kind, body.name)
    await db.commit()
    return item


async def _update(
    db: DB, kind: Kind, item_id: uuid.UUID, body: TechCatalogItemUpdate
) -> TechCatalogItemOut:
    item = await technician_catalogs.update(db, kind, item_id, body)
    await db.commit()
    return item


async def _delete(db: DB, kind: Kind, item_id: uuid.UUID) -> Response:
    await technician_catalogs.delete(db, kind, item_id)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/technician-tools", response_model=list[TechCatalogItemOut])
async def list_technician_tools(
    db: DB, user: StaffUser, active: bool | None = None
) -> list[TechCatalogItemOut]:
    """O Ferramental. `technicians`: os do papel técnico, com ou sem acesso, que marcaram (a mesma
    regra do filtro `tool_id` de GET /technicians); `applications`: sempre 0 (a ficha tem o
    ferramental em texto livre)."""
    return await technician_catalogs.list_items(db, "tool", user, active)


@router.post(
    "/technician-tools", response_model=TechCatalogItemOut, status_code=status.HTTP_201_CREATED
)
async def create_technician_tool(
    body: TechCatalogItemCreate, db: DB, _: SettingsEdit
) -> TechCatalogItemOut:
    """Ferramenta nova, já ativa: 2 a 80 caracteres; repetida (sem acento e sem maiúsculas,
    também entre as desativadas) 409 CATALOG_NAME_TAKEN; até 200 no catálogo."""
    return await _create(db, "tool", body)


@router.patch("/technician-tools/{tool_id}", response_model=TechCatalogItemOut)
async def update_technician_tool(
    tool_id: uuid.UUID, body: TechCatalogItemUpdate, db: DB, _: SettingsEdit
) -> TechCatalogItemOut:
    """Só o que vier muda (null é ignorado): renomear ou desativar/reativar."""
    return await _update(db, "tool", tool_id, body)


@router.delete("/technician-tools/{tool_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_technician_tool(tool_id: uuid.UUID, db: DB, _: SettingsEdit) -> Response:
    """Só a ferramenta nunca usada; com uso, 409 CATALOG_IN_USE (desative)."""
    return await _delete(db, "tool", tool_id)


@router.get("/technician-areas", response_model=list[TechCatalogItemOut])
async def list_technician_areas(
    db: DB, user: StaffUser, active: bool | None = None
) -> list[TechCatalogItemOut]:
    """As Áreas de atuação. `technicians`: os do papel técnico, com ou sem acesso, que têm a área;
    `applications`: as fichas da homologação (de qualquer situação) que a citam."""
    return await technician_catalogs.list_items(db, "area", user, active)


@router.post(
    "/technician-areas", response_model=TechCatalogItemOut, status_code=status.HTTP_201_CREATED
)
async def create_technician_area(
    body: TechCatalogItemCreate, db: DB, _: SettingsEdit
) -> TechCatalogItemOut:
    """Área nova, já ativa (sem o código das 10 áreas de antes): 2 a 80 caracteres; repetida 409
    CATALOG_NAME_TAKEN; até 100 no catálogo."""
    return await _create(db, "area", body)


@router.patch("/technician-areas/{area_id}", response_model=TechCatalogItemOut)
async def update_technician_area(
    area_id: uuid.UUID, body: TechCatalogItemUpdate, db: DB, _: SettingsEdit
) -> TechCatalogItemOut:
    """Só o que vier muda (null é ignorado): renomear ou desativar/reativar."""
    return await _update(db, "area", area_id, body)


@router.delete("/technician-areas/{area_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_technician_area(area_id: uuid.UUID, db: DB, _: SettingsEdit) -> Response:
    """Só a área nunca usada; com uso, 409 CATALOG_IN_USE (desative)."""
    return await _delete(db, "area", area_id)


@router.get("/technician-skills", response_model=list[TechCatalogItemOut])
async def list_technician_skills(
    db: DB, user: StaffUser, active: bool | None = None
) -> list[TechCatalogItemOut]:
    """As Aptidões. `technicians`: os do papel técnico, com ou sem acesso, que têm a aptidão;
    `applications`: as fichas da homologação (de qualquer situação) que a citam."""
    return await technician_catalogs.list_items(db, "skill", user, active)


@router.post(
    "/technician-skills", response_model=TechCatalogItemOut, status_code=status.HTTP_201_CREATED
)
async def create_technician_skill(
    body: TechCatalogItemCreate, db: DB, _: SettingsEdit
) -> TechCatalogItemOut:
    """Aptidão nova, já ativa: 2 a 80 caracteres; repetida 409 CATALOG_NAME_TAKEN; até 300 no
    catálogo."""
    return await _create(db, "skill", body)


@router.patch("/technician-skills/{skill_id}", response_model=TechCatalogItemOut)
async def update_technician_skill(
    skill_id: uuid.UUID, body: TechCatalogItemUpdate, db: DB, _: SettingsEdit
) -> TechCatalogItemOut:
    """Só o que vier muda (null é ignorado): renomear ou desativar/reativar."""
    return await _update(db, "skill", skill_id, body)


@router.delete("/technician-skills/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_technician_skill(skill_id: uuid.UUID, db: DB, _: SettingsEdit) -> Response:
    """Só a aptidão nunca usada; com uso, 409 CATALOG_IN_USE (desative)."""
    return await _delete(db, "skill", skill_id)
