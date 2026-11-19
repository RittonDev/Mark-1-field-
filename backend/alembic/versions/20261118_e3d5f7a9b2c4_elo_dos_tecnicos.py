"""Elo dos técnicos

O técnico ganha um elo (Bronze, Prata, Ouro ou Diamante) pela quantidade e pela qualidade dos
atendimentos dos últimos 12 meses (services/technician_levels.py). Novas tabelas:
- technician_levels: uma linha por técnico com a faixa em vigor (tier), a calculada
  (computed_tier), desde quando (tier_since), o início do risco de descer (at_risk_since, a
  carência de 30 dias), os números da última conta (metrics JSONB) e quando foi feita
  (computed_at). user_id é a chave e cai junto com o usuário (ON DELETE CASCADE); índice
  ix_technician_levels_tier.
- technician_level_waivers: as ocorrências que a central desconsiderou (atraso, retorno ou visita
  perdida), com o motivo e quem fez; uma por ocorrência do técnico
  (uq_technician_level_waivers_occurrence). Caem junto com o técnico ou com a OS.
E o índice parcial ix_ticket_events_reopened (created_at das reaberturas), para a conta dos
retornos.

A nova responsabilidade "technician" dos motivos (improdutiva e violação) não pede DDL: a coluna é
VARCHAR(32) sem CHECK (enum guardado como texto). Nenhum motivo é reclassificado.

Sem backfill: as linhas nascem no primeiro cálculo (a primeira lista de Técnicos ou de sugestões,
ou a rotina periódica). O downgrade apaga as duas tabelas (os elos e as desconsiderações) e o
índice; os eventos ficam como estão (o technician_id gravado nos eventos novos fica no JSON).

Revision ID: e3d5f7a9b2c4
Revises: e2c4d6f8a1b3
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e3d5f7a9b2c4"
down_revision: str | None = "e2c4d6f8a1b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "technician_levels",
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("tier", sa.String(length=32), nullable=False),
        sa.Column("computed_tier", sa.String(length=32), nullable=False),
        sa.Column("tier_since", sa.DateTime(timezone=True), nullable=False),
        sa.Column("at_risk_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("metrics", postgresql.JSONB(), server_default="{}", nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_technician_levels_tier", "technician_levels", ["tier"])

    op.create_table(
        "technician_level_waivers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "technician_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column(
            "ticket_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tickets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ref_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column(
            "created_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint(
            "technician_id", "kind", "ref_id", name="uq_technician_level_waivers_occurrence"
        ),
    )
    op.create_index(
        "ix_technician_level_waivers_technician_id",
        "technician_level_waivers",
        ["technician_id"],
    )
    op.create_index(
        "ix_technician_level_waivers_ticket_id", "technician_level_waivers", ["ticket_id"]
    )

    op.create_index(
        "ix_ticket_events_reopened",
        "ticket_events",
        ["created_at"],
        postgresql_where=sa.text("event_type = 'status_changed' AND to_value = 'reopened'"),
    )


def downgrade() -> None:
    op.drop_index("ix_ticket_events_reopened", table_name="ticket_events")
    op.drop_index("ix_technician_level_waivers_ticket_id", table_name="technician_level_waivers")
    op.drop_index(
        "ix_technician_level_waivers_technician_id", table_name="technician_level_waivers"
    )
    op.drop_table("technician_level_waivers")
    op.drop_index("ix_technician_levels_tier", table_name="technician_levels")
    op.drop_table("technician_levels")
