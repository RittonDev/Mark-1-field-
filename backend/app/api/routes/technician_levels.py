"""Elo dos técnicos (services/technician_levels.py).

Técnico (app): GET /me/level, só o dele. Central (tela Técnicos): o detalhe com as ocorrências,
desconsiderar e voltar a contar (Editar) e o recálculo de todos. O selo nas listas vem em
TechnicianOut.level e TechnicianSuggestion.level.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, status

from app.api.deps import DB, access_user, require_roles
from app.core.enums import UserRole
from app.models import User
from app.schemas.technician_level import (
    LevelRefresh,
    LevelWaiverCreate,
    MyLevel,
    TechnicianLevelDetail,
)
from app.services import technician_levels as svc
from app.services import technicians as technicians_svc

router = APIRouter(tags=["technician-levels"])

TechniciansView = access_user("base.technicians")
TechniciansEdit = access_user("base.technicians", level="edit")
TechnicianUser = Annotated[User, Depends(require_roles(UserRole.TECHNICIAN))]


@router.get("/me/level", response_model=MyLevel)
async def my_level(db: DB, user: TechnicianUser) -> MyLevel:
    """O elo do técnico logado, recalculado agora (o app chama a cada 30 min e ao puxar a tela)."""
    out = await svc.my_level(db, user)
    await db.commit()
    return out


@router.post("/technicians/levels/refresh", response_model=LevelRefresh)
async def refresh_levels(db: DB, _: TechniciansEdit) -> dict:
    """Recalcula agora o elo de todos os técnicos e devolve quantos ficaram em cada faixa."""
    counts = await svc.refresh_all(db)
    await db.commit()
    return counts


@router.get("/technicians/{user_id}/level", response_model=TechnicianLevelDetail)
async def technician_level(user_id: uuid.UUID, db: DB, _: TechniciansView) -> TechnicianLevelDetail:
    """O elo do técnico, recalculado agora, com as ocorrências (também as desconsideradas)."""
    technician = await technicians_svc.get_technician(db, user_id)
    out = await svc.central_detail(db, technician)
    await db.commit()
    return out


@router.post(
    "/technicians/{user_id}/level/waivers",
    response_model=TechnicianLevelDetail,
    status_code=status.HTTP_201_CREATED,
)
async def add_level_waiver(
    user_id: uuid.UUID, body: LevelWaiverCreate, db: DB, actor: TechniciansEdit
) -> TechnicianLevelDetail:
    """Desconsidera uma ocorrência (atraso, retorno ou visita perdida) com o motivo."""
    technician = await technicians_svc.get_technician(db, user_id)
    out = await svc.add_waiver(db, technician, body, actor)
    await db.commit()
    return out


@router.delete(
    "/technicians/{user_id}/level/waivers/{waiver_id}", response_model=TechnicianLevelDetail
)
async def remove_level_waiver(
    user_id: uuid.UUID, waiver_id: uuid.UUID, db: DB, _: TechniciansEdit
) -> TechnicianLevelDetail:
    """A ocorrência desconsiderada volta a contar."""
    technician = await technicians_svc.get_technician(db, user_id)
    out = await svc.remove_waiver(db, technician, waiver_id)
    await db.commit()
    return out
