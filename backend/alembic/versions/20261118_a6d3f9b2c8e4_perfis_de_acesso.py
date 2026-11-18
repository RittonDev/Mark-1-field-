"""Perfis de acesso

Perfis de acesso por tela e visibilidade das filas. Sem perda: os perfis padrão começam vazios
(= acesso de hoje, definido no código) e todo supervisor/analista entra no perfil do seu papel.
Administrador (acesso total), técnico e cliente ficam sem perfil.

Revision ID: a6d3f9b2c8e4
Revises: f3b8d2e6a4c1
Create Date: 2026-11-18
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a6d3f9b2c8e4"
down_revision: str | None = "f3b8d2e6a4c1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    profiles = op.create_table(
        "access_profiles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("system_key", sa.String(length=20), nullable=True),
        sa.Column("items", JSONB, server_default="{}", nullable=False),
        sa.Column("queue_scope", sa.String(length=10), server_default="all", nullable=False),
        sa.Column("queue_unowned", sa.Boolean(), server_default="true", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("name", name="uq_access_profiles_name"),
        sa.UniqueConstraint("system_key", name="uq_access_profiles_system_key"),
        sa.CheckConstraint(
            "queue_scope in ('own','all')", name=op.f("ck_access_profiles_queue_scope")
        ),
    )
    # Perfis padrão vazios: cada tela fica no padrão do papel (o acesso de hoje).
    op.bulk_insert(
        profiles,
        [
            {
                "id": uuid.uuid4(),
                "name": name,
                "description": description,
                "system_key": key,
                "items": {},
                "queue_scope": "all",
                "queue_unowned": True,
            }
            for name, description, key in [
                ("Supervisor", "Padrão dos supervisores", "supervisor"),
                ("Analista", "Padrão dos analistas", "analyst"),
            ]
        ],
    )
    op.add_column(
        "users", sa.Column("access_profile_id", postgresql.UUID(as_uuid=True), nullable=True)
    )
    op.add_column("users", sa.Column("access_overrides", JSONB, nullable=True))
    op.create_index("ix_users_access_profile_id", "users", ["access_profile_id"])
    op.create_foreign_key(
        "fk_users_access_profile_id_access_profiles",
        "users",
        "access_profiles",
        ["access_profile_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    # Todo supervisor e analista entra no perfil do papel; admin, técnico e cliente ficam NULL.
    op.execute(
        "UPDATE users u SET access_profile_id = p.id FROM access_profiles p "
        "WHERE p.system_key = u.role AND u.role IN ('supervisor', 'analyst')"
    )


def downgrade() -> None:
    op.drop_constraint("fk_users_access_profile_id_access_profiles", "users", type_="foreignkey")
    op.drop_index("ix_users_access_profile_id", table_name="users")
    op.drop_column("users", "access_overrides")
    op.drop_column("users", "access_profile_id")
    op.drop_table("access_profiles")
