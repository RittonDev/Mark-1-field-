"""Sem autorização do cliente antes da visita: as OS aguardando ficam liberadas

A função de registrar a autorização do cliente (e travar o técnico até ela) foi retirada. As OS
que estavam aguardando (ou com a visita recusada) passam a "não exigida", para nada ficar travado
nem aparecer como pendência. As que já tinham autorização registrada ficam como estão (histórico:
o relógio de chegada delas contou da autorização).

Revision ID: c3f8a1d6e4b2
Revises: a9d4c2e7f1b3
Create Date: 2026-11-12 23:30:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "c3f8a1d6e4b2"
down_revision: str | None = "a9d4c2e7f1b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "UPDATE tickets SET authorization_status = 'not_required'"
        " WHERE authorization_status IN ('pending', 'denied')"
    )


def downgrade() -> None:
    # Não há como saber quais estavam aguardando: a função não volta pelo banco.
    pass
