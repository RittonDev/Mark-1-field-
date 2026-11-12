"""Simulador de rastreamento para demonstração (só fora de produção).

Abre a jornada dos técnicos do seed e envia posições a cada poucos segundos pelo mesmo
caminho do app (tracking.add_pings + evento em tempo real), para ver o mapa ao vivo andando.

    docker compose exec api python -m app.devtools.simulate_tracking --minutos 20

Quem já está "em deslocamento" anda até o local da OS; quem está "em atendimento" fica
parado no cliente; os demais circulam perto do ponto de partida.
"""

import argparse
import asyncio
import math
import random
from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy import select

from app.core.config import settings
from app.core.enums import TicketStatus, UserRole
from app.db.base import utcnow
from app.db.session import SessionLocal
from app.models import Ticket, User
from app.schemas.tracking import PingIn
from app.services import geo, tracking
from app.services.realtime import bus

SPEED_MPS = 11.0  # ~40 km/h no trânsito
DEFAULT_START = (-23.5614, -46.6559)  # Sede - São Paulo


@dataclass
class Walker:
    user: User
    lat: float
    lng: float
    target: tuple[float, float] | None
    battery: float = field(default_factory=lambda: random.uniform(55, 95))


def _step(w: Walker, seconds: float) -> tuple[float, float]:
    """Anda em direção ao destino; devolve (velocidade m/s, rumo em graus)."""
    if w.target is None:
        return 0.0, 0.0
    dlat, dlng = w.target[0] - w.lat, w.target[1] - w.lng
    meters = math.hypot(dlat * 111_000, dlng * 111_000 * math.cos(math.radians(w.lat)))
    if meters < 30:
        w.target = None
        return 0.0, 0.0
    frac = min(1.0, SPEED_MPS * seconds / meters)
    w.lat += dlat * frac + random.uniform(-0.00005, 0.00005)
    w.lng += dlng * frac + random.uniform(-0.00005, 0.00005)
    heading = (math.degrees(math.atan2(dlng, dlat)) + 360) % 360
    return SPEED_MPS * random.uniform(0.6, 1.1), heading


async def _walkers() -> list[Walker]:
    async with SessionLocal() as db:
        techs = list(
            await db.scalars(
                select(User).where(User.role == UserRole.TECHNICIAN, User.is_active.is_(True))
            )
        )
        walkers = []
        for tech in techs:
            in_field = list(
                await db.scalars(
                    select(Ticket).where(
                        Ticket.assignee_id == tech.id,
                        Ticket.status.in_((TicketStatus.IN_PROGRESS, TicketStatus.EN_ROUTE)),
                    )
                )
            )
            # Em atendimento tem prioridade (igual ao mapa ao vivo).
            ticket = next(
                (t for t in in_field if t.status == TicketStatus.IN_PROGRESS),
                in_field[0] if in_field else None,
            )
            loc = ticket.location if ticket else None
            dest = (
                (loc.latitude, loc.longitude)
                if loc and geo.valid_coords(loc.latitude, loc.longitude)
                else None
            )
            if ticket and ticket.status == TicketStatus.IN_PROGRESS and dest:
                walkers.append(Walker(tech, dest[0] + 0.0002, dest[1] + 0.0002, None))
            elif dest:
                # Começa a ~6 km do cliente e vai até ele.
                walkers.append(Walker(tech, dest[0] - 0.04, dest[1] - 0.035, dest))
            else:
                walkers.append(Walker(tech, *DEFAULT_START, None))
            if tech.location_consent_at is None:
                tech.location_consent_at = utcnow()  # demonstração: aceite simulado
            await tracking.start_shift(db, tech, walkers[-1].lat, walkers[-1].lng)
        await db.commit()
        return walkers


async def main(minutes: float, interval: float) -> None:
    if settings.is_production:
        raise SystemExit("O simulador não roda em produção.")
    await bus.start()
    walkers = await _walkers()
    print(f"Simulando {len(walkers)} técnico(s) por {minutes:g} min (Ctrl+C para parar).")
    end = utcnow() + timedelta(minutes=minutes)
    try:
        while utcnow() < end:
            for w in walkers:
                speed, heading = _step(w, interval)
                w.battery = max(5.0, w.battery - 0.02)
                ping = PingIn(
                    recorded_at=utcnow(),
                    latitude=w.lat,
                    longitude=w.lng,
                    accuracy_m=random.uniform(4, 15),
                    speed_mps=speed,
                    heading=heading if speed else None,
                    battery_pct=round(w.battery),
                )
                async with SessionLocal() as db:
                    user = await db.get(User, w.user.id)
                    _, latest = await tracking.add_pings(db, user, [ping])  # type: ignore[arg-type]
                    await db.commit()
                await tracking.publish_location(w.user, latest)
            await asyncio.sleep(interval)
    finally:
        await bus.stop()
    print("Fim da simulação. As jornadas continuam abertas; sem novas posições viram 'sem sinal'.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--minutos", type=float, default=20)
    parser.add_argument("--intervalo", type=float, default=5, help="segundos entre posições")
    args = parser.parse_args()
    asyncio.run(main(args.minutos, args.intervalo))
