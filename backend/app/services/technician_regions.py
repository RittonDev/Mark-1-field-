"""Região de atuação dos técnicos e busca dos mais próximos de uma loja.

O endereço que veio do Field Control é pouco confiável (muitos técnicos ficaram com o endereço
do escritório como padrão), então a região sai principalmente do histórico: a cidade onde o
técnico mais atendeu nos últimos 36 meses. Sem histórico, vale o endereço dele (quando tem
coordenadas de verdade).

A distância até uma loja é a menor entre: as lojas que ele já atendeu, o endereço dele e a
posição ao vivo (em jornada, com sinal dos últimos 30 min).
"""

from __future__ import annotations

import math
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import (
    ColumnElement,
    Float,
    and_,
    case,
    false,
    func,
    literal,
    or_,
    select,
    union_all,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import TicketStatus, UserRole
from app.db.base import utcnow
from app.models import Location, LocationPing, TechnicianShift, Ticket, TicketWorklog, User
from app.services import geo
from app.services.errors import NotFound, WorkflowError
from app.services.workflow import OPEN_STATUSES

HISTORY_MONTHS = 36
STALE_AFTER = timedelta(hours=6)
LIVE_WINDOW = timedelta(minutes=30)
EARTH_KM = 6371.0

_FOLD_FROM = "ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ"
_FOLD_TO = "AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn"


# ------------------------------------------------------------------ texto e geometria


def fold_text(value: str | None) -> str:
    """ "São  Paulo" -> "sao paulo" (sem acento, minúsculo, espaços normalizados)."""
    text = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()
    return " ".join(text.lower().split())


def fold_sql(column: ColumnElement) -> ColumnElement:
    """O mesmo de fold_text, no banco (cidade sem acento e sem diferença de maiúsculas)."""
    return func.lower(
        func.regexp_replace(
            func.trim(func.translate(column, _FOLD_FROM, _FOLD_TO)), r"\s+", " ", "g"
        )
    )


def fold_words_sql(column: ColumnElement) -> ColumnElement:
    """Sem acento e em minúsculas, sem mexer nos espaços: para procurar uma palavra solta (mais
    leve em texto longo, como a descrição da OS). Nulo vira texto vazio."""
    return func.lower(func.translate(func.coalesce(column, ""), _FOLD_FROM, _FOLD_TO))


def haversine_sql(lat1, lon1, lat2, lon2) -> ColumnElement:
    a = func.power(func.sin(func.radians(lat2 - lat1) / 2), 2) + func.cos(
        func.radians(lat1)
    ) * func.cos(func.radians(lat2)) * func.power(func.sin(func.radians(lon2 - lon1) / 2), 2)
    return 2 * EARTH_KM * func.asin(func.sqrt(func.least(1.0, a)))


def km_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_KM * math.asin(math.sqrt(min(1.0, h)))


def km_text(km: float) -> str:
    """1.23 -> "1,2"; 3.0 -> "3"; 12.6 -> "13"."""
    if km < 10:
        text = f"{km:.1f}".replace(".", ",")
        return text[:-2] if text.endswith(",0") else text
    return str(round(km))


def _date_br(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(ZoneInfo(settings.TIMEZONE)).strftime("%d/%m/%Y")


def _since(now: datetime) -> datetime:
    return now - timedelta(days=30 * HISTORY_MONTHS)


def footprint(since: datetime, until: datetime | None = None):
    """Visitas de cada técnico: (técnico, OS, loja, quando), uma por técnico e OS.

    Conta a OS em que ele é o responsável (não cancelada) e a OS em que ele apontou trabalho
    (visitas anteriores de outra pessoa ficam com quem foi). Com `until`, só o que já
    aconteceu (uma OS agendada para amanhã ainda não é visita).
    """
    assigned = select(
        Ticket.assignee_id.label("user_id"),
        Ticket.id.label("ticket_id"),
        Ticket.location_id.label("location_id"),
        func.coalesce(Ticket.resolved_at, Ticket.scheduled_start, Ticket.created_at).label("at"),
    ).where(
        Ticket.assignee_id.is_not(None),
        Ticket.location_id.is_not(None),
        Ticket.status != TicketStatus.CANCELLED,
    )
    worked = (
        select(
            TicketWorklog.user_id,
            TicketWorklog.ticket_id,
            Ticket.location_id,
            TicketWorklog.started_at,
        )
        .join(Ticket, Ticket.id == TicketWorklog.ticket_id)
        .where(TicketWorklog.user_id.is_not(None), Ticket.location_id.is_not(None))
    )
    both = union_all(assigned, worked).subquery("visits_raw")
    pairs = (
        select(
            both.c.user_id,
            both.c.ticket_id,
            both.c.location_id,
            func.max(both.c.at).label("at"),
        )
        .group_by(both.c.user_id, both.c.ticket_id, both.c.location_id)
        .subquery("visits_pairs")
    )
    conds = [pairs.c.at >= since]
    if until is not None:
        conds.append(pairs.c.at <= until)
    return select(pairs).where(*conds).subquery("footprint")


# ------------------------------------------------------------------ base (região de atuação)


async def refresh_bases(db: AsyncSession, now: datetime | None = None) -> dict[str, int]:
    """Recalcula a região de atuação de todos os técnicos (a cidade onde mais atendeu)."""
    now = now or utcnow()
    fp = footprint(_since(now))
    joined = (
        select(
            fp.c.user_id,
            Location.city,
            Location.state,
            Location.latitude,
            Location.longitude,
            fp.c.at,
        )
        .join(Location, Location.id == fp.c.location_id)
        .join(User, User.id == fp.c.user_id)
        .where(
            User.role == UserRole.TECHNICIAN,
            geo.valid_coords_sql(Location.latitude, Location.longitude),
        )
        .subquery("joined")
    )
    city_key = fold_sql(func.coalesce(joined.c.city, ""))
    per_city = (
        select(
            joined.c.user_id,
            func.min(joined.c.city).label("city"),
            joined.c.state,
            func.count().label("n"),
            func.max(joined.c.at).label("last_at"),
            func.avg(joined.c.latitude).label("lat"),
            func.avg(joined.c.longitude).label("lon"),
        )
        .group_by(joined.c.user_id, city_key, joined.c.state)
        .subquery("per_city")
    )
    ranked = select(
        per_city,
        func.row_number()
        .over(
            partition_by=per_city.c.user_id,
            order_by=(per_city.c.n.desc(), per_city.c.last_at.desc()),
        )
        .label("rk"),
        func.sum(per_city.c.n).over(partition_by=per_city.c.user_id).label("total"),
        func.max(per_city.c.last_at).over(partition_by=per_city.c.user_id).label("last_any"),
    ).subquery("ranked")
    history = {
        row.user_id: row for row in (await db.execute(select(ranked).where(ranked.c.rk == 1))).all()
    }

    techs = (
        await db.execute(
            select(
                User.id,
                User.home_city,
                User.home_state,
                User.home_latitude,
                User.home_longitude,
            ).where(User.role == UserRole.TECHNICIAN)
        )
    ).all()
    params = []
    counts = {"technicians": len(techs), "history": 0, "home": 0, "none": 0}
    for t in techs:
        row = history.get(t.id)
        if row is not None:
            counts["history"] += 1
            params.append(
                {
                    "id": t.id,
                    "base_city": row.city,
                    "base_state": row.state,
                    "base_latitude": float(row.lat),
                    "base_longitude": float(row.lon),
                    "base_source": "history",
                    "base_visits": int(row.total),
                    "last_visit_at": row.last_any,
                    "base_updated_at": now,
                }
            )
        elif t.home_latitude is not None and t.home_longitude is not None:
            counts["home"] += 1
            params.append(
                {
                    "id": t.id,
                    "base_city": t.home_city,
                    "base_state": t.home_state,
                    "base_latitude": t.home_latitude,
                    "base_longitude": t.home_longitude,
                    "base_source": "home",
                    "base_visits": 0,
                    "last_visit_at": None,
                    "base_updated_at": now,
                }
            )
        else:
            counts["none"] += 1
            params.append(
                {
                    "id": t.id,
                    "base_city": None,
                    "base_state": None,
                    "base_latitude": None,
                    "base_longitude": None,
                    "base_source": None,
                    "base_visits": 0,
                    "last_visit_at": None,
                    "base_updated_at": now,
                }
            )
    if params:
        await db.execute(update(User), params)
    return counts


async def refresh_if_stale(db: AsyncSession) -> bool:
    """Atualiza as regiões quando a última conta tem mais de 6 h (a lista chama isto)."""
    newest = await db.scalar(
        select(func.max(User.base_updated_at)).where(User.role == UserRole.TECHNICIAN)
    )
    has_techs = await db.scalar(
        select(func.count()).select_from(User).where(User.role == UserRole.TECHNICIAN)
    )
    if not has_techs:
        return False
    if newest is not None and utcnow() - newest < STALE_AFTER:
        return False
    await refresh_bases(db)
    return True


def region_filter(state: str | None, city: str | None) -> ColumnElement | None:
    """Filtro da lista: a região de atuação (histórico) ou o endereço batem com UF e cidade."""
    uf = (state or "").strip().upper() or None
    key = fold_text(city) or None
    if not uf and not key:
        return None

    def match(state_col, city_col) -> ColumnElement:
        conds = []
        if uf:
            conds.append(state_col == uf)
        if key:
            conds.append(fold_sql(city_col) == key)
        return and_(*conds)

    return or_(match(User.base_state, User.base_city), match(User.home_state, User.home_city))


async def regions(db: AsyncSession, active: bool | None) -> list[dict]:
    """Estados e cidades com técnicos (região efetiva: a base, senão o endereço)."""
    has_base = User.base_source.is_not(None)
    state = case((has_base, User.base_state), else_=User.home_state)
    city = case((has_base, User.base_city), else_=User.home_city)
    stmt = (
        select(state.label("state"), city.label("city"), func.count().label("n"))
        .where(User.role == UserRole.TECHNICIAN)
        .group_by(state, city)
    )
    if active is not None:
        stmt = stmt.where(User.is_active.is_(active))
    states: dict[str, dict] = {}
    for row in (await db.execute(stmt)).all():
        if not row.state:
            continue
        entry = states.setdefault(row.state, {"state": row.state, "total": 0, "cities": {}})
        entry["total"] += row.n
        if row.city:
            key = fold_text(row.city)
            city_entry = entry["cities"].setdefault(key, {"names": {}, "total": 0})
            city_entry["total"] += row.n
            city_entry["names"][row.city] = city_entry["names"].get(row.city, 0) + row.n
    out = []
    for entry in states.values():
        cities = [
            {"city": max(c["names"].items(), key=lambda kv: kv[1])[0], "total": c["total"]}
            for c in entry["cities"].values()
        ]
        cities.sort(key=lambda c: (-c["total"], fold_text(c["city"])))
        out.append({"state": entry["state"], "total": entry["total"], "cities": cities})
    out.sort(key=lambda s: (-s["total"], s["state"]))
    return out


# ------------------------------------------------------------------ ponto de referência


@dataclass
class Point:
    latitude: float
    longitude: float
    label: str
    location_id: uuid.UUID | None = None
    city: str | None = None
    state: str | None = None


async def _city_centroid(db: AsyncSession, city: str, uf: str) -> tuple[float, float, str] | None:
    """Centro das lojas com coordenadas na cidade (e o nome da cidade como está cadastrado)."""
    row = (
        await db.execute(
            select(
                func.avg(Location.latitude),
                func.avg(Location.longitude),
                func.count(),
                func.mode().within_group(Location.city),
            ).where(
                fold_sql(Location.city) == fold_text(city),
                Location.state == uf,
                geo.valid_coords_sql(Location.latitude, Location.longitude),
            )
        )
    ).one()
    if not row[2]:
        return None
    return float(row[0]), float(row[1]), row[3]


async def city_centroid(db: AsyncSession, city: str, uf: str) -> tuple[float, float, str] | None:
    """(latitude, longitude, nome da cidade) do centro das lojas com coordenada na cidade."""
    return await _city_centroid(db, city, uf)


def _location_label(loc: Location) -> str:
    name = f"{loc.code} - {loc.name}" if loc.code else loc.name
    place = "-".join(p for p in (loc.city, loc.state) if p)
    return f"{name} ({place})" if place else name


async def _store_without_coords(db: AsyncSession, loc: Location) -> Point:
    """Loja sem coordenada (ou com o ponto padrão): mede pelo centro das lojas da cidade."""
    name = f"{loc.code} - {loc.name}" if loc.code else loc.name
    uf = (loc.state or "").strip().upper()
    if not loc.city or not uf:
        raise WorkflowError("A loja não tem coordenadas")
    centroid = await _city_centroid(db, loc.city, uf)
    if centroid is None:
        raise WorkflowError(
            f"A loja não tem coordenadas e não há lojas com coordenadas em {loc.city}-{uf} "
            "para calcular a distância"
        )
    return Point(
        latitude=centroid[0],
        longitude=centroid[1],
        label=f"{name} (centro de {loc.city.strip()}-{uf}, a loja não tem coordenadas)",
        location_id=loc.id,
        city=loc.city,
        state=uf,
    )


async def resolve_point(
    db: AsyncSession,
    *,
    location_id: uuid.UUID | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    city: str | None = None,
    state: str | None = None,
) -> Point:
    """De onde medir: a loja, coordenadas coladas ou o centro das lojas da cidade."""
    if location_id is not None:
        loc = await db.get(Location, location_id)
        if loc is None:
            raise NotFound("Loja não encontrada")
        if not geo.valid_coords(loc.latitude, loc.longitude):
            return await _store_without_coords(db, loc)
        return Point(
            latitude=loc.latitude,
            longitude=loc.longitude,
            label=_location_label(loc),
            location_id=loc.id,
            city=loc.city,
            state=loc.state,
        )
    if latitude is not None and longitude is not None:
        if not geo.valid_coords(latitude, longitude):
            raise WorkflowError("Coordenadas inválidas")
        return Point(latitude=latitude, longitude=longitude, label="Coordenadas informadas")
    if city and state:
        uf = state.strip().upper()
        centroid = await _city_centroid(db, city, uf)
        if centroid is None:
            raise WorkflowError(
                f"Não há lojas com coordenadas em {city.strip()}-{uf} para calcular a distância"
            )
        return Point(
            latitude=centroid[0],
            longitude=centroid[1],
            label=f"{centroid[2]}-{uf} (centro das lojas da cidade)",
            city=centroid[2],
            state=uf,
        )
    raise WorkflowError("Informe a loja, as coordenadas ou a cidade com o estado")


async def point_for_place(
    db: AsyncSession,
    *,
    location: Location | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    city: str | None = None,
    state: str | None = None,
) -> Point | None:
    """Versão sem erro (sugestões da OS): sem coordenadas, tenta o centro da cidade."""
    if location is not None:
        if geo.valid_coords(location.latitude, location.longitude):
            return Point(
                latitude=location.latitude,
                longitude=location.longitude,
                label=_location_label(location),
                location_id=location.id,
                city=location.city,
                state=location.state,
            )
        city, state = location.city, location.state
    if geo.valid_coords(latitude, longitude):
        return Point(
            latitude=latitude, longitude=longitude, label="Coordenadas", city=city, state=state
        )
    if city and state:
        uf = state.strip().upper()
        centroid = await _city_centroid(db, city, uf)
        if centroid is not None:
            return Point(
                latitude=centroid[0],
                longitude=centroid[1],
                label=f"{centroid[2]}-{uf}",
                location_id=location.id if location is not None else None,
                city=city,
                state=uf,
            )
    return None


# ------------------------------------------------------------------ distâncias


@dataclass
class Proximity:
    distance_km: float | None = None
    nearest_kind: str | None = None  # store_history | home | live
    store_km: float | None = None
    home_km: float | None = None
    live_km: float | None = None
    visits_at_location: int = 0
    last_visit_at_location: datetime | None = None
    visits_in_city: int = 0
    total_visits: int = 0
    last_visit_at: datetime | None = None


async def proximity(
    db: AsyncSession, point: Point, users: list[User], now: datetime | None = None
) -> dict[uuid.UUID, Proximity]:
    """Distância de cada técnico ao ponto (a menor entre histórico, endereço e posição ao vivo)."""
    now = now or utcnow()
    ids = [u.id for u in users]
    if not ids:
        return {}
    fp = footprint(_since(now), until=now)
    per_loc = (
        select(
            fp.c.user_id,
            fp.c.location_id,
            func.count().label("n"),
            func.max(fp.c.at).label("last_at"),
        )
        .where(fp.c.user_id.in_(ids))
        .group_by(fp.c.user_id, fp.c.location_id)
        .subquery("per_loc")
    )
    has_coords = geo.valid_coords_sql(Location.latitude, Location.longitude)
    distance = haversine_sql(
        literal(point.latitude, Float),
        literal(point.longitude, Float),
        Location.latitude,
        Location.longitude,
    )
    same_loc = per_loc.c.location_id == point.location_id if point.location_id else false()
    same_city = (
        and_(fold_sql(Location.city) == fold_text(point.city), Location.state == point.state)
        if point.city and point.state
        else false()
    )
    stmt = (
        select(
            per_loc.c.user_id,
            func.min(case((has_coords, distance))).label("store_km"),
            func.sum(per_loc.c.n).label("total"),
            func.max(per_loc.c.last_at).label("last_at"),
            func.coalesce(func.sum(case((same_loc, per_loc.c.n))), 0).label("at_loc"),
            func.max(case((same_loc, per_loc.c.last_at))).label("last_at_loc"),
            func.coalesce(func.sum(case((same_city, per_loc.c.n))), 0).label("in_city"),
        )
        .join(Location, Location.id == per_loc.c.location_id)
        .group_by(per_loc.c.user_id)
    )
    history = {row.user_id: row for row in (await db.execute(stmt)).all()}

    on_shift = set(
        await db.scalars(
            select(TechnicianShift.user_id).where(
                TechnicianShift.user_id.in_(ids), TechnicianShift.ended_at.is_(None)
            )
        )
    )
    pings = {
        p.user_id: p
        for p in await db.scalars(
            select(LocationPing)
            .where(LocationPing.user_id.in_(ids), LocationPing.recorded_at >= now - LIVE_WINDOW)
            .distinct(LocationPing.user_id)
            .order_by(LocationPing.user_id, LocationPing.recorded_at.desc())
        )
    }
    target = (point.latitude, point.longitude)
    out: dict[uuid.UUID, Proximity] = {}
    for u in users:
        p = Proximity()
        row = history.get(u.id)
        if row is not None:
            p.store_km = float(row.store_km) if row.store_km is not None else None
            p.total_visits = int(row.total or 0)
            p.last_visit_at = row.last_at
            p.visits_at_location = int(row.at_loc or 0)
            p.last_visit_at_location = row.last_at_loc
            p.visits_in_city = int(row.in_city or 0)
        if geo.valid_coords(u.home_latitude, u.home_longitude):
            p.home_km = km_between((u.home_latitude, u.home_longitude), target)
        ping = pings.get(u.id) if u.id in on_shift else None
        if ping is not None and geo.valid_coords(ping.latitude, ping.longitude):
            p.live_km = km_between((ping.latitude, ping.longitude), target)
        candidates = [
            (km, kind)
            for km, kind in (
                (p.store_km, "store_history"),
                (p.home_km, "home"),
                (p.live_km, "live"),
            )
            if km is not None
        ]
        if candidates:
            p.distance_km, p.nearest_kind = min(candidates, key=lambda c: c[0])
        out[u.id] = p
    return out


def proximity_reasons(p: Proximity, user: User, *, include_base: bool = True) -> list[str]:
    """Por que este técnico: atendeu a loja, está perto agora, atendeu perto, mora perto, base."""
    reasons: list[str] = []
    if p.visits_at_location:
        last = _date_br(p.last_visit_at_location)
        reasons.append(
            f"Atendeu esta loja {p.visits_at_location}x" + (f" (última em {last})" if last else "")
        )
    if p.live_km is not None:
        reasons.append(f"Em jornada agora a {km_text(p.live_km)} km")
    if p.store_km is not None and not p.visits_at_location:
        reasons.append(f"Já atendeu a {km_text(p.store_km)} km daqui")
    if p.home_km is not None:
        reasons.append(f"Mora a {km_text(p.home_km)} km")
    if include_base and user.base_source == "history" and user.base_city:
        place = f"{user.base_city}-{user.base_state}" if user.base_state else user.base_city
        reasons.append(f"Base em {place} ({user.base_visits} OS)")
    return reasons


async def nearby(
    db: AsyncSession,
    point: Point,
    *,
    limit: int = 15,
    include_inactive: bool = True,
    max_km: float | None = None,
) -> list[dict]:
    """Os técnicos mais próximos do ponto, do mais perto para o mais longe."""
    stmt = select(User).where(User.role == UserRole.TECHNICIAN)
    if not include_inactive:
        stmt = stmt.where(User.is_active.is_(True))
    users = list(await db.scalars(stmt))
    prox = await proximity(db, point, users)
    picked = []
    for u in users:
        p = prox[u.id]
        if p.distance_km is None:
            continue
        if max_km is not None and p.distance_km > max_km:
            continue
        picked.append((u, p))
    picked.sort(key=lambda up: (up[1].distance_km, -up[1].visits_at_location, up[0].name))
    picked = picked[:limit]
    ids = [u.id for u, _ in picked]
    open_counts: dict[uuid.UUID, int] = {}
    on_shift: set[uuid.UUID] = set()
    if ids:
        open_counts = dict(
            (
                await db.execute(
                    select(Ticket.assignee_id, func.count())
                    .where(Ticket.assignee_id.in_(ids), Ticket.status.in_(OPEN_STATUSES))
                    .group_by(Ticket.assignee_id)
                )
            ).all()
        )
        on_shift = set(
            await db.scalars(
                select(TechnicianShift.user_id).where(
                    TechnicianShift.user_id.in_(ids), TechnicianShift.ended_at.is_(None)
                )
            )
        )
    from app.services.technicians import avatar_url  # evita import circular

    rows = []
    for u, p in picked:
        load = open_counts.get(u.id, 0)
        reasons = proximity_reasons(p, u)
        if load:
            reasons.append("1 OS aberta agora" if load == 1 else f"{load} OS abertas agora")
        if not u.is_active:
            reasons.append("Inativo no app")
        rows.append(
            {
                "id": u.id,
                "name": u.name,
                "email": u.email,
                "phone": u.phone,
                "is_active": u.is_active,
                "avatar_url": avatar_url(u),
                "base_city": u.base_city,
                "base_state": u.base_state,
                "base_source": u.base_source,
                "distance_km": round(p.distance_km, 1) if p.distance_km is not None else None,
                "nearest_kind": p.nearest_kind,
                "visits_at_location": p.visits_at_location,
                "last_visit_at_location": p.last_visit_at_location,
                "visits_in_city": p.visits_in_city,
                "total_visits": p.total_visits,
                "last_visit_at": p.last_visit_at,
                "open_tickets": load,
                "on_shift": u.id in on_shift,
                "reasons": reasons,
            }
        )
    return rows
