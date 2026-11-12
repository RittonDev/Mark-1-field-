import datetime as dt
import re

from fastapi import APIRouter, HTTPException, status

from app.api.deps import DB, TicketManagerUser
from app.schemas.reports import DailyReport, MonthlyReport
from app.services import reports as svc
from app.services.activities import local_today

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/daily", response_model=DailyReport)
async def daily(db: DB, _: TicketManagerUser, date: dt.date | None = None) -> DailyReport:
    """Fechamento do dia. Sem data: o dia anterior (o dia fecha à meia-noite)."""
    return await svc.daily(db, date or svc.default_report_day())


@router.get("/monthly", response_model=MonthlyReport)
async def monthly(db: DB, _: TicketManagerUser, month: str | None = None) -> MonthlyReport:
    """Relatório do mês (AAAA-MM). Sem mês: o mês corrente, até hoje."""
    if month is None:
        today = local_today()
        return await svc.monthly(db, today.year, today.month)
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Mês no formato AAAA-MM")
    year, mon = (int(p) for p in month.split("-"))
    return await svc.monthly(db, year, mon)
