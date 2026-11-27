"""Elo por pontos (Etapa 1): o livro de pontos imutável e o histórico das regras.

technician_level_entries (`TechnicianLevelEntry`): um lançamento por ocorrência, só por INSERT
(services/level_ledger.py). O saldo e a categoria do técnico saem do último lançamento dele (o maior
`seq`): `balance_after = balance_before + points` e `tier_after` pelas faixas aprovadas. Correção é
estorno (`kind` "reversal", `reverses_id`) mais o lançamento de novo, com a mesma `occurrence` e a
`generation` seguinte. Nada muda nem se apaga: o gatilho technician_level_entries_immutable recusa
UPDATE e DELETE (o TRUNCATE da limpeza da demonstração e dos testes não dispara gatilho de linha), e
as FKs são RESTRICT (o lançamento não deixa apagar técnico, autor nem OS). Só a central vê pontos.

level_rule_changes (`LevelRuleChange`): uma linha por gravação de Configurações › Elo ("seed", "save"
ou "approve"), com quem (`actor_id` null = Sistema) e o texto de cada regra que mudou
([{item, from, to}], services/level_rules.value_text).

O gatilho nasce aqui também (event after_create): o banco dos testes vem dos modelos. A migração
d9e1f3a5b7c2 tem cópias do SQL (tests/test_level_rules_migration.py confere).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    DDL,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    event,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import LevelEntryKind, LevelTier
from app.db.base import Base, UUIDPrimaryKey, created_at_column
from app.models._types import str_enum
from app.models.user import User

# O nome do gatilho e da "restrição" que ele cita no erro (app.main.CONSTRAINT_MESSAGES).
IMMUTABLE = "technician_level_entries_immutable"
IMMUTABLE_MESSAGE = "Lançamento de pontos não muda nem se apaga: use o estorno"

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

# Os checks (ck_technician_level_entries_{nome}); a migração tem a mesma cópia.
CHECKS: dict[str, str] = {
    "balance": "balance_after = balance_before + points",
    "counters": "seq >= 1 AND generation >= 0",
    # O 1º lançamento do técnico é a abertura, do zero e sem categoria anterior.
    "first": "seq > 1 OR (kind = 'opening' AND balance_before = 0 AND tier_before IS NULL)",
    "tier_before": "seq = 1 OR tier_before IS NOT NULL",
    "reversal": "(kind = 'reversal') = (reverses_id IS NOT NULL)",
    # Ajuste e estorno sempre com quem fez.
    "author": "kind NOT IN ('adjustment', 'reversal') OR created_by_id IS NOT NULL",
    "reason": "length(btrim(reason)) > 0",
    "opening_count": (
        "(kind = 'opening') = (opening_count IS NOT NULL) AND coalesce(opening_count, 0) >= 0"
    ),
    # O pedido pela regra só fica quando o saldo mínimo cortou a perda.
    "rule_points": "rule_points IS NULL OR rule_points < points",
    # O sinal de cada tipo (o estorno é livre); tipo fora da lista não entra.
    "sign": (
        "(kind = 'opening' AND points >= 0)"
        " OR (kind IN ('completion', 'on_time') AND points > 0)"
        " OR (kind IN ('late', 'abandonment', 'rework_failure') AND points <= 0)"
        " OR (kind = 'adjustment' AND points <> 0)"
        " OR (kind = 'recategorization' AND points = 0)"
        " OR kind = 'reversal'"
    ),
}


class TechnicianLevelEntry(UUIDPrimaryKey, Base):
    """Lançamento do livro de pontos. Imutável (gatilho no banco); sem relação de volta em User,
    nada cai em cascata."""

    __tablename__ = "technician_level_entries"
    __table_args__ = (
        # A ordem do técnico: duas gravações juntas não encadeiam o mesmo saldo (o serviço trava o
        # técnico antes; o índice fica de reserva).
        UniqueConstraint("technician_id", "seq", name="uq_technician_level_entries_seq"),
        # A mesma ocorrência vale uma vez por geração (a seguinte só depois do estorno).
        UniqueConstraint(
            "occurrence", "generation", name="uq_technician_level_entries_occurrence"
        ),
        UniqueConstraint("reverses_id", name="uq_technician_level_entries_reverses_id"),
        *(CheckConstraint(sql, name=name) for name, sql in CHECKS.items()),
    )

    technician_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    # 1, 2, 3... por técnico.
    seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[LevelEntryKind] = mapped_column(str_enum(LevelEntryKind))
    # Os pontos aplicados (com o sinal) e, quando o saldo mínimo em zero cortou a perda, os pedidos
    # pela regra.
    points: Mapped[int] = mapped_column(Integer)
    rule_points: Mapped[int | None] = mapped_column(Integer)
    balance_before: Mapped[int] = mapped_column(Integer)
    balance_after: Mapped[int] = mapped_column(Integer)
    # Null só no 1º lançamento (a abertura).
    tier_before: Mapped[LevelTier | None] = mapped_column(str_enum(LevelTier))
    tier_after: Mapped[LevelTier] = mapped_column(str_enum(LevelTier))
    ticket_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tickets.id", ondelete="RESTRICT"), index=True
    )
    # A atividade (visita) da ocorrência: a FK entra na Etapa 2, com a tabela das atividades.
    activity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Só na abertura: os atendimentos concluídos que definiram a categoria.
    opening_count: Mapped[int | None] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text)
    # A chave da ocorrência ("opening:{técnico}", "adjustment:{pedido}", "reversal:{lançamento}"...)
    # e a geração (0; a seguinte depois do estorno da anterior).
    occurrence: Mapped[str] = mapped_column(String(160))
    generation: Mapped[int] = mapped_column(SmallInteger, default=0, server_default="0")
    reverses_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "technician_level_entries.id",
            ondelete="RESTRICT",
            name="fk_technician_level_entries_reverses_id",
        )
    )
    # Quem lançou (null = Sistema).
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT")
    )
    created_at: Mapped[datetime] = created_at_column()


# O gatilho de imutabilidade também no create_all (testes); no banco de verdade, a migração.
event.listen(
    TechnicianLevelEntry.__table__,
    "after_create",
    DDL(IMMUTABLE_FUNCTION_SQL).execute_if(dialect="postgresql"),
)
event.listen(
    TechnicianLevelEntry.__table__,
    "after_create",
    DDL(IMMUTABLE_TRIGGER_SQL).execute_if(dialect="postgresql"),
)


class LevelRuleChange(UUIDPrimaryKey, Base):
    """Histórico de Configurações › Elo: as sugestões preenchidas (seed), cada gravação (save) e
    cada aprovação (approve)."""

    __tablename__ = "level_rule_changes"
    __table_args__ = (Index("ix_level_rule_changes_created", "created_at", "id"),)

    # Quem gravou ou aprovou; null = Sistema (as sugestões da migração).
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # "seed" | "save" | "approve".
    action: Mapped[str] = mapped_column(String(16))
    # [{item, from, to}]: o texto de cada regra (from null no seed e na aprovação).
    changes: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at_column()

    actor: Mapped[User | None] = relationship(foreign_keys=[actor_id], lazy="selectin")
