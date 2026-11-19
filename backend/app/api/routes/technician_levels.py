"""Elo dos técnicos (services/technician_levels.py) e o Perfil do técnico: Estatísticas e
Histórico de atendimentos (services/my_history.py).

Técnico (app), só os dele: GET /me/level, GET /me/stats (o total desde sempre, os 12 meses do elo
e 12 meses de calendário) e GET /me/history (as OS concluídas em que atuou, por cursor, no recorte
de campo). Central (tela Técnicos): o detalhe com as ocorrências, desconsiderar e voltar a contar
(Editar), o recálculo de todos e GET /technicians/{id}/stats (os atendimentos por mês da ficha). O
selo nas listas vem em TechnicianOut.level e TechnicianSuggestion.level.

O detalhe e as desconsiderações seguem a fila de quem pede: com "Somente a própria fila", a
ocorrência de OS de outra fila vem mascarada e mexer nela dá 403 QUEUE_FORBIDDEN. Estatísticas e
histórico são só leitura (nada gravado, sem evento); as da central são só contagens, sem OS, e
não mudam com a fila.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.api.deps import DB, access_user, require_roles
from app.core.enums import UserRole
from app.models import User
from app.schemas.common import Ref
from app.schemas.my_history import MyHistoryPage
from app.schemas.technician_level import (
    LevelRefresh,
    LevelWaiverCreate,
    MyLevel,
    MyStats,
    TechnicianLevelDetail,
    TechnicianStats,
)
from app.services import my_history as history_svc
from app.services import technician_levels as svc
from app.services import technicians as technicians_svc
from app.services.my_history import CURSOR_MAX, HISTORY_PAGE, HISTORY_PAGE_MAX

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


@router.get("/me/stats", response_model=MyStats)
async def my_stats(db: DB, user: TechnicianUser) -> MyStats:
    """As Estatísticas do técnico logado (Perfil e tela Estatísticas). Só leitura: não recalcula
    nem grava o elo."""
    return await svc.stats(db, user.id)


@router.get("/me/history", response_model=MyHistoryPage)
async def my_history(
    db: DB,
    user: TechnicianUser,
    limit: Annotated[int, Query(ge=1, le=HISTORY_PAGE_MAX)] = HISTORY_PAGE,
    cursor: Annotated[str | None, Query(max_length=CURSOR_MAX)] = None,
) -> MyHistoryPage:
    """O Histórico de atendimentos do técnico logado (Perfil): as OS concluídas, das mais
    recentes para as mais antigas, no recorte de campo. `cursor`: o next_cursor da página
    anterior (estragado: 422). Só leitura."""
    return await history_svc.history_page(db, user, limit=limit, cursor=cursor)


@router.post("/technicians/levels/refresh", response_model=LevelRefresh)
async def refresh_levels(db: DB, _: TechniciansEdit) -> dict:
    """Recalcula agora o elo de todos os técnicos e devolve quantos ficaram em cada faixa."""
    counts = await svc.refresh_all(db)
    await db.commit()
    return counts


@router.get("/technicians/{user_id}/level", response_model=TechnicianLevelDetail)
async def technician_level(
    user_id: uuid.UUID, db: DB, viewer: TechniciansView
) -> TechnicianLevelDetail:
    """O elo do técnico, recalculado agora, com as ocorrências (também as desconsideradas). OS de
    outra fila: a ocorrência vem sem a OS e sem as notas (ticket.hidden)."""
    technician = await technicians_svc.get_technician(db, user_id)
    out = await svc.central_detail(db, technician, viewer)
    await db.commit()
    return out


@router.get("/technicians/{user_id}/stats", response_model=TechnicianStats)
async def technician_stats(user_id: uuid.UUID, db: DB, _: TechniciansView) -> TechnicianStats:
    """Atendimentos por mês do técnico (ficha na central). Só contagens: não mostra OS nenhuma,
    então a fila de quem pede não muda nada (como as contagens do elo). Só leitura."""
    technician = await technicians_svc.get_technician(db, user_id)
    out = await svc.stats(db, technician.id)
    return TechnicianStats(
        **out.model_dump(), technician=Ref(id=technician.id, name=technician.name)
    )


@router.post(
    "/technicians/{user_id}/level/waivers",
    response_model=TechnicianLevelDetail,
    status_code=status.HTTP_201_CREATED,
)
async def add_level_waiver(
    user_id: uuid.UUID, body: LevelWaiverCreate, db: DB, actor: TechniciansEdit
) -> TechnicianLevelDetail:
    """Desconsidera uma ocorrência (atraso, retorno ou visita perdida) com o motivo. OS de outra
    fila: 403 QUEUE_FORBIDDEN."""
    technician = await technicians_svc.get_technician(db, user_id)
    out = await svc.add_waiver(db, technician, body, actor)
    await db.commit()
    return out


@router.delete(
    "/technicians/{user_id}/level/waivers/{waiver_id}", response_model=TechnicianLevelDetail
)
async def remove_level_waiver(
    user_id: uuid.UUID, waiver_id: uuid.UUID, db: DB, actor: TechniciansEdit
) -> TechnicianLevelDetail:
    """A ocorrência desconsiderada volta a contar. OS de outra fila: 403 QUEUE_FORBIDDEN."""
    technician = await technicians_svc.get_technician(db, user_id)
    out = await svc.remove_waiver(db, technician, waiver_id, actor)
    await db.commit()
    return out
