"""regiao de atuacao dos tecnicos: coordenadas do endereco e base pelo historico de OS

Revision ID: c3d9e7a1b2f4
Revises: b8f1c3d2e4a5
Create Date: 2026-11-12 22:40:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3d9e7a1b2f4"
down_revision: str | None = "b8f1c3d2e4a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("home_latitude", sa.Float(), nullable=True))
    op.add_column("users", sa.Column("home_longitude", sa.Float(), nullable=True))
    op.add_column("users", sa.Column("base_city", sa.String(length=120), nullable=True))
    op.add_column("users", sa.Column("base_state", sa.String(length=2), nullable=True))
    op.add_column("users", sa.Column("base_latitude", sa.Float(), nullable=True))
    op.add_column("users", sa.Column("base_longitude", sa.Float(), nullable=True))
    op.add_column("users", sa.Column("base_source", sa.String(length=10), nullable=True))
    op.add_column(
        "users",
        sa.Column("base_visits", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column("users", sa.Column("last_visit_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "users", sa.Column("base_updated_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_index("ix_users_base_state_city", "users", ["base_state", "base_city"])


def downgrade() -> None:
    op.drop_index("ix_users_base_state_city", table_name="users")
    for column in (
        "base_updated_at",
        "last_visit_at",
        "base_visits",
        "base_source",
        "base_longitude",
        "base_latitude",
        "base_state",
        "base_city",
        "home_longitude",
        "home_latitude",
    ):
        op.drop_column("users", column)
