"""Meu cadastro do técnico: chave PIX e histórico do cadastro

O técnico passa a manter o próprio cadastro no app (foto, nome, celular, e-mail, endereço e a chave
PIX para receber por chamado). Novas colunas em users, todas opcionais:
- pix_key_type (cpf | cnpj | email | phone | random, VARCHAR como os outros enums), pix_key (a chave
  normalizada), pix_holder_name (titular da conta) e pix_updated_at (quando a chave mudou: a central
  vê o selo "Chave nova" por 7 dias);
- a restrição ck_users_pix_pair: tipo e chave andam juntos.
E a tabela user_changes, o histórico do cadastro: cada gravação (pelo app ou pela central) com quem
fez e as mudanças [{field, from, to}] já com o texto da tela (a chave PIX só mascarada). Índice
ix_user_changes_user_created (user_id, created_at) para a lista do mais novo para o mais antigo.

Sem backfill: ninguém tem chave PIX hoje e o histórico começa vazio. O downgrade apaga o histórico e
as chaves PIX cadastradas.

Revision ID: e1b3c5d7f9a2
Revises: d7a2e9c4b1f6
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e1b3c5d7f9a2"
down_revision: str | None = "d7a2e9c4b1f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("pix_key_type", sa.String(length=32), nullable=True))
    op.add_column("users", sa.Column("pix_key", sa.String(length=80), nullable=True))
    op.add_column("users", sa.Column("pix_holder_name", sa.String(length=160), nullable=True))
    op.add_column("users", sa.Column("pix_updated_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        op.f("ck_users_pix_pair"), "users", "(pix_key IS NULL) = (pix_key_type IS NULL)"
    )
    op.create_table(
        "user_changes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "actor_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("via", sa.String(length=10), nullable=False),
        sa.Column("changes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_user_changes_user_created", "user_changes", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_user_changes_user_created", table_name="user_changes")
    op.drop_table("user_changes")
    op.drop_constraint(op.f("ck_users_pix_pair"), "users", type_="check")
    op.drop_column("users", "pix_updated_at")
    op.drop_column("users", "pix_holder_name")
    op.drop_column("users", "pix_key")
    op.drop_column("users", "pix_key_type")
