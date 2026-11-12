import uuid
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import DB, TicketManagerUser
from app.core.enums import TicketStatus
from app.schemas.schedule import CalendarEvent, CalendarFilters, ConflictItem
from app.services import schedule

router = APIRouter(tags=["schedule"])

MAX_RANGE = timedelta(days=62)


@router.get("/calendar", response_model=list[CalendarEvent])
async def calendar(
    db: DB,
    _: TicketManagerUser,
    start: datetime,
    end: datetime,
    assignee_id: Annotated[list[uuid.UUID], Query()] = [],  # noqa: B006
    unassigned: bool = False,
    team_id: uuid.UUID | None = None,
    customer_id: uuid.UUID | None = None,
    location_id: uuid.UUID | None = None,
    city: str | None = None,
    status_: Annotated[list[TicketStatus], Query(alias="status")] = [],  # noqa: B006
) -> list[CalendarEvent]:
    """OS agendadas no período, com os conflitos de horário de cada técnico."""
    if end <= start or end - start > MAX_RANGE:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Período inválido (máximo de 62 dias)"
        )
    filters = CalendarFilters(
        assignee_ids=assignee_id,
        unassigned=unassigned,
        team_id=team_id,
        customer_id=customer_id,
        location_id=location_id,
        city=city,
        statuses=status_,
    )
    return await schedule.calendar(db, start, end, filters)


@router.get("/calendar/conflicts", response_model=list[ConflictItem])
async def conflicts(
    db: DB,
    _: TicketManagerUser,
    assignee_id: uuid.UUID,
    start: datetime,
    end: datetime | None = None,
    estimated_minutes: int | None = None,
    exclude_id: uuid.UUID | None = None,
) -> list[ConflictItem]:
    """Prévia antes de agendar: o que o técnico já tem neste horário."""
    finish = schedule.visit_end(start, end, estimated_minutes)
    clashes = await schedule.find_conflicts(
        db, assignee_id=assignee_id, start=start, end=finish, exclude_id=exclude_id
    )
    return [schedule.conflict_item(t) for t in clashes]
