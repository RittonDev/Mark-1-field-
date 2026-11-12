"""Abertura da OS: nº do chamado do cliente, observação da visita e técnicos auxiliares

Revision ID: a9d4c2e7f1b3
Revises: f7b3c5d9e2a1
Create Date: 2026-11-12 21:30:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a9d4c2e7f1b3"
down_revision: str | None = "f7b3c5d9e2a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tickets", sa.Column("client_reference", sa.String(length=80), nullable=True))
    op.add_column("tickets", sa.Column("visit_note", sa.Text(), nullable=True))
    op.create_index("ix_tickets_client_reference", "tickets", ["client_reference"])
    op.create_table(
        "ticket_helpers",
        sa.Column("ticket_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["ticket_id"], ["tickets.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("ticket_id", "user_id"),
    )
    op.create_index("ix_ticket_helpers_user_id", "ticket_helpers", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_ticket_helpers_user_id", table_name="ticket_helpers")
    op.drop_table("ticket_helpers")
    op.drop_index("ix_tickets_client_reference", table_name="tickets")
    op.drop_column("tickets", "visit_note")
    op.drop_column("tickets", "client_reference")
