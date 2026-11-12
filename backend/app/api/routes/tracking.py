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
    PingBatch,
    PingResult,
    ShiftAction,
    ShiftOut,
    ShiftState,
    TrackingHistory,
)
from app.services import tracking
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


@router.get("/shift", response_model=ShiftState)
async def current_shift(db: DB, user: TechnicianUser) -> ShiftState:
    shift = await tracking.open_shift(db, user)
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
    """Lote de posições (o app guarda offline e envia quando tem rede)."""
    result, latest = await tracking.add_pings(db, user, body.pings)
    await db.commit()
    await tracking.publish_location(user, latest)
    return result


@router.get("/live", response_model=list[LiveTechnician])
async def live(db: DB, _: TicketManagerUser, team_id: uuid.UUID | None = None) -> list:
    """Mapa ao vivo: onde está cada técnico, o estado e a OS em campo."""
    return await tracking.live(db, team_id)


@router.get("/history", response_model=TrackingHistory)
async def history(
    db: DB, _: TicketManagerUser, user_id: uuid.UUID, date: dt.date | None = None
) -> TrackingHistory:
    return await tracking.history(db, user_id, date or local_today())
