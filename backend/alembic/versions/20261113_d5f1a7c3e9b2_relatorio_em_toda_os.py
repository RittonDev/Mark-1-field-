"""Relatório em toda OS

Como no Field Control, toda OS tem o link do relatório para o cliente (antes só a concluída ganhava).
As OS novas já nascem com o link; esta migração cria o link das que não têm. Só preenche o id do
link (o token público é assinado com o segredo da API na hora de montar a URL) e não mexe na
versão nem no "atualizado em" da OS.

Revision ID: d5f1a7c3e9b2
Revises: d4e8b2a6c9f1
Create Date: 2026-11-13
"""

import secrets
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "d5f1a7c3e9b2"
down_revision: str | None = "d4e8b2a6c9f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BATCH = 1000


def upgrade() -> None:
    conn = op.get_bind()
    ids = [
        row[0]
        for row in conn.execute(sa.text("SELECT id FROM tickets WHERE report_link_id IS NULL"))
    ]
    now = datetime.now(UTC)
    update = sa.text(
        "UPDATE tickets SET report_link_id = :link, report_link_created_at = :now WHERE id = :id"
    )
    for start in range(0, len(ids), BATCH):
        conn.execute(
            update,
            [
                # Mesmo formato de app.core.links.new_link_id (12 caracteres, 72 bits aleatórios).
                {"id": ticket_id, "link": secrets.token_urlsafe(9), "now": now}
                for ticket_id in ids[start : start + BATCH]
            ],
        )


def downgrade() -> None:
    # Os links criados continuam valendo (voltar não apaga relatórios já enviados a clientes).
    pass
