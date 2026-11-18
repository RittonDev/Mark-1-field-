"""Técnicos favoritos por cidade (gestão). Registrado antes das rotas de técnicos, para
/technicians/favorites não cair em /technicians/{user_id}/..."""

import uuid

from fastapi import APIRouter

from app.api.deps import DB, TicketManagerUser, access_user
from app.schemas.technician_favorite import FavoriteCityDetail, FavoriteSet, FavoritesOut
from app.services import technician_favorites as svc
from app.services.errors import WorkflowError

router = APIRouter(tags=["technicians"])

# Tela de Técnicos (os favoritos da cidade da loja ficam com toda a gestão: a Nova OS usa).
TechniciansView = access_user("base.technicians")
TechniciansEdit = access_user("base.technicians", level="edit")


@router.get("/technicians/favorites", response_model=FavoritesOut)
async def list_favorites(
    db: DB,
    _: TechniciansView,
    state: str | None = None,
    technician_id: uuid.UUID | None = None,
) -> FavoritesOut:
    """Todas as cidades com loja e os favoritos de cada uma. `technician_id`: só as cidades em
    que ele é favorito ou foi tirado da lista."""
    return await svc.list_cities(db, state=state, technician_id=technician_id)


@router.get("/technicians/favorites/city", response_model=FavoriteCityDetail)
async def city_favorites(
    db: DB,
    _: TicketManagerUser,
    location_id: uuid.UUID | None = None,
    state: str | None = None,
    city: str | None = None,
) -> FavoriteCityDetail:
    """A cidade da loja (ou a cidade com a UF): favoritos, tirados e outros que atenderam."""
    if location_id is not None:
        state, city = await svc.resolve_location(db, location_id)
    elif not (state or "").strip() or not (city or "").strip():
        raise WorkflowError("Informe a loja ou a cidade com a UF")
    return await svc.city_detail(db, state, city)


@router.put("/technicians/favorites/{technician_id}", response_model=FavoriteCityDetail)
async def set_favorite(
    technician_id: uuid.UUID, body: FavoriteSet, db: DB, user: TechniciansEdit
) -> FavoriteCityDetail:
    """favorite=true fixa o técnico na cidade; favorite=false tira da lista (ou desfaz o fixado)."""
    await svc.set_favorite(db, technician_id, body, user)
    await db.commit()
    return await svc.city_detail(db, body.state, body.city)


@router.delete("/technicians/favorites/{technician_id}", response_model=FavoriteCityDetail)
async def clear_favorite(
    technician_id: uuid.UUID, state: str, city: str, db: DB, user: TechniciansEdit
) -> FavoriteCityDetail:
    """Volta a valer só a regra automática (idempotente)."""
    await svc.clear_favorite(db, technician_id, state, city, user)
    await db.commit()
    return await svc.city_detail(db, state, city)
