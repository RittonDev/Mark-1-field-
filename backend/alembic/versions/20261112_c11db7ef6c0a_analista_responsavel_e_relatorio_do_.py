"""analista responsavel e relatorio do cliente

Revision ID: c11db7ef6c0a
Revises: 572fd4316bc0
Create Date: 2026-11-12 16:38:38.908481

"""

import secrets
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c11db7ef6c0a"
down_revision: str | None = "572fd4316bc0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

MANAGER_ROLES = "('admin', 'supervisor', 'analyst')"


def upgrade() -> None:
    op.add_column("tickets", sa.Column("owner_id", sa.Uuid(), nullable=True))
    op.add_column("tickets", sa.Column("report_link_id", sa.String(length=24), nullable=True))
    op.add_column(
        "tickets", sa.Column("report_link_created_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "tickets", sa.Column("report_views", sa.Integer(), server_default="0", nullable=False)
    )
    op.add_column(
        "tickets", sa.Column("report_last_viewed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_index(op.f("ix_tickets_owner_id"), "tickets", ["owner_id"], unique=False)
    op.create_unique_constraint(op.f("uq_tickets_report_link_id"), "tickets", ["report_link_id"])
    op.create_foreign_key(
        op.f("fk_tickets_owner_id_users"),
        "tickets",
        "users",
        ["owner_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # Analista responsável das OS existentes: quem abriu pela gestão; senão o analista que executa.
    op.execute(
        f"""
        UPDATE tickets t SET owner_id = u.id FROM users u
         WHERE t.created_by_id = u.id AND u.role IN {MANAGER_ROLES}
        """
    )
    op.execute(
        f"""
        UPDATE tickets t SET owner_id = u.id FROM users u
         WHERE t.owner_id IS NULL AND t.assignee_id = u.id AND u.role IN {MANAGER_ROLES}
        """
    )

    # OS já concluídas ganham o link do relatório (o token completo é assinado na API).
    conn = op.get_bind()
    finished = conn.execute(
        sa.text(
            "SELECT id FROM tickets WHERE status IN ('resolved', 'closed') "
            "AND report_link_id IS NULL"
        )
    ).fetchall()
    for (ticket_id,) in finished:
        conn.execute(
            sa.text(
                "UPDATE tickets SET report_link_id = :link, "
                "report_link_created_at = COALESCE(resolved_at, closed_at, now()) WHERE id = :id"
            ),
            {"link": secrets.token_urlsafe(9), "id": ticket_id},
        )


def downgrade() -> None:
    op.drop_constraint(op.f("fk_tickets_owner_id_users"), "tickets", type_="foreignkey")
    op.drop_constraint(op.f("uq_tickets_report_link_id"), "tickets", type_="unique")
    op.drop_index(op.f("ix_tickets_owner_id"), table_name="tickets")
    op.drop_column("tickets", "report_last_viewed_at")
    op.drop_column("tickets", "report_views")
    op.drop_column("tickets", "report_link_created_at")
    op.drop_column("tickets", "report_link_id")
    op.drop_column("tickets", "owner_id")
