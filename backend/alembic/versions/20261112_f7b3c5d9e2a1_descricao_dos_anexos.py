"""Descrição (legenda) dos anexos da OS

Revision ID: f7b3c5d9e2a1
Revises: e6a2f4b8c1d3
Create Date: 2026-11-12 20:30:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f7b3c5d9e2a1"
down_revision: str | None = "e6a2f4b8c1d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("ticket_attachments", sa.Column("description", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("ticket_attachments", "description")
