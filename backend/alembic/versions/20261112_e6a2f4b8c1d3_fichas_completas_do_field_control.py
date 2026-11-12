"""fichas completas: contatos, endereco da matriz, jornada, servicos e origem (Field Control)

Revision ID: e6a2f4b8c1d3
Revises: c3d9e7a1b2f4
Create Date: 2026-11-12 23:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e6a2f4b8c1d3"
down_revision: str | None = "c3d9e7a1b2f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    # Clientes: todos os contatos, endereço da matriz, logo e dados de origem.
    op.add_column(
        "customers", sa.Column("contacts", JSONB, server_default="[]", nullable=False)
    )
    op.add_column("customers", sa.Column("address_line", sa.String(length=255), nullable=True))
    op.add_column("customers", sa.Column("district", sa.String(length=120), nullable=True))
    op.add_column("customers", sa.Column("city", sa.String(length=120), nullable=True))
    op.add_column("customers", sa.Column("state", sa.String(length=2), nullable=True))
    op.add_column("customers", sa.Column("zip_code", sa.String(length=10), nullable=True))
    op.add_column("customers", sa.Column("latitude", sa.Float(), nullable=True))
    op.add_column("customers", sa.Column("longitude", sa.Float(), nullable=True))
    op.add_column("customers", sa.Column("logo_url", sa.String(length=1000), nullable=True))
    op.add_column("customers", sa.Column("legacy", JSONB, nullable=True))
    # Locais: todos os contatos e dados de origem.
    op.add_column(
        "locations", sa.Column("contacts", JSONB, server_default="[]", nullable=False)
    )
    op.add_column("locations", sa.Column("legacy", JSONB, nullable=True))
    # Técnicos: endereço completo, jornada, serviços que faz, foto externa e origem.
    op.add_column("users", sa.Column("address_line", sa.String(length=255), nullable=True))
    op.add_column("users", sa.Column("address_district", sa.String(length=120), nullable=True))
    op.add_column("users", sa.Column("address_zip", sa.String(length=10), nullable=True))
    op.add_column("users", sa.Column("work_schedule", JSONB, nullable=True))
    op.add_column(
        "users", sa.Column("service_type_ids", JSONB, server_default="[]", nullable=False)
    )
    op.add_column(
        "users", sa.Column("avatar_external_url", sa.String(length=1000), nullable=True)
    )
    op.add_column("users", sa.Column("legacy", JSONB, nullable=True))


def downgrade() -> None:
    for column in (
        "legacy",
        "avatar_external_url",
        "service_type_ids",
        "work_schedule",
        "address_zip",
        "address_district",
        "address_line",
    ):
        op.drop_column("users", column)
    for column in ("legacy", "contacts"):
        op.drop_column("locations", column)
    for column in (
        "legacy",
        "logo_url",
        "longitude",
        "latitude",
        "zip_code",
        "state",
        "city",
        "district",
        "address_line",
        "contacts",
    ):
        op.drop_column("customers", column)
