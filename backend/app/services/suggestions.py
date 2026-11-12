"""Sugestão de técnicos para uma OS, pela localização (e o que mais ajuda a decidir).

Ex.: caiu uma OS em Santos-SP: aparecem os 5 técnicos da base que moram em Santos (ou atendem
a região), com o motivo de cada um: mora na cidade, está a X km agora, livre no horário,
tem a skill, carga atual. A decisão continua com o analista.
"""

import math
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import ApplicationStatus, UserRole
from app.db.base import utcnow
from app.models import (
    LocationPing,
    Project,
    TechnicianApplication,
    TechnicianShift,
    Ticket,
    User,
)
from app.services.schedule import find_conflicts, visit_end
from app.services.workflow import OPEN_STATUSES

# Palavras do tipo de serviço/categoria da OS -> área de atuação da homologação.
AREA_KEYWORDS = {
    "impress": "impressoras",
    "multifunc": "impressoras",
    "computador": "computadores",
    "notebook": "computadores",
    "desktop": "computadores",
    "rede": "redes",
    "cabeamento": "redes",
    "rack": "redes",
    "wi-fi": "wifi",
    "wifi": "wifi",
    "cftv": "cftv",
    "camera": "cftv",
    "dvr": "cftv",
    "alarme": "seguranca",
    "acesso": "seguranca",
    "telefon": "telefonia",
    "pabx": "telefonia",
    "servidor": "servidores",
    "nobreak": "energia",
    "energia": "energia",
    "pdv": "automacao",
    "automacao": "automacao",
}
AREA_LABEL = {
    "impressoras": "impressoras",
    "computadores": "computadores",
    "redes": "redes",
    "wifi": "Wi-Fi",
    "cftv": "CFTV",
    "seguranca": "segurança",
    "telefonia": "telefonia",
    "servidores": "servidores",
    "energia": "energia",
    "automacao": "PDV",
}
LIVE_WINDOW = timedelta(minutes=30)


def norm(value: str | None) -> str:
    text = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()
    return " ".join(text.lower().split())


def km_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 6371 * 2 * math.asin(math.sqrt(h))


@dataclass
class Target:
    city: str | None = None
    state: str | None = None
    coords: tuple[float, float] | None = None
    start: datetime | None = None
    end: datetime | None = None
    project_member_ids: set[str] = field(default_factory=set)
    areas: set[str] = field(default_factory=set)
    exclude_ticket_id: uuid.UUID | None = None


def target_for(ticket: Ticket, project: Project | None) -> Target:
    loc = ticket.location
    text = norm(
        " ".join(
            filter(
                None,
                [
                    ticket.title,
                    ticket.category.full_name if ticket.category else None,
                    ticket.service_type.name if ticket.service_type else None,
                ],
            )
        )
    )
    start = ticket.scheduled_start
    return Target(
        city=loc.city if loc else None,
        state=loc.state if loc else None,
        coords=(loc.latitude, loc.longitude)
        if loc and loc.latitude is not None and loc.longitude is not None
        else None,
        start=start,
        end=visit_end(start, ticket.scheduled_end, ticket.estimated_minutes) if start else None,
        project_member_ids=set(project.member_ids or []) if project else set(),
        areas={area for word, area in AREA_KEYWORDS.items() if word in text},
        exclude_ticket_id=ticket.id,
    )


async def suggest(db: AsyncSession, target: Target, limit: int = 5) -> list[dict]:
    techs = list(
        await db.scalars(
            select(User).where(User.role == UserRole.TECHNICIAN, User.is_active.is_(True))
        )
    )
    if not techs:
        return []
    ids = [t.id for t in techs]
    loads = dict(
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
    pings = {
        p.user_id: p
        for p in await db.scalars(
            select(LocationPing)
            .where(
                LocationPing.user_id.in_(ids), LocationPing.recorded_at >= utcnow() - LIVE_WINDOW
            )
            .distinct(LocationPing.user_id)
            .order_by(LocationPing.user_id, LocationPing.recorded_at.desc())
        )
    }
    areas = {
        a.user_id: set(a.service_areas or [])
        for a in await db.scalars(
            select(TechnicianApplication).where(
                TechnicianApplication.user_id.in_(ids),
                TechnicianApplication.status == ApplicationStatus.APPROVED,
            )
        )
    }
    city, state = norm(target.city), (target.state or "").upper()

    ranked = []
    for tech in techs:
        score = 0.0
        reasons: list[str] = []
        home = norm(tech.home_city)
        if city and home == city:
            score += 50
            reasons.append(f"Mora em {tech.home_city}")
        elif city and city in norm(tech.coverage_area):
            score += 30
            reasons.append(f"Atende {target.city}")
        elif state and (tech.home_state or "").upper() == state:
            score += 10
            reasons.append(f"Mesmo estado ({state})")
        distance = None
        ping = pings.get(tech.id) if tech.id in on_shift else None
        if ping is not None and target.coords is not None:
            distance = km_between((ping.latitude, ping.longitude), target.coords)
            if distance <= 10:
                score += 25
            elif distance <= 30:
                score += 10
            reasons.append(f"A {distance:.0f} km agora")
        if str(tech.id) in target.project_member_ids:
            score += 20
            reasons.append("Equipe do projeto")
        matched = target.areas & areas.get(tech.id, set())
        if matched:
            score += 15
            reasons.append("Atende " + ", ".join(sorted(AREA_LABEL[a] for a in matched)))
        if target.start and target.end:
            busy = await find_conflicts(
                db,
                assignee_id=tech.id,
                start=target.start,
                end=target.end,
                exclude_id=target.exclude_ticket_id,
            )
            if busy:
                score -= 40
                reasons.append("Ocupado no horário")
            else:
                score += 5
                reasons.append("Livre no horário")
        load = loads.get(tech.id, 0)
        score -= min(load, 10) * 2
        reasons.append(f"{load} OS em aberto")
        ranked.append(
            {
                "id": tech.id,
                "name": tech.name,
                "phone": tech.phone,
                "home_city": tech.home_city,
                "home_state": tech.home_state,
                "team": {"id": tech.team.id, "name": tech.team.name} if tech.team else None,
                "open_tickets": load,
                "on_shift": tech.id in on_shift,
                "distance_km": round(distance, 1) if distance is not None else None,
                "score": round(score, 1),
                "reasons": reasons,
            }
        )
    ranked.sort(key=lambda r: (-r["score"], r["open_tickets"], r["name"]))
    return ranked[:limit]
