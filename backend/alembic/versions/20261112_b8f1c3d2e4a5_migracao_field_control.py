"""migracao do Field Control: referencias de origem, etiquetas, dados legados e anexos externos

Revision ID: b8f1c3d2e4a5
Revises: 07fcac5b7207
Create Date: 2026-11-12 20:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b8f1c3d2e4a5"
down_revision: str | None = "07fcac5b7207"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "legacy_refs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("source", sa.String(length=30), nullable=False),
        sa.Column("kind", sa.String(length=30), nullable=False),
        sa.Column("external_id", sa.String(length=80), nullable=False),
        sa.Column("internal_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_legacy_refs")),
        sa.UniqueConstraint(
            "source", "kind", "external_id", name="uq_legacy_refs_source_kind_external"
        ),
    )
    op.create_index("ix_legacy_refs_kind_internal", "legacy_refs", ["kind", "internal_id"])

    op.add_column(
        "customers",
        sa.Column(
            "tags",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "tickets",
        sa.Column(
            "tags",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column("tickets", sa.Column("legacy", postgresql.JSONB(astext_type=sa.Text())))
    op.add_column("quotes", sa.Column("legacy", postgresql.JSONB(astext_type=sa.Text())))
    op.add_column("ticket_attachments", sa.Column("external_url", sa.String(length=1000)))
    op.alter_column(
        "ticket_attachments", "storage_key", existing_type=sa.String(500), nullable=True
    )


def downgrade() -> None:
    # Anexos só externos não têm arquivo local: saem antes de voltar a exigir a chave.
    op.execute("DELETE FROM ticket_attachments WHERE storage_key IS NULL")
    op.alter_column(
        "ticket_attachments", "storage_key", existing_type=sa.String(500), nullable=False
    )
    op.drop_column("ticket_attachments", "external_url")
    op.drop_column("quotes", "legacy")
    op.drop_column("tickets", "legacy")
    op.drop_column("tickets", "tags")
    op.drop_column("customers", "tags")
    op.drop_index("ix_legacy_refs_kind_internal", table_name="legacy_refs")
    op.drop_table("legacy_refs")
