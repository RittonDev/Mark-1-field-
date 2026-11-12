import uuid
from typing import Annotated, Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from sqlalchemy import func, or_, select

from app.api.deps import DB, CurrentUser, StaffUser, TicketManagerUser
from app.core.enums import AssetType, TicketStatus
from app.db.base import utcnow
from app.models import Asset, Customer, Location, Ticket, User
from app.schemas.common import Page
from app.schemas.customer import (
    AssetCreate,
    AssetOut,
    AssetUpdate,
    CustomerCreate,
    CustomerOut,
    CustomerUpdate,
    IntakeContext,
    IntakeCustomer,
    IntakeLastVisit,
    IntakeLocation,
    LocationCreate,
    LocationOut,
    LocationUpdate,
)
from app.schemas.records import dedupe_contacts, format_phone, primary_contact
from app.schemas.ticket import format_ticket_code
from app.services import field as field_rules
from app.services import geo, location_import, search
from app.services.location_import import LocationImportResult
from app.services.spreadsheet import SpreadsheetError
from app.services.tickets import visibility_clause
from app.services.workflow import OPEN_STATUSES

router = APIRouter(tags=["customers"])


async def _get_or_404(db: DB, model: type, obj_id: uuid.UUID, label: str):  # noqa: ANN202
    obj = await db.get(model, obj_id)
    if obj is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} não encontrado")
    return obj


# ------------------------------------------------------------------ métricas derivadas


async def _ticket_stats(
    db: DB, user: User, column: Any, ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict[str, Any]]:
    """OS abertas, total e data da última OS por cliente/local, no escopo visível do usuário."""
    if not ids:
        return {}
    conds = [column.in_(ids)]
    vis = visibility_clause(user)
    if vis is not None:
        conds.append(vis)
    rows = await db.execute(
        select(
            column,
            func.count(),
            func.count().filter(Ticket.status.in_(OPEN_STATUSES)),
            func.max(Ticket.created_at),
        )
        .where(*conds)
        .group_by(column)
    )
    return {
        key: {"total_tickets": total, "open_tickets": open_, "last_ticket_at": last}
        for key, total, open_, last in rows
    }


def _apply_contacts(target: Customer | Location, fields: dict[str, Any]) -> None:
    """Grava a lista de contatos e mantém os campos únicos (principal) em dia, se não vierem."""
    if fields.get("contacts") is None:
        fields.pop("contacts", None)
        return
    contacts = dedupe_contacts(fields.pop("contacts"))
    target.contacts = contacts
    email = primary_contact(contacts, "email")
    phone = primary_contact(contacts, "phone")
    if isinstance(target, Customer):
        if "email" not in fields:
            target.email = email["value"] if email else None
        if "phone" not in fields:
            target.phone = format_phone(phone["value"]) if phone else None
    else:
        if "contact_phone" not in fields:
            target.contact_phone = format_phone(phone["value"]) if phone else None
        if "contact_name" not in fields:
            target.contact_name = (phone or email or {}).get("name")


async def _customers_out(db: DB, user: User, customers: list[Customer]) -> list[CustomerOut]:
    ids = [c.id for c in customers]
    stats = await _ticket_stats(db, user, Ticket.customer_id, ids)
    counts: dict[uuid.UUID, int] = {}
    if ids:
        counts = dict(
            (
                await db.execute(
                    select(Location.customer_id, func.count())
                    .where(Location.customer_id.in_(ids))
                    .group_by(Location.customer_id)
                )
            ).all()
        )
    hidden = {} if user.is_staff else {"legacy": None}
    return [
        CustomerOut.model_validate(c).model_copy(
            update={**stats.get(c.id, {}), "locations_count": counts.get(c.id, 0), **hidden}
        )
        for c in customers
    ]


async def _locations_out(db: DB, user: User, locations: list[Location]) -> list[LocationOut]:
    stats = await _ticket_stats(db, user, Ticket.location_id, [loc.id for loc in locations])
    hidden = {} if user.is_staff else {"legacy": None}
    return [
        LocationOut.model_validate(loc).model_copy(update={**stats.get(loc.id, {}), **hidden})
        for loc in locations
    ]


# ------------------------------------------------------------------ clientes


@router.get("/customers", response_model=list[CustomerOut])
async def list_customers(db: DB, user: CurrentUser, q: str | None = None) -> list[CustomerOut]:
    stmt = select(Customer)
    # Busca por palavras (nome ou CNPJ/CPF), em qualquer ordem e sem acento.
    matched = search.all_words(q, [Customer.name], digit_columns=[Customer.document])
    if matched is not None:
        stmt = stmt.where(matched).order_by(
            search.rank(q, Customer.name, exact=[Customer.document]), Customer.name
        )
    else:
        stmt = stmt.order_by(Customer.name)
    return await _customers_out(db, user, list(await db.scalars(stmt)))


@router.post("/customers", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
async def create_customer(body: CustomerCreate, db: DB, user: TicketManagerUser) -> CustomerOut:
    fields = body.model_dump(exclude_unset=True)
    customer = Customer(is_active=True)
    _apply_contacts(customer, fields)
    for key, value in fields.items():
        setattr(customer, key, value)
    db.add(customer)
    await db.commit()
    return (await _customers_out(db, user, [customer]))[0]


@router.get("/customers/{customer_id}", response_model=CustomerOut)
async def get_customer(customer_id: uuid.UUID, db: DB, user: CurrentUser) -> CustomerOut:
    customer = await _get_or_404(db, Customer, customer_id, "Cliente")
    return (await _customers_out(db, user, [customer]))[0]


@router.patch("/customers/{customer_id}", response_model=CustomerOut)
async def update_customer(
    customer_id: uuid.UUID, body: CustomerUpdate, db: DB, user: TicketManagerUser
) -> CustomerOut:
    customer = await _get_or_404(db, Customer, customer_id, "Cliente")
    fields = body.model_dump(exclude_unset=True)
    _apply_contacts(customer, fields)
    for key, value in fields.items():
        setattr(customer, key, value)
    await db.commit()
    return (await _customers_out(db, user, [customer]))[0]


# ------------------------------------------------------------------ locais (filiais)


@router.get("/customers/{customer_id}/locations", response_model=list[LocationOut])
async def customer_locations(
    customer_id: uuid.UUID, db: DB, user: CurrentUser
) -> list[LocationOut]:
    locations = await db.scalars(
        select(Location).where(Location.customer_id == customer_id).order_by(Location.name)
    )
    return await _locations_out(db, user, list(locations))


@router.post(
    "/customers/{customer_id}/locations",
    response_model=LocationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_location(
    customer_id: uuid.UUID, body: LocationCreate, db: DB, user: TicketManagerUser
) -> LocationOut:
    await _get_or_404(db, Customer, customer_id, "Cliente")
    fields = body.model_dump(exclude_unset=True)
    location = Location(customer_id=customer_id, is_active=True)
    _apply_contacts(location, fields)
    for key, value in fields.items():
        setattr(location, key, value)
    db.add(location)
    await db.commit()
    loaded = await db.get(Location, location.id, populate_existing=True)
    return (await _locations_out(db, user, [loaded]))[0]  # type: ignore[list-item]


@router.get("/locations", response_model=Page[LocationOut])
async def list_locations(
    db: DB,
    user: CurrentUser,
    customer_id: uuid.UUID | None = None,
    q: str | None = None,
    active: bool | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
) -> Page[LocationOut]:
    """Locais como cadastro próprio: busca por nome, código, CNPJ, endereço ou cliente."""
    conds: list[Any] = []
    if customer_id is not None:
        conds.append(Location.customer_id == customer_id)
    if active is not None:
        conds.append(Location.is_active.is_(active))
    # Busca por palavras: cada uma em nome, código, cidade, bairro, endereço ou cliente (ou nos
    # dígitos do CNPJ), em qualquer ordem e sem acento ("Le Biscuit Iguatemi Fortaleza").
    matched = search.all_words(
        q,
        [
            Location.name,
            Location.code,
            Location.city,
            Location.district,
            Location.address_line,
            Customer.name,
        ],
        digit_columns=[Location.document],
    )
    if matched is not None:
        conds.append(matched)
    base = select(Location).join(Customer, Customer.id == Location.customer_id).where(*conds)
    total = await db.scalar(select(func.count()).select_from(base.subquery())) or 0
    order: list[Any] = [Customer.name, Location.name]
    if matched is not None:
        # Código exato e nome que começa com a busca vêm primeiro.
        order.insert(0, search.rank(q, Location.name, exact=[Location.code, Location.document]))
    rows = await db.scalars(base.order_by(*order).offset((page - 1) * page_size).limit(page_size))
    return Page(
        items=await _locations_out(db, user, list(rows)),
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/locations/{location_id}", response_model=LocationOut)
async def get_location(location_id: uuid.UUID, db: DB, user: CurrentUser) -> LocationOut:
    location = await _get_or_404(db, Location, location_id, "Local")
    return (await _locations_out(db, user, [location]))[0]


UPCOMING_DAYS = 7


async def _last_visit(db: DB, location_id: uuid.UUID) -> IntakeLastVisit | None:
    done_at = func.coalesce(Ticket.resolved_at, Ticket.closed_at)
    row = (
        await db.execute(
            select(Ticket, done_at)
            .where(
                Ticket.location_id == location_id,
                Ticket.status.in_((TicketStatus.RESOLVED, TicketStatus.CLOSED)),
                done_at.is_not(None),
            )
            .order_by(done_at.desc())
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    ticket, at = row
    return IntakeLastVisit(
        ticket_id=ticket.id,
        code=format_ticket_code(ticket.number),
        title=ticket.title,
        at=at,
        technician=ticket.assignee.name if ticket.assignee else None,
    )


@router.get("/intake/context", response_model=IntakeContext)
async def intake_context(
    db: DB,
    user: TicketManagerUser,
    customer_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
) -> IntakeContext:
    """Contexto para abrir a OS: o cliente (etiquetas, avaliação, OS agendadas nos próximos
    dias) e a loja (endereço, contato, histórico, última visita e prazo de chegada)."""
    now = utcnow()
    location = await _get_or_404(db, Location, location_id, "Local") if location_id else None
    if location is not None:
        customer_id = location.customer_id
    customer = await _get_or_404(db, Customer, customer_id, "Cliente") if customer_id else None
    out = IntakeContext(upcoming_days=UPCOMING_DAYS)

    if customer is not None:
        stats = (await _ticket_stats(db, user, Ticket.customer_id, [customer.id])).get(
            customer.id, {}
        )
        upcoming = await db.scalar(
            select(func.count()).where(
                Ticket.customer_id == customer.id,
                Ticket.status.in_(OPEN_STATUSES),
                Ticket.scheduled_start >= now,
                Ticket.scheduled_start < now + timedelta(days=UPCOMING_DAYS),
            )
        )
        rating = (customer.legacy or {}).get("rating") or {}
        average = rating.get("average") or None
        out.customer = IntakeCustomer(
            id=customer.id,
            name=customer.name,
            tags=customer.tags or [],
            notes=customer.notes,
            rating_average=round(float(average), 1) if average else None,
            rating_last=int(rating["last_star"]) if rating.get("last_star") else None,
            total_tickets=stats.get("total_tickets", 0),
            open_tickets=stats.get("open_tickets", 0),
            upcoming=upcoming or 0,
        )

    if location is not None:
        stats = (await _ticket_stats(db, user, Ticket.location_id, [location.id])).get(
            location.id, {}
        )
        recent = await db.scalar(
            select(func.count()).where(
                Ticket.location_id == location.id,
                Ticket.created_at >= now - timedelta(days=30),
            )
        )
        rules = await field_rules.rules(db)
        valid = geo.valid_coords(location.latitude, location.longitude)
        out.location = IntakeLocation(
            id=location.id,
            name=location.name,
            code=location.code,
            address_line=location.address_line,
            district=location.district,
            city=location.city,
            state=location.state,
            zip_code=location.zip_code,
            latitude=location.latitude if valid else None,
            longitude=location.longitude if valid else None,
            contact_name=location.contact_name,
            contact_phone=location.contact_phone,
            notes=location.notes,
            total_tickets=stats.get("total_tickets", 0),
            open_tickets=stats.get("open_tickets", 0),
            tickets_30d=recent or 0,
            last_visit=await _last_visit(db, location.id),
            is_capital=field_rules.is_capital(location.city, location.state),
            arrival_hours=field_rules.arrival_hours(rules, location.city, location.state),
        )
    return out


@router.patch("/locations/{location_id}", response_model=LocationOut)
async def update_location(
    location_id: uuid.UUID, body: LocationUpdate, db: DB, user: TicketManagerUser
) -> LocationOut:
    location = await _get_or_404(db, Location, location_id, "Local")
    fields = body.model_dump(exclude_unset=True)
    _apply_contacts(location, fields)
    for key, value in fields.items():
        setattr(location, key, value)
    await db.commit()
    return (await _locations_out(db, user, [location]))[0]


# ------------------------------------------------------------------ ativos


@router.get("/assets", response_model=list[AssetOut])
async def list_assets(
    db: DB,
    _: CurrentUser,
    customer_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
    asset_type: AssetType | None = None,
    q: str | None = None,
) -> list[Asset]:
    stmt = select(Asset).order_by(Asset.name)
    if customer_id is not None:
        stmt = stmt.where(Asset.customer_id == customer_id)
    if location_id is not None:
        stmt = stmt.where(Asset.location_id == location_id)
    if asset_type is not None:
        stmt = stmt.where(Asset.asset_type == asset_type)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Asset.name.ilike(like),
                Asset.serial_number.ilike(like),
                Asset.asset_tag.ilike(like),
                Asset.ip_address.ilike(like),
                Asset.model.ilike(like),
            )
        )
    return list(await db.scalars(stmt.limit(1000)))


async def _check_asset_location(
    db: DB, customer_id: uuid.UUID, location_id: uuid.UUID | None
) -> None:
    if location_id is None:
        return
    location = await db.get(Location, location_id)
    if location is None or location.customer_id != customer_id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "O local não pertence ao cliente do ativo"
        )


@router.post("/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def create_asset(body: AssetCreate, db: DB, _: StaffUser) -> Asset:
    await _get_or_404(db, Customer, body.customer_id, "Cliente")
    await _check_asset_location(db, body.customer_id, body.location_id)
    asset = Asset(**body.model_dump(), is_active=True)
    db.add(asset)
    await db.commit()
    return await db.get(Asset, asset.id, populate_existing=True)  # type: ignore[return-value]


@router.get("/assets/{asset_id}", response_model=AssetOut)
async def get_asset(asset_id: uuid.UUID, db: DB, _: CurrentUser) -> Asset:
    return await _get_or_404(db, Asset, asset_id, "Ativo")


@router.patch("/assets/{asset_id}", response_model=AssetOut)
async def update_asset(asset_id: uuid.UUID, body: AssetUpdate, db: DB, _: StaffUser) -> Asset:
    asset = await _get_or_404(db, Asset, asset_id, "Ativo")
    fields = body.model_dump(exclude_unset=True)
    if "location_id" in fields:
        await _check_asset_location(db, asset.customer_id, fields["location_id"])
    for key, value in fields.items():
        setattr(asset, key, value)
    await db.commit()
    return await db.get(Asset, asset.id, populate_existing=True)  # type: ignore[return-value]


# ------------------------------------------------------- importação de locais


@router.post("/locations/import", response_model=LocationImportResult)
async def import_locations(
    db: DB,
    _: TicketManagerUser,
    file: Annotated[UploadFile, File()],
    dry_run: bool = True,
    customer_id: uuid.UUID | None = None,
) -> LocationImportResult:
    """Base de locais por planilha CSV ou XLSX. Por padrão só a prévia; dry_run=false grava."""
    data = await file.read()
    try:
        result = await location_import.import_locations(
            db, file.filename or "", data, dry_run, customer_id
        )
    except SpreadsheetError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    if not dry_run:
        await db.commit()
    return result
