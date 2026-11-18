"""Formulários que entram sozinhos na OS

O modelo de formulário passa a entrar sozinho nas OS pelo tipo de OS (service_type_ids, que antes
só sugeria) e pela categoria, valendo também as subcategorias. Novas colunas:
- form_templates.category_ids (JSONB, lista de ids): as categorias em que o modelo entra sozinho;
- form_templates.default_required: o formulário entra na OS como obrigatório (padrão) ou opcional;
- ticket_forms.auto_attached: o formulário entrou sozinho (pelo tipo ou pela categoria). Só esses
  saem sozinhos da OS que ainda não começou, quando o tipo ou a categoria deixam de casar e ninguém
  começou a responder.
E o índice ix_ticket_forms_template_id, para o histórico de uso do modelo e para levar o modelo às
OS que ainda não começaram.

A resposta automática (FormField.prefill) mora no JSON dos campos e os dados novos dos eventos
(template_id, auto, forms_left_out) no JSONB data: nada disso pede coluna.

Backfill: só os padrões. Os modelos existentes ficam sem categoria e obrigatórios por padrão; os
formulários já anexados (inclusive os migrados do Field Control) ficam com auto_attached falso e
nunca saem sozinhos. O downgrade apaga o índice e as três colunas (perde as categorias ligadas aos
modelos, o padrão de obrigatório e a marca de anexo automático).

Revision ID: d7a2e9c4b1f6
Revises: c5e8a3f1d7b4
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d7a2e9c4b1f6"
down_revision: str | None = "c5e8a3f1d7b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "form_templates",
        sa.Column(
            "category_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "form_templates",
        sa.Column("default_required", sa.Boolean(), server_default="true", nullable=False),
    )
    op.add_column(
        "ticket_forms",
        sa.Column("auto_attached", sa.Boolean(), server_default="false", nullable=False),
    )
    op.create_index(
        op.f("ix_ticket_forms_template_id"), "ticket_forms", ["template_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_ticket_forms_template_id"), table_name="ticket_forms")
    op.drop_column("ticket_forms", "auto_attached")
    op.drop_column("form_templates", "default_required")
    op.drop_column("form_templates", "category_ids")
