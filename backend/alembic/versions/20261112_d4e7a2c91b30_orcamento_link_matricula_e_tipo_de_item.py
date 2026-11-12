"""orcamento: link persistente, matricula, comentario e tipo de item

Revision ID: d4e7a2c91b30
Revises: c11db7ef6c0a
Create Date: 2026-11-12 17:20:00.000000

"""

import secrets
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e7a2c91b30"
down_revision: str | None = "c11db7ef6c0a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "quote_item_catalog",
        sa.Column("kind", sa.String(length=20), server_default="product", nullable=False),
    )
    op.add_column("quotes", sa.Column("link_id", sa.String(length=24), nullable=True))
    op.add_column(
        "quotes", sa.Column("approver_registration", sa.String(length=40), nullable=True)
    )
    op.add_column("quotes", sa.Column("client_comment", sa.Text(), nullable=True))
    op.create_unique_constraint(op.f("uq_quotes_link_id"), "quotes", ["link_id"])

    # Orçamentos já enviados ganham o link persistente (o antigo, só com hash, segue valendo).
    conn = op.get_bind()
    sent = conn.execute(
        sa.text(
            "SELECT id FROM quotes WHERE link_id IS NULL "
            "AND (token_hash IS NOT NULL OR status IN ('sent', 'approved', 'rejected', 'expired'))"
        )
    ).fetchall()
    for (quote_id,) in sent:
        conn.execute(
            sa.text("UPDATE quotes SET link_id = :link WHERE id = :id"),
            {"link": secrets.token_urlsafe(9), "id": quote_id},
        )


def downgrade() -> None:
    op.drop_constraint(op.f("uq_quotes_link_id"), "quotes", type_="unique")
    op.drop_column("quotes", "client_comment")
    op.drop_column("quotes", "approver_registration")
    op.drop_column("quotes", "link_id")
    op.drop_column("quote_item_catalog", "kind")
