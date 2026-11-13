import datetime as dt
import re
import uuid

from fastapi import APIRouter, HTTPException, status

from app.api.deps import DB, TicketManagerUser
from app.schemas.reports import DailyReport, MonthlyReport
from app.services import reports as svc
from app.services.activities import local_today

router = APIRouter(prefix="/reports", tags=["reports"])

# Período aceito (fora dele não há OS, e datas como 0001-01-01 estouram as contas de fuso).
FIRST_DAY = dt.date(2000, 1, 1)
LAST_DAY = dt.date(2100, 12, 31)
OUT_OF_RANGE = "Escolha uma data entre 2000 e 2100"


@router.get("/daily", response_model=DailyReport)
async def daily(
    db: DB,
    _: TicketManagerUser,
    date: dt.date | None = None,
    customer_id: uuid.UUID | None = None,
) -> DailyReport:
    """Fechamento do dia. Sem data: o dia anterior (o dia fecha à meia-noite). Com `customer_id`,
    só as OS daquele cliente."""
    day = date or svc.default_report_day()
    if not FIRST_DAY <= day <= LAST_DAY:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, OUT_OF_RANGE)
    return await svc.daily(db, day, customer_id)


@router.get("/monthly", response_model=MonthlyReport)
async def monthly(
    db: DB,
    _: TicketManagerUser,
    month: str | None = None,
    customer_id: uuid.UUID | None = None,
) -> MonthlyReport:
    """Relatório do mês (AAAA-MM). Sem mês: o mês corrente, até hoje. Com `customer_id`, só as
    OS daquele cliente."""
    if month is None:
        today = local_today()
        return await svc.monthly(db, today.year, today.month, customer_id)
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Mês no formato AAAA-MM")
    year, mon = (int(p) for p in month.split("-"))
    if not FIRST_DAY.year <= year <= LAST_DAY.year:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, OUT_OF_RANGE)
    return await svc.monthly(db, year, mon, customer_id)
