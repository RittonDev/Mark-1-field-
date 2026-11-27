"""Migração da gestão dos técnicos (c8f2a4e6b0d3): a cadeia, as cópias do código, as funções puras
dos passos de dados e do downgrade, e os passos de verdade no banco de teste.

O banco de teste nasce dos modelos (os catálogos vazios e o name_key do ferramental já NOT NULL e
único): o teste com banco tira essas duas regras numa transação, grava os dados no formato de antes,
roda os passos com o driver do alembic e desfaz tudo no fim.
"""

import importlib.util
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any, get_args

import pytest
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from tests.conftest import requires_db

BACKEND = Path(__file__).resolve().parents[1]
MIGRATION = BACKEND / "alembic" / "versions" / "20261126_c8f2a4e6b0d3_gestao_dos_tecnicos.py"


def _migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("gestao_dos_tecnicos", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


M = _migration()


def _id() -> str:
    return str(uuid.uuid4())


# ------------------------------------------------------------------ cadeia e cópias


def test_revision_follows_the_head() -> None:
    config = Config()
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    script = ScriptDirectory.from_config(config)
    assert script.get_heads() == ["c8f2a4e6b0d3"]
    revision = script.get_revision("c8f2a4e6b0d3")
    assert revision is not None and revision.down_revision == "b7e2d4f6a8c1"
    assert (M.revision, M.down_revision) == ("c8f2a4e6b0d3", "b7e2d4f6a8c1")


def test_copies_match_the_app() -> None:
    """As cópias da migração seguem o código (ela não importa app.*)."""
    from app.core import text as core_text
    from app.models import ServiceArea, Skill, TechnicianTool
    from app.schemas import onboarding
    from app.schemas.tech_profile import SkillLevel
    from app.services import technician_catalogs

    assert M.DEFAULT_AREAS == technician_catalogs.DEFAULT_AREAS
    assert len(M.DEFAULT_AREAS) == 10 and M.DEFAULT_AREAS[2] == (
        "redes",
        "Redes e cabeamento estruturado",
    )
    assert M.DEFAULT_SKILLS == technician_catalogs.DEFAULT_SKILLS
    assert len(M.DEFAULT_SKILLS) == len(set(M.DEFAULT_SKILLS)) == 16
    # As listas fixas de antes, enquanto existirem (a ficha da Entrega 1).
    legacy_areas = getattr(onboarding, "SERVICE_AREAS", None)
    if legacy_areas is not None:
        assert tuple(legacy_areas.items()) == M.DEFAULT_AREAS
    legacy_skills = getattr(onboarding, "SKILL_SUGGESTIONS", None)
    if legacy_skills is not None:
        assert tuple(legacy_skills) == M.DEFAULT_SKILLS
    assert M.SKILL_LEVELS == tuple(onboarding.SKILL_LEVELS) == get_args(SkillLevel)
    assert M.DEFAULT_LEVEL == "basico"
    assert M.NAME_MAX == technician_catalogs.NAME_MAX == 80
    for model in (ServiceArea, Skill, TechnicianTool):
        assert model.__table__.c.name.type.length == M.NAME_MAX
        assert model.__table__.c.name_key.type.length == M.KEY_MAX == 160
    assert ServiceArea.__table__.c.code.type.length == M.CODE_MAX == 32
    samples = [
        " Multímetro ",
        "multimetro",
        "\ufb01bra óptica",
        "Lin\u200bux",
        "\ufeff\u202eRedes\u202c ",
        "Curso\u0000 Exemplo\u0007",
        "Fibra\tóptica\r\n(fusão)\v\f",
        "Re\x1cdes\x85",
        "Cafe\u200d\u0301",
        "Windows\xa010/11",
        "ÁÉÍÓÚ ç Ñ straße",
        "",
        None,
    ]
    for sample in samples:
        assert M.fold(sample) == core_text.fold(sample), sample
        assert M.clean(sample) == core_text.clean(sample), sample
    assert M.fold(" Multímetro ") == "multimetro"
    assert M.fold("\ufb01bra") == M.fold("FIBRA") == "fibra"
    assert M.clean("Cafe\u200d\u0301") == "Café"
    # O texto das listas do histórico de hoje (" e mais N" e o " (Nível)").
    from app.services.tech_profile import items_text

    twelve = [f"Item {n:02d}" for n in range(1, 13)]
    tools = [{"field": "tools", "from": None, "to": items_text(twelve)}]
    assert M.history_names(tools, "tools") == twelve[:10]
    for label in onboarding.SKILL_LEVELS.values():
        skills = [{"field": "skills", "from": f"Linux ({label})", "to": None}]
        assert M.history_names(skills, "skills") == ["Linux"], label


# ------------------------------------------------------------------ funções puras


def test_skill_names_seed_defaults_first() -> None:
    recorded = [
        "linux",
        "  Python   Exemplo ",
        "",
        "   ",
        None,
        3,
        "LÍNUX",
        "Pýthon exemplo",
        "x" * 100,
        "Lin\u200bux",
    ]
    assert M.seed_skill_names(("Linux", "Windows 10/11"), recorded) == [
        "Linux",
        "Windows 10/11",
        "Python Exemplo",
        "x" * 80,
    ]
    # As padrão primeiro, também quando repetem entre si (fica a grafia da primeira).
    assert M.seed_skill_names(("PABX IP", "pabx ip"), []) == ["PABX IP"]
    assert M.seed_skill_names(M.DEFAULT_SKILLS, []) == list(M.DEFAULT_SKILLS)


def test_area_codes_become_ids_and_unknown_codes_become_areas() -> None:
    redes, cftv, other = _id(), _id(), _id()
    by_code = {"redes": redes, "cftv": cftv}
    known = {redes, cftv}
    values = ["redes", "CFTV", "redes", " xyz-exemplo ", redes, other, 7, "", "  ", "xyz-exemplo"]
    assert M.area_ids(values, by_code, known) == ([redes, cftv], ["xyz-exemplo"])
    # Já convertida: igual (rodar de novo não muda nada); o id em maiúsculas volta minúsculo.
    assert M.area_ids([cftv, redes], by_code, known) == ([cftv, redes], [])
    assert M.area_ids([redes.upper()], by_code, known) == ([redes], [])
    assert M.area_ids([], by_code, known) == ([], [])
    for odd in (None, "redes", {"redes": 1}, 3):
        assert M.area_ids(odd, by_code, known) is None


def test_skills_by_name_keep_level_and_since() -> None:
    linux, python = _id(), _id()
    by_key = {"linux": linux, "python exemplo": python}
    raw = [
        {"name": "linux", "level": "avancado", "since": "2026-01-10"},
        {"name": " Pýthon  Exemplo", "level": "intermediario"},
    ]
    assert M.skill_items(raw, by_key, since="2026-03-10") == [
        {"skill_id": linux, "level": "avancado", "since": "2026-01-10"},
        {"skill_id": python, "level": "intermediario", "since": "2026-03-10"},
    ]
    # A ficha: sem "desde".
    assert M.skill_items(raw, by_key, since=None) == [
        {"skill_id": linux, "level": "avancado"},
        {"skill_id": python, "level": "intermediario"},
    ]


def test_skill_items_keep_everything() -> None:
    """Nível ruim vira básico; o mesmo id duas vezes fica o primeiro; o item já convertido fica; o
    que não é item sai; o nome fora do catálogo sai (o catálogo já tem todos os gravados)."""
    linux, kept = _id(), _id()
    by_key = {"linux": linux}
    raw = [
        {"name": "Linux", "level": "expert", "since": ""},
        {"name": "LINUX", "level": "basico", "since": "2026-02-02"},
        {"skill_id": kept, "level": "avancado", "since": "2025-05-05"},
        {"skill_id": kept, "level": "basico"},
        "Linux",
        {"name": "Fora Exemplo", "level": "basico"},
        {"level": "basico"},
    ]
    assert M.skill_items(raw, by_key, since="2026-03-10") == [
        {"skill_id": linux, "level": "basico", "since": "2026-03-10"},
        {"skill_id": kept, "level": "avancado", "since": "2025-05-05"},
    ]
    converted = M.skill_items(raw, by_key, since="2026-03-10")
    assert M.skill_items(converted, by_key, since="2026-03-10") == converted
    for odd in (None, "Linux", {"name": "Linux"}, 3):
        assert M.skill_items(odd, by_key, since=None) is None


def test_history_names_of_tools_and_skills() -> None:
    changes = [
        {"field": "tools", "from": "Escada", "to": "Alicate de inserção (punch down), Trena"},
        {"field": "tools", "from": None, "to": "Escada, Furadeira e mais 3"},
        {"field": "skills", "from": "Linux (Básico)", "to": "Fibra óptica (fusão) (Avançado)"},
        {"field": "skills", "from": None, "to": "PABX IP (Intermediário) e mais 12"},
        {"field": "name", "from": "Tecnico", "to": "Tecnico Alfa"},
        "texto",
    ]
    assert M.history_names(changes, "tools") == [
        "Escada",
        "Alicate de inserção (punch down)",
        "Trena",
        "Furadeira",
    ]
    assert M.history_names(changes, "skills") == ["Linux", "Fibra óptica (fusão)", "PABX IP"]
    assert M.history_names(None, "tools") == M.history_names("x", "tools") == []


def test_tool_duplicates_merge_into_the_oldest() -> None:
    a, b, c, d = sorted(_id() for _ in range(4))
    old = datetime(2026, 1, 1, tzinfo=UTC)
    new = datetime(2026, 2, 1, tzinfo=UTC)
    rows = [
        (c, "Multímetro", new),
        (d, "multimetro", old),
        (a, "Escada", old),
        (b, " MULTÍMETRO ", old),
    ]
    # O mais antigo fica; no empate (b e d), o menor id.
    assert M.merge_duplicates(rows) == {c: b, d: b}
    assert M.merge_duplicates([(a, "Escada", old), (b, "Trena", old)]) == {}
    # Sem fuso: UTC.
    naive = [(a, "Trena", datetime(2026, 1, 1)), (b, "trena", new)]
    assert M.merge_duplicates(naive) == {b: a}
    assert M.replace_ids([c, a, d, b, 5], {c: b, d: b}) == [b, a, 5]
    assert M.replace_ids("x", {}) is None


def test_area_stamp_and_names() -> None:
    at = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
    skills = {"at": "2026-02-01T10:00:00+00:00", "via": "app"}
    assert M.stamp_areas({"skills": skills}, at) == {
        "skills": skills,
        "areas": {"at": "2026-03-01T12:00:00+00:00", "via": "ficha"},
    }
    assert M.stamp_areas({"areas": skills}, at) is None
    assert M.stamp_areas(None, at) is None
    assert M.catalog_name("  Área   Exemplo ") == "Área Exemplo"
    assert M.catalog_name("\u200b") is None and M.catalog_name(3) is None
    assert M.key_of("Ação") == "acao"


def test_downgrade_helpers() -> None:
    linux, python, gone = _id(), _id(), _id()
    names = {linux: "Linux", python: "Python Exemplo"}
    raw = [
        {"skill_id": linux, "level": "avancado", "since": "2026-01-10"},
        {"skill_id": gone, "level": "basico", "since": "2026-01-10"},
        {"skill_id": python, "level": "basico", "since": "2026-03-10"},
        {"name": "Já Antigo", "level": "basico", "since": "2025-01-01"},
        {"name": "linux", "level": "basico", "since": "2025-01-01"},
    ]
    assert M.skills_back(raw, names, with_since=True) == [
        {"name": "Linux", "level": "avancado", "since": "2026-01-10"},
        {"name": "Python Exemplo", "level": "basico", "since": "2026-03-10"},
        {"name": "Já Antigo", "level": "basico", "since": "2025-01-01"},
    ]
    ficha = [{"skill_id": linux, "level": "intermediario"}]
    assert M.skills_back(ficha, names, with_since=False) == [
        {"name": "Linux", "level": "intermediario"}
    ]
    assert M.skills_back({"x": 1}, names, with_since=True) is None

    redes, new = _id(), _id()
    codes = {redes: "redes"}
    assert M.areas_back([redes, new, "cftv", "redes", redes], {**codes, _id(): "cftv"}) == [
        "redes",
        "cftv",
    ]
    assert M.areas_back([new], codes) == []
    assert M.areas_back(None, codes) is None

    stamps = {
        "skills": {"at": "2026-11-26T10:00:00+00:00", "via": "central"},
        "tools": {"at": "2026-11-20T10:00:00+00:00", "via": "app"},
        "areas": {"at": "2026-03-01T12:00:00+00:00", "via": "ficha"},
    }
    assert M.stamps_back(stamps) == {
        "skills": {"at": "2026-11-26T10:00:00+00:00", "via": "app"},
        "tools": {"at": "2026-11-20T10:00:00+00:00", "via": "app"},
    }
    assert stamps["skills"]["via"] == "central"  # a entrada não muda
    assert M.stamps_back(None) is None

    changes = [
        {"field": "internal_attachments", "from": None, "to": "incluiu Anexo interno Contrato"},
        {"field": "name", "from": "Tecnico", "to": "Tecnico Alfa"},
    ]
    assert M.strip_internal(changes) == [changes[1]]
    assert M.strip_internal(changes[:1]) == []
    assert M.strip_internal("x") == "x"


# ------------------------------------------------------------------ no banco

NOW = datetime(2026, 11, 26, 12, 0, tzinfo=UTC)
CPF = "12345678909"
JSONB_COLUMNS = {
    "service_areas",
    "skills",
    "tool_ids",
    "tech_profile_stamps",
    "availability",
    "changes",
}


def _run(sync_conn: Any, steps: list[Any], out: list[Any]) -> None:
    with Operations.context(MigrationContext.configure(sync_conn)):
        out.extend(step() for step in steps)


async def _on_driver(conn: AsyncConnection, *steps: Any) -> list[Any]:
    out: list[Any] = []
    await conn.run_sync(_run, list(steps), out)
    return out


async def _insert(conn: AsyncConnection, table: str, values: dict[str, Any]) -> uuid.UUID:
    values = {"id": uuid.uuid4(), **values}
    for key in JSONB_COLUMNS & values.keys():
        if not isinstance(values[key], str):
            values[key] = json.dumps(values[key])
    columns = ", ".join(values)
    params = ", ".join(
        f"CAST(:{key} AS jsonb)" if key in JSONB_COLUMNS else f":{key}" for key in values
    )
    await conn.execute(text(f"INSERT INTO {table} ({columns}) VALUES ({params})"), values)
    return values["id"]


async def _user(conn: AsyncConnection, name: str, **fields: Any) -> uuid.UUID:
    return await _insert(
        conn,
        "users",
        {
            "name": name,
            "email": f"{name.lower().replace(' ', '.')}@exemplo.com",
            "password_hash": "x",
            "role": "technician",
            **fields,
        },
    )


async def _application(conn: AsyncConnection, **fields: Any) -> uuid.UUID:
    return await _insert(
        conn,
        "technician_applications",
        {
            "status": "pending",
            "full_name": "Tecnico Alfa",
            "email": f"ficha-{uuid.uuid4().hex[:6]}@exemplo.com",
            "phone": "(11) 99999-0000",
            "document": CPF,
            "city": "Cidade Exemplo",
            "state": "SP",
            "service_areas": [],
            "skills": [],
            "has_vehicle": False,
            "has_driver_license": False,
            "coverage_area": "Cidade Exemplo",
            "availability": [],
            "privacy_consent_at": NOW,
            "privacy_version": "2026-11-26",
            **fields,
        },
    )


async def _tool(conn: AsyncConnection, name: str, created_at: datetime, active: bool) -> str:
    tool_id = await _insert(
        conn,
        "tool_catalog",
        {"name": name, "is_active": active, "created_at": created_at, "updated_at": created_at},
    )
    return str(tool_id)


async def _json(conn: AsyncConnection, sql: str, **params: Any) -> Any:
    return json.loads((await conn.execute(text(sql), params)).scalar_one())


async def _ids_by(conn: AsyncConnection, sql: str) -> dict[str, str]:
    return {str(key): str(value) for key, value in (await conn.execute(text(sql))).all()}


@requires_db
async def test_data_steps_run_on_the_driver(engine: AsyncEngine) -> None:
    """Os passos de dados de verdade (asyncpg, como o alembic roda) sobre dados no formato de antes,
    numa transação desfeita no fim: catálogos, ferramentas repetidas, áreas e aptidões convertidas,
    o 1º uso e o carimbo; rodar de novo não muda nada; o ferramental aceita o NOT NULL e o índice
    único; e os passos do downgrade voltam nomes, códigos e carimbos, tiram os eventos de avaliação
    e os anexos internos do histórico."""
    async with engine.connect() as conn:
        transaction = await conn.begin()
        try:
            await conn.execute(
                text(
                    "ALTER TABLE tool_catalog DROP CONSTRAINT uq_tool_catalog_name_key,"
                    " ALTER COLUMN name_key DROP NOT NULL"
                )
            )
            jan = datetime(2026, 1, 1, tzinfo=UTC)
            meter = await _tool(conn, "Multímetro", jan, active=False)
            meter_dup = await _tool(conn, "multimetro", datetime(2026, 2, 1, tzinfo=UTC), True)
            ladder = await _tool(conn, "Escada", jan, active=True)
            tape = await _tool(conn, "Trena", jan, active=True)
            drill = await _tool(conn, "Furadeira", jan, active=True)
            skills_stamp = {"at": "2026-02-02T10:00:00+00:00", "via": "app"}
            alfa = await _user(
                conn,
                "Tecnico Alfa",
                created_at=datetime(2026, 3, 10, 15, 0, tzinfo=UTC),
                tool_ids=[meter_dup, drill, meter],
                service_areas=["redes", "cftv", "redes", "xyz-exemplo"],
                skills=[
                    {"name": "linux", "level": "avancado", "since": "2026-01-10"},
                    {"name": "Python Exemplo", "level": "expert"},
                    {"name": "LINUX", "level": "basico", "since": "2026-02-02"},
                ],
                tech_profile_stamps={"skills": skills_stamp},
            )
            beta = await _user(conn, "Tecnico Beta")
            gama = await _user(conn, "Tecnico Gama", service_areas="null", skills={"name": "x"})
            ficha_at = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
            ficha_alfa = await _application(
                conn,
                status="approved",
                user_id=alfa,
                created_at=ficha_at,
                reviewed_at=ficha_at,
                service_areas=["redes"],
                skills=[{"name": "Montagem de Rack", "level": "intermediario"}],
            )
            ficha_pending = await _application(
                conn,
                created_at=datetime(2026, 11, 20, 9, 0, tzinfo=UTC),
                service_areas=["automacao"],
                skills=[{"name": "Novo Exemplo", "level": "avancado"}],
            )
            await _insert(
                conn,
                "user_changes",
                {
                    "user_id": alfa,
                    "via": "app",
                    "changes": [
                        {"field": "tools", "from": None, "to": "Escada, Furadeira"},
                        {"field": "skills", "from": "Active Directory (Básico)", "to": None},
                    ],
                },
            )

            counts = await _on_driver(conn, *M.DATA_STEPS)
            # 10 áreas; 16 aptidões + "Python Exemplo" + "Novo Exemplo"; ferramental (reativa a
            # mantida, troca o id em alfa, apaga a repetida, 4 name_key); áreas de alfa e das 2
            # fichas; aptidões de alfa e das 2 fichas; 1º uso de 3 ferramentas, 4 áreas e 5
            # aptidões; o carimbo de alfa.
            assert counts == [10, 18, 7, 3, 3, 12, 1]

            # O ferramental aceita as regras de agora.
            await conn.execute(
                text(
                    "ALTER TABLE tool_catalog ALTER COLUMN name_key SET NOT NULL,"
                    " ADD CONSTRAINT uq_tool_catalog_name_key UNIQUE (name_key)"
                )
            )
            tools = {
                str(row["id"]): dict(row)
                for row in (
                    await conn.execute(
                        text(
                            "SELECT id, name_key, is_active, used_at IS NOT NULL AS used"
                            " FROM tool_catalog"
                        )
                    )
                ).mappings()
            }
            assert set(tools) == {meter, ladder, tape, drill}
            assert {key: (t["name_key"], t["used"]) for key, t in tools.items()} == {
                meter: ("multimetro", True),
                ladder: ("escada", True),
                tape: ("trena", False),
                drill: ("furadeira", True),
            }
            assert tools[meter]["is_active"] is True  # a repetida estava ativa

            areas = await _ids_by(conn, "SELECT code, id FROM area_catalog")
            assert len(areas) == 11
            assert set(areas) == {code for code, _ in M.DEFAULT_AREAS} | {"xyz-exemplo"}
            new_area = await _ids_by(
                conn, "SELECT name, is_active::text FROM area_catalog WHERE code = 'xyz-exemplo'"
            )
            assert new_area == {"xyz-exemplo": "true"}
            skills = await _ids_by(conn, "SELECT name, id FROM skill_catalog")
            assert set(skills) == {*M.DEFAULT_SKILLS, "Python Exemplo", "Novo Exemplo"}

            user_sql = "SELECT {} FROM users WHERE id = :id"
            assert await _json(conn, user_sql.format("tool_ids::text"), id=alfa) == [meter, drill]
            assert await _json(conn, user_sql.format("service_areas::text"), id=alfa) == [
                areas["redes"],
                areas["cftv"],
                areas["xyz-exemplo"],
            ]
            assert await _json(conn, user_sql.format("skills::text"), id=alfa) == [
                {"skill_id": skills["Linux"], "level": "avancado", "since": "2026-01-10"},
                {"skill_id": skills["Python Exemplo"], "level": "basico", "since": "2026-03-10"},
            ]
            assert await _json(conn, user_sql.format("tech_profile_stamps::text"), id=alfa) == {
                "skills": skills_stamp,
                "areas": {"at": ficha_at.isoformat(), "via": "ficha"},
            }
            # O que não é lista fica; quem não tem nada não ganha carimbo.
            assert await _json(conn, user_sql.format("service_areas::text"), id=gama) is None
            assert await _json(conn, user_sql.format("skills::text"), id=gama) == {"name": "x"}
            assert await _json(conn, user_sql.format("tech_profile_stamps::text"), id=beta) == {}
            ficha_sql = "SELECT {} FROM technician_applications WHERE id = :id"
            assert await _json(conn, ficha_sql.format("service_areas::text"), id=ficha_alfa) == [
                areas["redes"]
            ]
            assert await _json(conn, ficha_sql.format("skills::text"), id=ficha_alfa) == [
                {"skill_id": skills["Montagem de rack"], "level": "intermediario"}
            ]
            assert await _json(conn, ficha_sql.format("skills::text"), id=ficha_pending) == [
                {"skill_id": skills["Novo Exemplo"], "level": "avancado"}
            ]
            used_areas = await _ids_by(
                conn, "SELECT code, id FROM area_catalog WHERE used_at IS NOT NULL"
            )
            assert set(used_areas) == {"redes", "cftv", "xyz-exemplo", "automacao"}
            used_skills = await _ids_by(
                conn, "SELECT name, id FROM skill_catalog WHERE used_at IS NOT NULL"
            )
            assert set(used_skills) == {
                "Linux",
                "Python Exemplo",
                "Montagem de rack",
                "Novo Exemplo",
                "Active Directory",
            }

            # Rodar de novo não muda nada.
            assert await _on_driver(conn, *M.DATA_STEPS) == [0] * len(M.DATA_STEPS)

            # Downgrade: dados que só o código novo grava.
            ticket = await _insert(
                conn,
                "tickets",
                {
                    "title": "OS Exemplo",
                    "description": "",
                    "type": "incident",
                    "status": "resolved",
                    "impact": "medium",
                    "urgency": "medium",
                    "priority": "medium",
                    "source": "web",
                },
            )
            for event_type in ("rating_set", "rating_removed", "status_changed"):
                await _insert(
                    conn, "ticket_events", {"ticket_id": ticket, "event_type": event_type}
                )
            internal = {"field": "internal_attachments", "from": None, "to": "incluiu Anexo"}
            renamed = {"field": "name", "from": "Tecnico", "to": "Tecnico Alfa"}
            only_internal = await _insert(
                conn, "user_changes", {"user_id": alfa, "via": "central", "changes": [internal]}
            )
            mixed = await _insert(
                conn,
                "user_changes",
                {"user_id": alfa, "via": "central", "changes": [internal, renamed]},
            )
            # Uma área sem código (criada pela central), uma aptidão que saiu do catálogo e o
            # carimbo da central.
            no_code = await _insert(
                conn,
                "area_catalog",
                {"name": "Área Nova Exemplo", "name_key": "area nova exemplo"},
            )
            central_stamp = {"at": "2026-11-26T10:00:00+00:00", "via": "central"}
            await conn.execute(
                text(
                    "UPDATE users SET service_areas = service_areas || CAST(:area AS jsonb),"
                    " skills = skills || CAST(:skill AS jsonb),"
                    " tech_profile_stamps = tech_profile_stamps || CAST(:stamp AS jsonb)"
                    " WHERE id = :id"
                ),
                {
                    "id": alfa,
                    "area": json.dumps([str(no_code)]),
                    "skill": json.dumps(
                        [{"skill_id": _id(), "level": "basico", "since": "2026-11-26"}]
                    ),
                    "stamp": json.dumps({"skills": central_stamp}),
                },
            )

            back = await _on_driver(conn, *M.DOWNGRADE_STEPS)
            # 2 eventos; 2 linhas do histórico; aptidões e áreas de alfa e das 2 fichas; carimbos
            # de alfa.
            assert back == [2, 2, 3, 3, 1]
            events = (
                await conn.execute(
                    text("SELECT event_type FROM ticket_events WHERE ticket_id = :id"),
                    {"id": ticket},
                )
            ).scalars()
            assert list(events) == ["status_changed"]
            history = {
                row["id"]: json.loads(row["changes"])
                for row in (
                    await conn.execute(
                        text("SELECT id, changes::text AS changes FROM user_changes")
                    )
                ).mappings()
            }
            assert only_internal not in history
            assert history[mixed] == [renamed]
            assert await _json(conn, user_sql.format("skills::text"), id=alfa) == [
                {"name": "Linux", "level": "avancado", "since": "2026-01-10"},
                {"name": "Python Exemplo", "level": "basico", "since": "2026-03-10"},
            ]
            assert await _json(conn, user_sql.format("service_areas::text"), id=alfa) == [
                "redes",
                "cftv",
                "xyz-exemplo",
            ]
            assert await _json(conn, user_sql.format("tech_profile_stamps::text"), id=alfa) == {
                "skills": {**central_stamp, "via": "app"}
            }
            assert await _json(conn, ficha_sql.format("skills::text"), id=ficha_alfa) == [
                {"name": "Montagem de rack", "level": "intermediario"}
            ]
            assert await _json(conn, ficha_sql.format("service_areas::text"), id=ficha_pending) == [
                "automacao"
            ]
            # De novo: nada a mudar.
            assert await _on_driver(conn, *M.DOWNGRADE_STEPS) == [0] * len(M.DOWNGRADE_STEPS)
        finally:
            await transaction.rollback()


@pytest.mark.parametrize("name", ["Multímetro", "  Trena   laser ", "\ufb01bra", "\ufb03" * 80])
def test_tool_name_key_is_the_fold(name: str) -> None:
    """O modelo grava o name_key sozinho (o mesmo fold da migração, cortado no tamanho da coluna:
    80 ligaduras "ffi" dão 240 letras)."""
    from app.models import ServiceArea, Skill, TechnicianTool
    from app.models.catalog import NAME_KEY_MAX, name_key_of

    assert NAME_KEY_MAX == M.KEY_MAX
    for model in (TechnicianTool, ServiceArea, Skill):
        item = model(name=name)
        assert item.name_key == M.key_of(name) == name_key_of(name)
        assert len(item.name_key) <= NAME_KEY_MAX
        item.name = "Outro Exemplo"
        assert item.name_key == "outro exemplo"
