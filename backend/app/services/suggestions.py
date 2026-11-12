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
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import ApplicationStatus, TicketStatus, UserRole
from app.models import (
    Location,
    Project,
    TechnicianApplication,
    TechnicianShift,
    Ticket,
    User,
)
from app.models.ticket import ticket_helpers
from app.services import geo, technician_regions
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
    # Loja da OS: dá a distância pelo histórico e as visitas a esta mesma loja.
    location: Location | None = None


def target_from(
    *,
    location: Location | None = None,
    city: str | None = None,
    state: str | None = None,
    coords: tuple[float, float] | None = None,
    texts: list[str | None] | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    estimated_minutes: int | None = None,
    project: Project | None = None,
    exclude_ticket_id: uuid.UUID | None = None,
) -> Target:
    """Alvo da sugestão: a loja (ou cidade/ponto), o serviço pedido e o horário da visita."""
    loc = location
    text = norm(" ".join(filter(None, texts or [])))
    if coords is None and loc and geo.valid_coords(loc.latitude, loc.longitude):
        coords = (loc.latitude, loc.longitude)  # type: ignore[assignment]
    return Target(
        city=(loc.city if loc else None) or city,
        state=(loc.state if loc else None) or state,
        coords=coords,
        start=start,
        end=visit_end(start, end, estimated_minutes) if start else None,
        project_member_ids=set(project.member_ids or []) if project else set(),
        areas={area for word, area in AREA_KEYWORDS.items() if word in text},
        exclude_ticket_id=exclude_ticket_id,
        location=loc,
    )


def target_for(ticket: Ticket, project: Project | None) -> Target:
    return target_from(
        location=ticket.location,
        texts=[
            ticket.title,
            ticket.category.full_name if ticket.category else None,
            ticket.service_type.name if ticket.service_type else None,
        ],
        start=ticket.scheduled_start,
        end=ticket.scheduled_end,
        estimated_minutes=ticket.estimated_minutes,
        project=project,
        exclude_ticket_id=ticket.id,
    )


async def _day_loads(
    db: AsyncSession, ids: list[uuid.UUID], start: datetime, exclude_id: uuid.UUID | None
) -> dict[uuid.UUID, int]:
    """Quantas OS cada técnico já tem no dia da visita (responsável ou outro técnico)."""
    local = start.astimezone(ZoneInfo(settings.TIMEZONE))
    day_start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1)
    same_day = [
        Ticket.scheduled_start >= day_start,
        Ticket.scheduled_start < day_end,
        Ticket.status != TicketStatus.CANCELLED,
    ]
    if exclude_id is not None:
        same_day.append(Ticket.id != exclude_id)
    loads: dict[uuid.UUID, int] = {}
    as_assignee = (
        select(Ticket.assignee_id, func.count())
        .where(Ticket.assignee_id.in_(ids), *same_day)
        .group_by(Ticket.assignee_id)
    )
    as_helper = (
        select(ticket_helpers.c.user_id, func.count())
        .join(Ticket, Ticket.id == ticket_helpers.c.ticket_id)
        .where(ticket_helpers.c.user_id.in_(ids), *same_day)
        .group_by(ticket_helpers.c.user_id)
    )
    for stmt in (as_assignee, as_helper):
        for user_id, count in (await db.execute(stmt)).all():
            loads[user_id] = loads.get(user_id, 0) + count
    return loads


def _distance_points(km: float | None) -> float:
    if km is None:
        return 0
    for limit, points in ((5, 40), (15, 32), (30, 24), (60, 14), (150, 6)):
        if km <= limit:
            return points
    return 0


async def suggest(db: AsyncSession, target: Target, limit: int = 5) -> list[dict]:
    """Ranking para atribuir: distância (histórico, endereço, ao vivo) e o que mais ajuda.

    Só técnicos ativos (a OS só pode ir para quem está no app). A distância e as visitas a
    esta mesma loja vêm do mesmo cálculo de "técnicos mais próximos".
    """
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
    areas = {
        a.user_id: set(a.service_areas or [])
        for a in await db.scalars(
            select(TechnicianApplication).where(
                TechnicianApplication.user_id.in_(ids),
                TechnicianApplication.status == ApplicationStatus.APPROVED,
            )
        )
    }
    point = await technician_regions.point_for_place(
        db,
        location=target.location,
        latitude=target.coords[0] if target.coords else None,
        longitude=target.coords[1] if target.coords else None,
        city=target.city,
        state=target.state,
    )
    prox = await technician_regions.proximity(db, point, techs) if point else {}
    city, state = norm(target.city), (target.state or "").strip().upper()
    day_loads = (
        await _day_loads(db, ids, target.start, target.exclude_ticket_id) if target.start else {}
    )

    ranked = []
    for tech in techs:
        score = 0.0
        reasons: list[str] = []
        is_busy: bool | None = None
        p = prox.get(tech.id)
        base_here = (
            bool(city)
            and norm(tech.base_city) == city
            and (not state or (tech.base_state or "").upper() == state)
        )
        if p is not None:
            same_state = not state or (tech.base_state or "").upper() == state
            reasons.extend(technician_regions.proximity_reasons(p, tech, include_base=same_state))
            score += _distance_points(p.distance_km)
            if p.visits_at_location:
                score += 20 + min(p.visits_at_location, 5) * 2
            if p.visits_in_city and not base_here:
                score += 10
                reasons.append(f"Já atendeu {p.visits_in_city} OS em {target.city}")
        if base_here:
            score += 20
            if p is None and tech.base_source == "history":
                reasons.append(
                    f"Base em {tech.base_city}-{tech.base_state} ({tech.base_visits} OS)"
                )
        home = norm(tech.home_city)
        if city and home == city:
            score += 20
            reasons.append(f"Mora em {tech.home_city}")
        elif city and city in norm(tech.coverage_area):
            score += 15
            reasons.append(f"Atende {target.city}")
        elif (
            not base_here
            and state
            and state
            in (
                (tech.base_state or "").upper(),
                (tech.home_state or "").upper(),
            )
        ):
            score += 5
            reasons.append(f"Mesmo estado ({state})")
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
            is_busy = bool(busy)
            if busy:
                score -= 40
                reasons.append("Ocupado no horário")
            else:
                score += 5
                reasons.append("Livre no horário")
        day_load = day_loads.get(tech.id, 0) if target.start else None
        if day_load is not None:
            # Agenda do dia equilibrada: quem já está cheio no dia perde um pouco de pontos.
            score -= min(day_load, 6) * 1.5
            reasons.append("Sem OS no dia" if day_load == 0 else f"{day_load} OS no dia")
        load = loads.get(tech.id, 0)
        score -= min(load, 10) * 2
        reasons.append(f"{load} OS em aberto")
        has_base = tech.base_source is not None
        distance = p.distance_km if p is not None else None
        ranked.append(
            {
                "id": tech.id,
                "name": tech.name,
                "phone": tech.phone,
                # Região efetiva: a base pelo histórico; sem ela, o endereço.
                "home_city": tech.base_city if has_base else tech.home_city,
                "home_state": tech.base_state if has_base else tech.home_state,
                "team": {"id": tech.team.id, "name": tech.team.name} if tech.team else None,
                "open_tickets": load,
                "on_shift": tech.id in on_shift,
                "distance_km": round(distance, 1) if distance is not None else None,
                "visits_at_location": p.visits_at_location if p is not None else 0,
                "last_visit_at_location": p.last_visit_at_location if p is not None else None,
                "busy": is_busy,
                "day_load": day_load,
                "score": round(score, 1),
                "reasons": reasons,
            }
        )
    ranked.sort(
        key=lambda r: (
            -r["score"],
            r["distance_km"] if r["distance_km"] is not None else float("inf"),
            r["open_tickets"],
            r["name"],
        )
    )
    return ranked[:limit]
