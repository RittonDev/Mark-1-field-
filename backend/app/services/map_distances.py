"""Distâncias no mapa ao vivo: onde o técnico está agora, a casa dele e a loja escolhida.

Para decidir quem mandar: quanto falta de onde ele está agora até a loja, quanto é de casa até a
loja (amanhã cedo, por exemplo) e quanto ele está longe de casa. As distâncias são em linha reta,
com uma estimativa pelas ruas (x1,3) e do tempo de carro. Sem coordenada própria, a loja e a casa
usam o centro da cidade e voltam marcadas como aproximadas.

A posição de agora só existe com a jornada aberta (termo de ciência, LGPD): quem encerrou a
jornada aparece só com a casa.
"""

import uuid
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import UserRole
from app.db.base import utcnow
from app.models import Location, User
from app.schemas.tracking import (
    DistanceLeg,
    MapDistances,
    MapPoint,
    TechnicianDistance,
    TechnicianHome,
)
from app.services import geo, technician_regions, tracking
from app.services.suggestions import km_between

ROAD_FACTOR = 1.3


def travel_minutes(road_km: float) -> int:
    """Tempo de carro estimado: trânsito de cidade até 20 km, estrada depois."""
    speed = 25 if road_km <= 20 else 50 if road_km <= 100 else 70
    return max(1, round(road_km / speed * 60))


def leg(a: MapPoint, b: MapPoint) -> DistanceLeg:
    km = km_between((a.latitude, a.longitude), (b.latitude, b.longitude))
    road = km * ROAD_FACTOR
    return DistanceLeg(
        km=round(km, 1),
        road_km=round(road, 1),
        minutes=travel_minutes(road),
        approximate=a.approximate or b.approximate,
    )


async def _home(
    db: AsyncSession, user: User, centroids: dict[tuple[str, str], tuple[float, float, str] | None]
) -> TechnicianHome | None:
    """Casa do técnico: o endereço com coordenada; sem ele, a cidade de casa; sem ela, a base."""
    place = "-".join(p for p in (user.home_city, user.home_state) if p)
    if geo.valid_coords(user.home_latitude, user.home_longitude):
        where = ", ".join(p for p in (user.address_line, user.address_district, place) if p)
        return TechnicianHome(
            latitude=float(user.home_latitude),  # type: ignore[arg-type]
            longitude=float(user.home_longitude),  # type: ignore[arg-type]
            label=f"Casa · {where}" if where else "Casa",
            kind="home",
        )
    if user.home_city and user.home_state:
        key = (user.home_city, user.home_state.upper())
        if key not in centroids:
            centroids[key] = await technician_regions.city_centroid(db, *key)
        centroid = centroids[key]
        if centroid is not None:
            return TechnicianHome(
                latitude=centroid[0],
                longitude=centroid[1],
                label=f"Casa em {centroid[2]}-{key[1]} (centro da cidade)",
                approximate=True,
                kind="home_city",
            )
    if user.base_city and geo.valid_coords(user.base_latitude, user.base_longitude):
        base = "-".join(p for p in (user.base_city, user.base_state) if p)
        return TechnicianHome(
            latitude=float(user.base_latitude),  # type: ignore[arg-type]
            longitude=float(user.base_longitude),  # type: ignore[arg-type]
            label=f"Base em {base} (onde mais atende; casa sem endereço no cadastro)",
            approximate=True,
            kind="base_city",
        )
    return None


async def distances(
    db: AsyncSession,
    *,
    location_id: uuid.UUID | None = None,
    team_id: uuid.UUID | None = None,
) -> MapDistances:
    """Técnicos ativos com a posição de agora e a casa; com loja, as distâncias até ela, do mais
    perto para o mais longe (pela posição de agora, se recente; senão, pela casa)."""
    now = utcnow()
    place: MapPoint | None = None
    if location_id is not None:
        point = await technician_regions.resolve_point(db, location_id=location_id)
        store = await db.get(Location, location_id)
        place = MapPoint(
            latitude=point.latitude,
            longitude=point.longitude,
            label=point.label,
            # Loja sem coordenada: o ponto é o centro das lojas da cidade.
            approximate=store is None or not geo.valid_coords(store.latitude, store.longitude),
        )

    stmt = select(User).where(User.role == UserRole.TECHNICIAN, User.is_active.is_(True))
    if team_id is not None:
        stmt = stmt.where(User.team_id == team_id)
    technicians = list(await db.scalars(stmt.order_by(User.name)))
    # Posição de agora: só o último ponto da jornada aberta de cada um.
    latest = await tracking.latest_pings(
        db, await tracking.active_shifts(db, [t.id for t in technicians], now)
    )

    centroids: dict[tuple[str, str], tuple[float, float, str] | None] = {}
    rows: list[TechnicianDistance] = []
    for tech in technicians:
        ping = latest.get(tech.id)
        live = (
            MapPoint(latitude=ping.latitude, longitude=ping.longitude, label="Agora")
            if ping is not None and geo.valid_coords(ping.latitude, ping.longitude)
            else None
        )
        home = await _home(db, tech, centroids)
        rows.append(
            TechnicianDistance(
                id=tech.id,
                name=tech.name,
                phone=tech.phone,
                live=live,
                live_at=ping.recorded_at if live is not None and ping is not None else None,
                home=home,
                live_to_place=leg(live, place) if live and place else None,
                home_to_place=leg(home, place) if home and place else None,
                live_to_home=leg(live, home) if live and home else None,
            )
        )

    if place is not None:
        fresh = now - timedelta(hours=2)

        def closeness(row: TechnicianDistance) -> tuple[float, str]:
            if row.live_to_place and row.live_at and row.live_at >= fresh:
                return row.live_to_place.km, row.name
            if row.home_to_place:
                return row.home_to_place.km, row.name
            if row.live_to_place:
                return row.live_to_place.km, row.name
            return float("inf"), row.name

        rows.sort(key=closeness)
    return MapDistances(place=place, technicians=rows)
