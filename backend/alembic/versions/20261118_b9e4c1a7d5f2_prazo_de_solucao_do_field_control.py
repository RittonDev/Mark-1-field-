"""Prazo de solução do Field Control

No Field Control o prazo de solução fecha quando a visita termina, mesmo improdutiva, e o veredito
fica na OS ("cumprido no prazo" ou "cumprido fora do prazo"). A importação guardou só o prazo: as
OS que chegaram abertas com o prazo já encerrado ficavam aqui com o relógio correndo para sempre
("SLA violado" e a contagem crescendo) e entravam como violadas ao serem concluídas.

Nova coluna tickets.resolution_sla_met_at: quando o prazo de solução fechou antes da conclusão da
OS. O backfill só toca as OS migradas com esse veredito que a importação não fechou (nas fechadas o
fim já é a conclusão): o fim é a última visita improdutiva ou a conclusão feita aqui depois, o que
veio primeiro. Em 17/11 isso reproduz o veredito do FC nas 53 OS abertas (39 no prazo e 14 fora),
sem nenhuma divergência. Sem perda: o downgrade só tira a coluna.

Revision ID: b9e4c1a7d5f2
Revises: a6d3f9b2c8e4
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b9e4c1a7d5f2"
down_revision: str | None = "a6d3f9b2c8e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Veredito do FC nas OS migradas que a importação não fechou (sem o evento de fechamento dela).
# Os testes rodam este mesmo texto (tests/test_sla_fc_verdict.py).
BACKFILL = """
UPDATE tickets t
   SET resolution_sla_met_at = LEAST(
           t.last_unproductive_at,
           CASE WHEN t.status IN ('resolved', 'closed') THEN t.resolved_at END
       )
 WHERE t.legacy ->> 'source' = 'fieldcontrol'
   AND t.legacy -> 'deadline' ->> 'solution_status'
       IN ('completedOnSchedule', 'completedOutOfSchedule')
   AND t.last_unproductive_at IS NOT NULL
   AND t.status <> 'cancelled'
   AND NOT EXISTS (
           SELECT 1 FROM ticket_events e
            WHERE e.ticket_id = t.id
              AND e.event_type = 'status_changed'
              AND e.to_value = 'closed'
              AND e.data ->> 'source' = 'fieldcontrol'
       )
"""


def upgrade() -> None:
    op.add_column(
        "tickets", sa.Column("resolution_sla_met_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute(BACKFILL)


def downgrade() -> None:
    op.drop_column("tickets", "resolution_sla_met_at")
