"""Indisponibilidade do técnico: períodos de/até, sem motivo (LGPD).

users.unavailability guarda [{"id", "start", "end"}] com as datas locais "AAAA-MM-DD" (os dois dias
inclusive). O app (PATCH /me/profile) e a central (PATCH /technicians/{id}, Técnicos em Editar)
mandam a lista inteira dos períodos que não terminaram; `wanted` diz se mudou e `normalize` confere,
tira os que já acabaram, mantém o id gravado e dá id novo ao resto. A leitura (`current`) mostra só
os de fim >= hoje, pelo início. No período o técnico sai da sugestão e das ofertas (`days_of`,
`on_day`); a atribuição manual só avisa.

Puro, sem banco. Os textos são os de lib/constants.ts (periodText, periodShort) e as mensagens as de
lib/unavailability.ts (PERIOD_MSG), sem o ponto final.
"""

import uuid
from collections.abc import Iterable, Mapping
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.core.config import settings
from app.services.errors import WorkflowError

PERIODS_MAX = 10
HORIZON_DAYS = 365
# Folga do fuso do aparelho (o dia dele pode ser o de ontem ou o de amanhã em Brasília): início a
# partir de hoje − 1 e fim até hoje + 366.
SLACK_DAYS = 1

END_BEFORE_START = "O fim não pode ser antes do início"
START_IN_PAST = "O início não pode ser antes de hoje"
TOO_FAR = "Até 365 dias a partir de hoje"
OVERLAP = "Já há um período nessas datas"
TOO_MANY = "Até 10 períodos"
INVALID_DATE = "Confira as datas do período"


def _get(item: Any, key: str) -> Any:
    if isinstance(item, Mapping):
        return item.get(key)
    return getattr(item, key, None)


def _day(value: Any) -> date:
    """A data de um período: `date` ou "AAAA-MM-DD"."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            pass
    raise ValueError(INVALID_DATE)


def _stored(stored: Iterable[Any] | None) -> list[dict[str, str]]:
    """Os períodos gravados que se leem ({"id", "start", "end"} em texto), na ordem do início; o
    que estiver estragado fica de fora."""
    out: list[dict[str, str]] = []
    for item in stored or []:
        try:
            start, end = _day(_get(item, "start")), _day(_get(item, "end"))
        except ValueError:
            continue
        period_id = _get(item, "id")
        if not period_id or end < start:
            continue
        out.append({"id": str(period_id), "start": start.isoformat(), "end": end.isoformat()})
    return sorted(out, key=lambda p: (p["start"], p["end"], p["id"]))


def normalize(
    items: Iterable[Any], stored: Iterable[Any] | None, today: date
) -> list[dict[str, str]]:
    """A lista nova a gravar (o PATCH manda a inteira): os que já acabaram saem; o id que está
    gravado fica, o resto ganha um novo; ordem do início. ValueError com a mensagem da tela: fim
    antes do início; início antes de hoje (menos o período gravado com o mesmo id e o mesmo
    início, que já começou); mais de 365 dias à frente; mais de 10; dias em comum com outro."""
    kept_by_id = {p["id"]: p for p in _stored(stored)}
    earliest = today - timedelta(days=SLACK_DAYS)
    latest = today + timedelta(days=HORIZON_DAYS + SLACK_DAYS)
    out: list[dict[str, str]] = []
    used_ids: set[str] = set()
    for item in items or []:
        start, end = _day(_get(item, "start")), _day(_get(item, "end"))
        if end < start:
            raise ValueError(END_BEFORE_START)
        if end < today:
            continue  # já acabou: sai da lista
        raw_id = _get(item, "id")
        kept = kept_by_id.get(str(raw_id)) if raw_id else None
        if kept is not None and kept["id"] in used_ids:
            kept = None  # o mesmo id duas vezes: o segundo é outro período
        if start < earliest and not (kept is not None and kept["start"] == start.isoformat()):
            raise ValueError(START_IN_PAST)
        if end > latest:
            raise ValueError(TOO_FAR)
        period_id = kept["id"] if kept is not None else str(uuid.uuid4())
        used_ids.add(period_id)
        out.append({"id": period_id, "start": start.isoformat(), "end": end.isoformat()})
    if len(out) > PERIODS_MAX:
        raise ValueError(TOO_MANY)
    out.sort(key=lambda p: (p["start"], p["end"], p["id"]))
    for previous, following in zip(out, out[1:], strict=False):
        if following["start"] <= previous["end"]:
            raise ValueError(OVERLAP)
    return out


def current(stored: Iterable[Any] | None, today: date) -> list[dict[str, str]]:
    """Os períodos que não acabaram (fim >= hoje), pelo início."""
    day = today.isoformat()
    return [p for p in _stored(stored) if p["end"] >= day]


def _days(periods: Iterable[Mapping[str, Any]]) -> list[tuple[str, str]]:
    return sorted((str(p["start"]), str(p["end"])) for p in periods)


def wanted(
    sent: Iterable[Any] | None, stored: Iterable[Any] | None, today: date
) -> list[dict[str, str]] | None:
    """A regra do PATCH (app e central): a lista inteira dos períodos que não acabaram vira a lista
    a gravar (`normalize`), ou None quando as datas são as mesmas dos vigentes (os ids gravados
    ficam; reenviar igual não é mudança). WorkflowError (422) com a mensagem da tela quando um
    período não vale."""
    try:
        periods = normalize(sent or [], stored, today)
    except ValueError as exc:
        raise WorkflowError(str(exc)) from None
    if _days(periods) == _days(current(stored, today)):
        return None
    return periods


def on_day(stored: Iterable[Any] | None, day: date) -> dict[str, str] | None:
    """O período que contém `day` (os dois dias inclusive), ou None."""
    text = day.isoformat()
    return next((p for p in _stored(stored) if p["start"] <= text <= p["end"]), None)


def _local_day(at: datetime, tz: ZoneInfo) -> date:
    aware = at if at.tzinfo is not None else at.replace(tzinfo=UTC)
    return aware.astimezone(tz).date()


def days_of(start: datetime | None, end: datetime | None) -> tuple[date, date]:
    """Os dias (no fuso da operação) que uma visita toca: do início ao fim; sem fim, o dia do
    início; sem início, hoje."""
    tz = ZoneInfo(settings.TIMEZONE)
    if start is None:
        today = datetime.now(tz).date()
        return today, today
    first = _local_day(start, tz)
    last = _local_day(end, tz) if end is not None else first
    return first, max(first, last)


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value or "")[:10]


def _br(iso: str) -> str:
    year, month, day = iso.split("-")
    return f"{day}/{month}/{year}"


def period_text(period: Any) -> str:
    """O período para ler (= periodText): "20/12/2026 a 05/01/2027"; um dia só, "20/12/2026"."""
    start, end = _iso(_get(period, "start")), _iso(_get(period, "end"))
    return _br(start) if start == end else f"{_br(start)} a {_br(end)}"


def period_short(period: Any, today: date | str) -> str:
    """Para chips e avisos (= periodShort): "até 30/11" (já começou), "em 20/12" (um dia), "de 20/12
    a 05/01/2027" (o ano só quando não é o de hoje)."""
    start, end = _iso(_get(period, "start")), _iso(_get(period, "end"))
    day = _iso(today)

    def short(iso: str) -> str:
        year, month, dd = iso.split("-")
        return f"{dd}/{month}" if year == day[:4] else f"{dd}/{month}/{year}"

    if start <= day:
        return f"até {short(end)}"
    return f"em {short(start)}" if start == end else f"de {short(start)} a {short(end)}"
