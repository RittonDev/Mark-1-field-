"""Cobrança e aberturas dos orçamentos

Quantas vezes o cliente abriu o link do orçamento (a equipe e a prévia não contam), a primeira e a
última abertura, e as cobranças registradas pelo "Cobrar" (quantas, quando e quem fez a última).
Sem backfill: os orçamentos migrados do Field Control começam com 0 aberturas e 0 cobranças.

Revision ID: f3b8d2e6a4c1
Revises: e1f4a7c2b9d6
Create Date: 2026-11-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f3b8d2e6a4c1"
down_revision: str | None = "e1f4a7c2b9d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "quotes", sa.Column("client_views", sa.Integer(), server_default="0", nullable=False)
    )
    op.add_column(
        "quotes", sa.Column("client_first_viewed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "quotes", sa.Column("client_last_viewed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "quotes", sa.Column("reminder_count", sa.Integer(), server_default="0", nullable=False)
    )
    op.add_column(
        "quotes", sa.Column("last_reminded_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "quotes",
        sa.Column("last_reminded_by_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_quotes_last_reminded_by_id_users",
        "quotes",
        "users",
        ["last_reminded_by_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_quotes_last_reminded_by_id_users", "quotes", type_="foreignkey")
    op.drop_column("quotes", "last_reminded_by_id")
    op.drop_column("quotes", "last_reminded_at")
    op.drop_column("quotes", "reminder_count")
    op.drop_column("quotes", "client_last_viewed_at")
    op.drop_column("quotes", "client_first_viewed_at")
    op.drop_column("quotes", "client_views")
