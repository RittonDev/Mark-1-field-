"""Perfil técnico (services/tech_profile.py e schemas/tech_profile.py).

Sem banco: os textos curtos (os mesmos casos das sondas de lib/constants.ts), os turnos que uma
visita toca e o sinal da disponibilidade na sugestão, as mensagens de cada item do PATCH
/me/profile, a normalização e o "o que conta como mudança" de `wanted`/`apply`, o que a ficha da
homologação traz na aprovação e a cópia desse mapa na migração f5a7c9e1b3d6. Dados fictícios.
"""

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
from pydantic import BaseModel, ConfigDict, ValidationError

from app.core.config import settings
from app.models import TechnicianApplication, User
from app.schemas.onboarding import AVAILABILITY, SKILL_LEVELS, VEHICLE_TYPES
from app.schemas.tech_profile import (
    EducationIn,
    TechnicianSkillIn,
    TechnicianToolCreate,
    TechnicianToolUpdate,
    TransportIn,
)
from app.services import tech_profile as tp
from app.services import validation_messages
from app.services.errors import WorkflowError

TZ = ZoneInfo(settings.TIMEZONE)
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


# ------------------------------------------------------------ wanted e apply


class _Body(BaseModel):
    """O pedaço de MyProfileUpdate que `wanted` lê (o PATCH /me/profile de verdade fica em
    schemas/my_profile.py)."""

    model_config = ConfigDict(extra="forbid")

    tool_ids: list[uuid.UUID] | None = None
    availability: list[str] | None = None
    transport: TransportIn | None = None
    skills: list[TechnicianSkillIn] | None = None
    education: list[EducationIn] | None = None


def _tech() -> User:
    return User(id=uuid.uuid4(), name="Tecnico Alfa", email="tecnico.alfa@exemplo.com")


AT = datetime(2026, 11, 19, 14, 2, 11, tzinfo=UTC)


async def _save(user: User, **body: Any) -> dict[str, Any]:
    """`wanted` e, com mudança, `apply` (como o PATCH faz); devolve as partes mudadas."""
    new = await tp.wanted(None, user, _Body.model_validate(body))  # type: ignore[arg-type]
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
    ],
)
def test_migration_backfill_is_the_same_as_the_approval(fields: dict[str, Any]) -> None:
    """A migração recebe o JSONB em texto (consulta em texto puro no asyncpg) e chega no mesmo
    perfil que a aprovação da ficha."""
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
    expected = tp.from_ficha(application)
    migration = _migration()
    assert migration._ficha_profile(row) == expected
    as_lists = {**row, "availability": application.availability, "skills": application.skills}
    assert migration._ficha_profile(as_lists) == expected
