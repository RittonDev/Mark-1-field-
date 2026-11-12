import re
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from sqlalchemy import func, or_, select

from app.api.deps import DB, CurrentUser, StaffUser, TicketManagerUser
from app.core.enums import AssetType
from app.models import Asset, Customer, Location, Ticket, User
from app.schemas.common import Page
from app.schemas.customer import (
    AssetCreate,
    AssetOut,
    AssetUpdate,
    CustomerCreate,
    CustomerOut,
    CustomerUpdate,
    LocationCreate,
    LocationOut,
    LocationUpdate,
)
from app.services import location_import
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
    return [
        CustomerOut.model_validate(c).model_copy(
            update={**stats.get(c.id, {}), "locations_count": counts.get(c.id, 0)}
        )
        for c in customers
    ]


async def _locations_out(db: DB, user: User, locations: list[Location]) -> list[LocationOut]:
    stats = await _ticket_stats(db, user, Ticket.location_id, [loc.id for loc in locations])
    return [
        LocationOut.model_validate(loc).model_copy(update=stats.get(loc.id, {}))
        for loc in locations
    ]


# ------------------------------------------------------------------ clientes


@router.get("/customers", response_model=list[CustomerOut])
async def list_customers(db: DB, user: CurrentUser, q: str | None = None) -> list[CustomerOut]:
    stmt = select(Customer).order_by(Customer.name)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Customer.name.ilike(like), Customer.document.ilike(like)))
    return await _customers_out(db, user, list(await db.scalars(stmt)))


@router.post("/customers", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
async def create_customer(body: CustomerCreate, db: DB, user: TicketManagerUser) -> CustomerOut:
    customer = Customer(**body.model_dump(), is_active=True)
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
    for key, value in body.model_dump(exclude_unset=True).items():
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
    location = Location(customer_id=customer_id, **body.model_dump(), is_active=True)
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
    if q and q.strip():
        like = f"%{q.strip()}%"
        text_match = [
            Location.name.ilike(like),
            Location.code.ilike(like),
            Location.city.ilike(like),
            Location.district.ilike(like),
            Location.address_line.ilike(like),
            Customer.name.ilike(like),
        ]
        doc = re.sub(r"[^0-9A-Za-z]", "", q).upper()
        if len(doc) >= 3:
            text_match.append(Location.document.ilike(f"%{doc}%"))
        conds.append(or_(*text_match))
    base = select(Location).join(Customer, Customer.id == Location.customer_id).where(*conds)
    total = await db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = await db.scalars(
        base.order_by(Customer.name, Location.name).offset((page - 1) * page_size).limit(page_size)
    )
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


@router.patch("/locations/{location_id}", response_model=LocationOut)
async def update_location(
    location_id: uuid.UUID, body: LocationUpdate, db: DB, user: TicketManagerUser
) -> LocationOut:
    location = await _get_or_404(db, Location, location_id, "Local")
    for key, value in body.model_dump(exclude_unset=True).items():
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
