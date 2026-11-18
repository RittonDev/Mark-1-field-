"""Ofertas de OS

A central manda uma OS sem técnico para até 10 técnicos parceiros, com o valor que ele recebe, um
prazo para responder (opcional) e um recado; o técnico aceita pelo valor ou recusa (sem
contraproposta) e o primeiro que aceita fica com a OS. Nova tabela ticket_offers, com uma oferta
pendente por técnico em cada OS (índice único parcial) e o índice das "Minhas ofertas" do técnico
(technician_id, status). O prazo vencido não é gravado: o estado "expired" é calculado na leitura.

Sem backfill: a tabela começa vazia. Os eventos novos do histórico (offer_sent, offer_accepted,
offer_declined, offer_cancelled) não pedem migração (o tipo do evento é VARCHAR). O downgrade apaga
a tabela com as ofertas.

Revision ID: c5e8a3f1d7b4
Revises: b9e4c1a7d5f2
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c5e8a3f1d7b4"
down_revision: str | None = "b9e4c1a7d5f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ticket_offers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "ticket_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tickets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "technician_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("decline_reason", sa.Text(), nullable=True),
        sa.Column("cancel_reason", sa.String(length=32), nullable=True),
        sa.Column("viewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_ticket_offers_ticket_id", "ticket_offers", ["ticket_id"])
    op.create_index("ix_ticket_offers_technician_id", "ticket_offers", ["technician_id"])
    op.create_index(
        "ix_ticket_offers_technician_status", "ticket_offers", ["technician_id", "status"]
    )
    op.create_index(
        "uq_ticket_offers_ticket_tech_pending",
        "ticket_offers",
        ["ticket_id", "technician_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("uq_ticket_offers_ticket_tech_pending", table_name="ticket_offers")
    op.drop_index("ix_ticket_offers_technician_status", table_name="ticket_offers")
    op.drop_index("ix_ticket_offers_technician_id", table_name="ticket_offers")
    op.drop_index("ix_ticket_offers_ticket_id", table_name="ticket_offers")
    op.drop_table("ticket_offers")
