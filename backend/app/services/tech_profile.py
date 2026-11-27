"""Perfil técnico (o perfil profissional): o que o técnico mantém no app e a central também edita.

Seis partes (PARTS), em colunas JSONB do usuário (models/user.py): tools (Ferramental: ids do
tool_catalog), availability (Disponibilidade: turnos "dia:turno", 7 dias × 4 turnos), transport
(meios de transporte e CNH), skills (Aptidões: [{skill_id, level, since}], do skill_catalog),
education (Formação) e areas (Áreas de atuação: ids do area_catalog em users.service_areas).
tech_profile_stamps guarda, por parte informada, quando mudou e por onde ({parte: {at, via}}; via
"app", "ficha" ou "central"); parte sem carimbo nunca foi informada. Os catálogos (Ferramental,
Aptidões e Áreas de atuação) são de services/technician_catalogs.py: o item desativado some das
telas e fica guardado com quem tinha; reativado, volta.

- PATCH /me/profile (services/my_profile.py, via "app") e PATCH /technicians/{id}
  (services/technicians.py, via "central", Técnicos em Editar): `wanted` normaliza e devolve só as
  partes que mudam de verdade, com as mesmas comparações do histórico do cadastro
  (services/user_history.snapshot: a rota só grava quando o histórico tem mudança); `apply` grava
  objetos novos (mudar a lista no lugar não grava) e carimba; `mark_used` grava o 1º uso dos itens
  do catálogo.
- Aprovação da ficha da homologação (services/onboarding.approve): `from_ficha` traz a
  disponibilidade, o transporte, as aptidões e as áreas da ficha, via "ficha". A migração
  f5a7c9e1b3d6 fez o mesmo (sem as áreas) para os técnicos já aprovados, com uma cópia do mapa.
- Central, app e sugestão de técnicos: leitura (`*_of`, `active_tool_ids`, `tool_refs`,
  `active_area_ids`, `areas_of`), textos curtos (`slots_text`, `transport_text`, ...) e o sinal da
  disponibilidade (`visit_slots`, `availability_signal`).

Os rótulos e os textos são os mesmos de lib/constants.ts (web e app): "sáb · tarde", "Carro, Moto ·
com CNH", "02/2022 a 12/2023".
"""

import re
import uuid
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

# fold e clean moram em core/text.py; ficam aqui também (schemas/personal, payout_methods e a
# rota do catálogo usam tech_profile.fold/clean).
from app.core.text import clean, fold
from app.db.base import utcnow
from app.models import TechnicianApplication, User
from app.schemas.common import Ref
from app.schemas.onboarding import SKILL_LEVELS
from app.schemas.tech_profile import (
    EducationOut,
    TechnicianSkillOut,
    TechProfileStamp,
    TechProfileStamps,
    TransportOut,
)
from app.services import technician_catalogs
from app.services.errors import WorkflowError
from app.services.technician_catalogs import CatalogInfo

if TYPE_CHECKING:
    from app.schemas.my_profile import ProfessionalProfileIn

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
PARTS = ("tools", "availability", "transport", "skills", "education", "areas")
MAX_TOOLS, MAX_SLOTS, MAX_MODES, MAX_SKILLS, MAX_EDUCATION = 200, 28, 6, 30, 20
# Áreas por técnico (a lista final, com as desativadas guardadas): technician_catalogs.MAX_AREAS.
MAX_AREAS = technician_catalogs.MAX_AREAS
TOOL_NAME_MAX = SKILL_NAME_MAX = 80
COURSE_MAX = INSTITUTION_MAX = 120
TEXT_MIN = 2
FIRST_MONTH = "1950-01"
MONTH_TOLERANCE = 1  # o servidor aceita até o mês atual + 1 (fuso do aparelho x Brasília)
HISTORY_ITEMS = 10  # textos do histórico: 10 itens + " e mais N"
AVAILABILITY_INSIDE_POINTS = 2  # dentro da disponibilidade declarada
AVAILABILITY_OUTSIDE_POINTS = -6  # fora (bem menor que os −40 de "Ocupado" e que a distância)
# Por onde a parte mudou (o carimbo): o técnico no app, a ficha aprovada ou a central (Técnicos).
VIA_APP, VIA_FICHA, VIA_CENTRAL = "app", "ficha", "central"

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


@lru_cache(maxsize=4096)
def _name_key(name: str) -> tuple[str, str]:
    """Ordem alfabética dos nomes (sem acento e sem maiúsculas; empate pela grafia)."""
    return fold(name), name


def _id_text(raw: Any) -> str | None:
    """O id de catálogo como se grava (str(UUID), minúsculo); None quando não é um id."""
    if raw is None:
        return None
    try:
        return str(raw if isinstance(raw, uuid.UUID) else uuid.UUID(str(raw).strip()))
    except ValueError:
        return None


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
    """A aptidão no histórico, com o nome do catálogo: "Linux (Básico)"."""
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


# --------------------------------------------------------------- os catálogos
# Ferramental, Aptidões e Áreas de atuação: services/technician_catalogs.py (as contagens e o uso
# de cada item também). Os nomes de antes (tool_catalog, user_tools, ToolInfo) ficam para quem já
# usa.

ToolInfo = CatalogInfo


async def tool_catalog(db: AsyncSession) -> dict[str, CatalogInfo]:
    """O Ferramental inteiro (ativas e desativadas), pela chave str(id): 1 consulta (≤ 200)."""
    return await technician_catalogs.catalog(db, "tool")


async def user_tools(db: AsyncSession, user: User) -> dict[str, CatalogInfo]:
    """Só as ferramentas que o técnico marcou (ativas ou não): nenhuma consulta sem ferramenta."""
    return await technician_catalogs.picked(db, "tool", user.tool_ids or [])


def skill_ids_of(user: User) -> list[str]:
    """Os ids das aptidões guardadas (também as desativadas), na ordem gravada."""
    out: list[str] = []
    for item in user.skills or []:
        key = _id_text(item.get("skill_id")) if isinstance(item, Mapping) else None
        if key is not None and key not in out:
            out.append(key)
    return out


async def user_skills(db: AsyncSession, user: User) -> dict[str, CatalogInfo]:
    """Só as aptidões que o técnico tem (ativas ou não): nenhuma consulta sem aptidão."""
    return await technician_catalogs.picked(db, "skill", skill_ids_of(user))


async def user_areas(db: AsyncSession, user: User) -> dict[str, CatalogInfo]:
    """Só as áreas que o técnico tem (ativas ou não): nenhuma consulta sem área."""
    return await technician_catalogs.picked(db, "area", user.service_areas or [])


def active_tool_ids(user: User, catalog: Mapping[str, CatalogInfo]) -> list[uuid.UUID]:
    """As ferramentas ativas do técnico, pela ordem fold(nome) (as desativadas ficam guardadas)."""
    return technician_catalogs.active_ids(user.tool_ids, catalog)


def tool_refs(user: User, catalog: Mapping[str, CatalogInfo]) -> list[Ref]:
    """O mesmo de `active_tool_ids`, como {id, name}."""
    return technician_catalogs.refs(user.tool_ids, catalog)


def active_area_ids(user: User, catalog: Mapping[str, CatalogInfo]) -> list[uuid.UUID]:
    """As áreas ativas do técnico, pela ordem do nome (as desativadas ficam guardadas)."""
    return technician_catalogs.active_ids(user.service_areas, catalog)


def areas_of(user: User, catalog: Mapping[str, CatalogInfo]) -> list[Ref]:
    """O mesmo de `active_area_ids`, como {id, name} (o detalhe da central)."""
    return technician_catalogs.refs(user.service_areas, catalog)


def skills_of(user: User, catalog: Mapping[str, CatalogInfo]) -> list[TechnicianSkillOut]:
    """As aptidões ativas, com o nome do catálogo: o "desde" mais novo primeiro, depois o nome."""
    return technician_catalogs.skills_out(user.skills, catalog)


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


def skill_set(items: Iterable[Any]) -> frozenset[tuple[str | None, Any]]:
    """Aptidões: (skill_id, nível) de cada uma, também as desativadas guardadas (o "desde" não
    conta; renomear no catálogo não é mudança do técnico)."""
    return frozenset(
        (_id_text(item.get("skill_id")), item.get("level"))
        for item in items
        if isinstance(item, Mapping)
    )


def area_set(values: Iterable[Any] | None) -> frozenset[str]:
    """Áreas de atuação: os ids gravados, também os desativados (reordenar não é mudança)."""
    return frozenset(_id_text(raw) or str(raw) for raw in values or [])


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


async def wanted(db: AsyncSession, user: User, data: "ProfessionalProfileIn") -> dict[str, Any]:
    """As partes do perfil técnico que mudam de verdade, já normalizadas (contrato da Entrega 2
    §6.2). `data` é o corpo do PATCH do app (MyProfileUpdate) ou da central (TechnicianUpdate): os
    dois herdam schemas.my_profile.ProfessionalProfileIn. Levanta WorkflowError na ferramenta que
    não existe e CodedError (422) na área ou aptidão fora do catálogo, repetida ou além do limite
    (technician_catalogs.resolve_areas / resolve_skills).

    Só conta o que veio no corpo (`model_fields_set`), e a parte vem inteira. A resposta tem só as
    partes mudadas, prontas para `apply`: "tools" (ids em texto, ordenados), "availability" (turnos
    na ordem da grade), "transport" ({"modes", "driver_license"}), "skills" ([{skill_id, level,
    since}]), "education" ([{id, course, level, institution, start, end}]) e "areas" (ids em
    texto, ordenados; vem de `area_ids`). As comparações são as do histórico (tool_set, slot_set,
    transport_key, skill_set, education_set e area_set, que user_history.snapshot também usa),
    senão a rota responderia 200 sem gravar: conjuntos de ids, de turnos, de (skill_id, nível), de
    (id, curso, nível, instituição, início, fim) e de ids; o transporte muda na 1ª vez (mesmo
    "Nenhum · sem CNH") ou quando (meios, CNH) muda. Reordenar não muda nada; a desativada enviada é
    ignorada e as guardadas desativadas ficam."""
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
        skills = await technician_catalogs.resolve_skills(
            db, data.skills or [], user.skills or [], today=_today()
        )
        if skill_set(skills) != skill_set(user.skills or []):
            new["skills"] = skills
    if "education" in sent:
        education = _wanted_education(user, data.education or [])
        if education_set(education) != education_set(user.education or []):
            new["education"] = education
    if "area_ids" in sent:
        areas = await technician_catalogs.resolve_areas(
            db, data.area_ids or [], user.service_areas or []
        )
        if area_set(areas) != area_set(user.service_areas):
            new["areas"] = areas
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
        elif part == "education":
            user.education = [dict(item) for item in value]
        else:
            user.service_areas = [str(area_id) for area_id in value]
    stamp = _stamp(at, via)
    user.tech_profile_stamps = {**_stamps_raw(user), **{part: dict(stamp) for part in parts}}


async def mark_used(db: AsyncSession, new: Mapping[str, Any]) -> None:
    """Depois de `apply`: o 1º uso (`used_at`) dos itens do catálogo que entraram no perfil
    (Ferramental, Aptidões e Áreas de atuação; com o uso, o item não se exclui mais, só desativa).
    Nenhuma consulta sem essas partes."""
    if "tools" in new:
        await technician_catalogs.mark_used(db, "tool", new["tools"])
    if "skills" in new:
        ids = [item.get("skill_id") for item in new["skills"] if isinstance(item, Mapping)]
        await technician_catalogs.mark_used(db, "skill", ids)
    if "areas" in new:
        await technician_catalogs.mark_used(db, "area", new["areas"])


def _ficha_skills(raw: Any, since: str) -> list[dict[str, Any]]:
    """As aptidões da ficha ([{skill_id, level}], conferidas no envio pelo catálogo): id e nível
    válidos, sem repetir o id (fica a primeira), até MAX_SKILLS, com o "desde" = o dia do envio."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, Mapping):
            continue
        key, level = _id_text(item.get("skill_id")), item.get("level")
        if key is None or not isinstance(level, str) or level not in SKILL_LEVELS or key in seen:
            continue
        seen.add(key)
        out.append({"skill_id": key, "level": level, "since": since})
    return out[:MAX_SKILLS]


def _ficha_areas(raw: Any) -> list[str]:
    """As áreas da ficha (ids do catálogo em texto, conferidos no envio; também as desativadas
    depois dele, que ficam guardadas): sem repetir, ordenadas, até MAX_AREAS."""
    ids = {key for value in (raw if isinstance(raw, list) else []) if (key := _id_text(value))}
    return sorted(ids)[:MAX_AREAS]


def from_ficha(application: TechnicianApplication) -> dict[str, Any]:
    """Os kwargs de User(...) com a disponibilidade, o transporte, as aptidões ({skill_id, level,
    since}), as áreas de atuação (service_areas) e os carimbos "ficha" (`at` = quando a ficha
    chegou; o "desde" das aptidões é o dia local dela). Parte vazia fica sem carimbo (não
    informada): o transporte só conta com algum meio ou com CNH. As ferramentas e as certificações
    da ficha são texto livre e ficam só na ficha. O 1º uso dos itens do catálogo já foi gravado no
    envio da ficha."""
    at = application.created_at or utcnow()
    codes = application.availability if isinstance(application.availability, list) else []
    availability = sort_slots(
        slot for code in codes for slot in FICHA_AVAILABILITY.get(str(code), ())
    )
    vehicle = FICHA_VEHICLE.get(str(application.vehicle_type or ""))
    modes = [vehicle] if application.has_vehicle and vehicle else []
    driver_license = bool(application.has_driver_license)
    skills = _ficha_skills(application.skills, _local_day(at))
    areas = _ficha_areas(application.service_areas)
    filled = {
        "availability": bool(availability),
        "transport": bool(modes) or driver_license,
        "skills": bool(skills),
        "areas": bool(areas),
    }
    stamp = _stamp(at, VIA_FICHA)
    return {
        "availability": availability,
        "transport_modes": modes,
        "has_driver_license": driver_license,
        "skills": skills,
        "service_areas": areas,
        "tech_profile_stamps": {part: dict(stamp) for part, ok in filled.items() if ok},
    }
