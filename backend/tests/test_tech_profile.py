"""Perfil técnico (services/tech_profile.py, schemas/tech_profile.py e o PATCH /me/profile).

Sem banco: os textos curtos (os mesmos casos das sondas de lib/constants.ts), os turnos que uma
visita toca e o sinal da disponibilidade na sugestão, as mensagens de cada item do PATCH
/me/profile, a normalização e o "o que conta como mudança" de `wanted`/`apply` (aptidões e áreas
pelo id do catálogo, com um catálogo de mentira), o carimbo "central", o que a ficha da homologação
traz na aprovação e a cópia desse mapa na migração f5a7c9e1b3d6 (comparada com o resultado fixo de
antes: a ficha agora guarda ids).

Com banco (requires_db): um PATCH por parte relido do banco (o PATCH só grava quando o histórico
muda: "200 sem gravar" aparece aqui), as mensagens 422 com o rótulo, o "desde" pelo id, o id dos
cursos, a ferramenta desativada, os textos do histórico do cadastro, o aviso profile.changed, os
caracteres invisíveis, duas gravações ao mesmo tempo e o backfill da migração pelo driver.
Dados fictícios (Tecnico Alfa, Escola Exemplo, @exemplo.com).
"""

import asyncio
import importlib.util
import json
import unicodedata
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import ModuleType
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from httpx import AsyncClient, Response
from pydantic import BaseModel, ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import ApplicationStatus
from app.models import Skill, TechnicianApplication, TechnicianTool, User
from app.schemas.my_profile import (
    PROFESSIONAL_FIELDS,
    SLOT_MAX,
    MyProfileUpdate,
    ProfessionalProfileIn,
)
from app.schemas.onboarding import AVAILABILITY, SKILL_LEVELS, VEHICLE_TYPES
from app.schemas.tech_profile import (
    EducationIn,
    TechnicianSkillIn,
    TechnicianToolCreate,
    TechnicianToolUpdate,
    TransportIn,
)
from app.schemas.technician import TechnicianUpdate
from app.services import realtime, technician_catalogs, validation_messages
from app.services import tech_profile as tp
from app.services.errors import CodedError, WorkflowError
from app.services.technician_catalogs import CatalogInfo
from tests.conftest import World, requires_db

TZ = ZoneInfo(settings.TIMEZONE)
API = settings.API_PREFIX
MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "20261119_f5a7c9e1b3d6_perfil_tecnico_e_escopo_lido.py"
)
WORKDAYS = ("mon", "tue", "wed", "thu", "fri")


def _migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("perfil_tecnico", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _month_from_now(months: int) -> str:
    now = datetime.now(TZ)
    index = now.year * 12 + now.month - 1 + months
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


def _problems(model: type[BaseModel], data: dict[str, Any]) -> list[tuple[tuple, str]]:
    """(loc, mensagem em português como a API devolve) de cada erro."""
    with pytest.raises(ValidationError) as caught:
        model.model_validate(data)
    return [(e["loc"], validation_messages.message(e)) for e in caught.value.errors()]


# ------------------------------------------------------------------ disponibilidade


def test_slots_follow_the_grid() -> None:
    assert len(tp.ALL_SLOTS) == 28
    assert (tp.ALL_SLOTS[0], tp.ALL_SLOTS[-1]) == ("mon:morning", "sun:night")
    assert tp.sort_slots(["sun:night", "xyz", "mon:morning", "mon:morning"]) == [
        "mon:morning",
        "sun:night",
    ]
    for hour in range(24):
        first, last = tp.PERIOD_HOURS[tp.period_at(hour)]
        assert first <= hour < last


@pytest.mark.parametrize(
    ("slots", "text"),
    [
        (["sat:afternoon"], "sáb · tarde"),
        (["sat:evening", "sat:afternoon"], "sáb · tarde e noite"),
        (["fri:evening", "sat:night"], "sex · noite; sáb · madrugada"),
        (
            [f"{d}:{p}" for d in WORKDAYS for p in ("morning", "afternoon")] + ["sat:morning"],
            "seg a sex · manhã e tarde; sáb · manhã",
        ),
        (["sat:morning", "sun:morning"], "sáb e dom · manhã"),
        (list(tp.ALL_SLOTS), "seg a dom · manhã, tarde, noite e madrugada"),
        (["mon:morning", "wed:morning"], "seg · manhã; qua · manhã"),
        ([], ""),
        (["xyz", "sat:afternoon", "sat:afternoon"], "sáb · tarde"),
    ],
)
def test_slots_text_is_the_same_as_the_web_and_the_app(slots: list[str], text: str) -> None:
    assert tp.slots_text(slots) == text


def test_visit_slots_are_the_periods_the_visit_touches() -> None:
    friday = datetime(2026, 11, 20, 23, 0, tzinfo=TZ)
    assert friday.weekday() == 4
    # Sexta 23:00 até sábado 01:00: a noite de sexta e a madrugada de sábado.
    assert tp.visit_slots(friday, friday + timedelta(hours=2), TZ) == ["fri:evening", "sat:night"]
    # 09:00–12:00: só a manhã (o fim não entra); 11:30–12:30: manhã e tarde.
    nine = friday.replace(hour=9)
    assert tp.visit_slots(nine, nine.replace(hour=12), TZ) == ["fri:morning"]
    half = friday.replace(hour=11, minute=30)
    assert tp.visit_slots(half, half + timedelta(hours=1), TZ) == ["fri:morning", "fri:afternoon"]
    # Fim igual ao início, sem fim ou antes do início: o turno do início.
    assert tp.visit_slots(half, half, TZ) == ["fri:morning"]
    assert tp.visit_slots(half, None, TZ) == ["fri:morning"]
    assert tp.visit_slots(half, half - timedelta(hours=3), TZ) == ["fri:morning"]
    # A hora que conta é a local: sábado 02:00 em UTC é sexta 23:00 em Brasília.
    brasilia = ZoneInfo("America/Sao_Paulo")
    utc = datetime(2026, 11, 21, 2, 0, tzinfo=UTC)
    assert tp.visit_slots(utc, utc + timedelta(minutes=30), brasilia) == ["fri:evening"]
    # Teto de 7 dias: a semana inteira.
    assert tp.visit_slots(nine, nine + timedelta(days=30), TZ) == list(tp.ALL_SLOTS)


def test_availability_signal_is_neutral_without_data() -> None:
    visit = ["fri:evening", "sat:night"]
    assert tp.availability_signal([], visit) == (None, [])
    assert tp.availability_signal(["sat:afternoon"], []) == (None, [])
    assert tp.availability_signal(["mon:morning", *visit], visit) == ("inside", [])
    assert tp.availability_signal(["fri:evening"], visit) == ("outside", ["sat:night"])
    assert tp.availability_signal(["mon:morning"], visit) == ("outside", visit)


# ------------------------------------------------------------- textos curtos


def test_short_texts() -> None:
    assert tp.transport_text(["motorcycle", "car"], True) == "Carro, Moto · com CNH"
    assert tp.transport_text([], False) == "Nenhum · sem CNH"
    assert tp.transport_text(["on_foot", "bus", "on_foot"], False) == "A pé · sem CNH"
    assert tp.month_text("2024-02") == "02/2024"
    assert tp.month_text("2026-11-19") == "11/2026"
    assert tp.month_text("x") == "x"
    assert tp.education_period_text("2022-02", "2023-12") == "02/2022 a 12/2023"
    assert tp.education_period_text("2024-02", None) == "desde 02/2024 (em andamento)"
    assert tp.skill_label({"name": "Linux", "level": "basico"}) == "Linux (Básico)"
    course = {
        "course": "Técnico em redes",
        "level": "technical",
        "institution": "Escola Exemplo",
        "start": "2024-02",
        "end": None,
    }
    assert tp.education_label(course) == (
        "Técnico em redes · Escola Exemplo · Técnico · desde 02/2024 (em andamento)"
    )
    assert tp.fold("  Câmeras   HIKVISION ") == "cameras hikvision"
    assert tp.clean(unicodedata.normalize("NFD", "  Fibra   óptica ")) == "Fibra óptica"


def test_control_and_format_characters_are_dropped() -> None:
    """Controles (Cc) e formatação (Cf: largura zero, BOM, direção) saem antes de contar e de
    comparar; tab, LF, VT, FF e CR viram espaço. Nome só de invisíveis cai na mensagem do tamanho
    (a aptidão pelo nome) ou fica vazio para o serviço recusar (o nome do catálogo), e a mesma
    aptidão com um espaço de largura zero chega igual ao serviço (que recusa a repetida)."""
    assert tp.clean("Lin\u200bux") == "Linux"
    assert tp.clean("\ufeff\u202eRedes\u202c ") == "Redes"
    assert tp.clean("Curso\u0000 Exemplo\u0007") == "Curso Exemplo"
    assert tp.clean("Fibra\tóptica\r\n(fusão)\v\f") == "Fibra óptica (fusão)"
    # Os outros controles saem em vez de virar espaço (como no app).
    assert tp.clean("Re\x1cdes\x85") == "Redes"
    # Antes do NFC: o acento separado da letra por um invisível volta a ser uma letra só.
    assert tp.clean("Cafe\u200d\u0301") == "Café"
    # O que não é controle nem formatação fica: espaço sem quebra (vira espaço), acentos.
    assert tp.clean("Windows\u00a010/11") == "Windows 10/11"
    assert tp.fold("LIN\u200bUX\u2066") == tp.fold("linux") == "linux"
    assert tp.clean("\u200b\u200b\u200b") == tp.fold("\u0001\u202e") == ""
    assert _problems(TechnicianSkillIn, {"name": "\u200b\u200b\u200b", "level": "basico"}) == [
        (("name",), "Informe o nome da aptidão")
    ]
    assert _problems(TechnicianToolCreate, {"name": "\u0000\u00ad"}) == [
        (("name",), "Informe o nome da ferramenta")
    ]
    linux = {"name": "Linux", "level": "basico"}
    assert _problems(MyProfileUpdate, {"skills": [linux, {**linux, "name": "Lin\u200bux"}]}) == [
        (("skills",), "Aptidão repetida: Linux")
    ]


def test_items_text_cuts_long_lists() -> None:
    """Textos do histórico: até 10 itens inteiros; mais que isso, os 10 primeiros e "e mais N"."""
    assert tp.items_text([]) is None
    assert tp.items_text(["Escada"]) == "Escada"
    assert tp.items_text(["Escada", "Multímetro"]) == "Escada, Multímetro"
    ten = [f"Item {n:02d}" for n in range(1, 11)]
    assert tp.items_text(ten) == ", ".join(ten)
    twelve = [*ten, "Item 11", "Item 12"]
    assert tp.items_text(twelve) == f"{', '.join(ten)} e mais 2"
    assert tp.items_text(twelve, "; ") == f"{'; '.join(ten)} e mais 2"
    assert tp.HISTORY_ITEMS == 10


# ------------------------------------------------------- itens do PATCH /me/profile


def test_skill_item_is_cleaned_and_checked() -> None:
    skill = TechnicianSkillIn.model_validate({"name": "  Impressoras   HP ", "level": "avancado"})
    assert skill.name == "Impressoras HP"
    assert _problems(TechnicianSkillIn, {"name": "  a ", "level": "basico"}) == [
        (("name",), "Informe o nome da aptidão")
    ]
    long_name = "a" * (tp.SKILL_NAME_MAX + 1)
    assert _problems(TechnicianSkillIn, {"name": long_name, "level": "basico"}) == [
        (("name",), "no máximo 80 caracteres")
    ]
    assert TechnicianSkillIn(name="a" * tp.SKILL_NAME_MAX, level="basico")
    assert _problems(TechnicianSkillIn, {"name": "Linux", "level": "expert"}) == [
        (("level",), "escolha uma das opções: basico, intermediario ou avancado")
    ]
    # O "desde" é do servidor.
    sent = {"name": "Linux", "level": "basico", "since": "2026-01-01"}
    assert _problems(TechnicianSkillIn, sent) == [(("since",), "campo não aceito")]
    # Pelo catálogo (o app novo e a central): o id; um e só um dos dois.
    skill_id = uuid.uuid4()
    item = TechnicianSkillIn.model_validate({"skill_id": str(skill_id), "level": "basico"})
    assert (item.skill_id, item.name) == (skill_id, None)
    both = {"skill_id": str(skill_id), "name": "Linux", "level": "basico"}
    assert _problems(TechnicianSkillIn, both) == [((), "Escolha a aptidão")]
    assert _problems(TechnicianSkillIn, {"level": "basico"}) == [((), "Escolha a aptidão")]
    [(loc, text)] = _problems(TechnicianSkillIn, {"skill_id": "x", "level": "basico"})
    assert loc == ("skill_id",) and text


def test_education_item_is_cleaned_and_checked() -> None:
    base = {
        "course": " Técnico  em redes ",
        "level": "technical",
        "institution": "Escola Exemplo",
        "start": "2024-02",
    }
    item = EducationIn.model_validate({**base, "end": "2024-02"})  # curso de um mês
    assert (item.course, item.end, item.id) == ("Técnico em redes", "2024-02", None)
    assert EducationIn.model_validate({**base, "end": " "}).end is None
    assert EducationIn.model_validate({**base, "end": _month_from_now(1)})
    assert _problems(EducationIn, {**base, "course": "x"}) == [(("course",), "Informe o curso")]
    assert _problems(EducationIn, {**base, "institution": " "}) == [
        (("institution",), "Informe a instituição")
    ]
    assert _problems(EducationIn, {**base, "course": "a" * (tp.COURSE_MAX + 1)}) == [
        (("course",), "no máximo 120 caracteres")
    ]
    assert _problems(EducationIn, {**base, "institution": "a" * (tp.INSTITUTION_MAX + 1)}) == [
        (("institution",), "no máximo 120 caracteres")
    ]
    longest = {**base, "course": "a" * tp.COURSE_MAX, "institution": "b" * tp.INSTITUTION_MAX}
    assert EducationIn.model_validate(longest)
    assert _problems(EducationIn, {**base, "start": "2024-13"}) == [
        (("start",), "Mês inválido: use AAAA-MM")
    ]
    assert _problems(EducationIn, {**base, "start": "02/2024"}) == [
        (("start",), "Mês inválido: use AAAA-MM")
    ]
    assert _problems(EducationIn, {**base, "start": "1949-12"}) == [(("start",), "Confira o ano")]
    assert EducationIn.model_validate({**base, "start": tp.FIRST_MONTH})
    assert _problems(EducationIn, {**base, "end": _month_from_now(2)}) == [
        (("end",), "Use um mês até o atual")
    ]
    assert _problems(EducationIn, {**base, "start": "2024-02", "end": "2023-12"}) == [
        ((), "O fim não pode ser antes do início")
    ]
    assert _problems(EducationIn, {**base, "added_at": "2026-11"}) == [
        (("added_at",), "campo não aceito")
    ]


def test_transport_item_is_checked() -> None:
    assert TransportIn.model_validate({"modes": [], "driver_license": False})
    assert TransportIn.model_validate({"modes": ["car"] * tp.MAX_MODES, "driver_license": True})
    too_many = {"modes": ["car"] * (tp.MAX_MODES + 1), "driver_license": True}
    assert _problems(TransportIn, too_many) == [(("modes",), "no máximo 6 itens")]
    [(loc, text)] = _problems(TransportIn, {"modes": ["bus"], "driver_license": True})
    assert loc == ("modes", 0) and text.startswith("escolha uma das opções: car, motorcycle")
    assert _problems(TransportIn, {"modes": ["car"]}) == [
        (("driver_license",), "campo obrigatório")
    ]
    assert _problems(TransportIn, {"modes": ["car"], "driver_license": None}) == [
        (("driver_license",), "informe sim ou não")
    ]
    assert _problems(TransportIn, {"modes": [], "driver_license": False, "x": 1}) == [
        (("x",), "campo não aceito")
    ]


def test_tool_name_is_cleaned_and_checked() -> None:
    assert TechnicianToolCreate.model_validate({"name": " Trena   laser "}).name == "Trena laser"
    assert _problems(TechnicianToolCreate, {"name": " x "}) == [
        (("name",), "Informe o nome da ferramenta")
    ]
    assert _problems(TechnicianToolCreate, {"name": "a" * (tp.TOOL_NAME_MAX + 1)}) == [
        (("name",), "no máximo 80 caracteres")
    ]
    assert TechnicianToolCreate(name="a" * tp.TOOL_NAME_MAX)
    update = TechnicianToolUpdate.model_validate({"name": None, "is_active": None})
    assert (update.name, update.is_active) == (None, None)
    assert _problems(TechnicianToolUpdate, {"name": ""}) == [
        (("name",), "Informe o nome da ferramenta")
    ]
    assert _problems(TechnicianToolUpdate, {"id": str(uuid.uuid4())}) == [
        (("id",), "campo não aceito")
    ]


def test_patch_limits_are_the_service_ones() -> None:
    """Os limites do PATCH /me/profile e dos itens são os de services/tech_profile.py (os mesmos de
    TECH_PROFILE_LIMITS em lib/constants.ts)."""

    def max_length(model: type[BaseModel], field: str) -> int:
        found = [
            m.max_length for m in model.model_fields[field].metadata if hasattr(m, "max_length")
        ]
        assert len(found) == 1, (model, field)
        return found[0]

    assert max_length(MyProfileUpdate, "tool_ids") == tp.MAX_TOOLS == 200
    assert max_length(MyProfileUpdate, "availability") == tp.MAX_SLOTS == len(tp.ALL_SLOTS)
    assert max_length(MyProfileUpdate, "skills") == tp.MAX_SKILLS == 30
    assert max_length(MyProfileUpdate, "education") == tp.MAX_EDUCATION == 20
    assert max_length(TransportIn, "modes") == tp.MAX_MODES == len(tp.TRANSPORT_MODES)
    assert max_length(TechnicianSkillIn, "name") == tp.SKILL_NAME_MAX
    assert max_length(EducationIn, "course") == tp.COURSE_MAX
    assert max_length(EducationIn, "institution") == tp.INSTITUTION_MAX
    assert max_length(TechnicianToolCreate, "name") == tp.TOOL_NAME_MAX
    # Cada turno cabe no limite por item (o item enorme recusa sem ecoar o valor).
    assert max(len(slot) for slot in tp.ALL_SLOTS) <= SLOT_MAX == 16


def test_patch_lists_are_checked_whole() -> None:
    """A lista inteira: turno desconhecido, transporte null e itens repetidos (os itens se
    conferem um a um nos testes acima)."""
    assert _problems(MyProfileUpdate, {"availability": ["sat:afternoon", "sat:lunch"]}) == [
        (("availability",), "Turno desconhecido: sat:lunch")
    ]
    assert _problems(MyProfileUpdate, {"transport": None}) == [
        (("transport",), "Informe os meios de transporte")
    ]
    linux = {"name": "linux", "level": "basico"}
    assert _problems(MyProfileUpdate, {"skills": [linux, {**linux, "name": " LÍNUX "}]}) == [
        (("skills",), "Aptidão repetida: LÍNUX")
    ]
    course = {
        "course": "Técnico em redes",
        "level": "technical",
        "institution": "Escola Exemplo",
        "start": "2024-02",
    }
    # O mesmo curso, instituição, nível e início, sem diferença de acento e maiúsculas.
    same = {**course, "course": "TÉCNICO  em redes", "institution": "escola exemplo", "end": None}
    assert _problems(MyProfileUpdate, {"education": [course, same]}) == [
        (("education",), "Formação repetida: TÉCNICO em redes")
    ]
    # O mesmo id duas vezes.
    twice = str(uuid.uuid4())
    other = {**course, "id": twice, "start": "2020-01", "end": "2021-12"}
    assert _problems(MyProfileUpdate, {"education": [{**course, "id": twice}, other]}) == [
        (("education",), "Formação repetida: Técnico em redes")
    ]
    # Outro nível ou outro início não repete; null e [] limpam.
    assert MyProfileUpdate.model_validate(
        {"education": [course, {**course, "level": "certification"}, other]}
    )
    cleared = MyProfileUpdate.model_validate(
        {"tool_ids": None, "availability": [], "skills": None, "education": None}
    )
    assert cleared.model_fields_set == {"tool_ids", "availability", "skills", "education"}


# ------------------------------------------------------------ wanted e apply


def _tech() -> User:
    return User(id=uuid.uuid4(), name="Tecnico Alfa", email="tecnico.alfa@exemplo.com")


AT = datetime(2026, 11, 19, 14, 2, 11, tzinfo=UTC)


async def _save(user: User, **body: Any) -> dict[str, Any]:
    """`wanted` e, com mudança, `apply` (como o PATCH faz); devolve as partes mudadas."""
    data = MyProfileUpdate.model_validate(body)
    new = await tp.wanted(None, user, data)  # type: ignore[arg-type]
    tp.apply(user, new, via=tp.VIA_APP, at=AT)
    return new


async def test_availability_and_transport_change_only_for_real() -> None:
    user = _tech()
    # Lista vazia sem nada informado: nada muda (sem data, sem histórico).
    assert await _save(user, availability=[]) == {}
    new = await _save(user, availability=["sat:afternoon", "mon:morning", "sat:afternoon"])
    assert new == {"availability": ["mon:morning", "sat:afternoon"]}
    assert user.availability == ["mon:morning", "sat:afternoon"]
    assert user.tech_profile_stamps == {"availability": {"at": AT.isoformat(), "via": "app"}}
    assert await _save(user, availability=["sat:afternoon", "mon:morning"]) == {}

    # Transporte: a 1ª vez é informação, mesmo "Nenhum · sem CNH".
    assert tp.transport_of(user) is None
    assert await _save(user, transport={"modes": [], "driver_license": False}) == {
        "transport": {"modes": [], "driver_license": False}
    }
    assert tp.transport_of(user) is not None
    assert await _save(user, transport={"modes": [], "driver_license": False}) == {}
    new = await _save(
        user, transport={"modes": ["motorcycle", "car", "car"], "driver_license": True}
    )
    assert new == {"transport": {"modes": ["car", "motorcycle"], "driver_license": True}}
    assert (user.transport_modes, user.has_driver_license) == (["car", "motorcycle"], True)
    assert set(user.tech_profile_stamps) == {"availability", "transport"}
    out = tp.transport_of(user)
    assert out is not None and out.model_dump() == {
        "modes": ["car", "motorcycle"],
        "driver_license": True,
    }


async def test_skills_keep_since_by_name() -> None:
    user = _tech()
    user.skills = [{"name": "Linux", "level": "basico", "since": "2025-03-10"}]
    today = datetime.now(TZ).date().isoformat()
    # Outro nível e outra caixa: a aptidão é a mesma e mantém o "desde"; a nova ganha hoje.
    new = await _save(
        user,
        skills=[
            {"name": "linux", "level": "avancado"},
            {"name": "  Fibra óptica  (fusão) ", "level": "basico"},
        ],
    )
    assert new["skills"] == [
        {"name": "Fibra óptica (fusão)", "level": "basico", "since": today},
        {"name": "linux", "level": "avancado", "since": "2025-03-10"},
    ]
    assert user.skills == new["skills"]
    # Reordenar não é mudança.
    same = [
        {"name": "linux", "level": "avancado"},
        {"name": "Fibra óptica (fusão)", "level": "basico"},
    ]
    assert await _save(user, skills=same) == {}
    # Trocar só a grafia é mudança e grava; o "desde" fica.
    new = await _save(user, skills=[{"name": "Linux", "level": "avancado"}])
    assert new["skills"] == [{"name": "Linux", "level": "avancado", "since": "2025-03-10"}]
    # Renomear de verdade recomeça o "desde".
    new = await _save(user, skills=[{"name": "Linux Debian", "level": "avancado"}])
    assert new["skills"] == [{"name": "Linux Debian", "level": "avancado", "since": today}]
    assert [s.model_dump() for s in tp.skills_of(user)] == new["skills"]
    assert await _save(user, skills=None) == {"skills": []}


async def test_education_ids_and_order() -> None:
    user = _tech()
    course = {
        "course": "Técnico em redes",
        "level": "technical",
        "institution": "Escola Exemplo",
        "start": "2022-02",
        "end": "2023-12",
    }
    ongoing = {**course, "course": "Graduação em TI", "level": "undergraduate", "start": "2024-02"}
    ongoing["end"] = None
    new = await _save(user, education=[course, ongoing])
    first, second = new["education"]
    # Em andamento primeiro; cada curso ganha um id.
    assert (first["course"], second["course"]) == ("Graduação em TI", "Técnico em redes")
    ids = {first["id"], second["id"]}
    assert len(ids) == 2 and all(uuid.UUID(i) for i in ids)
    # O mesmo curso reenviado sem id mantém o id: nada muda.
    assert await _save(user, education=[ongoing, course]) == {}
    # Com o id, mantém o id mesmo mudando o fim; id desconhecido vira item novo.
    changed = {**course, "id": second["id"], "end": "2024-01"}
    unknown = {**ongoing, "id": str(uuid.uuid4()), "course": "Certificação Exemplo"}
    new = await _save(user, education=[changed, unknown])
    by_course = {item["course"]: item for item in new["education"]}
    assert by_course["Técnico em redes"]["id"] == second["id"]
    assert by_course["Técnico em redes"]["end"] == "2024-01"
    assert by_course["Certificação Exemplo"]["id"] not in ids | {unknown["id"]}
    assert [str(e.id) for e in tp.education_of(user)] == [i["id"] for i in new["education"]]


async def test_tools_hide_inactive_and_keep_them(monkeypatch: pytest.MonkeyPatch) -> None:
    trena, escada, alicate, gone = (str(uuid.uuid4()) for _ in range(4))
    catalog = {
        trena: tp.ToolInfo("Trena", True),
        escada: tp.ToolInfo("escada", False),
        alicate: tp.ToolInfo("Alicate de corte", True),
    }

    async def fake_catalog(_: Any) -> dict[str, tp.ToolInfo]:
        return catalog

    monkeypatch.setattr(tp, "tool_catalog", fake_catalog)
    user = _tech()
    user.tool_ids = [escada]
    # A desativada enviada é ignorada; a guardada fica.
    new = await _save(user, tool_ids=[trena, escada, trena])
    assert new == {"tools": sorted([trena, escada])}
    assert await _save(user, tool_ids=[trena]) == {}
    with pytest.raises(WorkflowError, match="Ferramenta não encontrada. Atualize a lista."):
        await _save(user, tool_ids=[gone])
    await _save(user, tool_ids=[alicate, trena])
    assert set(user.tool_ids) == {alicate, trena, escada}
    # Só as ativas aparecem, em ordem alfabética; reativada, volta.
    assert tp.active_tool_ids(user, catalog) == [uuid.UUID(alicate), uuid.UUID(trena)]
    catalog[escada] = tp.ToolInfo("escada", True)
    assert [ref.name for ref in tp.tool_refs(user, catalog)] == [
        "Alicate de corte",
        "escada",
        "Trena",
    ]


def test_apply_writes_new_objects_and_stamps() -> None:
    user = _tech()
    user.tech_profile_stamps = {"skills": {"at": "2026-11-12T10:00:00+00:00", "via": "ficha"}}
    old_stamps = user.tech_profile_stamps
    tp.apply(user, {"name": "ignorado", "availability": ["sat:night"]}, via=tp.VIA_APP, at=AT)
    assert user.availability == ["sat:night"]
    assert user.tech_profile_stamps is not old_stamps
    stamps = tp.stamps_of(user)
    assert stamps.skills is not None and stamps.skills.via == "ficha"
    assert stamps.availability is not None and stamps.availability.via == "app"
    assert stamps.tools is None and stamps.transport is None and stamps.education is None
    assert tp.latest_stamp(user) == AT
    tp.apply(user, {"name": "ignorado"}, via=tp.VIA_APP, at=AT)
    assert set(user.tech_profile_stamps) == {"skills", "availability"}
    assert tp.latest_stamp(_tech()) is None


# ------------------------------------------------------ ficha da homologação

CREATED = datetime(2026, 11, 20, 1, 30, tzinfo=UTC)  # 19/11 às 22:30 em Brasília
FICHA_STAMP = {"at": CREATED.isoformat(), "via": "ficha"}


def _ficha(**fields: Any) -> TechnicianApplication:
    base: dict[str, Any] = {
        "full_name": "Tecnico Alfa",
        "email": "tecnico.alfa@exemplo.com",
        "availability": [],
        "has_vehicle": False,
        "vehicle_type": None,
        "has_driver_license": False,
        "skills": [],
        "created_at": CREATED,
    }
    return TechnicianApplication(**{**base, **fields})


@pytest.mark.parametrize(
    ("codes", "slots"),
    [
        (["dias_uteis_manha"], [f"{d}:morning" for d in WORKDAYS]),
        (["dias_uteis_tarde"], [f"{d}:afternoon" for d in WORKDAYS]),
        (["dias_uteis_noite"], [f"{d}:evening" for d in WORKDAYS]),
        (["sabado"], ["sat:morning", "sat:afternoon", "sat:evening"]),
        (["domingo_feriado"], ["sun:morning", "sun:afternoon", "sun:evening"]),
        (["plantao"], list(tp.ALL_SLOTS)),
        (
            ["sabado", "codigo_antigo", "dias_uteis_manha"],
            [f"{d}:morning" for d in WORKDAYS] + ["sat:morning", "sat:afternoon", "sat:evening"],
        ),
        (["plantao", "sabado"], list(tp.ALL_SLOTS)),
    ],
)
def test_ficha_availability(codes: list[str], slots: list[str]) -> None:
    profile = tp.from_ficha(_ficha(availability=codes))
    assert profile["availability"] == slots
    assert profile["tech_profile_stamps"] == {"availability": FICHA_STAMP}


@pytest.mark.parametrize(
    ("vehicle", "license_", "transport"),
    [
        ({"has_vehicle": True, "vehicle_type": "carro"}, False, ["car"]),
        ({"has_vehicle": True, "vehicle_type": "moto"}, True, ["motorcycle"]),
        ({"has_vehicle": True, "vehicle_type": "outro"}, True, []),
        ({"has_vehicle": False, "vehicle_type": None}, True, []),
        ({"has_vehicle": True, "vehicle_type": "outro"}, False, None),
        ({"has_vehicle": False, "vehicle_type": "carro"}, False, None),
    ],
)
def test_ficha_transport(vehicle: dict[str, Any], license_: bool, transport: list | None) -> None:
    profile = tp.from_ficha(_ficha(**vehicle, has_driver_license=license_))
    assert profile["transport_modes"] == (transport or [])
    assert profile["has_driver_license"] is license_
    stamps = profile["tech_profile_stamps"]
    # Sem meio e sem CNH a ficha não diz nada: o transporte fica "não informado".
    assert stamps == ({} if transport is None else {"transport": FICHA_STAMP})


def test_ficha_skills_and_nothing_informed() -> None:
    skills = [
        {"name": " linux ", "level": "basico"},
        {"name": "Linux", "level": "avancado"},
        {"name": "Câmeras  Hikvision", "level": "intermediario"},
        {"name": " a ", "level": "basico"},
        {"name": "Nobreaks", "level": "expert"},
        {"level": "basico"},
    ]
    since = CREATED.astimezone(TZ).date().isoformat()
    profile = tp.from_ficha(_ficha(skills=skills))
    assert profile["skills"] == [
        {"name": "Câmeras Hikvision", "level": "intermediario", "since": since},
        {"name": "linux", "level": "basico", "since": since},
    ]
    assert profile["tech_profile_stamps"] == {"skills": FICHA_STAMP}
    many = [{"name": f"Aptidão {n:02d}", "level": "basico"} for n in range(tp.MAX_SKILLS + 5)]
    assert len(tp.from_ficha(_ficha(skills=many))["skills"]) == tp.MAX_SKILLS
    assert tp.from_ficha(_ficha()) == {
        "availability": [],
        "transport_modes": [],
        "has_driver_license": False,
        "skills": [],
        "tech_profile_stamps": {},
    }


def test_ficha_since_is_the_local_day() -> None:
    profile = tp.from_ficha(_ficha(skills=[{"name": "Linux", "level": "basico"}]))
    if settings.TIMEZONE == "America/Sao_Paulo":
        assert profile["skills"][0]["since"] == "2026-11-19"
    assert profile["skills"][0]["since"] == CREATED.astimezone(TZ).date().isoformat()


def test_ficha_map_covers_the_ficha_codes() -> None:
    """Todo código da ficha pública tem um mapa (um código novo lá pede um turno aqui)."""
    assert set(tp.FICHA_AVAILABILITY) == set(AVAILABILITY)
    assert set(tp.FICHA_VEHICLE) | {"outro"} == set(VEHICLE_TYPES)
    assert all(set(slots) <= set(tp.ALL_SLOTS) for slots in tp.FICHA_AVAILABILITY.values())


# -------------------------------------------------------------- a migração


def test_migration_copies_the_service_rules() -> None:
    migration = _migration()
    assert (migration.revision, migration.down_revision) == ("f5a7c9e1b3d6", "e4b6d8f0a2c3")
    assert migration.DEFAULT_TOOLS == tp.DEFAULT_TOOLS
    assert len(tp.DEFAULT_TOOLS) == 20
    assert len({tp.fold(name) for name in tp.DEFAULT_TOOLS}) == 20
    assert all(len(name) <= tp.TOOL_NAME_MAX for name in tp.DEFAULT_TOOLS)
    assert migration.FICHA_AVAILABILITY == tp.FICHA_AVAILABILITY
    assert migration.FICHA_VEHICLE == tp.FICHA_VEHICLE
    assert (migration.WEEKDAYS, migration.PERIODS) == (tp.WEEKDAYS, tp.PERIODS)
    assert migration.ALL_SLOTS == tp.ALL_SLOTS
    assert tuple(SKILL_LEVELS) == migration.SKILL_LEVELS
    assert (migration.MAX_SKILLS, migration.TEXT_MIN, migration.SKILL_NAME_MAX) == (
        tp.MAX_SKILLS,
        tp.TEXT_MIN,
        tp.SKILL_NAME_MAX,
    )
    assert migration.TIMEZONE == settings.TIMEZONE
    # O texto: a mesma limpeza e a mesma comparação do serviço (controles e formatação saem).
    for sample in (
        "  Câmeras   HIKVISION ",
        unicodedata.normalize("NFD", "Fibra óptica"),
        "Lin\u200bux\u202e",
        "\ufeffCurso\u0000\tExemplo\x85\x1c",
        "Cafe\u200d\u0301",
        "\ufb01bra óptica",
    ):
        assert migration._clean(sample) == tp.clean(sample), repr(sample)
        assert migration._fold(sample) == tp.fold(sample), repr(sample)


@pytest.mark.parametrize(
    "fields",
    [
        {},
        {
            "availability": ["dias_uteis_manha", "sabado"],
            "has_vehicle": True,
            "vehicle_type": "moto",
        },
        {"availability": ["plantao", "x"], "has_driver_license": True},
        {"has_vehicle": True, "vehicle_type": "outro"},
        {
            "skills": [
                {"name": "DVR/NVR  Intelbras", "level": "avancado"},
                {"name": "dvr/nvr intelbras", "level": "basico"},
                {"name": "Fibra óptica (fusão)", "level": "nenhum"},
                {"name": "Windows 10/11", "level": "intermediario"},
            ]
        },
        # O que não é lista não traz nada: texto JSON no topo (só com SQL feito à mão; a API grava
        # listas), texto com uma lista dentro, objeto e null.
        {"availability": "plantao", "skills": "Redes"},
        {"availability": '["sabado"]', "skills": '[{"name": "Linux", "level": "basico"}]'},
        {"availability": {"plantao": True}, "skills": None, "has_driver_license": True},
        # Nomes com controles e formatação: a mesma limpeza do serviço.
        {
            "skills": [
                {"name": "Lin\u200bux", "level": "basico"},
                {"name": "linux", "level": "avancado"},
                {"name": "\u200b\u202e", "level": "basico"},
            ]
        },
    ],
)
def test_migration_backfill_is_the_same_as_the_approval(fields: dict[str, Any]) -> None:
    """A migração lê availability e skills como texto (o ::text de APPROVED; o json.loads é dela)
    e chega no mesmo perfil que a aprovação da ficha, também quando o JSONB não é lista."""
    application = _ficha(**fields)
    row = {
        "user_id": uuid.uuid4(),
        "availability": json.dumps(application.availability),
        "has_vehicle": application.has_vehicle,
        "vehicle_type": application.vehicle_type,
        "has_driver_license": application.has_driver_license,
        "skills": json.dumps(application.skills),
        "created_at": application.created_at,
    }
    assert _migration()._ficha_profile(row) == tp.from_ficha(application)


def _approved(user_id: uuid.UUID, **fields: Any) -> TechnicianApplication:
    """Uma ficha aprovada para gravar no banco (os campos obrigatórios com dados fictícios)."""
    application = _ficha(**fields)
    application.status = ApplicationStatus.APPROVED
    application.user_id = user_id
    application.phone = "(11) 99999-0000"
    application.document = "12345678909"
    application.city = "Cidade Exemplo"
    application.state = "SP"
    application.coverage_area = "Cidade Exemplo"
    application.privacy_consent_at = CREATED
    application.privacy_version = "2026-11-20"
    return application


@requires_db
async def test_migration_backfill_runs_on_the_driver(world: World, engine: AsyncEngine) -> None:
    """O _backfill de verdade, com o driver do alembic (asyncpg, que já entrega o JSONB
    decodificado: daí o ::text). A ficha com availability e skills em texto JSON no topo não
    derruba o upgrade e não traz nada (perfil vazio, como na aprovação); a ficha com listas traz o
    mesmo perfil da aprovação; rodar de novo não muda nada."""
    migration = _migration()
    lists = {
        "availability": ["sabado"],
        "has_vehicle": True,
        "vehicle_type": "moto",
        "skills": [{"name": "Redes", "level": "basico"}],
    }
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add(_approved(world.tech.user.id, availability="dias_uteis_manha", skills="Redes"))
        db.add(_approved(world.tech_other.user.id, **lists))
        await db.commit()
    async with engine.connect() as conn:
        kinds = await conn.execute(
            text(
                "SELECT jsonb_typeof(availability), jsonb_typeof(skills)"
                " FROM technician_applications WHERE user_id = :id"
            ),
            {"id": world.tech.user.id},
        )
        assert tuple(kinds.one()) == ("string", "string")

    def backfill(sync_conn: Any) -> None:
        with Operations.context(MigrationContext.configure(sync_conn)):
            migration._backfill()

    empty = {
        "availability": [],
        "transport_modes": [],
        "has_driver_license": False,
        "skills": [],
        "tech_profile_stamps": {},
    }
    for _ in range(2):
        async with engine.begin() as conn:
            await conn.run_sync(backfill)
        async with maker() as db:
            for application in (await db.scalars(select(TechnicianApplication))).all():
                user = await db.get(User, application.user_id)
                assert user is not None
                expected = tp.from_ficha(application)
                assert {key: getattr(user, key) for key in expected} == expected
                if user.id == world.tech.user.id:
                    assert expected == empty
                else:
                    assert set(expected["tech_profile_stamps"]) == {
                        "availability",
                        "transport",
                        "skills",
                    }


# ------------------------------------------------- PATCH /me/profile (com banco)

COURSE: dict[str, Any] = {
    "course": "Técnico em redes",
    "level": "technical",
    "institution": "Escola Exemplo",
    "start": "2024-02",
    "end": None,
}
COURSE_TEXT = "Técnico em redes · Escola Exemplo · Técnico · desde 02/2024 (em andamento)"


async def _patch(client: AsyncClient, world: World, **body: Any) -> Response:
    return await client.patch(f"{API}/me/profile", json=body, headers=world.tech.headers)


async def _me(client: AsyncClient, world: World) -> dict[str, Any]:
    r = await client.get(f"{API}/me/profile", headers=world.tech.headers)
    assert r.status_code == 200, r.text
    return r.json()


async def _history(client: AsyncClient, world: World) -> list[dict[str, Any]]:
    """O histórico do cadastro como a central lê (o mais novo primeiro)."""
    r = await client.get(
        f"{API}/technicians/{world.tech.user.id}/changes", headers=world.analyst.headers
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _stored(engine: AsyncEngine, world: World) -> User:
    """O técnico relido do banco, numa sessão nova."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        return user


async def _new_tools(engine: AsyncEngine, *names: str) -> list[str]:
    """Ferramentas no catálogo (a suíte monta o banco pelos models: começa sem as 20 da
    migração)."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        tools = [TechnicianTool(name=name) for name in names]
        db.add_all(tools)
        await db.commit()
        return [str(tool.id) for tool in tools]


async def _set_active(engine: AsyncEngine, tool_id: str, active: bool) -> None:
    """A central desativa ou reativa (direto no banco: as rotas do catálogo têm os testes delas,
    em test_technician_tools.py)."""
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE tool_catalog SET is_active = :active WHERE id = :id"),
            {"active": active, "id": uuid.UUID(tool_id)},
        )


def _profile_events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Os profile.changed publicados, inteiros, na ordem."""
    published: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        if event["type"] == "profile.changed":
            published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", capture)
    return published


def _issues(r: Response) -> list[tuple[str | None, str]]:
    """(rótulo, mensagem) de cada recusa, como o app e a web mostram."""
    detail = r.json()["detail"]
    if isinstance(detail, str):
        return [(None, detail)]
    return [(item.get("label"), item["msg"]) for item in detail]


@requires_db
async def test_each_part_is_saved_and_read_back(
    client: AsyncClient, world: World, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Um PATCH por parte: a resposta volta normalizada, com a data e "app" na parte, e o banco
    guardou de verdade. O mesmo PATCH de novo (reordenado, escrito de outro jeito): 200, sem
    histórico nem aviso."""
    events = _profile_events(monkeypatch)
    trena, escada = await _new_tools(engine, "Trena", "Escada")
    today = datetime.now(TZ).date().isoformat()
    done = {**COURSE, "course": " Técnico  em redes ", "start": "2022-02", "end": "2023-12"}
    ongoing = {**COURSE, "course": "Graduação em TI", "level": "undergraduate"}
    bodies: dict[str, dict[str, Any]] = {
        "tools": {"tool_ids": [trena, escada, trena]},
        "availability": {"availability": ["sat:afternoon", "mon:morning", "sat:afternoon"]},
        "transport": {"transport": {"modes": ["motorcycle", "car"], "driver_license": True}},
        "skills": {
            "skills": [
                {"name": " linux ", "level": "basico"},
                {"name": "Câmeras  Hikvision", "level": "avancado"},
            ]
        },
        "education": {"education": [done, ongoing]},
    }
    for part, body in bodies.items():
        r = await _patch(client, world, **body)
        assert r.status_code == 200, r.text
        stamp = r.json()["tech_profile_updated"][part]
        assert stamp is not None and stamp["via"] == "app", part
        assert datetime.fromisoformat(stamp["at"]).tzinfo is not None
    me = r.json()
    assert me["tool_ids"] == [escada, trena]  # pelo nome
    assert me["availability"] == ["mon:morning", "sat:afternoon"]
    assert me["transport"] == {"modes": ["car", "motorcycle"], "driver_license": True}
    assert me["skills"] == [
        {"name": "Câmeras Hikvision", "level": "avancado", "since": today},
        {"name": "linux", "level": "basico", "since": today},
    ]
    first, second = me["education"]  # em andamento primeiro
    assert (first["course"], first["end"]) == ("Graduação em TI", None)
    assert (second["course"], second["start"], second["end"]) == (
        "Técnico em redes",
        "2022-02",
        "2023-12",
    )
    assert len({uuid.UUID(first["id"]), uuid.UUID(second["id"])}) == 2

    # Relido do banco: cada parte gravou (o PATCH só faz commit quando o histórico muda).
    user = await _stored(engine, world)
    assert user.tool_ids == sorted([trena, escada])
    assert user.availability == ["mon:morning", "sat:afternoon"]
    assert (user.transport_modes, user.has_driver_license) == (["car", "motorcycle"], True)
    assert user.skills == me["skills"]
    assert user.education == me["education"]
    stamps = {part: stamp["via"] for part, stamp in user.tech_profile_stamps.items()}
    assert stamps == dict.fromkeys(tp.PARTS, "app")
    assert await _me(client, world) == me

    rows = await _history(client, world)
    assert [c["field"] for row in reversed(rows) for c in row["changes"]] == list(tp.PARTS)
    assert {row["via"] for row in rows} == {"app"}
    assert [e["data"] for e in events] == [{"fields": [part], "via": "app"} for part in tp.PARTS]

    events.clear()
    again: list[dict[str, Any]] = [
        {"tool_ids": [escada, trena]},
        {"availability": ["sat:afternoon", "mon:morning"]},
        {"transport": {"modes": ["car", "motorcycle", "car"], "driver_license": True}},
        {
            "skills": [
                {"name": "Câmeras Hikvision", "level": "avancado"},
                {"name": "linux", "level": "basico"},
            ]
        },
        {"education": [ongoing, done]},
    ]
    for body in again:
        r = await _patch(client, world, **body)
        assert r.status_code == 200 and r.json() == me, body
    assert len(await _history(client, world)) == len(rows)
    assert events == []


@requires_db
async def test_validation_messages_and_no_password(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Cada recusa com a mensagem e o rótulo que o app mostra, sem gravar nada. Nenhuma parte pede
    senha, nem com a senha provisória (só e-mail e PIX travam)."""
    skill = {"name": "Linux", "level": "basico"}
    course = {key: value for key, value in COURSE.items() if key != "end"}
    twice = str(uuid.uuid4())
    modes = "car, motorcycle, bicycle, public_transport, ride_app ou on_foot"
    cases: list[tuple[dict[str, Any], list[tuple[str | None, str]]]] = [
        (
            {"tool_ids": [str(uuid.uuid4())]},
            [(None, "Ferramenta não encontrada. Atualize a lista.")],
        ),
        (
            {"tool_ids": [str(uuid.uuid4()) for _ in range(201)]},
            [("Ferramental", "No máximo 200 itens")],
        ),
        ({"tool_ids": ["x"]}, [("Ferramental", "Identificador inválido")]),
        (
            {"availability": [*tp.ALL_SLOTS, "mon:morning"]},
            [("Disponibilidade", "No máximo 28 itens")],
        ),
        ({"availability": ["sat:lunch"]}, [("Disponibilidade", "Turno desconhecido: sat:lunch")]),
        ({"availability": ["x" * 200]}, [("Disponibilidade", "No máximo 16 caracteres")]),
        ({"transport": None}, [("Transporte", "Informe os meios de transporte")]),
        (
            {"transport": {"modes": ["car"] * 7, "driver_license": True}},
            [("Meios de transporte", "No máximo 6 itens")],
        ),
        (
            {"transport": {"modes": ["bus"], "driver_license": True}},
            [("Meios de transporte", f"Escolha uma das opções: {modes}")],
        ),
        ({"transport": {"modes": ["car"]}}, [("CNH", "Campo obrigatório")]),
        (
            {"transport": {"modes": ["car"], "driver_license": None}},
            [("CNH", "Informe sim ou não")],
        ),
        (
            {"transport": {"modes": [], "driver_license": False, "car": True}},
            [(None, "Campo não aceito")],
        ),
        ({"skills": [{**skill, "name": " a "}]}, [("Nome", "Informe o nome da aptidão")]),
        # Só invisíveis (largura zero, direção): saem, e o nome fica vazio.
        (
            {"skills": [{**skill, "name": "\u200b\u202e\u200b"}]},
            [("Nome", "Informe o nome da aptidão")],
        ),
        ({"skills": [{**skill, "name": "a" * 81}]}, [("Nome", "No máximo 80 caracteres")]),
        (
            {"skills": [{**skill, "level": "expert"}]},
            [("Nível", "Escolha uma das opções: basico, intermediario ou avancado")],
        ),
        (
            {"skills": [{**skill, "name": "linux"}, {**skill, "name": "Linux "}]},
            [("Aptidões", "Aptidão repetida: Linux")],
        ),
        (
            {"skills": [skill, {**skill, "name": "Lin\u200bux"}]},
            [("Aptidões", "Aptidão repetida: Linux")],
        ),
        (
            {"skills": [{**skill, "name": f"Aptidão {n:02d}"} for n in range(31)]},
            [("Aptidões", "No máximo 30 itens")],
        ),
        ({"skills": [{**skill, "since": "2026-01-01"}]}, [(None, "Campo não aceito")]),
        ({"education": [{**course, "course": "x"}]}, [("Curso", "Informe o curso")]),
        (
            {"education": [{**course, "course": "\u0000\u0001\ufeff"}]},
            [("Curso", "Informe o curso")],
        ),
        (
            {"education": [{**course, "institution": " "}]},
            [("Instituição", "Informe a instituição")],
        ),
        ({"education": [{**course, "course": "a" * 121}]}, [("Curso", "No máximo 120 caracteres")]),
        (
            {"education": [{**course, "institution": "a" * 121}]},
            [("Instituição", "No máximo 120 caracteres")],
        ),
        (
            {"education": [{**course, "start": "2024-13"}]},
            [("Início", "Mês inválido: use AAAA-MM")],
        ),
        ({"education": [{**course, "start": "1949-12"}]}, [("Início", "Confira o ano")]),
        (
            {"education": [{**course, "end": _month_from_now(2)}]},
            [("Fim", "Use um mês até o atual")],
        ),
        (
            {"education": [{**course, "end": "2023-12"}]},
            [("Formação", "O fim não pode ser antes do início")],
        ),
        (
            {"education": [{**course, "id": twice}, {**course, "id": twice, "start": "2020-01"}]},
            [("Formação", "Formação repetida: Técnico em redes")],
        ),
        (
            {"education": [course, {**course, "course": "técnico EM redes"}]},
            [("Formação", "Formação repetida: técnico EM redes")],
        ),
        (
            {"education": [{**course, "start": f"{2000 + n}-01"} for n in range(21)]},
            [("Formação", "No máximo 20 itens")],
        ),
        ({"education": [{**course, "added_at": "2026-11"}]}, [(None, "Campo não aceito")]),
    ]
    for body, expected in cases:
        r = await _patch(client, world, **body)
        assert r.status_code == 422, (body, r.text)
        assert _issues(r) == expected, body
    # O turno enorme recusa sem ecoar o valor (antes, voltava duas vezes na resposta).
    r = await _patch(client, world, availability=["x" * 200])
    assert r.status_code == 422 and "x" * (SLOT_MAX + 1) not in r.text
    assert await _history(client, world) == []
    user = await _stored(engine, world)
    assert (user.tool_ids, user.availability, user.skills, user.education) == ([], [], [], [])
    assert user.tech_profile_stamps == {}

    # Nenhuma parte pede senha, nem com a provisória (a central redefiniu).
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE users SET must_change_password = true WHERE id = :id"),
            {"id": world.tech.user.id},
        )
    r = await _patch(
        client,
        world,
        availability=["sat:morning"],
        transport={"modes": [], "driver_license": False},
    )
    assert r.status_code == 200, r.text
    assert r.json()["transport"] == {"modes": [], "driver_license": False}
    assert (await _history(client, world))[0]["changes"] == [
        {"field": "availability", "from": None, "to": "sáb · manhã"},
        {"field": "transport", "from": None, "to": "Nenhum · sem CNH"},
    ]


@requires_db
async def test_skill_since_is_kept_by_name(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O "desde" fica pelo nome (outro nível, outra caixa); a aptidão nova ganha hoje; trocar só a
    grafia grava (e entra no histórico); renomear de verdade recomeça."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        user.skills = [{"name": "Linux", "level": "basico", "since": "2025-03-10"}]
        await db.commit()
    today = datetime.now(TZ).date().isoformat()
    printer = {"name": "Impressoras HP", "level": "basico"}

    r = await _patch(client, world, skills=[{"name": "LINUX", "level": "avancado"}, printer])
    assert r.status_code == 200, r.text
    assert r.json()["skills"] == [
        {"name": "Impressoras HP", "level": "basico", "since": today},
        {"name": "LINUX", "level": "avancado", "since": "2025-03-10"},
    ]
    r = await _patch(client, world, skills=[printer, {"name": "Linux", "level": "avancado"}])
    assert r.status_code == 200, r.text
    assert r.json()["skills"][1] == {"name": "Linux", "level": "avancado", "since": "2025-03-10"}
    assert (await _stored(engine, world)).skills == r.json()["skills"]
    r = await _patch(client, world, skills=[printer, {"name": "Linux Debian", "level": "avancado"}])
    assert r.status_code == 200, r.text
    assert {s["name"]: s["since"] for s in r.json()["skills"]} == {
        "Impressoras HP": today,
        "Linux Debian": today,
    }

    rows = await _history(client, world)
    assert [row["changes"] for row in rows] == [
        [{"field": "skills", "from": "Linux (Avançado)", "to": "Linux Debian (Avançado)"}],
        [{"field": "skills", "from": "LINUX (Avançado)", "to": "Linux (Avançado)"}],
        [
            {
                "field": "skills",
                "from": "Linux (Básico)",
                "to": "Impressoras HP (Básico), LINUX (Avançado)",
            }
        ],
    ]


@requires_db
async def test_education_keeps_the_ids(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Curso novo ganha id; reenviado igual sem id mantém o id (nada muda); com o id, mantém mesmo
    mudando; id desconhecido vira curso novo; o mesmo id duas vezes no corpo: 422."""
    r = await _patch(client, world, education=[COURSE])
    assert r.status_code == 200, r.text
    [first] = r.json()["education"]
    course_id = first["id"]
    assert uuid.UUID(course_id)
    without_id = {key: value for key, value in COURSE.items() if key != "end"}
    r = await _patch(client, world, education=[without_id])
    assert r.status_code == 200 and r.json()["education"] == [first]
    finished = {**COURSE, "id": course_id, "end": "2025-12"}
    r = await _patch(client, world, education=[finished])
    assert r.status_code == 200 and r.json()["education"] == [{**first, "end": "2025-12"}]
    unknown = {
        **COURSE,
        "id": str(uuid.uuid4()),
        "course": "Certificação Exemplo",
        "level": "certification",
    }
    r = await _patch(client, world, education=[finished, unknown])
    assert r.status_code == 200, r.text
    ids = {item["course"]: item["id"] for item in r.json()["education"]}
    assert ids["Técnico em redes"] == course_id
    assert ids["Certificação Exemplo"] not in (course_id, unknown["id"])
    saved = r.json()["education"]
    r = await _patch(client, world, education=[finished, {**finished, "start": "2020-01"}])
    assert r.status_code == 422
    assert _issues(r) == [("Formação", "Formação repetida: Técnico em redes")]
    assert (await _stored(engine, world)).education == saved

    certification = (
        "Certificação Exemplo · Escola Exemplo · Certificação · desde 02/2024 (em andamento)"
    )
    finished_text = "Técnico em redes · Escola Exemplo · Técnico · 02/2024 a 12/2025"
    rows = await _history(client, world)
    assert [row["changes"] for row in rows] == [
        [{"field": "education", "from": None, "to": certification}],
        [{"field": "education", "from": COURSE_TEXT, "to": finished_text}],
        [{"field": "education", "from": None, "to": COURSE_TEXT}],
    ]


@requires_db
async def test_inactive_tool_is_hidden_and_kept(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Desativada pela central: some do GET, fica guardada no banco e volta quando reativam;
    mandar a desativada é ignorado (200, nada muda)."""
    alicate, escada, trena = await _new_tools(engine, "Alicate de corte", "Escada", "Trena")
    r = await _patch(client, world, tool_ids=[escada, alicate])
    assert r.status_code == 200 and r.json()["tool_ids"] == [alicate, escada]
    await _set_active(engine, escada, False)
    assert (await _me(client, world))["tool_ids"] == [alicate]
    assert set((await _stored(engine, world)).tool_ids) == {alicate, escada}

    r = await _patch(client, world, tool_ids=[alicate, trena])
    assert r.status_code == 200 and r.json()["tool_ids"] == [alicate, trena]
    assert set((await _stored(engine, world)).tool_ids) == {alicate, escada, trena}
    rows = await _history(client, world)
    assert rows[0]["changes"] == [{"field": "tools", "from": None, "to": "Trena"}]
    r = await _patch(client, world, tool_ids=[trena, escada, alicate])
    assert r.status_code == 200 and r.json()["tool_ids"] == [alicate, trena]
    assert len(await _history(client, world)) == len(rows)

    # Limpar tira as ativas; a desativada continua guardada e volta quando reativam.
    r = await _patch(client, world, tool_ids=None)
    assert r.status_code == 200 and r.json()["tool_ids"] == []
    assert (await _stored(engine, world)).tool_ids == [escada]
    assert (await _history(client, world))[0]["changes"] == [
        {"field": "tools", "from": "Alicate de corte, Trena", "to": None}
    ]
    await _set_active(engine, escada, True)
    assert (await _me(client, world))["tool_ids"] == [escada]


@requires_db
async def test_history_texts_and_the_event(
    client: AsyncClient, world: World, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Histórico: nas listas, "from" é o que saiu e "to" o que entrou (mais de 10 itens: os 10
    primeiros e "e mais N"); o transporte vai de → para. O aviso profile.changed leva só as partes
    e "app", para a gestão (sem PIX, sem after_reset)."""
    ids = dict(zip(tp.DEFAULT_TOOLS, await _new_tools(engine, *tp.DEFAULT_TOOLS), strict=True))
    for body in (
        {"tool_ids": [ids["Furadeira"]]},
        {"availability": ["mon:night"]},
        {"skills": [{"name": "Linux", "level": "basico"}]},
    ):
        assert (await _patch(client, world, **body)).status_code == 200
    events = _profile_events(monkeypatch)
    steps: list[tuple[dict[str, Any], dict[str, Any]]] = [
        (
            {"tool_ids": [ids["Multímetro"], ids["Escada"]]},
            {"field": "tools", "from": "Furadeira", "to": "Escada, Multímetro"},
        ),
        (
            {"availability": ["sat:evening", "sat:afternoon"]},
            {"field": "availability", "from": "seg · madrugada", "to": "sáb · tarde e noite"},
        ),
        (
            {"transport": {"modes": ["motorcycle", "car"], "driver_license": True}},
            {"field": "transport", "from": None, "to": "Carro, Moto · com CNH"},
        ),
        (
            {"transport": {"modes": [], "driver_license": False}},
            {"field": "transport", "from": "Carro, Moto · com CNH", "to": "Nenhum · sem CNH"},
        ),
        (
            {"skills": [{"name": "Linux", "level": "intermediario"}]},
            {"field": "skills", "from": "Linux (Básico)", "to": "Linux (Intermediário)"},
        ),
        ({"education": [COURSE]}, {"field": "education", "from": None, "to": COURSE_TEXT}),
        (
            {"availability": []},
            {"field": "availability", "from": "sáb · tarde e noite", "to": None},
        ),
    ]
    for body, change in steps:
        r = await _patch(client, world, **body)
        assert r.status_code == 200, r.text
        assert (await _history(client, world))[0]["changes"] == [change], body

    r = await _patch(client, world, tool_ids=list(ids.values()))
    assert r.status_code == 200, r.text
    added = sorted(
        (name for name in tp.DEFAULT_TOOLS if name not in ("Escada", "Multímetro")),
        key=lambda name: (tp.fold(name), name),
    )
    assert (await _history(client, world))[0]["changes"] == [
        {"field": "tools", "from": None, "to": f"{', '.join(added[:10])} e mais {len(added) - 10}"}
    ]

    expected = [{"fields": [change["field"]], "via": "app"} for _, change in steps]
    assert [event["data"] for event in events] == [*expected, {"fields": ["tools"], "via": "app"}]
    first = events[0]
    assert first["data"] == {"fields": ["tools"], "via": "app"}
    assert first["audience"] == {"managers_only": True}
    assert first["user_id"] == first["actor_id"] == str(world.tech.user.id)
    assert not any("pix" in str(event) for event in events)


@requires_db
async def test_invisible_characters_are_dropped_before_saving(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Controles e formatação saem antes de gravar: o U+0000 no curso (que o banco recusa: era um
    500) grava sem ele, e a largura zero e a marca de direção não sobram nos nomes. O mesmo curso
    reenviado com os invisíveis não muda nada."""
    course = {
        **COURSE,
        "course": "Técnico\u0000 em\u200b redes",
        "institution": "\u202eEscola\tExemplo",
    }
    r = await _patch(
        client, world, education=[course], skills=[{"name": "Lin\u200bux", "level": "basico"}]
    )
    assert r.status_code == 200, r.text
    [saved] = r.json()["education"]
    assert (saved["course"], saved["institution"]) == ("Técnico em redes", "Escola Exemplo")
    assert [skill["name"] for skill in r.json()["skills"]] == ["Linux"]
    user = await _stored(engine, world)
    assert (user.education, user.skills) == (r.json()["education"], r.json()["skills"])
    rows = await _history(client, world)
    assert rows[0]["changes"][1] == {"field": "education", "from": None, "to": COURSE_TEXT}
    r = await _patch(client, world, education=[{**course, "id": saved["id"]}])
    assert r.status_code == 200 and r.json()["education"] == [saved]
    assert len(await _history(client, world)) == len(rows)


@requires_db
async def test_two_parts_saved_together_keep_both_stamps(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Duas partes gravadas ao mesmo tempo (o app que reenvia depois do tempo esgotado, o técnico
    em dois aparelhos): uma gravação por vez por técnico, e nenhuma apaga o carimbo da outra (sem o
    carimbo, o transporte gravado voltava "não informado")."""
    [escada] = await _new_tools(engine, "Escada")
    transport = {"modes": ["car"], "driver_license": True}
    responses = await asyncio.gather(
        _patch(client, world, transport=transport), _patch(client, world, tool_ids=[escada])
    )
    assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]
    assert set((await _stored(engine, world)).tech_profile_stamps) == {"transport", "tools"}
    me = await _me(client, world)
    assert (me["transport"], me["tool_ids"]) == (transport, [escada])
    # A resposta de quem gravou por último (a que o app guarda) já traz as duas partes.
    assert any(r.json() == me for r in responses)
    rows = await _history(client, world)
    assert sorted(change["field"] for row in rows for change in row["changes"]) == [
        "tools",
        "transport",
    ]


@requires_db
async def test_one_part_saved_twice_together_keeps_the_history_right(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """A mesma parte duas vezes ao mesmo tempo: a segunda gravação espera a primeira e compara com
    o que ela gravou, e o histórico fecha com o valor final do banco (em qualquer ordem)."""
    one, two = ["mon:morning"], ["mon:morning", "tue:morning"]
    responses = await asyncio.gather(
        _patch(client, world, availability=one), _patch(client, world, availability=two)
    )
    assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]
    final = (await _stored(engine, world)).availability
    assert (await _me(client, world))["availability"] == final
    if final == two:  # [seg] gravou primeiro
        expected = [(None, "seg · manhã"), (None, "ter · manhã")]
    else:  # [seg e ter] gravou primeiro
        assert final == one
        expected = [(None, "seg e ter · manhã"), ("ter · manhã", None)]
    rows = await _history(client, world)
    assert [row["changes"] for row in reversed(rows)] == [
        [{"field": "availability", "from": old, "to": new}] for old, new in expected
    ]
