"""Coordenadas de loja confiáveis.

Quando o endereço não foi encontrado, o geocodificador do sistema antigo gravou um ponto padrão:
o centro geográfico do Brasil (-14,2350, -51,9253). Lojas de cidades e estados diferentes ficaram
"no mesmo lugar", e a busca por proximidade dava 0 km para quem nunca esteve perto. Regras:

- inválidos sempre: (0, 0), o centro do Brasil e pontos fora do Brasil (ex.: latitude e
  longitude trocadas, ou o mesmo número nas duas);
- inválido também: o mesmo ponto em lojas de 2 ou mais UFs (lojas do mesmo shopping repetem o
  ponto, mas na mesma UF, e continuam valendo).

Uso único na base: `python -m app.services.geo` limpa as coordenadas inválidas e recalcula a
região de atuação dos técnicos.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import defaultdict
from collections.abc import Iterable

from sqlalchemy import ColumnElement, Numeric, and_, cast, func, not_, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Location

BRAZIL_CENTER = (-14.2350, -51.9253)
CENTER_TOLERANCE = 0.001
# Retângulo que cobre o Brasil, com as ilhas oceânicas (lat mín., lat máx., lon mín., lon máx.).
BRAZIL_BOUNDS = (-34.0, 6.0, -74.5, -28.0)
DUPLICATE_DECIMALS = 4  # ~11 m: o "mesmo ponto"

log = logging.getLogger("geo")


def valid_coords(latitude: float | None, longitude: float | None) -> bool:
    """Coordenada utilizável para distância e mapa: dentro do Brasil, não 0,0 nem o centro."""
    if latitude is None or longitude is None:
        return False
    try:
        lat, lon = float(latitude), float(longitude)
    except (TypeError, ValueError):
        return False
    if lat == 0 and lon == 0:
        return False
    if (
        abs(lat - BRAZIL_CENTER[0]) < CENTER_TOLERANCE
        and abs(lon - BRAZIL_CENTER[1]) < CENTER_TOLERANCE
    ):
        return False
    lat_min, lat_max, lon_min, lon_max = BRAZIL_BOUNDS
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


def valid_coords_sql(latitude: ColumnElement, longitude: ColumnElement) -> ColumnElement:
    """O mesmo de valid_coords, no banco."""
    lat_min, lat_max, lon_min, lon_max = BRAZIL_BOUNDS
    return and_(
        latitude.is_not(None),
        longitude.is_not(None),
        latitude.between(lat_min, lat_max),
        longitude.between(lon_min, lon_max),
        not_(and_(latitude == 0, longitude == 0)),
        not_(
            and_(
                func.abs(latitude - BRAZIL_CENTER[0]) < CENTER_TOLERANCE,
                func.abs(longitude - BRAZIL_CENTER[1]) < CENTER_TOLERANCE,
            )
        ),
    )


def coord_key(latitude: float, longitude: float) -> tuple[float, float]:
    return round(float(latitude), DUPLICATE_DECIMALS), round(float(longitude), DUPLICATE_DECIMALS)


def cross_state_pairs(
    points: Iterable[tuple[float | None, float | None, str | None]],
) -> set[tuple[float, float]]:
    """Pontos repetidos em lojas de 2+ UFs (lista de (lat, lon, UF)): ponto padrão, não endereço."""
    states: dict[tuple[float, float], set[str]] = defaultdict(set)
    for lat, lon, uf in points:
        if lat is None or lon is None or not uf:
            continue
        states[coord_key(lat, lon)].add(uf)
    return {key for key, ufs in states.items() if len(ufs) >= 2}


async def invalid_location_ids(db: AsyncSession) -> list[uuid.UUID]:
    """Lojas com coordenada inválida: (0,0), centro do Brasil ou ponto repetido em 2+ UFs."""
    key_lat = func.round(cast(Location.latitude, Numeric), DUPLICATE_DECIMALS)
    key_lon = func.round(cast(Location.longitude, Numeric), DUPLICATE_DECIMALS)
    has_coords = and_(Location.latitude.is_not(None), Location.longitude.is_not(None))
    shared = (
        select(key_lat, key_lon)
        .where(has_coords, Location.state.is_not(None))
        .group_by(key_lat, key_lon)
        .having(func.count(func.distinct(Location.state)) >= 2)
    )
    stmt = select(Location.id).where(
        has_coords,
        (tuple_(key_lat, key_lon).in_(shared))
        | not_(valid_coords_sql(Location.latitude, Location.longitude)),
    )
    return list(await db.scalars(stmt))


async def clear_invalid_location_coords(db: AsyncSession) -> int:
    """Apaga as coordenadas inválidas das lojas (a busca passa a usar o centro da cidade)."""
    ids = await invalid_location_ids(db)
    if ids:
        await db.execute(
            update(Location).where(Location.id.in_(ids)).values(latitude=None, longitude=None)
        )
    return len(ids)


async def _main() -> None:
    from app.db.session import SessionLocal
    from app.services.technician_regions import refresh_bases

    async with SessionLocal() as db:
        cleared = await clear_invalid_location_coords(db)
        bases = await refresh_bases(db)
        await db.commit()
    log.info("Lojas com coordenada inválida limpas: %s", cleared)
    log.info("Região dos técnicos recalculada: %s", bases)
    print({"locations_cleared": cleared, "technician_regions": bases})


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    asyncio.run(_main())
