"""Duração estimada × real, e a estimativa que aprende.

No Field Control, uma "Impressora A4 - Instalação" estimada em 20 min levou 3h55 e o tipo
continuou dizendo 20 min. Aqui a duração real vem do próprio fluxo (tempo somado em
"Em atendimento"), cada tipo mostra a mediana observada das OS concluídas e, quando a
estimativa erra demais, a API sugere o ajuste. Quem aplica é uma pessoa (um clique),
para o catálogo não mudar sozinho por causa de uma OS atípica.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import TicketStatus
from app.models import Ticket

# Mínimo de OS concluídas para a mediana virar sugestão.
MIN_SAMPLES = 3
# Desvio a partir do qual sugerimos ajustar (25% para cima ou 20% para baixo).
UPPER_RATIO = 1.25
LOWER_RATIO = 0.8
DONE = (TicketStatus.RESOLVED, TicketStatus.CLOSED)


def actual_seconds(work_seconds: int, work_started_at: datetime | None, now: datetime) -> int:
    """Tempo em atendimento, incluindo o trecho em andamento."""
    running = int((now - work_started_at).total_seconds()) if work_started_at else 0
    return (work_seconds or 0) + max(running, 0)


def round_to_5(minutes: float) -> int:
    return max(5, int(5 * round(minutes / 5)))


def suggested_minutes(estimated: int, median: float | None, count: int) -> int | None:
    """Sugestão de nova estimativa, ou None se a atual está boa ou há poucos dados."""
    if median is None or count < MIN_SAMPLES or estimated <= 0:
        return None
    ratio = median / estimated
    if LOWER_RATIO < ratio < UPPER_RATIO:
        return None
    suggestion = round_to_5(median)
    return suggestion if suggestion != estimated else None


async def observed_stats(
    db: AsyncSession, service_type_ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict[str, Any]]:
    """Mediana (minutos) e quantidade de OS concluídas com tempo medido, por tipo."""
    if not service_type_ids:
        return {}
    rows = await db.execute(
        select(
            Ticket.service_type_id,
            func.count(),
            func.percentile_cont(0.5).within_group(Ticket.work_seconds.asc()),
        )
        .where(
            Ticket.service_type_id.in_(service_type_ids),
            Ticket.status.in_(DONE),
            Ticket.work_seconds > 0,
        )
        .group_by(Ticket.service_type_id)
    )
    return {
        type_id: {
            "observed_count": count,
            "observed_median_minutes": round(float(median) / 60, 1),
        }
        for type_id, count, median in rows
    }
