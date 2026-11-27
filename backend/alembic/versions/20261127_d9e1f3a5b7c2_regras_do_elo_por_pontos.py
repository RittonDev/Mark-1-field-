"""Regras do elo por pontos (Elo, Etapa 1)

- technician_level_entries: o livro de pontos imutável (vazio nesta etapa). Um lançamento por
  ocorrência, com o técnico e a ordem dele (uq_technician_level_entries_seq), a chave da ocorrência
  com a geração (uq_technician_level_entries_occurrence), o estorno (reverses_id, único: um estorno
  por lançamento), os checks ck_technician_level_entries_* (saldo, contadores, 1º lançamento,
  categoria anterior, estorno, autor, motivo, contagem da abertura, pontos pedidos e o sinal de cada
  tipo), o índice da OS e as FKs RESTRICT (o lançamento não deixa apagar técnico, autor nem OS).
- O gatilho technician_level_entries_immutable (BEFORE UPDATE OR DELETE FOR EACH ROW): recusa com
  o erro 23001 (restrict_violation) e o nome dele, para a API responder com a frase (409).
- level_rule_changes: o histórico de Configurações › Elo (seed, save, approve; actor null =
  Sistema), com o índice ix_level_rule_changes_created (created_at, id).
- Dados: system_settings["level.rules"] com as sugestões do QA "a validar" e as decisões pendentes
  vazias (ON CONFLICT DO NOTHING) e, se entrou, o 1º histórico ("Sugestões do QA e padrões, a
  validar"). Nada mais muda: o elo de 12 meses continua valendo até a ativação (Etapa 2).

Cópias (não importar app.* numa migração): services/level_rules (SETTING_KEY, SEED_NOTE,
default_doc e seed_changes, com os textos) e models/level_points (o SQL da função e do gatilho e os
checks). tests/test_level_rules_migration.py confere.

O downgrade apaga a chave level.rules, o gatilho, a função e as duas tabelas (o livro está vazio
nesta etapa; o histórico das regras se perde).

Revision ID: d9e1f3a5b7c2
Revises: c8f2a4e6b0d3
Create Date: 2026-11-27
"""

import json
import uuid
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d9e1f3a5b7c2"
down_revision: str | None = "c8f2a4e6b0d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = postgresql.JSONB(astext_type=sa.Text())
UUID = postgresql.UUID(as_uuid=True)

# ------------------------------------------------------------------ cópias de services/level_rules

SETTING_KEY = "level.rules"
SEED_NOTE = "Sugestões do QA e padrões, a validar"
RULE_KEYS: tuple[str, ...] = (
    "count_bands",
    "points_bands",
    "opening_bonus",
    "completion_gain",
    "on_time_gain",
    "late",
    "abandonment_loss",
    "rework_loss",
    "min_balance",
    "arrival_tolerance",
    "arrival_time",
    "confirmers",
    "app_reasons",
)
# As sugestões do QA ("qa") e os padrões do sistema ("default").
QA_VALUES: dict[str, Any] = {
    "count_bands": {"silver": 51, "gold": 101, "diamond": 151},
    "points_bands": {"bronze": 100, "silver": 901, "gold": 1401, "diamond": 1850},
    "opening_bonus": 100,
    "abandonment_loss": 80,
    "rework_loss": 50,
}
DEFAULT_VALUES: dict[str, Any] = {
    "completion_gain": None,
    "on_time_gain": None,
    "late": None,
    "min_balance": None,
    "arrival_tolerance": None,
    "arrival_time": None,
    "app_reasons": False,
}
# O texto de cada regra que nasce com valor (services/level_rules.value_text) e, em quem confirma,
# o dos padrões dos perfis (o administrador e o perfil Supervisor).
SEED_TEXTS: dict[str, str] = {
    "count_bands": "Bronze 0 a 50 · Prata 51 a 100 · Ouro 101 a 150 · Diamante 151 ou mais",
    "points_bands": (
        "Bronze 100 a 900 · Prata 901 a 1.400 · Ouro 1.401 a 1.849 · Diamante 1.850 ou mais"
    ),
    "opening_bonus": "100 pontos: Bronze 200 · Prata 1.001 · Ouro 1.501 · Diamante 1.950",
    "abandonment_loss": "Perde 80 pontos",
    "rework_loss": "Perde 50 pontos",
    "confirmers": "Administrador · Supervisor",
    "app_reasons": "Desligado",
}


def default_doc() -> dict[str, Any]:
    """O documento das regras sem gravação: sugestões e padrões, nada aprovado, versão 1."""
    items: dict[str, Any] = {}
    for key in RULE_KEYS:
        item: dict[str, Any] = {
            "value": None,
            "origin": "qa" if key in QA_VALUES else "default",
            "changed_at": None,
            "changed_by": None,
            "approved": None,
        }
        if key == "confirmers":
            del item["value"]  # sai dos perfis de acesso
        elif key in QA_VALUES:
            item["value"] = json.loads(json.dumps(QA_VALUES[key]))
        else:
            item["value"] = DEFAULT_VALUES[key]
        items[key] = item
    return {"version": 1, "activated_at": None, "activated_by": None, "items": items}


def seed_changes() -> list[dict[str, Any]]:
    """O 1º histórico: as regras que nascem com valor, na ordem da tela, com `from` null."""
    return [
        {"item": key, "from": None, "to": SEED_TEXTS[key]} for key in RULE_KEYS if key in SEED_TEXTS
    ]


# ------------------------------------------------------------------ cópias de models/level_points

IMMUTABLE_FUNCTION_SQL = """\
CREATE OR REPLACE FUNCTION technician_level_entries_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Lançamento de pontos não muda nem se apaga: use o estorno'
        USING ERRCODE = 'restrict_violation',
              CONSTRAINT = 'technician_level_entries_immutable';
END;
$$"""

IMMUTABLE_TRIGGER_SQL = """\
CREATE TRIGGER technician_level_entries_immutable
BEFORE UPDATE OR DELETE ON technician_level_entries
FOR EACH ROW EXECUTE FUNCTION technician_level_entries_immutable()"""

DROP_TRIGGER_SQL = (
    "DROP TRIGGER IF EXISTS technician_level_entries_immutable ON technician_level_entries"
)
DROP_FUNCTION_SQL = "DROP FUNCTION IF EXISTS technician_level_entries_immutable()"

CHECKS: dict[str, str] = {
    "balance": "balance_after = balance_before + points",
    "counters": "seq >= 1 AND generation >= 0",
    "first": "seq > 1 OR (kind = 'opening' AND balance_before = 0 AND tier_before IS NULL)",
    "tier_before": "seq = 1 OR tier_before IS NOT NULL",
    "reversal": "(kind = 'reversal') = (reverses_id IS NOT NULL)",
    "author": "kind NOT IN ('adjustment', 'reversal') OR created_by_id IS NOT NULL",
    "reason": "length(btrim(reason)) > 0",
    "opening_count": (
        "(kind = 'opening') = (opening_count IS NOT NULL) AND coalesce(opening_count, 0) >= 0"
    ),
    "rule_points": "rule_points IS NULL OR rule_points < points",
    "sign": (
        "(kind = 'opening' AND points >= 0)"
        " OR (kind IN ('completion', 'on_time') AND points > 0)"
        " OR (kind IN ('late', 'abandonment', 'rework_failure') AND points <= 0)"
        " OR (kind = 'adjustment' AND points <> 0)"
        " OR (kind = 'recategorization' AND points = 0)"
        " OR kind = 'reversal'"
    ),
}

# ------------------------------------------------------------------ passo de dados

INSERT_RULES = sa.text(
    "INSERT INTO system_settings (key, value, updated_at)"
    " VALUES (:key, CAST(:doc AS jsonb), now()) ON CONFLICT (key) DO NOTHING RETURNING key"
)
INSERT_SEED = sa.text(
    "INSERT INTO level_rule_changes (id, actor_id, action, changes, note, created_at)"
    " VALUES (:id, NULL, 'seed', CAST(:changes AS jsonb), :note, now())"
)
DELETE_RULES = sa.text("DELETE FROM system_settings WHERE key = :key")


def _seed() -> int:
    """As regras com as sugestões e, se a chave entrou agora, o 1º histórico. Rodar de novo não
    muda nada (0)."""
    conn = op.get_bind()
    params = {"key": SETTING_KEY, "doc": json.dumps(default_doc())}
    if conn.execute(INSERT_RULES, params).first() is None:
        return 0
    seed = {"id": uuid.uuid4(), "changes": json.dumps(seed_changes()), "note": SEED_NOTE}
    conn.execute(INSERT_SEED, seed)
    return 1


# ------------------------------------------------------------------ upgrade / downgrade


def upgrade() -> None:
    op.create_table(
        "technician_level_entries",
        sa.Column("id", UUID, primary_key=True),
        sa.Column(
            "technician_id",
            UUID,
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("rule_points", sa.Integer(), nullable=True),
        sa.Column("balance_before", sa.Integer(), nullable=False),
        sa.Column("balance_after", sa.Integer(), nullable=False),
        sa.Column("tier_before", sa.String(length=32), nullable=True),
        sa.Column("tier_after", sa.String(length=32), nullable=False),
        sa.Column(
            "ticket_id", UUID, sa.ForeignKey("tickets.id", ondelete="RESTRICT"), nullable=True
        ),
        sa.Column("activity_id", UUID, nullable=True),
        sa.Column("opening_count", sa.Integer(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("occurrence", sa.String(length=160), nullable=False),
        sa.Column("generation", sa.SmallInteger(), server_default="0", nullable=False),
        sa.Column(
            "reverses_id",
            UUID,
            sa.ForeignKey(
                "technician_level_entries.id",
                ondelete="RESTRICT",
                name=op.f("fk_technician_level_entries_reverses_id"),
            ),
            nullable=True,
        ),
        sa.Column(
            "created_by_id",
            UUID,
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint(
            "technician_id", "seq", name=op.f("uq_technician_level_entries_seq")
        ),
        sa.UniqueConstraint(
            "occurrence", "generation", name=op.f("uq_technician_level_entries_occurrence")
        ),
        sa.UniqueConstraint("reverses_id", name=op.f("uq_technician_level_entries_reverses_id")),
        *(
            sa.CheckConstraint(sql, name=op.f(f"ck_technician_level_entries_{name}"))
            for name, sql in CHECKS.items()
        ),
    )
    op.create_index(
        "ix_technician_level_entries_ticket_id", "technician_level_entries", ["ticket_id"]
    )
    op.execute(sa.text(IMMUTABLE_FUNCTION_SQL))
    op.execute(sa.text(IMMUTABLE_TRIGGER_SQL))

    op.create_table(
        "level_rule_changes",
        sa.Column("id", UUID, primary_key=True),
        sa.Column(
            "actor_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("changes", JSONB, nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_level_rule_changes_created", "level_rule_changes", ["created_at", "id"])

    _seed()


def downgrade() -> None:
    op.get_bind().execute(DELETE_RULES, {"key": SETTING_KEY})
    op.execute(sa.text(DROP_TRIGGER_SQL))
    op.execute(sa.text(DROP_FUNCTION_SQL))
    op.drop_index("ix_level_rule_changes_created", table_name="level_rule_changes")
    op.drop_table("level_rule_changes")
    op.drop_index("ix_technician_level_entries_ticket_id", table_name="technician_level_entries")
    op.drop_table("technician_level_entries")
