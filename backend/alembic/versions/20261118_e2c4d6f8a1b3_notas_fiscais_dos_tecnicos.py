"""Notas fiscais dos técnicos

O técnico parceiro envia pelo app (aba Ganhos) a nota fiscal do mês, opcional, com o arquivo (PDF, XML
ou foto) e as OS que ela cobre; a central confere em Pagamentos (aguardando conferência, conferida ou
recusada com motivo). Nova tabela technician_invoices:
- client_upload_id: a chave de idempotência do app, única por técnico
  (uq_technician_invoices_technician_upload);
- competence: sempre o dia 1 do mês do serviço;
- status VARCHAR como os outros enums (server_default "pending");
- o arquivo em storage_key (invoices/{técnico}/...), com nome, tipo real e tamanho.
Índices ix_technician_invoices_technician_id, _status e _competence.

E a coluna ticket_payouts.invoice_id (FK com ON DELETE SET NULL e índice): a nota que cobre aquele
valor. Um valor fica em no máximo uma nota; uma nota cobre vários valores do mesmo técnico.

Sem backfill: a tabela começa vazia e a coluna nula. O downgrade apaga a tabela com as notas e a
ligação com os valores; os arquivos em media/invoices ficam no disco (apague a pasta à mão, se for o
caso).

Revision ID: e2c4d6f8a1b3
Revises: e1b3c5d7f9a2
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e2c4d6f8a1b3"
down_revision: str | None = "e1b3c5d7f9a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "technician_invoices",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "technician_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("client_upload_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("number", sa.String(length=30), nullable=False),
        sa.Column("issue_date", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("competence", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("reject_reason", sa.Text(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "reviewed_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=120), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("storage_key", sa.String(length=500), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint(
            "technician_id", "client_upload_id", name="uq_technician_invoices_technician_upload"
        ),
    )
    op.create_index(
        "ix_technician_invoices_technician_id", "technician_invoices", ["technician_id"]
    )
    op.create_index("ix_technician_invoices_status", "technician_invoices", ["status"])
    op.create_index("ix_technician_invoices_competence", "technician_invoices", ["competence"])
    op.add_column(
        "ticket_payouts", sa.Column("invoice_id", postgresql.UUID(as_uuid=True), nullable=True)
    )
    op.create_foreign_key(
        op.f("fk_ticket_payouts_invoice_id_technician_invoices"),
        "ticket_payouts",
        "technician_invoices",
        ["invoice_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_ticket_payouts_invoice_id", "ticket_payouts", ["invoice_id"])


def downgrade() -> None:
    op.drop_index("ix_ticket_payouts_invoice_id", table_name="ticket_payouts")
    op.drop_constraint(
        op.f("fk_ticket_payouts_invoice_id_technician_invoices"),
        "ticket_payouts",
        type_="foreignkey",
    )
    op.drop_column("ticket_payouts", "invoice_id")
    op.drop_index("ix_technician_invoices_competence", table_name="technician_invoices")
    op.drop_index("ix_technician_invoices_status", table_name="technician_invoices")
    op.drop_index("ix_technician_invoices_technician_id", table_name="technician_invoices")
    op.drop_table("technician_invoices")
