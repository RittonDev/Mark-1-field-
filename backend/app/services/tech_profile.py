"""Perfil técnico: o que o técnico mantém no app e a central só vê.

Cinco partes (PARTS), em colunas JSONB do usuário (models/user.py): tools (Ferramental: ids do
catálogo tool_catalog), availability (Disponibilidade: turnos "dia:turno", 7 dias × 4 turnos),
transport (meios de transporte e CNH), skills (Aptidões: nome, nível e "desde") e education
(Formação). tech_profile_stamps guarda, por parte informada, quando mudou e por onde
({parte: {at, via}}; via "app" ou "ficha"); parte sem carimbo nunca foi informada.

- PATCH /me/profile (services/my_profile.py): `wanted` normaliza e devolve só as partes que mudam de
  verdade, com as mesmas comparações do histórico do cadastro (services/user_history.snapshot: a
  rota só grava quando o histórico tem mudança); `apply` grava objetos novos (mudar a lista no lugar
  não grava) e carimba.
- Aprovação da ficha da homologação (services/onboarding.approve): `from_ficha` traz a
  disponibilidade, o transporte e as aptidões da ficha, via "ficha". A migração f5a7c9e1b3d6 fez o
  mesmo para os técnicos já aprovados, com uma cópia do mapa (tests/test_tech_profile.py confere).
- Central e sugestão de técnicos: leitura (`*_of`, `active_tool_ids`, `tool_refs`), textos curtos
  (`slots_text`, `transport_text`, ...) e o sinal da disponibilidade (`visit_slots`,
  `availability_signal`).

Os rótulos e os textos são os mesmos de lib/constants.ts (web e app): "sáb · tarde", "Carro, Moto ·
com CNH", "02/2022 a 12/2023".
"""

import re
import unicodedata
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ValidationError
from sqlalchemy import String, column, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import UserRole
from app.db.base import utcnow
from app.models import TechnicianApplication, TechnicianTool, User
from app.schemas.common import Ref
from app.schemas.onboarding import SKILL_LEVELS
from app.schemas.tech_profile import (
    EducationOut,
    TechnicianSkillOut,
    TechProfileStamp,
    TechProfileStamps,
    TransportOut,
)
from app.services.errors import WorkflowError

if TYPE_CHECKING:
    from app.schemas.my_profile import MyProfileUpdate

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")  # datetime.weekday(): 0 = mon
DAY_SHORT = {
    "mon": "seg",
    "tue": "ter",
    "wed": "qua",
    "thu": "qui",
    "fri": "sex",
    "sat": "sáb",
    "sun": "dom",
}
PERIODS = ("morning", "afternoon", "evening", "night")  # ordem da grade
PERIOD_LABEL = {"morning": "manhã", "afternoon": "tarde", "evening": "noite", "night": "madrugada"}
# Horas locais (settings.TIMEZONE); o fim não entra. "night" é a madrugada DO PRÓPRIO DIA:
# sat:night = sábado 00h–06h.
PERIOD_HOURS = {"night": (0, 6), "morning": (6, 12), "afternoon": (12, 18), "evening": (18, 24)}
ALL_SLOTS = tuple(f"{d}:{p}" for d in WEEKDAYS for p in PERIODS)  # 28
TRANSPORT_MODES = {
    "car": "Carro",
    "motorcycle": "Moto",
    "bicycle": "Bicicleta",
    "public_transport": "Transporte público",
    "ride_app": "Carro de aplicativo",
    "on_foot": "A pé",
}
EDUCATION_LEVELS = {
    "high_school": "Ensino médio",
    "technical": "Técnico",
    "undergraduate": "Graduação",
    "postgraduate": "Pós-graduação",
    "certification": "Certificação",
    "free_course": "Curso livre",
}
# Níveis da aptidão: schemas.onboarding.SKILL_LEVELS (basico/intermediario/avancado →
# Básico/Intermediário/Avançado).
PARTS = ("tools", "availability", "transport", "skills", "education")
MAX_TOOLS, MAX_SLOTS, MAX_MODES, MAX_SKILLS, MAX_EDUCATION = 200, 28, 6, 30, 20
TOOL_NAME_MAX = SKILL_NAME_MAX = 80
COURSE_MAX = INSTITUTION_MAX = 120
TEXT_MIN = 2
FIRST_MONTH = "1950-01"
MONTH_TOLERANCE = 1  # o servidor aceita até o mês atual + 1 (fuso do aparelho x Brasília)
HISTORY_ITEMS = 10  # textos do histórico: 10 itens + " e mais N"
AVAILABILITY_INSIDE_POINTS = 2  # dentro da disponibilidade declarada
AVAILABILITY_OUTSIDE_POINTS = -6  # fora (bem menor que os −40 de "Ocupado" e que a distância)
VIA_APP, VIA_FICHA = "app", "ficha"

# Lista inicial do ferramental (nossa, TI de campo), na ordem em que a migração grava.
DEFAULT_TOOLS = (
    "Alicate de corte",
    "Alicate de crimpar",
    "Alicate de inserção (punch down)",
    "Caneta óptica (VFL)",
    "Escada",
    "Etiquetadora",
    "Ferro de solda",
    "Furadeira",
    "HD externo",
    "Jogo de chaves Phillips e fenda",
    "Kit de limpeza",
    "Lanterna",
    "Localizador de cabos",
    "Máquina de fusão de fibra óptica",
    "Multímetro",
    "Notebook com cabo console",
    "Parafusadeira",
    "Pendrive de instalação",
    "Testador de cabo de rede",
    "Trena",
)
# Códigos da disponibilidade da ficha da homologação → turnos. A ficha só tinha manhã, tarde e
# noite: o fim de semana ganha os três, e só o plantão ("24h") leva à madrugada. "Feriado" não tem
# equivalente e se perde (o técnico corrige no app).
FICHA_AVAILABILITY = {
    "dias_uteis_manha": tuple(f"{d}:morning" for d in WEEKDAYS[:5]),
    "dias_uteis_tarde": tuple(f"{d}:afternoon" for d in WEEKDAYS[:5]),
    "dias_uteis_noite": tuple(f"{d}:evening" for d in WEEKDAYS[:5]),
    "sabado": ("sat:morning", "sat:afternoon", "sat:evening"),
    "domingo_feriado": ("sun:morning", "sun:afternoon", "sun:evening"),
    "plantao": ALL_SLOTS,
}
FICHA_VEHICLE = {"carro": "car", "moto": "motorcycle"}  # "outro" não tem meio equivalente

TOOL_NOT_FOUND = "Ferramenta não encontrada. Atualize a lista."

_MONTH_TEXT = re.compile(r"([0-9]{4})-([0-9]{2})(?:-[0-9]{2})?")


# ------------------------------------------------------------------------- texto


def fold(text: str) -> str:
    """NFKD sem marcas, casefold, espaços colapsados (comparar nomes sem acento e sem
    maiúsculas)."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    plain = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(plain.casefold().split())


def clean(text: str) -> str:
    """NFC e espaços colapsados nas pontas e no meio (o que se grava)."""
    return " ".join(unicodedata.normalize("NFC", text or "").split())


@lru_cache(maxsize=4096)
def _name_key(name: str) -> tuple[str, str]:
    """Ordem alfabética dos nomes (sem acento e sem maiúsculas; empate pela grafia)."""
    return fold(name), name


# ------------------------------------------------------------------ disponibilidade


def sort_slots(slots: Iterable[str]) -> list[str]:
    """Sem repetidos nem desconhecidos, na ordem de ALL_SLOTS."""
    wanted = set(slots)
    return [slot for slot in ALL_SLOTS if slot in wanted]


def _join(words: list[str]) -> str:
    if len(words) > 1:
        return f"{', '.join(words[:-1])} e {words[-1]}"
    return words[0] if words else ""


def periods_phrase(periods: Iterable[str]) -> str:
    """Os turnos na ordem da grade: "manhã e tarde", "manhã, tarde, noite e madrugada" ("" sem
    turno)."""
    wanted = set(periods)
    return _join([PERIOD_LABEL[p] for p in PERIODS if p in wanted])


def slots_text(slots: Iterable[str]) -> str:
    """Igual a slotsText do TS: "sáb · tarde", "seg a sex · manhã e tarde; sáb · manhã"; vazio:
    "". Dias seguidos com os mesmos turnos se juntam."""
    wanted = set(slots)
    days = [(d, [p for p in PERIODS if f"{d}:{p}" in wanted]) for d in WEEKDAYS]
    parts: list[str] = []
    i = 0
    while i < len(days):
        periods = days[i][1]
        if not periods:
            i += 1
            continue
        j = i
        while j + 1 < len(days) and days[j + 1][1] == periods:
            j += 1
        first, last = DAY_SHORT[days[i][0]], DAY_SHORT[days[j][0]]
        span = first if j == i else (f"{first} e {last}" if j == i + 1 else f"{first} a {last}")
        parts.append(f"{span} · {periods_phrase(periods)}")
        i = j + 1
    return "; ".join(parts)


def period_at(hour: int) -> str:
    """O turno de uma hora local (PERIOD_HOURS): night < 6 ≤ morning < 12 ≤ afternoon < 18 ≤
    evening."""
    if hour < 6:
        return "night"
    if hour < 12:
        return "morning"
    if hour < 18:
        return "afternoon"
    return "evening"


def visit_slots(start: datetime, end: datetime | None, tz: ZoneInfo) -> list[str]:
    """Turnos tocados por [start, end) no fuso local; end ausente ou ≤ start: o turno do início;
    teto de 7 dias. Anda de fronteira em fronteira (00h, 06h, 12h, 18h)."""
    local, stop = start.astimezone(tz), (end or start).astimezone(tz)
    if stop <= local:
        stop = local + timedelta(minutes=1)
    stop = min(stop, local + timedelta(days=7))
    out: list[str] = []
    cursor = local
    while cursor < stop:
        slot = f"{WEEKDAYS[cursor.weekday()]}:{period_at(cursor.hour)}"
        if slot not in out:
            out.append(slot)
        base = cursor.replace(minute=0, second=0, microsecond=0)
        boundary = (cursor.hour // 6 + 1) * 6
        cursor = (
            base.replace(hour=0) + timedelta(days=1)
            if boundary == 24
            else base.replace(hour=boundary)
        )
    return sort_slots(out)


def availability_signal(
    declared: list[str], visit: list[str]
) -> tuple[Literal["inside", "outside"] | None, list[str]]:
    """Sem visita ou sem disponibilidade declarada: (None, []) (neutro). Senão gaps = turnos da
    visita fora da declarada: ("outside", gaps) com algum, ("inside", []) sem nenhum."""
    if not visit or not declared:
        return None, []
    have = set(declared)
    gaps = [slot for slot in visit if slot not in have]
    if gaps:
        return "outside", gaps
    return "inside", []


# ------------------------------------------------------------- textos curtos


def _modes(modes: Iterable[str]) -> list[str]:
    """Meios sem repetir e sem desconhecidos, na ordem de TRANSPORT_MODES."""
    wanted = set(modes)
    return [mode for mode in TRANSPORT_MODES if mode in wanted]


def transport_text(modes: Iterable[str], driver_license: bool) -> str:
    """Meios e CNH em texto: "Carro, Moto · com CNH" (rótulos na ordem de TRANSPORT_MODES),
    "Nenhum · sem CNH"."""
    labels = [TRANSPORT_MODES[mode] for mode in _modes(modes)]
    return f"{', '.join(labels) or 'Nenhum'} · {'com CNH' if driver_license else 'sem CNH'}"


def month_text(value: str) -> str:
    """Mês em texto: "2024-02" ou "2024-02-19" → "02/2024" (fora do formato, volta como veio)."""
    match = _MONTH_TEXT.fullmatch(value or "")
    return f"{match.group(2)}/{match.group(1)}" if match else value


def education_period_text(start: str, end: str | None) -> str:
    """Período da formação: "02/2022 a 12/2023"; sem fim, "desde 02/2024 (em andamento)"."""
    if end:
        return f"{month_text(start)} a {month_text(end)}"
    return f"desde {month_text(start)} (em andamento)"


def skill_label(item: Mapping[str, Any]) -> str:
    """A aptidão no histórico: "Linux (Básico)"."""
    level = str(item.get("level") or "")
    return f"{item.get('name') or ''} ({SKILL_LEVELS.get(level, level)})"


def education_label(item: Mapping[str, Any]) -> str:
    """O curso no histórico: "Técnico em redes · Escola Exemplo · Técnico · desde 02/2024 (em
    andamento)"."""
    level = str(item.get("level") or "")
    period = education_period_text(str(item.get("start") or ""), item.get("end"))
    return " · ".join(
        (
            str(item.get("course") or ""),
            str(item.get("institution") or ""),
            EDUCATION_LEVELS.get(level, level),
            period,
        )
    )


def items_text(labels: list[str], sep: str = ", ") -> str | None:
    """Itens do histórico: None sem itens; até HISTORY_ITEMS, todos; mais, os primeiros e
    " e mais N"."""
    if not labels:
        return None
    if len(labels) <= HISTORY_ITEMS:
        return sep.join(labels)
    return f"{sep.join(labels[:HISTORY_ITEMS])} e mais {len(labels) - HISTORY_ITEMS}"


# ------------------------------------------------------------------ ferramental


@dataclass(frozen=True)
class ToolInfo:
    name: str
    is_active: bool


async def tool_catalog(db: AsyncSession) -> dict[str, ToolInfo]:
    """O catálogo inteiro (ativas e desativadas), pela chave str(id): 1 consulta (≤ 200 linhas)."""
    rows = await db.execute(
        select(TechnicianTool.id, TechnicianTool.name, TechnicianTool.is_active)
    )
    return {str(tool_id): ToolInfo(name, bool(active)) for tool_id, name, active in rows.all()}


async def user_tools(db: AsyncSession, user: User) -> dict[str, ToolInfo]:
    """Só as ferramentas que o técnico marcou (ativas ou não), pela chave str(id): 1 consulta
    pequena, nenhuma sem ferramenta marcada (GET /me/profile e o histórico do cadastro)."""
    ids: list[uuid.UUID] = []
    for raw in user.tool_ids or []:
        try:
            ids.append(uuid.UUID(str(raw)))
        except ValueError:
            continue
    if not ids:
        return {}
    rows = await db.execute(
        select(TechnicianTool.id, TechnicianTool.name, TechnicianTool.is_active).where(
            TechnicianTool.id.in_(ids)
        )
    )
    return {str(tool_id): ToolInfo(name, bool(active)) for tool_id, name, active in rows.all()}


async def tool_counts(db: AsyncSession) -> dict[str, int]:
    """Quantos técnicos (papel technician, ativos ou não) marcaram cada id, a mesma regra do
    filtro `tool_id` da lista de técnicos."""
    marked = (
        func.jsonb_array_elements_text(User.tool_ids)
        .table_valued(column("value", String), joins_implicitly=True)
        .alias("marked")
    )
    rows = await db.execute(
        select(marked.c.value, func.count(distinct(User.id)))
        .select_from(User)
        .where(User.role == UserRole.TECHNICIAN)
        .group_by(marked.c.value)
    )
    return {str(tool_id): int(total) for tool_id, total in rows.all()}


def _active_tools(user: User, catalog: Mapping[str, ToolInfo]) -> list[tuple[str, ToolInfo]]:
    """As ferramentas ativas do técnico, sem repetir, em ordem alfabética."""
    seen: set[str] = set()
    out: list[tuple[str, ToolInfo]] = []
    for raw in user.tool_ids or []:
        key = str(raw)
        info = catalog.get(key)
        if info is None or not info.is_active or key in seen:
            continue
        seen.add(key)
        out.append((key, info))
    out.sort(key=lambda item: (*_name_key(item[1].name), item[0]))
    return out


def active_tool_ids(user: User, catalog: Mapping[str, ToolInfo]) -> list[uuid.UUID]:
    """As ferramentas ativas do técnico, pela ordem fold(nome) (as desativadas ficam guardadas)."""
    return [uuid.UUID(key) for key, _ in _active_tools(user, catalog)]


def tool_refs(user: User, catalog: Mapping[str, ToolInfo]) -> list[Ref]:
    """O mesmo de `active_tool_ids`, como {id, name}."""
    return [Ref(id=uuid.UUID(key), name=info.name) for key, info in _active_tools(user, catalog)]


# --------------------------------------------------------------------- leitura


def _stamps_raw(user: User) -> dict[str, Any]:
    stamps = user.tech_profile_stamps
    return stamps if isinstance(stamps, dict) else {}


def _informed(user: User, part: str) -> bool:
    return isinstance(_stamps_raw(user).get(part), Mapping)


def _parse[M: BaseModel](model: type[M], item: Any) -> M | None:
    """O item gravado pelo schema; estragado, None (sai da tela em vez de virar erro 500)."""
    try:
        return model.model_validate(item)
    except ValidationError:
        return None


def _valid[M: BaseModel](model: type[M], items: Iterable[Any]) -> list[M]:
    return [parsed for item in items if (parsed := _parse(model, item)) is not None]


def transport_of(user: User) -> TransportOut | None:
    """None sem "transport" em tech_profile_stamps (nunca informou)."""
    if not _informed(user, "transport"):
        return None
    return TransportOut(
        modes=_modes(user.transport_modes or []),  # type: ignore[arg-type]
        driver_license=bool(user.has_driver_license),
    )


def stamps_of(user: User) -> TechProfileStamps:
    """Uma data por parte (null: nunca informada)."""
    raw = _stamps_raw(user)
    parts: dict[str, TechProfileStamp | None] = {
        part: _parse(TechProfileStamp, raw[part]) for part in PARTS if part in raw
    }
    return TechProfileStamps(**parts)


def _utc(at: datetime) -> datetime:
    return at.astimezone(UTC) if at.tzinfo is not None else at.replace(tzinfo=UTC)


def latest_stamp(user: User) -> datetime | None:
    """A data da parte mudada por último (None: nada informado)."""
    stamps = stamps_of(user)
    times = [_utc(stamp.at) for part in PARTS if (stamp := getattr(stamps, part)) is not None]
    return max(times) if times else None


def skills_of(user: User) -> list[TechnicianSkillOut]:
    """As aptidões na ordem gravada (já ordenada: "desde" mais novo primeiro, depois o nome)."""
    return _valid(TechnicianSkillOut, user.skills or [])


def education_of(user: User) -> list[EducationOut]:
    """A formação na ordem gravada (já ordenada: em andamento primeiro, depois o fim mais novo)."""
    return _valid(EducationOut, user.education or [])


# --------------------------------------------------------------------- gravação


def _today() -> str:
    """Hoje em Brasília ("AAAA-MM-DD"): o "desde" da aptidão nova."""
    return datetime.now(ZoneInfo(settings.TIMEZONE)).date().isoformat()


def _local_day(at: datetime) -> str:
    return _utc(at).astimezone(ZoneInfo(settings.TIMEZONE)).date().isoformat()


def _stamp(at: datetime, via: str) -> dict[str, str]:
    return {"at": _utc(at).isoformat(), "via": via}


def _sorted_skills(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """O "desde" mais novo primeiro, depois o nome (sem acento e sem maiúsculas)."""
    ordered = sorted(items, key=lambda item: _name_key(item["name"]))
    return sorted(ordered, key=lambda item: item["since"], reverse=True)


def _sorted_education(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Em andamento primeiro, depois o fim mais novo, o início mais novo e o curso."""
    ordered = sorted(items, key=lambda item: _name_key(item["course"]))
    ordered.sort(key=lambda item: item["start"], reverse=True)
    ordered.sort(key=lambda item: item["end"] or "", reverse=True)
    ordered.sort(key=lambda item: item["end"] is not None)
    return ordered


# ----------------------------------------------- o que conta como mudança
# Uma comparação por parte, a mesma em `wanted` e no histórico do cadastro
# (services/user_history.snapshot): a rota só grava quando o histórico tem mudança, então qualquer
# diferença entre os dois devolveria 200 sem gravar.


def tool_set(user: User) -> frozenset[str]:
    """Ferramental: os ids gravados, também os desativados (ficam guardados)."""
    return frozenset(str(raw) for raw in user.tool_ids or [])


def slot_set(user: User) -> frozenset[str]:
    """Disponibilidade: os turnos gravados (reordenar não é mudança)."""
    return frozenset(str(slot) for slot in user.availability or [])


def transport_key(user: User) -> tuple[tuple[str, ...], bool] | None:
    """Transporte: None sem a parte informada; senão (meios na ordem de TRANSPORT_MODES, CNH)."""
    if not _informed(user, "transport"):
        return None
    return tuple(_modes(user.transport_modes or [])), bool(user.has_driver_license)


def skill_set(items: Iterable[Any]) -> frozenset[tuple[Any, Any]]:
    """Aptidões: (nome gravado, nível) de cada uma ("linux" → "Linux" é mudança; o "desde" não
    conta)."""
    return frozenset(
        (item.get("name"), item.get("level")) for item in items if isinstance(item, Mapping)
    )


# A formação no histórico: (id, *EDUCATION_KEYS).
EDUCATION_KEYS = ("course", "level", "institution", "start", "end")


def education_set(items: Iterable[Any]) -> frozenset[tuple[Any, ...]]:
    """Formação: (id, curso, nível, instituição, início, fim) de cada curso."""
    return frozenset(
        (str(item.get("id")), *(item.get(key) for key in EDUCATION_KEYS))
        for item in items
        if isinstance(item, Mapping)
    )


async def _wanted_tools(
    db: AsyncSession, user: User, sent: Iterable[Any] | None
) -> list[str] | None:
    """Os ids a gravar (texto, em ordem), ou None sem mudança. A desativada enviada é ignorada e as
    guardadas que não estão ativas ficam (voltam se a central reativar)."""
    catalog = await tool_catalog(db)
    chosen: set[str] = set()
    for raw in sent or []:
        key = str(raw)
        info = catalog.get(key)
        if info is None:
            raise WorkflowError(TOOL_NOT_FOUND)
        if info.is_active:
            chosen.add(key)
    stored = tool_set(user)
    kept = {key for key in stored if not (key in catalog and catalog[key].is_active)}
    final = chosen | kept
    return None if final == stored else sorted(final)


def _wanted_skills(user: User, sent: Iterable[Any]) -> list[dict[str, Any]]:
    """As aptidões a gravar: o "desde" de uma gravada com o mesmo nome (sem acento e sem
    maiúsculas) fica; a nova ganha hoje."""
    since: dict[str, str] = {}
    for item in user.skills or []:
        if isinstance(item, Mapping) and isinstance(item.get("name"), str) and item.get("since"):
            since.setdefault(fold(item["name"]), str(item["since"]))
    today = _today()
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in sent:
        name = clean(item.name)
        key = fold(name)
        if key in seen:
            continue
        seen.add(key)
        out.append({"name": name, "level": item.level, "since": since.get(key, today)})
    return _sorted_skills(out)


def _wanted_education(user: User, sent: Iterable[Any]) -> list[dict[str, Any]]:
    """Os cursos a gravar. Com o id de um gravado, mantém o id; sem id (ou com um desconhecido),
    reaproveita o de um gravado igual que nenhum outro item citou, senão ganha um novo."""
    items = list(sent)
    stored = [item for item in user.education or [] if isinstance(item, Mapping) and item.get("id")]
    stored_ids = {str(item["id"]) for item in stored}
    taken = {str(item.id) for item in items if item.id is not None and str(item.id) in stored_ids}
    assigned: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in items:
        values = {
            "course": clean(item.course),
            "level": item.level,
            "institution": clean(item.institution),
            "start": item.start,
            "end": item.end,
        }
        key = str(item.id) if item.id is not None else None
        if key is None or key not in stored_ids or key in assigned:
            same = tuple(values[k] for k in EDUCATION_KEYS)
            key = next(
                (
                    str(old["id"])
                    for old in stored
                    if str(old["id"]) not in taken
                    and tuple(old.get(k) for k in EDUCATION_KEYS) == same
                ),
                None,
            ) or str(uuid.uuid4())
            taken.add(key)
        assigned.add(key)
        out.append({"id": key, **values})
    return _sorted_education(out)


async def wanted(db: AsyncSession, user: User, data: "MyProfileUpdate") -> dict[str, Any]:
    """As partes do perfil técnico que mudam de verdade, já normalizadas (contrato §6.1). Levanta
    WorkflowError na ferramenta que não existe. Chamado por my_profile._wanted.

    Só conta o que veio no corpo (`model_fields_set`), e a parte vem inteira. A resposta tem só as
    partes mudadas, prontas para `apply`: "tools" (ids em texto, ordenados), "availability" (turnos
    na ordem da grade), "transport" ({"modes", "driver_license"}), "skills" ([{name, level, since}])
    e "education" ([{id, course, level, institution, start, end}]). As comparações são as do
    histórico (tool_set, slot_set, transport_key, skill_set e education_set, que
    user_history.snapshot também usa), senão a rota responderia 200 sem gravar: conjuntos de ids,
    de turnos, de (nome, nível) e de (id, curso, nível, instituição, início, fim); o transporte
    muda na 1ª vez (mesmo "Nenhum · sem CNH") ou quando (meios, CNH) muda. Reordenar não muda nada.
    """
    sent = data.model_fields_set
    new: dict[str, Any] = {}
    if "tool_ids" in sent:
        tools = await _wanted_tools(db, user, data.tool_ids)
        if tools is not None:
            new["tools"] = tools
    if "availability" in sent:
        slots = sort_slots(data.availability or [])
        if frozenset(slots) != slot_set(user):
            new["availability"] = slots
    if "transport" in sent and data.transport is not None:
        modes = _modes(data.transport.modes)
        driver_license = bool(data.transport.driver_license)
        if transport_key(user) != (tuple(modes), driver_license):
            new["transport"] = {"modes": modes, "driver_license": driver_license}
    if "skills" in sent:
        skills = _wanted_skills(user, data.skills or [])
        if skill_set(skills) != skill_set(user.skills or []):
            new["skills"] = skills
    if "education" in sent:
        education = _wanted_education(user, data.education or [])
        if education_set(education) != education_set(user.education or []):
            new["education"] = education
    return new


def apply(user: User, new: Mapping[str, Any], *, via: str, at: datetime) -> None:
    """Grava as colunas das partes em `new` (objetos novos) e o carimbo {at, via} de cada parte.
    `new` é o de `wanted` (as chaves que não são partes, como as do resto do cadastro, ficam de
    fora)."""
    parts = [part for part in PARTS if part in new]
    if not parts:
        return
    for part in parts:
        value = new[part]
        if part == "tools":
            user.tool_ids = [str(tool_id) for tool_id in value]
        elif part == "availability":
            user.availability = [str(slot) for slot in value]
        elif part == "transport":
            user.transport_modes = [str(mode) for mode in value["modes"]]
            user.has_driver_license = bool(value["driver_license"])
        elif part == "skills":
            user.skills = [dict(item) for item in value]
        else:
            user.education = [dict(item) for item in value]
    stamp = _stamp(at, via)
    user.tech_profile_stamps = {**_stamps_raw(user), **{part: dict(stamp) for part in parts}}


def _ficha_skills(raw: Any, since: str) -> list[dict[str, Any]]:
    """As aptidões da ficha: nível válido, nome limpo (2 a 80), sem repetir o nome (fica a
    primeira), até MAX_SKILLS."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, Mapping):
            continue
        name, level = item.get("name"), item.get("level")
        if not isinstance(name, str) or not isinstance(level, str) or level not in SKILL_LEVELS:
            continue
        name = clean(name)
        key = fold(name)
        if not TEXT_MIN <= len(name) <= SKILL_NAME_MAX or key in seen:
            continue
        seen.add(key)
        out.append({"name": name, "level": level, "since": since})
    return _sorted_skills(out[:MAX_SKILLS])


def from_ficha(application: TechnicianApplication) -> dict[str, Any]:
    """Os kwargs de User(...) com a disponibilidade, o transporte, as aptidões e os carimbos
    "ficha" (`at` = quando a ficha chegou). Parte vazia fica sem carimbo (não informada): o
    transporte só conta com algum meio ou com CNH. As ferramentas e as certificações da ficha são
    texto livre e ficam só na ficha."""
    at = application.created_at or utcnow()
    codes = application.availability if isinstance(application.availability, list) else []
    availability = sort_slots(
        slot for code in codes for slot in FICHA_AVAILABILITY.get(str(code), ())
    )
    vehicle = FICHA_VEHICLE.get(str(application.vehicle_type or ""))
    modes = [vehicle] if application.has_vehicle and vehicle else []
    driver_license = bool(application.has_driver_license)
    skills = _ficha_skills(application.skills, _local_day(at))
    filled = {
        "availability": bool(availability),
        "transport": bool(modes) or driver_license,
        "skills": bool(skills),
    }
    stamp = _stamp(at, VIA_FICHA)
    return {
        "availability": availability,
        "transport_modes": modes,
        "has_driver_license": driver_license,
        "skills": skills,
        "tech_profile_stamps": {part: dict(stamp) for part, ok in filled.items() if ok},
    }
