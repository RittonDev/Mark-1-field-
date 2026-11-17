"""Técnicos favoritos por cidade

Só as decisões manuais ficam no banco (técnico fixado ou tirado da lista de uma cidade); a lista
automática (quem mais atendeu nas lojas da cidade nos últimos 12 meses) é calculada na hora.
Sem backfill: a tabela começa vazia.

Revision ID: e1f4a7c2b9d6
Revises: d5f1a7c3e9b2
Create Date: 2026-11-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e1f4a7c2b9d6"
down_revision: str | None = "d5f1a7c3e9b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "technician_favorites",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("state", sa.String(length=2), nullable=False),
        sa.Column("city_key", sa.String(length=120), nullable=False),
        sa.Column("city", sa.String(length=120), nullable=False),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "updated_by_id",
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
        sa.UniqueConstraint(
            "state", "city_key", "user_id", name="uq_technician_favorites_city_tech"
        ),
    )
    op.create_index("ix_technician_favorites_user_id", "technician_favorites", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_technician_favorites_user_id", table_name="technician_favorites")
    op.drop_table("technician_favorites")
