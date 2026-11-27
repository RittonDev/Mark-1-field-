"""Regras do elo por pontos: Configurações › Elo (Etapa 1).

As 13 regras ficam em system_settings["level.rules"], numa chave só delas (o app lê
GET /settings/field e nunca recebe pontos):

    {version, activated_at, activated_by, items: {chave: item}}
    item = {value, origin ("qa" | "default" | "central"), changed_at, changed_by: {id, name} | null,
            approved: {value, text, at, by: {id, name}} | null}

`confirmers` não tem `value`: sai dos perfis de acesso (quem tem "Elo: confirmar ocorrências" em
Editar, mais o administrador). Sem a linha, vale `default_doc()` (versão 1): as sugestões do QA e o
padrão "a validar", as decisões pendentes vazias (os +10/+5/−10 da conversa não entram). A migração
d9e1f3a5b7c2 grava o mesmo documento e o 1º histórico (`seed_changes()`; as cópias de lá são
conferidas em tests/test_level_rules_migration.py).

Estado de cada regra pelo valor comparável (`comparable`): "pending" (null: falta definir),
"approved" (igual ao aprovado; voltar ao valor aprovado volta a aprovar) e "to_validate" (o resto).
Na abertura o comparável leva junto as faixas de pontos (faixa nova pede nova aprovação da
abertura); em quem confirma, os ids dos perfis e das pessoas.

Gravar (PUT) e aprovar sobem a versão (outra versão: 409 LEVEL_RULES_CHANGED) sob a trava
"level-rules" e deixam uma linha em level_rule_changes com o texto das regras (`value_text`); sem a
linha, gravam o seed antes. Nada mudou, nada é gravado. Só os valores aprovados valem
(`effective`): o livro de pontos (services/level_ledger.py) lê só eles. Nesta etapa ninguém grava
`activated_at`: o elo de 12 meses continua valendo e o livro recusa tudo.

Puras (a web repete em lib/levelRules.ts; os limites são lidos pela sonda da web, por isso os
números sem "_"): tier_for_count, tier_for_balance, opening_balance, apply_floor, value_text,
rule_problems, comparable, activation_missing e effective.
"""

import copy
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import DateTime, Uuid, literal, select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions
from app.core.enums import LevelTier, UserRole
from app.core.labels import LEVEL_TIER_LABELS
from app.core.text import fold
from app.db.base import utcnow
from app.models import AccessProfile, LevelRuleChange, SystemSetting, User
from app.schemas.level_rules import (
    RULE_KEYS,
    RULE_LABELS,
    LevelRulesApprove,
    LevelRulesIn,
    LevelRulesOut,
)
from app.services.access import SYSTEM_PROFILES
from app.services.errors import CodedError, WorkflowError

SETTING_KEY = "level.rules"
COUNT_MAX = 100000
POINTS_MAX = 1000000
GAIN_MAX = 1000
LOSS_MAX = 10000
ABANDONMENT_MIN = 80
REWORK_MIN = 50
TOLERANCE_MAX = 240
ADJUST_MAX = 10000
REASON_MIN, REASON_MAX = 10, 500

LOCK_KEY = "level-rules"
SEED_NOTE = "Sugestões do QA e padrões, a validar"
CONFIRM_ITEM = "base.level_confirm"
ADMIN_LABEL = "Administrador"
OWN_ADJUSTMENT = "ajuste próprio"
ORIGINS = ("qa", "default", "central")

# Erros (servidor: sem ponto final).
RULES_CHANGED = "As regras do elo mudaram em outra tela. Recarregue"
RULE_EMPTY = "Falta definir: {label}"
PAGE_ERROR = "Página do histórico inválida. Recarregue a tela"
BEFORE_MAX = 100

VALUE_KEYS: tuple[str, ...] = tuple(key for key in RULE_KEYS if key != "confirmers")
TIERS: tuple[LevelTier, ...] = (
    LevelTier.BRONZE,
    LevelTier.SILVER,
    LevelTier.GOLD,
    LevelTier.DIAMOND,
)
# Na contagem o Bronze começa em 0: só o início das outras três é guardado.
COUNT_TIERS: tuple[LevelTier, ...] = TIERS[1:]
# "O início do Ouro tem de ser maior que o da Prata."
_OF: dict[str, str] = {
    LevelTier.BRONZE: "do Bronze",
    LevelTier.SILVER: "da Prata",
    LevelTier.GOLD: "do Ouro",
    LevelTier.DIAMOND: "do Diamante",
}

# As sugestões do QA ("a validar" até a operação aprovar).
QA_VALUES: dict[str, Any] = {
    "count_bands": {"silver": 51, "gold": 101, "diamond": 151},
    "points_bands": {"bronze": 100, "silver": 901, "gold": 1401, "diamond": 1850},
    "opening_bonus": 100,
    "abandonment_loss": 80,
    "rework_loss": 50,
}
# Os padrões do sistema: as decisões pendentes vazias e os motivos no app desligados.
DEFAULT_VALUES: dict[str, Any] = {
    "completion_gain": None,
    "on_time_gain": None,
    "late": None,
    "min_balance": None,
    "arrival_tolerance": None,
    "arrival_time": None,
    "app_reasons": False,
}


# ------------------------------------------------------------------ números e textos


def fmt(number: int) -> str:
    """Inteiro com ponto de milhar ("1.401")."""
    return f"{number:,}".replace(",", ".")


def points_text(number: int) -> str:
    return f"{fmt(number)} {'ponto' if abs(number) == 1 else 'pontos'}"


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _bands(value: Any, tiers: Iterable[str]) -> dict[str, int] | None:
    """As faixas com todos os inícios inteiros; senão None."""
    if not isinstance(value, Mapping):
        return None
    out: dict[str, int] = {}
    for tier in tiers:
        number = _int(value.get(tier))
        if number is None:
            return None
        out[tier] = number
    return out


# ------------------------------------------------------------------ categorias (puras)


def tier_for_count(bands: Mapping[str, int], count: int) -> LevelTier:
    """Categoria de abertura pela quantidade de atendimentos concluídos: a mais alta cujo início
    a contagem alcança (o Bronze começa em 0; Ouro até o início do Diamante menos 1)."""
    for tier in reversed(COUNT_TIERS):
        if count >= bands[tier]:
            return tier
    return LevelTier.BRONZE


def tier_for_balance(bands: Mapping[str, int], balance: int) -> LevelTier:
    """Categoria pelo saldo: abaixo do início da Prata é Bronze, mesmo negativo; o Diamante não
    tem teto."""
    for tier in reversed(TIERS[1:]):
        if balance >= bands[tier]:
            return tier
    return LevelTier.BRONZE


def opening_balance(bands: Mapping[str, int], bonus: int, tier: str) -> int:
    """Saldo de abertura da categoria: o início da faixa de pontos mais o bônus."""
    return bands[tier] + bonus


def apply_floor(min_balance: str | None, balance: int, points: int) -> tuple[int, int | None]:
    """(pontos aplicados, pontos pedidos pela regra ou None). Com o saldo mínimo em zero, a perda
    para no zero: max(pontos, -max(saldo, 0)); o pedido fica quando a perda foi cortada."""
    if min_balance == "zero" and points < 0:
        applied = max(points, -max(balance, 0))
        if applied != points:
            return applied, points
    return points, None


# ------------------------------------------------------------------ documento


def _item(value: Any, origin: str) -> dict[str, Any]:
    return {
        "value": value,
        "origin": origin,
        "changed_at": None,
        "changed_by": None,
        "approved": None,
    }


def default_doc() -> dict[str, Any]:
    """O documento sem gravação: as sugestões do QA ("qa") e os padrões ("default"), nada
    aprovado, versão 1. Quem confirma não tem valor (sai dos perfis)."""
    items: dict[str, Any] = {}
    for key in RULE_KEYS:
        if key == "confirmers":
            item = _item(None, "default")
            del item["value"]
            items[key] = item
        elif key in QA_VALUES:
            items[key] = _item(copy.deepcopy(QA_VALUES[key]), "qa")
        else:
            items[key] = _item(DEFAULT_VALUES[key], "default")
    return {"version": 1, "activated_at": None, "activated_by": None, "items": items}


def normalize(raw: Any) -> dict[str, Any]:
    """O documento gravado completo e numa cópia nova (quem muda grava um objeto novo no JSONB):
    a regra que faltar volta ao padrão; versão estranha vira 1."""
    base = default_doc()
    if not isinstance(raw, Mapping):
        return base
    doc = copy.deepcopy(dict(raw))
    version = _int(doc.get("version"))
    doc["version"] = version if version is not None and version >= 1 else 1
    doc.setdefault("activated_at", None)
    doc.setdefault("activated_by", None)
    stored = doc.get("items")
    items: dict[str, Any] = dict(stored) if isinstance(stored, Mapping) else {}
    for key in RULE_KEYS:
        item = items.get(key)
        if not isinstance(item, Mapping):
            items[key] = base["items"][key]
            continue
        merged = {**base["items"][key], **item}
        if merged.get("origin") not in ORIGINS:
            merged["origin"] = base["items"][key]["origin"]
        items[key] = merged
    doc["items"] = items
    return doc


def values_of(doc: Mapping[str, Any]) -> dict[str, Any]:
    """Os 12 valores gravados (sem quem confirma)."""
    return {key: doc["items"][key].get("value") for key in VALUE_KEYS}


# ------------------------------------------------------------------ quem confirma


@dataclass(frozen=True)
class Confirmers:
    """Quem confirma abandono e retorno agora: o administrador (sempre), os perfis com o item em
    Editar (na ordem da tela de perfis) e as pessoas com o ajuste próprio (por nome)."""

    profiles: tuple[tuple[uuid.UUID, str], ...] = ()
    people: tuple[tuple[uuid.UUID, str], ...] = ()

    @property
    def value(self) -> dict[str, list[str]]:
        """O comparável: os ids ordenados."""
        return {
            "profiles": sorted(str(item_id) for item_id, _ in self.profiles),
            "people": sorted(str(item_id) for item_id, _ in self.people),
        }

    @property
    def text(self) -> str:
        return confirmers_text(
            [name for _, name in self.profiles], [name for _, name in self.people]
        )


def confirmers_text(profiles: Iterable[str], people: Iterable[str]) -> str:
    """"Administrador · Supervisor · Ana Exemplo (ajuste próprio)"."""
    own = [f"{name} ({OWN_ADJUSTMENT})" for name in people]
    return " · ".join([ADMIN_LABEL, *profiles, *own])


def default_confirmers_text() -> str:
    """Quem confirma pelos padrões do código (os perfis padrão com o item em Editar): o texto das
    sugestões preenchidas."""
    defaults = permissions.ROLE_DEFAULTS
    names = [name for key, name, _ in SYSTEM_PROFILES if defaults[key][CONFIRM_ITEM] == "edit"]
    return confirmers_text(names, [])


def _profile_order(profile: AccessProfile) -> tuple[int, str, str]:
    rank = {UserRole.SUPERVISOR.value: 0, UserRole.ANALYST.value: 1}
    return (rank.get(profile.system_key or "", 2), fold(profile.name), str(profile.id))


async def current_confirmers(db: AsyncSession) -> Confirmers:
    """Os perfis com "Elo: confirmar ocorrências" em Editar (padrão do código mais o gravado) e as
    pessoas ativas (supervisor ou analista) com o ajuste próprio em Editar cujo perfil não dá o
    item. O administrador confirma sempre e não entra nos ids."""
    profiles = sorted(await db.scalars(select(AccessProfile)), key=_profile_order)
    granted = [p for p in profiles if permissions.profile_items(p)[CONFIRM_ITEM] == "edit"]
    system = {p.system_key: p for p in profiles if p.system_key}
    users = await db.scalars(
        select(User).where(
            User.role.in_(sorted(permissions.PROFILE_ROLES)), User.is_active.is_(True)
        )
    )
    people: list[tuple[uuid.UUID, str]] = []
    for user in users:
        overrides = user.access_overrides if isinstance(user.access_overrides, Mapping) else {}
        items = overrides.get("items")
        if not isinstance(items, Mapping) or items.get(CONFIRM_ITEM) != "edit":
            continue
        role = UserRole(user.role)
        profile = user.access_profile or system.get(role.value)
        if permissions.profile_items(profile, role)[CONFIRM_ITEM] == "edit":
            continue  # o perfil já dá o item
        people.append((user.id, user.name))
    people.sort(key=lambda person: (fold(person[1]), str(person[0])))
    return Confirmers(tuple((p.id, p.name) for p in granted), tuple(people))


# ------------------------------------------------------------------ texto de cada regra


def _bands_text(starts: Mapping[str, int]) -> str:
    """"Bronze 100 a 900 · Prata 901 a 1.400 · Ouro 1.401 a 1.849 · Diamante 1.850 ou mais": o fim
    de cada uma é o início da próxima menos 1."""
    labels = LEVEL_TIER_LABELS
    parts = [
        f"{labels[tier]} {fmt(starts[tier])} a {fmt(starts[TIERS[i + 1]] - 1)}"
        for i, tier in enumerate(TIERS[:-1])
    ]
    parts.append(f"{labels[LevelTier.DIAMOND]} {fmt(starts[LevelTier.DIAMOND])} ou mais")
    return " · ".join(parts)


def value_text(
    key: str, values: Mapping[str, Any], confirmers: Confirmers | None = None
) -> str | None:
    """O texto da regra, com ponto de milhar (null = falta definir). Na abertura, o bônus e a
    abertura de cada categoria pelas faixas de pontos de `values`."""
    if key == "confirmers":
        return confirmers.text if confirmers is not None else None
    value = values.get(key)
    if value is None:
        return None
    if key == "count_bands":
        bands = _bands(value, COUNT_TIERS)
        return _bands_text({LevelTier.BRONZE: 0, **bands}) if bands is not None else None
    if key == "points_bands":
        bands = _bands(value, TIERS)
        return _bands_text(bands) if bands is not None else None
    if key == "opening_bonus":
        bonus = _int(value)
        if bonus is None:
            return None
        bands = _bands(values.get("points_bands"), TIERS)
        if bands is None:
            return points_text(bonus)
        labels = LEVEL_TIER_LABELS
        openings = " · ".join(f"{labels[t]} {fmt(bands[t] + bonus)}" for t in TIERS)
        return f"{points_text(bonus)}: {openings}"
    if key in ("completion_gain", "on_time_gain"):
        number = _int(value)
        if number is None:
            return None
        return f"Ganha {points_text(number)}" if number else "Não gera pontos"
    if key == "late":
        if not isinstance(value, Mapping):
            return None
        if value.get("mode") == "no_gain":
            return "Só deixa de ganhar"
        number = _int(value.get("points"))
        return f"Desconta {points_text(number)}" if number is not None else None
    if key in ("abandonment_loss", "rework_loss"):
        number = _int(value)
        return f"Perde {points_text(number)}" if number is not None else None
    if key == "min_balance":
        return {"negative": "Pode ficar negativo", "zero": "Para em zero"}.get(value)
    if key == "arrival_tolerance":
        number = _int(value)
        return f"{fmt(number)} min" if number is not None else None
    if key == "arrival_time":
        return {"server": "Hora do servidor", "device": "Hora do aparelho"}.get(value)
    if key == "app_reasons":
        return "Ligado (sem pontos)" if value is True else "Desligado"
    return None


def seed_changes() -> list[dict[str, Any]]:
    """O 1º histórico (as sugestões preenchidas): o texto das regras que nascem com valor, na ordem
    da tela, com `from` null."""
    values = values_of(default_doc())
    out: list[dict[str, Any]] = []
    for key in RULE_KEYS:
        shown = default_confirmers_text() if key == "confirmers" else value_text(key, values)
        if shown is not None:
            out.append({"item": key, "from": None, "to": shown})
    return out


# ------------------------------------------------------------------ validação (§2.3)


def range_message(low: int, high: int) -> str:
    return f"Use um número inteiro de {fmt(low)} a {fmt(high)}."


TOLERANCE_MESSAGE = f"Use minutos inteiros de 0 a {TOLERANCE_MAX}."
LATE_MODE_MESSAGE = "Escolha se o atraso desconta pontos ou só deixa de ganhar."
LATE_POINTS_MESSAGE = "Informe quantos pontos o atraso desconta."


def order_message(tier: str, previous: str) -> str:
    return f"O início {_OF[tier]} tem de ser maior que o {_OF[previous]}."


def opening_message(tier: str, opening: int, end: int) -> str:
    return (
        f"Com este bônus, a abertura {_OF[tier]} ({fmt(opening)}) passa do fim da faixa "
        f"({fmt(end)})."
    )


def minimum_message(low: int) -> str:
    return f"No mínimo {fmt(low)} pontos."


def _band_problems(
    key: str, value: Any, tiers: Iterable[str], low: int, high: int, first: tuple[str, int] | None
) -> list[tuple[str, str]]:
    """Faixa a faixa: fora do limite, ou o início que não passa o da categoria de antes (a
    mensagem fica no campo de cima). `first` = (categoria, início) fixo antes delas (o Bronze em 0
    na contagem)."""
    bands = value if isinstance(value, Mapping) else {}
    out: list[tuple[str, str]] = []
    previous = first
    for tier in tiers:
        number = _int(bands.get(tier))
        field = f"{key}.{tier}"
        if number is None or not low <= number <= high:
            out.append((field, range_message(low, high)))
            previous = None
            continue
        if previous is not None and number <= previous[1]:
            out.append((field, order_message(tier, previous[0])))
        previous = (tier, number)
    return out


def rule_problems(values: Mapping[str, Any]) -> list[tuple[str, str]]:
    """Os problemas dos valores, na ordem da tela: (campo, mensagem da tela, com ponto). Campo =
    "count_bands.gold", "points_bands.silver", "opening_bonus", "late.mode", "late.points"..."""
    out: list[tuple[str, str]] = []
    out += _band_problems(
        "count_bands", values.get("count_bands"), COUNT_TIERS, 1, COUNT_MAX, None
    )
    band_problems = _band_problems(
        "points_bands", values.get("points_bands"), TIERS, 0, POINTS_MAX, None
    )
    out += band_problems

    bonus = _int(values.get("opening_bonus"))
    if bonus is None or not 0 <= bonus <= POINTS_MAX:
        out.append(("opening_bonus", range_message(0, POINTS_MAX)))
    elif not band_problems:
        bands = _bands(values.get("points_bands"), TIERS) or {}
        for i, tier in enumerate(TIERS[:-1]):
            end = bands[TIERS[i + 1]] - 1
            if bands[tier] + bonus > end:
                out.append(("opening_bonus", opening_message(tier, bands[tier] + bonus, end)))
                break

    for key in ("completion_gain", "on_time_gain"):
        raw = values.get(key)
        number = _int(raw)
        if raw is not None and (number is None or not 0 <= number <= GAIN_MAX):
            out.append((key, range_message(0, GAIN_MAX)))

    late = values.get("late")
    if late is not None:
        late = late if isinstance(late, Mapping) else {}
        mode = late.get("mode")
        points = late.get("points")
        if mode not in ("deduct", "no_gain"):
            out.append(("late.mode", LATE_MODE_MESSAGE))
        elif mode == "deduct":
            number = _int(points)
            if points is None:
                out.append(("late.points", LATE_POINTS_MESSAGE))
            elif number is None or not 1 <= number <= GAIN_MAX:
                out.append(("late.points", range_message(1, GAIN_MAX)))

    for key, low in (("abandonment_loss", ABANDONMENT_MIN), ("rework_loss", REWORK_MIN)):
        number = _int(values.get(key))
        if number is None or number > LOSS_MAX:
            out.append((key, range_message(low, LOSS_MAX)))
        elif number < low:
            out.append((key, minimum_message(low)))

    tolerance = values.get("arrival_tolerance")
    number = _int(tolerance)
    if tolerance is not None and (number is None or not 0 <= number <= TOLERANCE_MAX):
        out.append(("arrival_tolerance", TOLERANCE_MESSAGE))
    return out


def server_message(field: str, message: str) -> str:
    """"{rótulo}: {mensagem com inicial minúscula, sem ponto}"."""
    label = RULE_LABELS[field.split(".", 1)[0]]
    return f"{label}: {message[:1].lower()}{message[1:].removesuffix('.')}"


def validate(values: Mapping[str, Any]) -> None:
    """422 LEVEL_RULE_INVALID com o 1º problema (na ordem da tela)."""
    problems = rule_problems(values)
    if problems:
        raise CodedError(server_message(*problems[0]), "LEVEL_RULE_INVALID", 422)


# ------------------------------------------------------------------ estado, trava e vigência


def comparable(key: str, values: Mapping[str, Any], confirmers: Confirmers | None = None) -> Any:
    """O que a aprovação guarda e compara: o valor; na abertura, o bônus com as faixas de pontos;
    em quem confirma, os ids dos perfis e das pessoas. None = falta definir."""
    if key == "confirmers":
        return confirmers.value if confirmers is not None else None
    value = values.get(key)
    if key == "opening_bonus" and value is not None:
        return {"bonus": value, "points_bands": values.get("points_bands")}
    return value


def state_of(current: Any, approved: Any) -> str:
    if current is None:
        return "pending"
    if isinstance(approved, Mapping) and approved.get("value") == current:
        return "approved"
    return "to_validate"


def states(doc: Mapping[str, Any], confirmers: Confirmers | None) -> dict[str, str]:
    values = values_of(doc)
    return {
        key: state_of(comparable(key, values, confirmers), doc["items"][key].get("approved"))
        for key in RULE_KEYS
    }


def activation_missing(doc: Mapping[str, Any], confirmers: Confirmers | None) -> list[str]:
    """O que impede ativar: as regras a definir ou a validar, na ordem da tela (a Etapa 2 recusa a
    ativação com 422 LEVEL_RULES_PENDING)."""
    return [key for key, state in states(doc, confirmers).items() if state != "approved"]


def effective(doc: Mapping[str, Any]) -> dict[str, Any]:
    """Só o que vale: {chave: valor aprovado}. A regra nunca aprovada fica de fora (a mudança só
    vale depois de aprovada, mesmo com o elo ativo). A abertura vale com as faixas de pontos que
    valem: aprovada com outras faixas, fica de fora até a nova aprovação. Em quem confirma,
    {profiles, people} da aprovação."""
    out: dict[str, Any] = {}
    for key in RULE_KEYS:
        approved = doc["items"][key].get("approved")
        if not isinstance(approved, Mapping):
            continue
        value = approved.get("value")
        if key == "opening_bonus":
            if not isinstance(value, Mapping):
                continue
            if value.get("points_bands") != out.get("points_bands"):
                continue
            value = value.get("bonus")
        if value is not None:
            out[key] = value
    return out


def is_active(doc: Mapping[str, Any]) -> bool:
    return bool(doc.get("activated_at"))


# ------------------------------------------------------------------ leitura e saída


async def _row(db: AsyncSession) -> SystemSetting | None:
    """A linha como está no banco agora (não a cópia guardada na sessão)."""
    stmt = (
        select(SystemSetting)
        .where(SystemSetting.key == SETTING_KEY)
        .execution_options(populate_existing=True)
    )
    return await db.scalar(stmt)


async def load(db: AsyncSession) -> dict[str, Any]:
    """O documento gravado (sem a linha: `default_doc()`), completo e numa cópia nova."""
    row = await _row(db)
    return normalize(row.value if row is not None else None)


def _stamp(at: Any, by: Any) -> dict[str, Any] | None:
    if not at:
        return None
    return {"at": at, "by": by if isinstance(by, Mapping) else None}


def out(doc: Mapping[str, Any], confirmers: Confirmers, *, can_edit: bool) -> LevelRulesOut:
    """GET /level-rules: valores, estado de cada regra, o que falta e quem confirma."""
    values = values_of(doc)
    state = states(doc, confirmers)
    items: dict[str, Any] = {}
    for key in RULE_KEYS:
        item = doc["items"][key]
        approved = item.get("approved")
        approval = None
        if isinstance(approved, Mapping) and approved.get("at"):
            approval = {
                **(_stamp(approved.get("at"), approved.get("by")) or {}),
                "text": approved.get("text") or "",
            }
        items[key] = {
            "state": state[key],
            "origin": None if key == "confirmers" else item.get("origin"),
            "text": value_text(key, values, confirmers),
            "changed": _stamp(item.get("changed_at"), item.get("changed_by")),
            "approved": approval,
        }
    return LevelRulesOut.model_validate(
        {
            "version": doc["version"],
            "active": is_active(doc),
            "activated_at": doc.get("activated_at"),
            "values": values,
            "items": items,
            "missing": {
                "define": [key for key in RULE_KEYS if state[key] == "pending"],
                "approve": [key for key in RULE_KEYS if state[key] == "to_validate"],
            },
            "confirmers": {
                "profiles": [{"id": i, "name": n} for i, n in confirmers.profiles],
                "people": [{"id": i, "name": n} for i, n in confirmers.people],
            },
            "can_edit": can_edit,
        }
    )


async def read(db: AsyncSession, *, can_edit: bool) -> LevelRulesOut:
    """As regras como estão (sem a linha, as sugestões do QA e os padrões, versão 1). Nada é
    gravado."""
    doc = await load(db)
    return out(doc, await current_confirmers(db), can_edit=can_edit)


# ------------------------------------------------------------------ gravar e aprovar


async def _lock(db: AsyncSession) -> None:
    """Uma gravação das regras por vez, até o fim da transação (a versão e o seed são conferidos
    lendo a linha depois da trava)."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": LOCK_KEY}
    )


def _person(user: User) -> dict[str, str]:
    return {"id": str(user.id), "name": user.name}


def _after(moment: datetime | None) -> datetime:
    """Agora, sempre depois de `moment` (o seed gravado na mesma transação fica antes)."""
    now = utcnow()
    if moment is not None and now <= moment:
        return moment + timedelta(microseconds=1)
    return now


async def _locked_row(db: AsyncSession) -> tuple[SystemSetting, datetime | None]:
    """Trava e lê a linha; sem ela, grava o seed antes (o documento padrão e o 1º histórico, como
    a migração). Devolve a linha e o instante do seed gravado agora (None se já havia)."""
    await _lock(db)
    row = await _row(db)
    if row is not None:
        return row, None
    seeded = utcnow()
    row = SystemSetting(key=SETTING_KEY, value=default_doc(), updated_at=seeded)
    db.add(row)
    db.add(
        LevelRuleChange(
            actor_id=None,
            action="seed",
            changes=seed_changes(),
            note=SEED_NOTE,
            created_at=seeded,
        )
    )
    await db.flush()
    return row, seeded


def _check_version(doc: Mapping[str, Any], version: int) -> None:
    if version != doc["version"]:
        raise CodedError(RULES_CHANGED, "LEVEL_RULES_CHANGED", 409)


def values_in(data: LevelRulesIn) -> dict[str, Any]:
    """Os 12 valores do PUT como ficam gravados ("Só deixa de ganhar" grava `points` null)."""
    raw = data.model_dump()
    values = {key: raw[key] for key in VALUE_KEYS}
    late = values["late"]
    if isinstance(late, Mapping) and late.get("mode") == "no_gain":
        values["late"] = {"mode": "no_gain", "points": None}
    return values


def _write(
    db: AsyncSession,
    row: SystemSetting,
    doc: dict[str, Any],
    actor: User,
    at: datetime,
    action: str,
    changes: list[dict[str, Any]],
) -> None:
    doc["version"] += 1
    row.value = doc  # objeto novo: o JSONB é regravado
    row.updated_at = at
    row.updated_by_id = actor.id
    db.add(LevelRuleChange(actor_id=actor.id, action=action, changes=changes, created_at=at))


async def save(db: AsyncSession, data: LevelRulesIn, actor: User) -> LevelRulesOut:
    """PUT: grava os 12 valores. O que mudou ganha a origem "central" e quem/quando; a aprovação
    fica guardada (voltar ao valor aprovado volta a aprovar). Versão lida diferente: 409
    LEVEL_RULES_CHANGED; valor inválido: 422 LEVEL_RULE_INVALID com o 1º problema. Nada mudou,
    nada é gravado. O histórico leva o texto que mudou (a abertura também quando mudam as
    faixas)."""
    row, seeded = await _locked_row(db)
    doc = normalize(row.value)
    _check_version(doc, data.version)
    new = values_in(data)
    validate(new)
    old = values_of(doc)
    confirmers = await current_confirmers(db)
    changed = [key for key in VALUE_KEYS if new[key] != old[key]]
    if changed:
        at = _after(seeded)
        for key in changed:
            item = doc["items"][key]
            item["value"] = copy.deepcopy(new[key])
            item["origin"] = "central"
            item["changed_at"] = at.isoformat()
            item["changed_by"] = _person(actor)
        changes = [
            {"item": key, "from": before, "to": after}
            for key in VALUE_KEYS
            if (before := value_text(key, old)) != (after := value_text(key, new))
        ]
        _write(db, row, doc, actor, at, "save", changes)
        await db.flush()
    return out(doc, confirmers, can_edit=True)


async def approve(db: AsyncSession, data: LevelRulesApprove, actor: User) -> LevelRulesOut:
    """Aprova as regras pedidas que estão a validar (com quem e quando e o texto aprovado). Regra
    a definir: 422 LEVEL_RULE_EMPTY "Falta definir: {rótulo}" e nada é aprovado; já aprovada, fica
    como está (nada a aprovar: nada gravado). Versão lida diferente: 409 LEVEL_RULES_CHANGED."""
    row, seeded = await _locked_row(db)
    doc = normalize(row.value)
    _check_version(doc, data.version)
    asked = set(data.keys)
    keys = [key for key in RULE_KEYS if key in asked]
    confirmers = await current_confirmers(db)
    state = states(doc, confirmers)
    for key in keys:
        if state[key] == "pending":
            raise CodedError(RULE_EMPTY.format(label=RULE_LABELS[key]), "LEVEL_RULE_EMPTY", 422)
    todo = [key for key in keys if state[key] == "to_validate"]
    if todo:
        at = _after(seeded)
        values = values_of(doc)
        changes: list[dict[str, Any]] = []
        for key in todo:
            shown = value_text(key, values, confirmers) or ""
            doc["items"][key]["approved"] = {
                "value": copy.deepcopy(comparable(key, values, confirmers)),
                "text": shown,
                "at": at.isoformat(),
                "by": _person(actor),
            }
            changes.append({"item": key, "from": None, "to": shown})
        _write(db, row, doc, actor, at, "approve", changes)
        await db.flush()
    return out(doc, confirmers, can_edit=True)


# ------------------------------------------------------------------ histórico


def parse_before(before: str) -> tuple[datetime, uuid.UUID]:
    """O `before` do histórico: "{created_at ISO 8601 com fuso}|{id}" da última linha recebida.
    Estragado (tamanho, separador, data sem fuso ou fora da faixa, id): 422 PAGE_ERROR."""
    if len(before) > BEFORE_MAX:
        raise WorkflowError(PAGE_ERROR)
    try:
        at_text, id_text = before.split("|")
        parsed = datetime.fromisoformat(at_text)
        row_id = uuid.UUID(id_text)
        at = parsed.astimezone(UTC) if parsed.tzinfo is not None else None
    except (ValueError, OverflowError) as exc:
        raise WorkflowError(PAGE_ERROR) from exc
    if at is None:
        raise WorkflowError(PAGE_ERROR)
    return at, row_id


async def history(
    db: AsyncSession, *, limit: int = 50, before: str | None = None
) -> list[LevelRuleChange]:
    """O histórico das regras, do mais novo para o mais antigo, `limit` linhas por vez; com
    `before`, as seguintes (mais antigas), sem repetir nem pular linha no mesmo instante."""
    stmt = (
        select(LevelRuleChange)
        .order_by(LevelRuleChange.created_at.desc(), LevelRuleChange.id.desc())
        .limit(limit)
    )
    if before:
        at, row_id = parse_before(before)
        stmt = stmt.where(
            tuple_(LevelRuleChange.created_at, LevelRuleChange.id)
            < tuple_(literal(at, DateTime(timezone=True)), literal(row_id, Uuid()))
        )
    return list(await db.scalars(stmt))
