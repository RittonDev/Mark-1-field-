import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel, Ref


class ShiftOut(ORMModel):
    id: uuid.UUID
    started_at: dt.datetime
    ended_at: dt.datetime | None


class ShiftState(BaseModel):
    shift: ShiftOut | None


class ShiftAction(BaseModel):
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)


class PingIn(BaseModel):
    recorded_at: dt.datetime
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0)
    speed_mps: float | None = Field(default=None, ge=0)
    heading: float | None = Field(default=None, ge=0, le=360)
    battery_pct: int | None = Field(default=None, ge=0, le=100)
    is_mock: bool = False


class PingBatch(BaseModel):
    pings: list[PingIn] = Field(min_length=1, max_length=500)


class PingResult(BaseModel):
    accepted: int
    # Fora de uma jornada aberta, no futuro ou repetidos: não são gravados.
    discarded: int


class LivePosition(BaseModel):
    latitude: float
    longitude: float
    accuracy_m: float | None
    speed_mps: float | None
    heading: float | None
    battery_pct: int | None
    is_mock: bool
    recorded_at: dt.datetime


class LiveTicketLocation(BaseModel):
    name: str
    city: str | None
    latitude: float | None
    longitude: float | None


class LiveTicket(BaseModel):
    id: uuid.UUID
    code: str
    title: str
    status: str
    location: LiveTicketLocation | None
    service_address: str | None


LiveState = Literal["offline", "no_signal", "available", "en_route", "in_progress"]


class LiveTechnician(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None
    team: Ref | None
    on_shift: bool
    shift_started_at: dt.datetime | None
    state: LiveState
    last_position: LivePosition | None
    current_ticket: LiveTicket | None
    open_tickets: int


class HistoryPoint(BaseModel):
    latitude: float
    longitude: float
    recorded_at: dt.datetime
    speed_mps: float | None


class HistoryStatusEvent(BaseModel):
    ticket_id: uuid.UUID
    ticket_code: str
    to_status: str
    at: dt.datetime
    latitude: float | None
    longitude: float | None


class TrackingHistory(BaseModel):
    user_id: uuid.UUID
    date: dt.date
    points: list[HistoryPoint]
    status_events: list[HistoryStatusEvent]
