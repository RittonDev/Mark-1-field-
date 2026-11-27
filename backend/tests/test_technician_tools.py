"""Ferramental dos técnicos e o perfil técnico na central.

GET/POST/PATCH/DELETE /technician-tools: a central inclui, renomeia, desativa e exclui o que nunca
foi usado (Configurações em Editar), com a regra dos catálogos de Configurações › Técnicos
(services/technician_catalogs.py; as Áreas de atuação e as Aptidões em
tests/test_technician_catalogs.py); o técnico lê só as ativas, sem a contagem. GET /technicians
traz o resumo do perfil técnico e filtra por ferramenta e por dia/turno; GET /technicians/{id} traz
o detalhe. O perfil vai direto nas colunas (quem grava pelo app é PATCH /me/profile, em
tests/test_tech_profile.py; pela central, em tests/test_central_tech_profile.py). Dados fictícios.
"""

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import ApplicationStatus, UserRole
from app.core.text import fold
from app.models import Skill, TechnicianApplication, TechnicianTool, User
from app.services import tech_profile, technician_catalogs
from tests.conftest import World, requires_db
from tests.test_access import restrict_analyst

pytestmark = requires_db

API = settings.API_PREFIX
TOOLS = f"{API}/technician-tools"
TAKEN = "Já existe uma ferramenta com este nome"


def _stamp(at: str, via: str = "app") -> dict[str, str]:
    return {"at": at, "via": via}


def _when(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


async def _set_profile(engine: AsyncEngine, user_id: uuid.UUID, **values: Any) -> None:
    """Grava colunas do perfil técnico direto no banco (o app grava por PATCH /me/profile)."""
    async with engine.begin() as conn:
        await conn.execute(update(User).where(User.id == user_id).values(**values))


def _issue(response: Any) -> dict:
    assert response.status_code == 422, response.text
    return response.json()["detail"][0]


# ------------------------------------------------------------------- catálogo


async def test_central_keeps_the_tool_catalog(
    client: AsyncClient, engine: AsyncEngine, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    an = world.analyst.headers
    # O analista sem Configurações (o padrão) lê o catálogo, mas não mexe nele.
    r = await client.post(TOOLS, json={"name": "Escada"}, headers=an)
    assert r.status_code == 403 and r.json()["code"] == "MODULE_FORBIDDEN"
    assert (await client.get(TOOLS, headers=an)).json() == []

    await restrict_analyst(client, world, **{"setup.settings": "edit"})
    created = {}
    for name in ("Escada", "  Multímetro   digital ", "Alicate de corte"):
        r = await client.post(TOOLS, json={"name": name}, headers=an)
        assert r.status_code == 201, r.text
        created[r.json()["name"]] = r.json()
    meter = created["Multímetro digital"]
    assert (meter["is_active"], meter["technicians"], meter["applications"]) == (True, 0, 0)
    assert meter["in_use"] is False
    ladder, pliers = created["Escada"]["id"], created["Alicate de corte"]["id"]
    async with engine.connect() as conn:
        key = await conn.scalar(
            select(TechnicianTool.name_key).where(TechnicianTool.id == uuid.UUID(meter["id"]))
        )
    assert key == "multimetro digital"

    # Nome: limpo, de 2 a 80; repetido sem acento e sem maiúsculas é recusado antes do banco.
    r = await client.post(TOOLS, json={"name": " a "}, headers=an)
    assert (r.status_code, r.json()["detail"]) == (422, "Informe o nome da ferramenta")
    issue = _issue(await client.post(TOOLS, json={"name": "x" * 81}, headers=an))
    assert (issue["msg"], issue["label"]) == ("No máximo 80 caracteres", "Nome")
    issue = _issue(await client.post(TOOLS, json={"name": "Trena", "ativa": 1}, headers=an))
    assert issue["msg"] == "Campo não aceito"
    for name in ("MULTIMETRO  digital", "Escada"):
        r = await client.post(TOOLS, json={"name": name}, headers=an)
        assert (r.status_code, r.json()) == (409, {"detail": TAKEN, "code": "CATALOG_NAME_TAKEN"})

    # Limite do catálogo (ativas e inativas).
    monkeypatch.setitem(technician_catalogs.MAX_ITEMS, "tool", 3)
    r = await client.post(TOOLS, json={"name": "Trena"}, headers=an)
    assert (r.status_code, r.json()["detail"]) == (422, "O catálogo aceita até 3 ferramentas")
    monkeypatch.undo()
    assert technician_catalogs.MAX_ITEMS["tool"] == 200
    r = await client.post(TOOLS, json={"name": "Trena"}, headers=an)
    assert r.status_code == 201, r.text
    tape = r.json()["id"]

    # Renomear (muda para todos), desativar e reativar; null não muda nada.
    r = await client.patch(f"{TOOLS}/{meter['id']}", json={"name": " Multímetro "}, headers=an)
    assert r.status_code == 200 and r.json()["name"] == "Multímetro"
    r = await client.patch(f"{TOOLS}/{meter['id']}", json={"name": "escada"}, headers=an)
    assert (r.status_code, r.json()["detail"]) == (409, TAKEN)
    r = await client.patch(f"{TOOLS}/{ladder}", json={"name": "ESCADA"}, headers=an)
    assert r.status_code == 200 and r.json()["name"] == "ESCADA"  # a própria não conta
    r = await client.patch(f"{TOOLS}/{ladder}", json={"name": "Escada"}, headers=an)
    assert r.status_code == 200
    r = await client.patch(f"{TOOLS}/{meter['id']}", json={"is_active": False}, headers=an)
    assert r.status_code == 200 and r.json()["is_active"] is False
    r = await client.patch(
        f"{TOOLS}/{meter['id']}", json={"name": None, "is_active": None}, headers=an
    )
    assert (r.json()["name"], r.json()["is_active"]) == ("Multímetro", False)
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                select(TechnicianTool.name, TechnicianTool.name_key, TechnicianTool.is_active).where(
                    TechnicianTool.id == uuid.UUID(meter["id"])
                )
            )
        ).one()
    assert tuple(row) == ("Multímetro", "multimetro", False)
    r = await client.patch(f"{TOOLS}/{ladder}", json={"name": "x"}, headers=an)
    assert (r.status_code, r.json()["detail"]) == (422, "Informe o nome da ferramenta")
    issue = _issue(await client.patch(f"{TOOLS}/{ladder}", json={"ordem": 1}, headers=an))
    assert issue["msg"] == "Campo não aceito"
    r = await client.patch(f"{TOOLS}/{uuid.uuid4()}", json={"is_active": True}, headers=an)
    assert (r.status_code, r.json()["detail"]) == (404, "Ferramenta não encontrada")

    # Contagem: técnicos (ativos ou não) que marcaram; quem não é técnico não conta.
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        retired = User(
            name="Tecnico Bravo",
            email="tecnico.bravo@exemplo.com",
            password_hash="x",
            role=UserRole.TECHNICIAN,
            is_active=False,
            tool_ids=[ladder],
        )
        db.add(retired)
        await db.commit()
    await _set_profile(engine, world.tech.user.id, tool_ids=sorted([ladder, meter["id"]]))
    await _set_profile(engine, world.tech_other.user.id, tool_ids=[ladder])
    await _set_profile(engine, world.supervisor.user.id, tool_ids=[ladder, pliers])

    r = await client.get(TOOLS, headers=an)
    assert r.status_code == 200, r.text
    rows = [(t["name"], t["is_active"], t["technicians"], t["applications"]) for t in r.json()]
    assert rows == [
        ("Alicate de corte", True, 0, 0),
        ("Escada", True, 3, 0),
        ("Multímetro", False, 1, 0),
        ("Trena", True, 0, 0),
    ]
    assert [t["in_use"] for t in r.json()] == [False, True, True, False]
    only_on = await client.get(TOOLS, params={"active": True}, headers=an)
    assert [t["name"] for t in only_on.json()] == ["Alicate de corte", "Escada", "Trena"]
    only_off = await client.get(TOOLS, params={"active": False}, headers=an)
    assert [t["name"] for t in only_off.json()] == ["Multímetro"]
    r = await client.patch(f"{TOOLS}/{meter['id']}", json={"is_active": True}, headers=an)
    assert (r.json()["is_active"], r.json()["technicians"]) == (True, 1)
    await client.patch(f"{TOOLS}/{meter['id']}", json={"is_active": False}, headers=an)

    # Excluir: só a nunca usada; a usada (Escada, com técnicos), desative.
    r = await client.delete(f"{TOOLS}/{ladder}", headers=an)
    assert (r.status_code, r.json()["code"]) == (409, "CATALOG_IN_USE")
    assert r.json()["detail"] == "Esta ferramenta já foi usada: desative para tirar das escolhas"
    r = await client.post(TOOLS, json={"name": "Lanterna"}, headers=an)
    lamp = r.json()["id"]
    assert (await client.delete(f"{TOOLS}/{lamp}", headers=an)).status_code == 204
    r = await client.delete(f"{TOOLS}/{lamp}", headers=an)
    assert (r.status_code, r.json()["detail"]) == (404, "Ferramenta não encontrada")

    # O técnico (o app) recebe só as ativas e sem a contagem; o `active` não vale para ele.
    th = world.tech.headers
    for params in ({}, {"active": False}):
        r = await client.get(TOOLS, params=params, headers=th)
        assert r.status_code == 200, r.text
        assert [(t["id"], t["name"], t["technicians"]) for t in r.json()] == [
            (pliers, "Alicate de corte", None),
            (ladder, "Escada", None),
            (tape, "Trena", None),
        ]
    assert (await client.post(TOOLS, json={"name": "Lanterna"}, headers=th)).status_code == 403
    r = await client.patch(f"{TOOLS}/{tape}", json={"is_active": False}, headers=th)
    assert r.status_code == 403
    # O cliente do portal não vê o catálogo.
    assert (await client.get(TOOLS, headers=world.requester.headers)).status_code == 403

    # Configurações só em Visualizar: lê (com a contagem), mas não inclui nem muda.
    await restrict_analyst(client, world, **{"setup.settings": "view"})
    r = await client.post(TOOLS, json={"name": "Lanterna"}, headers=an)
    assert r.status_code == 403 and r.json()["code"] == "MODULE_FORBIDDEN"
    r = await client.patch(f"{TOOLS}/{tape}", json={"is_active": False}, headers=an)
    assert r.status_code == 403 and r.json()["code"] == "MODULE_FORBIDDEN"
    r = await client.get(TOOLS, headers=an)
    assert r.status_code == 200 and len(r.json()) == 4
    assert {t["name"]: t["technicians"] for t in r.json()}["Escada"] == 3
    async with maker() as db:
        names = set(await db.scalars(select(TechnicianTool.name)))
    assert names == {"Alicate de corte", "Escada", "Multímetro", "Trena"}


async def test_tool_catalog_holds_when_two_arrive_together(
    client: AsyncClient, engine: AsyncEngine, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Dois pedidos ao mesmo tempo (dois analistas em Configurações): a trava do catálogo deixa um
    passar por vez, então o nome repetido em outra grafia e o limite valem também aí (sem ela, os
    dois liam o catálogo antes de gravar e os dois gravavam)."""
    await restrict_analyst(client, world, **{"setup.settings": "edit"})
    an = world.analyst.headers
    full = "O catálogo aceita até 3 ferramentas"

    async def post(name: str) -> tuple[int, str | None]:
        r = await client.post(TOOLS, json={"name": name}, headers=an)
        return r.status_code, r.json().get("detail")

    async def rename(tool_id: str, name: str) -> tuple[int, str | None]:
        r = await client.patch(f"{TOOLS}/{tool_id}", json={"name": name}, headers=an)
        return r.status_code, r.json().get("detail")

    async def catalog() -> dict[str, str]:
        """Nome -> id, lido do banco."""
        async with engine.connect() as conn:
            rows = await conn.execute(select(TechnicianTool.name, TechnicianTool.id))
            return {name: str(tool_id) for name, tool_id in rows}

    def same(name: str, names: dict[str, str]) -> list[str]:
        return [n for n in names if fold(n) == fold(name)]

    # Cadastro: a mesma ferramenta em duas grafias.
    both = await asyncio.gather(post("Multímetro"), post("multimetro"))
    assert sorted(both) == [(201, None), (409, TAKEN)]
    assert len(await catalog()) == 1

    # Limite: com 2 de 3 no catálogo, só um dos dois entra.
    assert (await post("Escada"))[0] == 201
    monkeypatch.setitem(technician_catalogs.MAX_ITEMS, "tool", 3)
    both = await asyncio.gather(post("Trena"), post("Alicate de corte"))
    assert sorted(both) == [(201, None), (422, full)]
    monkeypatch.undo()
    tools = await catalog()
    assert len(tools) == 3

    # Renomeação: duas ferramentas para o mesmo nome em grafias diferentes.
    meter, ladder = tools[same("Multímetro", tools)[0]], tools["Escada"]
    both = await asyncio.gather(rename(meter, "Lanterna"), rename(ladder, "LANTERNA"))
    assert sorted(both) == [(200, None), (409, TAKEN)]
    assert len(same("Lanterna", await catalog())) == 1

    # Cadastro e renomeação juntos: só um dos dois fica com o nome.
    third = next(i for n, i in tools.items() if n in ("Trena", "Alicate de corte"))
    created, renamed = await asyncio.gather(post("Fita isolante"), rename(third, "FITA ISOLANTE"))
    assert (created, renamed) in (((201, None), (409, TAKEN)), ((409, TAKEN), (200, None)))
    assert len(same("Fita isolante", await catalog())) == 1


# ---------------------------------------------------------- perfil técnico na central

SAT_MORNING_AT = "2026-11-18T09:30:00+00:00"
NEWEST_AT = "2026-11-19T14:02:11+00:00"


async def _seed_profiles(engine: AsyncEngine, world: World) -> dict[str, Any]:
    """Tecnico (tudo informado, uma ferramenta desativada guardada), Redes (ferramenta e sábado
    de manhã; ficha aprovada com aptidão que não é dele no perfil) e Tecnico Bravo (nada)."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        ladder = TechnicianTool(name="Escada", is_active=True)
        meter = TechnicianTool(name="Multímetro", is_active=True)
        pliers = TechnicianTool(name="Alicate de corte", is_active=False)
        bravo = User(
            name="Tecnico Bravo",
            email="tecnico.bravo@exemplo.com",
            password_hash="x",
            role=UserRole.TECHNICIAN,
            is_active=True,
        )
        db.add_all([ladder, meter, pliers, bravo])
        await db.flush()
        application = TechnicianApplication(
            status=ApplicationStatus.APPROVED,
            full_name="Redes Exemplo",
            email="redes@exemplo.com",
            phone="(11) 98888-7777",
            document="12345678909",
            city="Cidade Exemplo",
            state="SP",
            coverage_area="Cidade Exemplo",
            service_areas=["cftv"],
            skills=[{"name": "DVR/NVR Intelbras", "level": "avancado"}],
            privacy_consent_at=datetime(2026, 11, 1, tzinfo=UTC),
            privacy_version="2026-11-19.2",
            user_id=world.tech_other.user.id,
        )
        db.add(application)
        await db.commit()
    education_id = str(uuid.uuid4())
    await _set_profile(
        engine,
        world.tech.user.id,
        tool_ids=sorted(str(t.id) for t in (ladder, meter, pliers)),
        availability=["mon:morning", "sat:afternoon"],
        transport_modes=["car"],
        has_driver_license=True,
        skills=[
            {"name": "Linux", "level": "avancado", "since": "2026-11-12"},
            {"name": "Cabeamento estruturado", "level": "basico", "since": "2026-10-01"},
        ],
        education=[
            {
                "id": education_id,
                "course": "Técnico em redes",
                "level": "technical",
                "institution": "Escola Exemplo",
                "start": "2024-02",
                "end": None,
            }
        ],
        tech_profile_stamps={
            "tools": _stamp(NEWEST_AT),
            "availability": _stamp("2026-11-12T10:00:00+00:00", "ficha"),
            "transport": _stamp("2026-11-12T10:00:00+00:00", "ficha"),
            "skills": _stamp("2026-11-12T10:00:00+00:00", "ficha"),
            "education": _stamp("2026-11-15T08:00:00+00:00"),
        },
    )
    await _set_profile(
        engine,
        world.tech_other.user.id,
        tool_ids=[str(ladder.id)],
        availability=["sat:morning"],
        tech_profile_stamps={
            "tools": _stamp(SAT_MORNING_AT),
            "availability": _stamp(SAT_MORNING_AT),
        },
    )
    return {
        "ladder": str(ladder.id),
        "meter": str(meter.id),
        "pliers": str(pliers.id),
        "bravo": str(bravo.id),
        "application": str(application.id),
        "education": education_id,
    }


async def test_central_reads_the_tech_profile(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed_profiles(engine, world)
    an = world.analyst.headers
    tech, other, bravo = str(world.tech.user.id), str(world.tech_other.user.id), ids["bravo"]

    r = await client.get(f"{API}/technicians", headers=an)
    assert r.status_code == 200, r.text
    assert r.headers["x-total-count"] == "3"
    rows = {row["id"]: row for row in r.json()}

    # Lista: o resumo do perfil técnico; a ferramenta desativada fica guardada e não aparece.
    full = rows[tech]
    assert full["tool_ids"] == [ids["ladder"], ids["meter"]]  # Escada, Multímetro
    assert full["availability"] == ["mon:morning", "sat:afternoon"]
    assert full["transport"] == {"modes": ["car"], "driver_license": True}
    assert full["skills"] == [
        {"name": "Linux", "level": "avancado", "since": "2026-11-12"},
        {"name": "Cabeamento estruturado", "level": "basico", "since": "2026-10-01"},
    ]
    assert full["education_count"] == 1
    assert _when(full["tech_profile_updated_at"]) == datetime.fromisoformat(NEWEST_AT)
    assert (full["tools"], full["education"], full["tech_profile_updated"]) == (None, None, None)

    # As aptidões vêm do perfil técnico (não da ficha); áreas e link continuam da ficha.
    partial = rows[other]
    assert partial["skills"] == []
    assert (partial["service_areas"], partial["application_id"]) == (["cftv"], ids["application"])
    assert (partial["tool_ids"], partial["availability"]) == ([ids["ladder"]], ["sat:morning"])
    assert (partial["transport"], partial["education_count"]) == (None, 0)
    assert _when(partial["tech_profile_updated_at"]) == datetime.fromisoformat(SAT_MORNING_AT)

    empty = rows[bravo]
    assert (empty["tool_ids"], empty["availability"], empty["skills"]) == ([], [], [])
    assert (empty["transport"], empty["education_count"]) == (None, 0)
    assert empty["tech_profile_updated_at"] is None
    assert (empty["service_areas"], empty["application_id"]) == ([], None)

    # Detalhe: os nomes das ferramentas ativas (ordem alfabética), a formação e cada data.
    r = await client.get(f"{API}/technicians/{tech}", headers=an)
    assert r.status_code == 200, r.text
    one = r.json()
    assert one["tools"] == [
        {"id": ids["ladder"], "name": "Escada"},
        {"id": ids["meter"], "name": "Multímetro"},
    ]
    assert one["education"] == [
        {
            "id": ids["education"],
            "course": "Técnico em redes",
            "level": "technical",
            "institution": "Escola Exemplo",
            "start": "2024-02",
            "end": None,
        }
    ]
    stamps = one["tech_profile_updated"]
    assert {part: stamp["via"] for part, stamp in stamps.items()} == {
        "tools": "app",
        "availability": "ficha",
        "transport": "ficha",
        "skills": "ficha",
        "education": "app",
    }
    assert _when(stamps["tools"]["at"]) == datetime.fromisoformat(NEWEST_AT)
    assert one["skills"] == full["skills"] and one["education_count"] == 1
    r = await client.get(f"{API}/technicians/{bravo}", headers=an)
    nothing = r.json()
    assert (nothing["tools"], nothing["education"]) == ([], [])
    assert nothing["tech_profile_updated"] == dict.fromkeys(tech_profile.PARTS)

    # A central não edita o perfil técnico: a ficha ignora esses campos.
    r = await client.patch(
        f"{API}/technicians/{tech}",
        json={
            "skills": [{"name": "Windows", "level": "basico"}],
            "tool_ids": [],
            "availability": ["sun:night"],
            "transport": None,
            "education": [],
        },
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert r.json()["skills"] == full["skills"]
    assert [t["name"] for t in r.json()["tools"]] == ["Escada", "Multímetro"]
    assert r.json()["availability"] == full["availability"]
    async with engine.connect() as conn:
        stored = (
            await conn.execute(
                select(User.tool_ids, User.availability, User.skills, User.education).where(
                    User.id == world.tech.user.id
                )
            )
        ).one()
    assert len(stored.tool_ids) == 3 and stored.availability == ["mon:morning", "sat:afternoon"]
    assert [s["name"] for s in stored.skills] == ["Linux", "Cabeamento estruturado"]
    assert len(stored.education) == 1

    # Técnico novo pela central: o detalhe vem vazio, nunca informado.
    r = await client.post(
        f"{API}/technicians",
        json={"name": "Tecnico Charlie", "email": "tecnico.charlie@exemplo.com"},
        headers=an,
    )
    assert r.status_code == 201, r.text
    novo = r.json()["technician"]
    assert (novo["tools"], novo["education"], novo["tool_ids"], novo["transport"]) == (
        [],
        [],
        [],
        None,
    )
    assert novo["tech_profile_updated"] == dict.fromkeys(tech_profile.PARTS)

    # O técnico não vê a base.
    assert (await client.get(f"{API}/technicians", headers=world.tech.headers)).status_code == 403


async def test_central_filters_by_tool_and_availability(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed_profiles(engine, world)
    an = world.analyst.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)

    async def found(**params: Any) -> tuple[set[str], str]:
        r = await client.get(f"{API}/technicians", params=params, headers=an)
        assert r.status_code == 200, r.text
        return {row["id"] for row in r.json()}, r.headers["x-total-count"]

    # Ferramenta: quem marcou (a desativada ainda acha quem tinha, como num link antigo).
    assert await found(tool_id=ids["ladder"]) == ({tech, other}, "2")
    assert await found(tool_id=ids["meter"]) == ({tech}, "1")
    assert await found(tool_id=ids["pliers"]) == ({tech}, "1")
    assert await found(tool_id=str(uuid.uuid4())) == (set(), "0")

    # Dia (qualquer turno), turno (qualquer dia) e os dois; quem nunca informou não entra.
    assert await found(day="sat") == ({tech, other}, "2")
    assert await found(day="mon") == ({tech}, "1")
    assert await found(day="sun") == (set(), "0")
    assert await found(period="morning") == ({tech, other}, "2")
    assert await found(period="afternoon") == ({tech}, "1")
    assert await found(period="night") == (set(), "0")
    assert await found(day="sat", period="morning") == ({other}, "1")
    assert await found(day="sat", period="afternoon") == ({tech}, "1")
    assert await found(day="mon", period="afternoon") == (set(), "0")
    # Com os outros filtros e na página: o total é o dos filtros, não o da página.
    assert await found(day="sat", period="morning", tool_id=ids["ladder"]) == ({other}, "1")
    assert await found(day="sat", period="morning", tool_id=ids["meter"]) == (set(), "0")
    assert await found(period="morning", limit=1) == ({other}, "2")  # por nome: Redes, Tecnico
    assert await found(period="morning", q="Redes") == ({other}, "1")

    # Valores fora da lista.
    r = await client.get(f"{API}/technicians", params={"day": "sab"}, headers=an)
    issue = _issue(r)
    assert issue["loc"] == ["query", "day"]
    assert issue["msg"] == "Escolha uma das opções: mon, tue, wed, thu, fri, sat ou sun"
    assert issue.get("label") == "Dia"
    issue = _issue(
        await client.get(f"{API}/technicians", params={"period": "madrugada"}, headers=an)
    )
    assert issue["msg"] == "Escolha uma das opções: morning, afternoon, evening ou night"
    assert issue.get("label") == "Turno"
    issue = _issue(await client.get(f"{API}/technicians", params={"tool_id": "escada"}, headers=an))
    assert (issue["loc"], issue["msg"]) == (["query", "tool_id"], "Identificador inválido")
