import uuid
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import DB, TicketManagerUser
from app.core.enums import TicketStatus
from app.schemas.schedule import CalendarEvent, CalendarFilters, ConflictItem
from app.schemas.ticket import assume_local
from app.services import schedule

router = APIRouter(tags=["schedule"])

MAX_RANGE = timedelta(days=62)
MAX_VISIT_MINUTES = 60 * 24 * 7


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
    """OS agendadas no período, com os conflitos de horário de cada técnico (o responsável e
    quem vai junto). Data sem fuso vale como hora de Brasília."""
    start, end = assume_local(start), assume_local(end)
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
    start: datetime,
    assignee_id: uuid.UUID | None = None,
    helper_id: Annotated[list[uuid.UUID], Query()] = [],  # noqa: B006
    end: datetime | None = None,
    estimated_minutes: int | None = None,
    exclude_id: uuid.UUID | None = None,
) -> list[ConflictItem]:
    """Prévia antes de agendar: o que o técnico (e cada outro técnico da visita, em
    `helper_id`) já tem neste horário. Cada item diz de quem é o choque (`who`)."""
    start = assume_local(start)
    end = assume_local(end) if end is not None else None
    if end is not None and end <= start:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "O fim da visita deve ser depois do início"
        )
    if estimated_minutes is not None and not 1 <= estimated_minutes <= MAX_VISIT_MINUTES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "A duração da visita deve ser de 1 minuto a 7 dias",
        )
    people = [p for p in dict.fromkeys([assignee_id, *helper_id]) if p is not None]
    return await schedule.preview_conflicts(
        db,
        people,
        start=start,
        end=schedule.visit_end(start, end, estimated_minutes),
        exclude_id=exclude_id,
    )
