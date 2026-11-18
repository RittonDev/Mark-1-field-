import datetime as dt
import uuid

from fastapi import APIRouter

from app.api.deps import DB, access_user
from app.schemas.activities import DayActivities
from app.services.activities import check_day, day_activities

router = APIRouter(tags=["activities"])

# Atividades do dia; o Mapa ao vivo também lê a lista.
DayView = access_user("operation.day", "operation.map")


@router.get("/activities/day", response_model=DayActivities)
async def activities_of_the_day(
    db: DB,
    user: DayView,
    date: dt.date | None = None,
    assignee_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
) -> DayActivities:
    """Atividades do dia (padrão: hoje no fuso da operação), agrupáveis por técnico."""
    check_day(date)
    return await day_activities(db, user, date, assignee_id=assignee_id, team_id=team_id)
