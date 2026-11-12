"""Rastreamento em tempo real dos técnicos (jornada, posições, estado para o mapa)."""

import uuid
from datetime import date, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import TicketEventType, TicketStatus, UserRole
from app.db.base import utcnow
from app.models import LocationPing, TechnicianShift, Ticket, TicketEvent, User
from app.schemas.ticket import format_ticket_code
from app.schemas.tracking import (
    HistoryPoint,
    HistoryStatusEvent,
    LivePosition,
    LiveTechnician,
    LiveTicket,
    LiveTicketLocation,
    PingIn,
    PingResult,
    TrackingHistory,
)
from app.services.activities import day_bounds
from app.services.realtime import bus
from app.services.workflow import OPEN_STATUSES

# Tolerância entre o relógio do aparelho e o início/fim da jornada.
CLOCK_TOLERANCE = timedelta(minutes=2)
# Sem posição há mais que isto durante a jornada: "sem sinal".
NO_SIGNAL_AFTER = timedelta(minutes=5)


async def open_shift(db: AsyncSession, user: User) -> TechnicianShift | None:
    return await db.scalar(
        select(TechnicianShift).where(
            TechnicianShift.user_id == user.id, TechnicianShift.ended_at.is_(None)
        )
    )


async def start_shift(
    db: AsyncSession, user: User, latitude: float | None, longitude: float | None
) -> TechnicianShift:
    current = await open_shift(db, user)
    if current is not None:
        return current  # idempotente: o app pode reenviar
    shift = TechnicianShift(
        id=uuid.uuid4(),
        user_id=user.id,
        started_at=utcnow(),
        start_latitude=latitude,
        start_longitude=longitude,
    )
    db.add(shift)
    await db.flush()
    return shift


async def end_shift(
    db: AsyncSession, user: User, latitude: float | None, longitude: float | None
) -> TechnicianShift | None:
    shift = await open_shift(db, user)
    if shift is None:
        return None
    shift.ended_at = utcnow()
    shift.end_latitude = latitude
    shift.end_longitude = longitude
    await db.flush()
    return shift


async def add_pings(db: AsyncSession, user: User, pings: list[PingIn]) -> tuple[PingResult, dict]:
    """Grava só os pontos dentro de uma jornada; devolve o resultado e o último ponto aceito."""
    now = utcnow()
    oldest = min(p.recorded_at for p in pings)
    shifts = list(
        await db.scalars(
            select(TechnicianShift).where(
                TechnicianShift.user_id == user.id,
                TechnicianShift.started_at <= now + CLOCK_TOLERANCE,
                (TechnicianShift.ended_at.is_(None))
                | (TechnicianShift.ended_at >= oldest - CLOCK_TOLERANCE),
            )
        )
    )

    def shift_for(at: datetime) -> TechnicianShift | None:
        for s in shifts:
            end = s.ended_at or now
            if s.started_at - CLOCK_TOLERANCE <= at <= end + CLOCK_TOLERANCE:
                return s
        return None

    rows = []
    for p in pings:
        if p.recorded_at > now + CLOCK_TOLERANCE:
            continue
        shift = shift_for(p.recorded_at)
        if shift is None:
            continue
        rows.append(
            {
                "user_id": user.id,
                "shift_id": shift.id,
                "recorded_at": p.recorded_at,
                "received_at": now,
                "latitude": p.latitude,
                "longitude": p.longitude,
                "accuracy_m": p.accuracy_m,
                "speed_mps": p.speed_mps,
                "heading": p.heading,
                "battery_pct": p.battery_pct,
                "is_mock": p.is_mock,
            }
        )
    accepted = 0
    if rows:
        result = await db.execute(
            insert(LocationPing)
            .values(rows)
            .on_conflict_do_nothing(constraint="uq_location_pings_user_recorded")
            .returning(LocationPing.id)
        )
        accepted = len(result.all())
    latest = max(rows, key=lambda r: r["recorded_at"]) if rows else {}
    return PingResult(accepted=accepted, discarded=len(pings) - accepted), latest


async def publish_location(user: User, latest: dict) -> None:
    """Avisa os gestores (só eles) da nova posição: o mapa ao vivo se atualiza."""
    if not latest:
        return
    await bus.publish(
        {
            "type": "technician.location",
            "user_id": str(user.id),
            "name": user.name,
            "latitude": latest["latitude"],
            "longitude": latest["longitude"],
            "recorded_at": latest["recorded_at"].isoformat(),
            "audience": {"managers_only": True},
        }
    )


async def publish_shift(user: User, on_shift: bool) -> None:
    await bus.publish(
        {
            "type": "technician.shift",
            "user_id": str(user.id),
            "name": user.name,
            "on_shift": on_shift,
            "audience": {"managers_only": True},
        }
    )


async def live(db: AsyncSession, team_id: uuid.UUID | None = None) -> list[LiveTechnician]:
    """Todos os técnicos ativos com jornada, última posição, OS em campo e estado."""
    now = utcnow()
    stmt = select(User).where(User.role == UserRole.TECHNICIAN, User.is_active.is_(True))
    if team_id is not None:
        stmt = stmt.where(User.team_id == team_id)
    technicians = list(await db.scalars(stmt.order_by(User.name)))
    ids = [t.id for t in technicians]
    if not ids:
        return []

    shifts = {
        s.user_id: s
        for s in await db.scalars(
            select(TechnicianShift).where(
                TechnicianShift.user_id.in_(ids), TechnicianShift.ended_at.is_(None)
            )
        )
    }
    latest = {
        p.user_id: p
        for p in await db.scalars(
            select(LocationPing)
            .where(LocationPing.user_id.in_(ids))
            .distinct(LocationPing.user_id)
            .order_by(LocationPing.user_id, LocationPing.recorded_at.desc())
        )
    }
    in_field: dict[uuid.UUID, Ticket] = {}
    for t in await db.scalars(
        select(Ticket).where(
            Ticket.assignee_id.in_(ids),
            Ticket.status.in_((TicketStatus.IN_PROGRESS, TicketStatus.EN_ROUTE)),
        )
    ):
        current = in_field.get(t.assignee_id)  # type: ignore[arg-type]
        # Em atendimento tem prioridade sobre em deslocamento.
        if current is None or (
            t.status == TicketStatus.IN_PROGRESS and current.status != TicketStatus.IN_PROGRESS
        ):
            in_field[t.assignee_id] = t  # type: ignore[index]
    open_counts = dict(
        (
            await db.execute(
                select(Ticket.assignee_id, func.count())
                .where(Ticket.assignee_id.in_(ids), Ticket.status.in_(OPEN_STATUSES))
                .group_by(Ticket.assignee_id)
            )
        ).all()
    )

    out: list[LiveTechnician] = []
    for tech in technicians:
        shift = shifts.get(tech.id)
        # Fora da jornada a posição não aparece (LGPD): o trajeto fica só no histórico.
        ping = latest.get(tech.id) if shift is not None else None
        ticket = in_field.get(tech.id)
        if shift is None:
            state = "offline"
        elif ping is None or ping.recorded_at < now - NO_SIGNAL_AFTER:
            state = "no_signal"
        elif ticket is not None and ticket.status == TicketStatus.IN_PROGRESS:
            state = "in_progress"
        elif ticket is not None:
            state = "en_route"
        else:
            state = "available"
        out.append(
            LiveTechnician(
                id=tech.id,
                name=tech.name,
                phone=tech.phone,
                team={"id": tech.team.id, "name": tech.team.name} if tech.team else None,
                on_shift=shift is not None,
                shift_started_at=shift.started_at if shift else None,
                state=state,
                last_position=LivePosition(
                    latitude=ping.latitude,
                    longitude=ping.longitude,
                    accuracy_m=ping.accuracy_m,
                    speed_mps=ping.speed_mps,
                    heading=ping.heading,
                    battery_pct=ping.battery_pct,
                    is_mock=ping.is_mock,
                    recorded_at=ping.recorded_at,
                )
                if ping
                else None,
                current_ticket=LiveTicket(
                    id=ticket.id,
                    code=format_ticket_code(ticket.number),
                    title=ticket.title,
                    status=ticket.status.value,
                    location=LiveTicketLocation(
                        name=ticket.location.name,
                        city=ticket.location.city,
                        latitude=ticket.location.latitude,
                        longitude=ticket.location.longitude,
                    )
                    if ticket.location
                    else None,
                    service_address=ticket.service_address,
                )
                if ticket
                else None,
                open_tickets=open_counts.get(tech.id, 0),
            )
        )
    return out


async def history(db: AsyncSession, user_id: uuid.UUID, day: date) -> TrackingHistory:
    """Trajeto do dia (pontos) e as mudanças de status que o técnico fez, com GPS."""
    start, end = day_bounds(day)
    points = [
        HistoryPoint(
            latitude=p.latitude,
            longitude=p.longitude,
            recorded_at=p.recorded_at,
            speed_mps=p.speed_mps,
        )
        for p in await db.scalars(
            select(LocationPing)
            .where(
                LocationPing.user_id == user_id,
                LocationPing.recorded_at >= start,
                LocationPing.recorded_at < end,
            )
            .order_by(LocationPing.recorded_at)
        )
    ]
    rows = await db.execute(
        select(TicketEvent, Ticket.number)
        .join(Ticket, Ticket.id == TicketEvent.ticket_id)
        .where(
            TicketEvent.actor_id == user_id,
            TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
            TicketEvent.created_at >= start,
            TicketEvent.created_at < end,
        )
        .order_by(TicketEvent.created_at)
    )
    events = [
        HistoryStatusEvent(
            ticket_id=ev.ticket_id,
            ticket_code=format_ticket_code(number),
            to_status=ev.to_value or "",
            at=ev.created_at,
            latitude=(ev.data or {}).get("latitude"),
            longitude=(ev.data or {}).get("longitude"),
        )
        for ev, number in rows
    ]
    return TrackingHistory(user_id=user_id, date=day, points=points, status_events=events)


async def purge_old_pings(db: AsyncSession, now: datetime | None = None) -> int:
    """Retenção (LGPD): apaga posições mais antigas que TRACKING_RETENTION_DAYS."""
    cutoff = (now or utcnow()) - timedelta(days=settings.TRACKING_RETENTION_DAYS)
    result = await db.execute(delete(LocationPing).where(LocationPing.recorded_at < cutoff))
    return result.rowcount or 0
