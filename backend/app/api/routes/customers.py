import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import or_, select

from app.api.deps import DB, CurrentUser, StaffUser, TicketManagerUser
from app.core.enums import AssetType
from app.models import Asset, Customer, Location
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

router = APIRouter(tags=["customers"])


async def _get_or_404(db: DB, model: type, obj_id: uuid.UUID, label: str):  # noqa: ANN202
    obj = await db.get(model, obj_id)
    if obj is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} não encontrado")
    return obj


# ------------------------------------------------------------------ clientes


@router.get("/customers", response_model=list[CustomerOut])
async def list_customers(db: DB, _: CurrentUser, q: str | None = None) -> list[Customer]:
    stmt = select(Customer).order_by(Customer.name)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Customer.name.ilike(like), Customer.document.ilike(like)))
    return list(await db.scalars(stmt))


@router.post("/customers", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
async def create_customer(body: CustomerCreate, db: DB, _: TicketManagerUser) -> Customer:
    customer = Customer(**body.model_dump(), is_active=True)
    db.add(customer)
    await db.commit()
    return customer


@router.get("/customers/{customer_id}", response_model=CustomerOut)
async def get_customer(customer_id: uuid.UUID, db: DB, _: CurrentUser) -> Customer:
    return await _get_or_404(db, Customer, customer_id, "Cliente")


@router.patch("/customers/{customer_id}", response_model=CustomerOut)
async def update_customer(
    customer_id: uuid.UUID, body: CustomerUpdate, db: DB, _: TicketManagerUser
) -> Customer:
    customer = await _get_or_404(db, Customer, customer_id, "Cliente")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(customer, key, value)
    await db.commit()
    return customer


# ------------------------------------------------------------------ locais


@router.get("/customers/{customer_id}/locations", response_model=list[LocationOut])
async def customer_locations(customer_id: uuid.UUID, db: DB, _: CurrentUser) -> list[Location]:
    return list(
        await db.scalars(
            select(Location).where(Location.customer_id == customer_id).order_by(Location.name)
        )
    )


@router.post(
    "/customers/{customer_id}/locations",
    response_model=LocationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_location(
    customer_id: uuid.UUID, body: LocationCreate, db: DB, _: TicketManagerUser
) -> Location:
    await _get_or_404(db, Customer, customer_id, "Cliente")
    location = Location(customer_id=customer_id, **body.model_dump(), is_active=True)
    db.add(location)
    await db.commit()
    return await db.get(Location, location.id, populate_existing=True)  # type: ignore[return-value]


@router.get("/locations", response_model=list[LocationOut])
async def list_locations(
    db: DB, _: CurrentUser, customer_id: uuid.UUID | None = None
) -> list[Location]:
    stmt = select(Location).order_by(Location.name)
    if customer_id is not None:
        stmt = stmt.where(Location.customer_id == customer_id)
    return list(await db.scalars(stmt))


@router.patch("/locations/{location_id}", response_model=LocationOut)
async def update_location(
    location_id: uuid.UUID, body: LocationUpdate, db: DB, _: TicketManagerUser
) -> Location:
    location = await _get_or_404(db, Location, location_id, "Local")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(location, key, value)
    await db.commit()
    return location


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
            status.HTTP_422_UNPROCESSABLE_ENTITY, "O local não pertence ao cliente do ativo"
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
