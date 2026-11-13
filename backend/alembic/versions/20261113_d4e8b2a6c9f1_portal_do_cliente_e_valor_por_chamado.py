"""Portal do cliente e valor por chamado

O usuário do cliente fica ligado à empresa (vê e abre as solicitações de todas as lojas dela).
O técnico parceiro recebe por chamado: valor padrão no tipo de serviço e o valor de cada técnico
em cada OS, com o pagamento (a pagar / pago).

Revision ID: d4e8b2a6c9f1
Revises: c3f8a1d6e4b2
Create Date: 2026-11-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d4e8b2a6c9f1"
down_revision: str | None = "c3f8a1d6e4b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("customer_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_index("ix_users_customer_id", "users", ["customer_id"])
    op.create_foreign_key(
        "fk_users_customer_id_customers",
        "users",
        "customers",
        ["customer_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.add_column("service_types", sa.Column("technician_fee", sa.Numeric(12, 2), nullable=True))

    op.create_table(
        "ticket_payouts",
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
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "paid_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
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
        sa.UniqueConstraint("ticket_id", "technician_id", name="uq_ticket_payouts_ticket_tech"),
    )
    op.create_index("ix_ticket_payouts_ticket_id", "ticket_payouts", ["ticket_id"])
    op.create_index("ix_ticket_payouts_technician_id", "ticket_payouts", ["technician_id"])


def downgrade() -> None:
    op.drop_index("ix_ticket_payouts_technician_id", table_name="ticket_payouts")
    op.drop_index("ix_ticket_payouts_ticket_id", table_name="ticket_payouts")
    op.drop_table("ticket_payouts")
    op.drop_column("service_types", "technician_fee")
    op.drop_constraint("fk_users_customer_id_customers", "users", type_="foreignkey")
    op.drop_index("ix_users_customer_id", table_name="users")
    op.drop_column("users", "customer_id")
