import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.api.deps import DB, TicketManagerUser, require_roles
from app.core.enums import UserRole
from app.db.base import utcnow
from app.models import User
from app.schemas.tracking import (
    LiveTechnician,
    MapDistances,
    PingBatch,
    PingResult,
    ShiftAction,
    ShiftOut,
    ShiftState,
    TrackingHistory,
)
from app.services import map_distances, tracking
from app.services.activities import local_today

router = APIRouter(prefix="/tracking", tags=["tracking"])

TechnicianUser = Annotated[User, Depends(require_roles(UserRole.TECHNICIAN))]

CONSENT_REQUIRED = (
    "Aceite o termo de ciência do rastreamento antes de iniciar a jornada "
    "(a localização só é coletada durante a jornada)."
)


@router.post("/consent", status_code=status.HTTP_204_NO_CONTENT)
async def give_consent(db: DB, user: TechnicianUser) -> Response:
    """Aceite do termo de ciência (LGPD). Fica registrado com data e hora."""
    if user.location_consent_at is None:
        user.location_consent_at = utcnow()
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/consent", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_consent(db: DB, user: TechnicianUser) -> Response:
    """Retira o aceite do termo (LGPD, a qualquer momento e sem custo): a jornada aberta é
    encerrada na hora e a próxima só começa com um novo aceite."""
    shift = await tracking.end_shift(db, user, None, None)
    user.location_consent_at = None
    await db.commit()
    if shift is not None:
        await tracking.publish_shift(user, False)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/shift", response_model=ShiftState)
async def current_shift(db: DB, user: TechnicianUser) -> ShiftState:
    shift = await tracking.open_shift(db, user)
    await db.commit()  # jornada esquecida aberta (passou do limite) é fechada na consulta
    return ShiftState(shift=ShiftOut.model_validate(shift) if shift else None)


@router.post("/shift/start", response_model=ShiftOut)
async def start_shift(body: ShiftAction, db: DB, user: TechnicianUser) -> ShiftOut:
    if user.location_consent_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, CONSENT_REQUIRED)
    shift = await tracking.start_shift(db, user, body.latitude, body.longitude)
    await db.commit()
    await tracking.publish_shift(user, True)
    return ShiftOut.model_validate(shift)


@router.post("/shift/end", response_model=ShiftOut | None)
async def end_shift(body: ShiftAction, db: DB, user: TechnicianUser) -> ShiftOut | None:
    shift = await tracking.end_shift(db, user, body.latitude, body.longitude)
    await db.commit()
    if shift is None:
        return None
    await tracking.publish_shift(user, False)
    return ShiftOut.model_validate(shift)


@router.post("/pings", response_model=PingResult)
async def add_pings(body: PingBatch, db: DB, user: TechnicianUser) -> PingResult:
    """Lote de posições (o app guarda offline e envia quando tem rede). Só entram os pontos de
    dentro de uma jornada (e antes do limite dela)."""
    result, latest = await tracking.add_pings(db, user, body.pings)
    await db.commit()
    await tracking.publish_location(user, latest)
    return result


@router.get("/live", response_model=list[LiveTechnician])
async def live(db: DB, _: TicketManagerUser, team_id: uuid.UUID | None = None) -> list:
    """Mapa ao vivo: onde está cada técnico, o estado e a OS em campo."""
    return await tracking.live(db, team_id)


@router.get("/distances", response_model=MapDistances)
async def distances(
    db: DB,
    _: TicketManagerUser,
    location_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
) -> MapDistances:
    """Para o mapa: posição de agora e casa de cada técnico e, com uma loja, as distâncias de
    onde ele está e de casa até ela (do mais perto para o mais longe)."""
    return await map_distances.distances(db, location_id=location_id, team_id=team_id)


@router.get("/history", response_model=TrackingHistory)
async def history(
    db: DB, _: TicketManagerUser, user_id: uuid.UUID, date: dt.date | None = None
) -> TrackingHistory:
    return await tracking.history(db, user_id, date or local_today())
