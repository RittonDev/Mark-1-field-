"""Livro de pontos do elo (Etapa 1): o saldo e a categoria saem dele; nada muda nem se apaga.

Cada lançamento (models/level_points.py) guarda o técnico, a ordem dele (`seq`), o tipo, os pontos
aplicados (e os pedidos pela regra quando o saldo mínimo cortou a perda), o saldo e a categoria
antes e depois, a OS e a atividade, o motivo, a chave da ocorrência com a geração, o estorno e quem
lançou. Correção = estorno (`reverse`) + o lançamento de novo, que entra na geração seguinte: a
mesma ocorrência nunca vale duas vezes ao mesmo tempo.

`post` (e `open_balance`, `adjust` e `reverse`, que passam por ele):
1. só técnico (422 LEVEL_NOT_TECHNICIAN);
2. só as regras aprovadas valem (level_rules.effective): as faixas de pontos e o saldo mínimo e, na
   abertura, também a abertura por atendimentos e o bônus (422 LEVEL_RULES_PENDING);
3. fora a abertura, o elo ativo (`activated_at`, gravado na ativação da Etapa 2; 422
   LEVEL_NOT_ACTIVE): nesta etapa o livro recusa tudo e o elo de 12 meses continua valendo;
4. um lançamento por técnico de cada vez (trava "level-points:{id}" até o fim da transação: o seq e
   o saldo encadeiam também com duas gravações juntas);
5. a mesma ocorrência: a última geração sem estorno é repetida (409 LEVEL_DUPLICATE); estornada, o
   lançamento novo entra na geração seguinte;
6. fora a abertura, exige um lançamento anterior (422 LEVEL_NO_OPENING);
7. saldo mínimo em zero: a perda para no zero e os pontos pedidos ficam em `rule_points`;
8. a categoria depois pelas faixas aprovadas (o Diamante não tem teto), `seq` + 1, INSERT e flush.

Sem rotas nesta etapa: a ativação (Etapa 2), o SLA e o abandono (Etapa 3), o retorno (Etapa 4) e o
extrato, o ajuste e o estorno na tela (Etapa 5) chamam estas funções. Só a central vê pontos.
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import LevelEntryKind, LevelTier, UserRole
from app.core.text import clean
from app.models import TechnicianLevelEntry, User
from app.schemas.level_rules import RULE_KEYS, RULE_LABELS
from app.services import level_rules
from app.services.errors import CodedError, NotFound

K = LevelEntryKind

NOT_TECHNICIAN = "Pontos só para técnicos"
RULES_PENDING = "Falta aprovar as regras do elo: {labels}"
NOT_ACTIVE = "O elo por pontos ainda não está ativo"
DUPLICATE = "Esta ocorrência já foi lançada no elo"
NO_OPENING = "O técnico ainda não tem saldo de abertura"
_MAX = level_rules.fmt(level_rules.ADJUST_MAX)
ADJUST_POINTS = f"Use um número inteiro de −{_MAX} a {_MAX}, diferente de zero"
REASON = f"Escreva o motivo com {level_rules.REASON_MIN} a {level_rules.REASON_MAX} caracteres"
ADJUST_NO_EFFECT = "Com o saldo mínimo em zero, este ajuste não muda o saldo"
NOT_REVERSIBLE = "Estorno e recategorização não se estornam"
ALREADY_REVERSED = "Este lançamento já foi estornado"
ENTRY_NOT_FOUND = "Lançamento não encontrado"

LOCK_KEY = "level-points:{technician_id}"
# As regras que cada lançamento lê (as aprovadas).
BASE_RULES = ("points_bands", "min_balance")
OPENING_RULES = ("count_bands", "points_bands", "opening_bonus", "min_balance")
# Tipos com função própria (motivo e autor conferidos lá).
_OWN_FUNCTION = {
    K.OPENING: "open_balance",
    K.ADJUSTMENT: "adjust",
    K.REVERSAL: "reverse",
}


@dataclass(frozen=True)
class Balance:
    """O saldo do técnico: o do último lançamento dele."""

    technician_id: uuid.UUID
    points: int
    tier: LevelTier
    seq: int
    entry_id: uuid.UUID
    at: datetime


E = TechnicianLevelEntry
_BALANCE_COLUMNS = (E.technician_id, E.balance_after, E.tier_after, E.seq, E.id, E.created_at)


def _balance(row: Any) -> Balance:
    technician_id, points, tier, seq, entry_id, at = row
    return Balance(technician_id, points, LevelTier(tier), seq, entry_id, at)


async def current(db: AsyncSession, technician_id: uuid.UUID) -> Balance | None:
    """O saldo e a categoria do técnico (o último `seq`); None sem lançamento."""
    row = (
        await db.execute(
            select(*_BALANCE_COLUMNS)
            .where(E.technician_id == technician_id)
            .order_by(E.seq.desc())
            .limit(1)
        )
    ).first()
    return _balance(row) if row is not None else None


async def balances(db: AsyncSession, ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, Balance]:
    """O saldo de vários técnicos de uma vez (DISTINCT ON o técnico); quem não tem lançamento fica
    de fora."""
    wanted = sorted(set(ids), key=str)
    if not wanted:
        return {}
    rows = await db.execute(
        select(*_BALANCE_COLUMNS)
        .where(E.technician_id.in_(wanted))
        .distinct(E.technician_id)
        .order_by(E.technician_id, E.seq.desc())
    )
    return {row[0]: _balance(row) for row in rows.all()}


# ------------------------------------------------------------------ conferências


def _require_technician(user: User | None) -> User:
    if user is None or user.role != UserRole.TECHNICIAN:
        raise CodedError(NOT_TECHNICIAN, "LEVEL_NOT_TECHNICIAN", 422)
    return user


def _reason(raw: Any) -> str:
    """O motivo limpo (core.text.clean), de REASON_MIN a REASON_MAX caracteres."""
    reason = clean(raw) if isinstance(raw, str) else ""
    if not level_rules.REASON_MIN <= len(reason) <= level_rules.REASON_MAX:
        raise CodedError(REASON, "LEVEL_REASON", 422)
    return reason


def _sign_ok(kind: LevelEntryKind, points: int) -> bool:
    """O sinal de cada tipo (o mesmo do check ck_technician_level_entries_sign)."""
    if kind == K.OPENING:
        return points >= 0
    if kind in (K.COMPLETION, K.ON_TIME):
        return points > 0
    if kind in (K.LATE, K.ABANDONMENT, K.REWORK_FAILURE):
        return points <= 0
    if kind == K.ADJUSTMENT:
        return points != 0
    if kind == K.RECATEGORIZATION:
        return points == 0
    return kind == K.REVERSAL


async def _rules(db: AsyncSession, kind: LevelEntryKind) -> tuple[dict[str, Any], dict[str, Any]]:
    """(documento, valores que valem); 422 LEVEL_RULES_PENDING quando falta aprovar uma regra que o
    lançamento lê."""
    doc = await level_rules.load(db)
    rules = level_rules.effective(doc)
    needed = OPENING_RULES if kind == K.OPENING else BASE_RULES
    missing = [key for key in RULE_KEYS if key in needed and key not in rules]
    if missing:
        labels = ", ".join(RULE_LABELS[key] for key in missing)
        raise CodedError(RULES_PENDING.format(labels=labels), "LEVEL_RULES_PENDING", 422)
    return doc, rules


async def _lock(db: AsyncSession, technician_id: uuid.UUID) -> None:
    """Um lançamento do técnico por vez, até o fim da transação: o último lançamento é lido depois
    da trava (em READ COMMITTED, já com o do outro pedido)."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": LOCK_KEY.format(technician_id=technician_id)},
    )


async def _reversal_of(db: AsyncSession, entry_id: uuid.UUID) -> uuid.UUID | None:
    return await db.scalar(select(E.id).where(E.reverses_id == entry_id))


async def _generation(db: AsyncSession, occurrence: str) -> int:
    """A geração do lançamento novo: 0; a seguinte quando a última foi estornada; a última sem
    estorno é repetida (409 LEVEL_DUPLICATE)."""
    last = (
        await db.execute(
            select(E.id, E.generation)
            .where(E.occurrence == occurrence)
            .order_by(E.generation.desc())
            .limit(1)
        )
    ).first()
    if last is None:
        return 0
    if await _reversal_of(db, last[0]) is None:
        raise CodedError(DUPLICATE, "LEVEL_DUPLICATE", 409)
    return int(last[1]) + 1


# ------------------------------------------------------------------ lançar


async def _post(
    db: AsyncSession,
    technician: User | None,
    *,
    kind: LevelEntryKind,
    points: int,
    reason: str,
    occurrence: str,
    actor: User | None,
    ticket_id: uuid.UUID | None = None,
    activity_id: uuid.UUID | None = None,
    opening_count: int | None = None,
    reverses: TechnicianLevelEntry | None = None,
    rules: tuple[dict[str, Any], dict[str, Any]] | None = None,
) -> TechnicianLevelEntry:
    """Os passos 1 a 8 do módulo; devolve o lançamento gravado (flush)."""
    technician = _require_technician(technician)
    doc, effective = rules if rules is not None else await _rules(db, kind)
    if kind != K.OPENING and not level_rules.is_active(doc):
        raise CodedError(NOT_ACTIVE, "LEVEL_NOT_ACTIVE", 422)
    await _lock(db, technician.id)
    if reverses is not None and await _reversal_of(db, reverses.id) is not None:
        raise CodedError(ALREADY_REVERSED, "LEVEL_ALREADY_REVERSED", 409)
    generation = await _generation(db, occurrence)
    last = await current(db, technician.id)
    if kind != K.OPENING and last is None:
        raise CodedError(NO_OPENING, "LEVEL_NO_OPENING", 422)
    balance = last.points if last is not None else 0
    applied, rule_points = level_rules.apply_floor(effective["min_balance"], balance, points)
    if kind == K.ADJUSTMENT and applied == 0:
        raise CodedError(ADJUST_NO_EFFECT, "LEVEL_ADJUST_NO_EFFECT", 422)
    after = balance + applied
    entry = TechnicianLevelEntry(
        technician_id=technician.id,
        seq=last.seq + 1 if last is not None else 1,
        kind=kind,
        points=applied,
        rule_points=rule_points,
        balance_before=balance,
        balance_after=after,
        tier_before=last.tier if last is not None else None,
        tier_after=level_rules.tier_for_balance(effective["points_bands"], after),
        ticket_id=ticket_id,
        activity_id=activity_id,
        opening_count=opening_count,
        reason=reason,
        occurrence=occurrence,
        generation=generation,
        reverses_id=reverses.id if reverses is not None else None,
        created_by_id=actor.id if actor is not None else None,
    )
    db.add(entry)
    await db.flush()
    return entry


async def post(
    db: AsyncSession,
    technician: User,
    *,
    kind: LevelEntryKind,
    points: int,
    reason: str,
    occurrence: str,
    actor: User | None,
    ticket_id: uuid.UUID | None = None,
    activity_id: uuid.UUID | None = None,
) -> TechnicianLevelEntry:
    """Lança uma ocorrência do sistema (conclusão, chegada, atraso, abandono, retorno com falha,
    recategorização) com os pontos da regra (o sinal do tipo; 0 em conclusão e chegada não lança).
    Abertura, ajuste e estorno têm função própria. `actor` None = Sistema."""
    kind = LevelEntryKind(kind)
    if kind in _OWN_FUNCTION:
        raise ValueError(f"Lançamento {kind.value}: use level_ledger.{_OWN_FUNCTION[kind]}")
    if isinstance(points, bool) or not isinstance(points, int) or not _sign_ok(kind, points):
        raise ValueError(f"Pontos fora do sinal do lançamento {kind.value}: {points!r}")
    cleaned = clean(reason) if isinstance(reason, str) else ""
    if not cleaned:
        raise ValueError("Lançamento sem motivo")
    return await _post(
        db,
        technician,
        kind=kind,
        points=points,
        reason=cleaned,
        occurrence=occurrence,
        actor=actor,
        ticket_id=ticket_id,
        activity_id=activity_id,
    )


def opening_reason(count: int) -> str:
    """"Abertura: 73 atendimentos concluídos" ("1 atendimento concluído")."""
    noun = "atendimento concluído" if count == 1 else "atendimentos concluídos"
    return f"Abertura: {level_rules.fmt(count)} {noun}"


async def open_balance(
    db: AsyncSession, technician: User, count: int, actor: User | None
) -> TechnicianLevelEntry:
    """A abertura pelo histórico: a categoria pela quantidade de atendimentos concluídos (faixas
    de abertura aprovadas) e o saldo = início da faixa de pontos + bônus. Uma por técnico
    (`opening:{id}`; repetida, 409 LEVEL_DUPLICATE). Não pede o elo ativo: a ativação abre os
    saldos antes de gravar `activated_at`."""
    _require_technician(technician)
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise ValueError(f"Contagem de abertura inválida: {count!r}")
    rules = await _rules(db, K.OPENING)
    effective = rules[1]
    tier = level_rules.tier_for_count(effective["count_bands"], count)
    points = level_rules.opening_balance(
        effective["points_bands"], effective["opening_bonus"], tier
    )
    return await _post(
        db,
        technician,
        kind=K.OPENING,
        points=points,
        reason=opening_reason(count),
        occurrence=f"opening:{technician.id}",
        actor=actor,
        opening_count=count,
        rules=rules,
    )


async def adjust(
    db: AsyncSession,
    technician: User,
    *,
    points: int,
    reason: str,
    actor: User,
    request_id: uuid.UUID,
    ticket_id: uuid.UUID | None = None,
) -> TechnicianLevelEntry:
    """Ajuste excepcional da central: −10.000 a 10.000, diferente de zero (422
    LEVEL_ADJUST_POINTS), com motivo de 10 a 500 caracteres (422 LEVEL_REASON) e autor.
    `request_id` é o id do diálogo (`adjustment:{id}`: o mesmo pedido repetido dá 409
    LEVEL_DUPLICATE). Com o saldo mínimo em zero, a perda que não muda o saldo: 422
    LEVEL_ADJUST_NO_EFFECT."""
    _require_technician(technician)
    limit = level_rules.ADJUST_MAX
    if (
        isinstance(points, bool)
        or not isinstance(points, int)
        or points == 0
        or not -limit <= points <= limit
    ):
        raise CodedError(ADJUST_POINTS, "LEVEL_ADJUST_POINTS", 422)
    cleaned = _reason(reason)
    if actor is None:
        raise ValueError("Ajuste sem autor")
    return await _post(
        db,
        technician,
        kind=K.ADJUSTMENT,
        points=points,
        reason=cleaned,
        occurrence=f"adjustment:{request_id}",
        actor=actor,
        ticket_id=ticket_id,
    )


async def reverse(
    db: AsyncSession, entry_id: uuid.UUID, *, reason: str, actor: User
) -> TechnicianLevelEntry:
    """Estorna um lançamento: os pontos ao contrário (com o saldo mínimo), a mesma OS e atividade,
    `reverses_id` e a ocorrência `reversal:{id}`; motivo de 10 a 500 caracteres e autor. O
    original fica como está. 404 "Lançamento não encontrado"; estorno e recategorização: 422
    LEVEL_NOT_REVERSIBLE; já estornado: 409 LEVEL_ALREADY_REVERSED. A correção é o estorno mais o
    lançamento de novo (na geração seguinte)."""
    entry = await db.get(TechnicianLevelEntry, entry_id)
    if entry is None:
        raise NotFound(ENTRY_NOT_FOUND)
    if entry.kind in (K.REVERSAL, K.RECATEGORIZATION):
        raise CodedError(NOT_REVERSIBLE, "LEVEL_NOT_REVERSIBLE", 422)
    cleaned = _reason(reason)
    if actor is None:
        raise ValueError("Estorno sem autor")
    technician = await db.get(User, entry.technician_id)
    return await _post(
        db,
        technician,
        kind=K.REVERSAL,
        points=-entry.points,
        reason=cleaned,
        occurrence=f"reversal:{entry.id}",
        actor=actor,
        ticket_id=entry.ticket_id,
        activity_id=entry.activity_id,
        reverses=entry,
    )
