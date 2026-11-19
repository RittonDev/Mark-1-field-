"""Ids nos eventos guardados pelo nome: o técnico das atribuições importadas do Field Control (a
busca "técnico que atuou" não perde a OS quando ele troca o nome) e o modelo dos formulários
tirados da OS antes dos formulários automáticos (a remoção conta como decisão de uma pessoa). A
importação grava o id do técnico; a migração e4b6d8f0a2c3 preenche os eventos antigos. Dados
fictícios."""

import importlib.util
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import TicketEventType, UserRole
from app.importers.fieldcontrol import Importer, Report
from app.models import TicketEvent, User
from tests.conftest import World, requires_db
from tests.test_api import create
from tests.test_forms_auto import FIELDS, service_type, template

API = settings.API_PREFIX
MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "20261119_e4b6d8f0a2c3_tecnico_e_modelo_nos_eventos_antigos.py"
)


def _migration_sql(name: str) -> str:
    spec = importlib.util.spec_from_file_location("eventos_antigos", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, name)


async def _run(engine: AsyncEngine, sql: str) -> int:
    async with engine.begin() as conn:
        return (await conn.execute(text(sql))).rowcount


async def _fc_assigned(engine: AsyncEngine, ticket_id: str, name: str, **data: Any) -> uuid.UUID:
    """Atribuição como a importação do Field Control grava: o nome em to_value."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        ev = TicketEvent(
            ticket_id=uuid.UUID(ticket_id),
            actor_id=None,
            event_type=TicketEventType.ASSIGNED,
            to_value=name[:64],
            data={"source": "fieldcontrol", "task": "t-1", **data},
        )
        db.add(ev)
        await db.commit()
        return ev.id


async def _data(engine: AsyncEngine, event_id: uuid.UUID) -> dict[str, Any]:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        return await db.scalar(select(TicketEvent.data).where(TicketEvent.id == event_id))


async def _found(client: AsyncClient, world: World, tech_id: str, ticket_id: str) -> bool:
    r = await client.get(
        f"{API}/tickets", params={"technician_id": tech_id}, headers=world.supervisor.headers
    )
    assert r.status_code == 200, r.text
    return ticket_id in {item["id"] for item in r.json()["items"]}


@requires_db
async def test_fc_ticket_stays_with_the_technician_after_a_rename(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    tech_id, other_id = str(world.tech.user.id), str(world.tech_other.user.id)
    t = await create(client, world, title="OS migrada")
    await _fc_assigned(engine, t["id"], world.tech.user.name, technician_id=tech_id)
    assert await _found(client, world, tech_id, t["id"])

    # O técnico troca o nome no app (Meu cadastro) e a central troca de novo (Técnicos).
    r = await client.patch(
        f"{API}/me/profile", json={"name": "Tecnico Alfa"}, headers=world.tech.headers
    )
    assert r.status_code == 200, r.text
    assert await _found(client, world, tech_id, t["id"])
    r = await client.patch(
        f"{API}/technicians/{tech_id}",
        json={"name": "Tecnico Alfa Silva"},
        headers=world.admin.headers,
    )
    assert r.status_code == 200, r.text
    assert await _found(client, world, tech_id, t["id"])

    # Sem o id (nome repetido ou sem cadastro na importação), vale o nome atual.
    by_name = await create(client, world, title="OS migrada sem o id")
    await _fc_assigned(engine, by_name["id"], "Tecnico Alfa Silva")
    assert await _found(client, world, tech_id, by_name["id"])
    # Com o id de outro técnico, o mesmo nome não conta (homônimo).
    namesake = await create(client, world, title="OS do homônimo")
    await _fc_assigned(engine, namesake["id"], "Tecnico Alfa Silva", technician_id=other_id)
    assert not await _found(client, world, tech_id, namesake["id"])
    assert await _found(client, world, other_id, namesake["id"])


def test_import_records_the_technician_id_on_the_assignment() -> None:
    tech = uuid.uuid4()
    now = datetime(2026, 11, 12, tzinfo=UTC)
    importer = Importer(None, Path("."), Report(), 120, now)  # type: ignore[arg-type]
    importer.refs["user"]["1"] = tech

    def task(employee: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": f"t-{uuid.uuid4().hex[:6]}",
            "status": "scheduled",
            "position": 0,
            "createdAt": "2026-11-01T10:00:00Z",
            "employee": employee,
            "scheduling": {"date": "2026-11-20", "time": "09:00:00"},
        }

    order = {
        "id": "o-1",
        "identifier": "100",
        "status": "pending",
        "createdAt": "2026-11-01T09:00:00Z",
        "updatedAt": "2026-11-01T09:30:00Z",
        "service": {"id": 1, "description": "Manutenção preventiva", "duration": 60},
        "tasks": [
            task({"id": 99, "_id": "emp-99", "name": "Tecnico Beta"}),  # não veio no export
            task({"id": 1, "_id": "emp-1", "name": "Tecnico Alfa"}),
        ],
        "deadline": None,
    }
    _, children = importer.build_ticket(order, {})
    assigned = [e for e in children["events"] if e["event_type"] == TicketEventType.ASSIGNED]
    assert [(e["to_value"], e["data"].get("technician_id")) for e in assigned] == [
        ("Tecnico Beta", None),
        ("Tecnico Alfa", str(tech)),
    ]
    assert all(e["data"]["source"] == "fieldcontrol" for e in assigned)


async def _user(engine: AsyncEngine, name: str, role: UserRole) -> uuid.UUID:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = User(
            name=name,
            email=f"{uuid.uuid4().hex[:10]}@exemplo.com",
            password_hash="x",
            role=role,
            is_active=True,
        )
        db.add(user)
        await db.commit()
        return user.id


@requires_db
async def test_migration_fills_the_technician_of_fc_assignments(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    long_name = "Tecnico Gama " + "de Souza " * 8  # mais de 64 letras: to_value guarda cortado
    long_id = await _user(engine, long_name.strip(), UserRole.TECHNICIAN)
    await _user(engine, "Tecnico Duplo", UserRole.TECHNICIAN)
    await _user(engine, " tecnico duplo", UserRole.TECHNICIAN)
    await _user(engine, "Analista Campo", UserRole.ANALYST)
    t = await create(client, world, title="OS migrada")
    tid, tech_id = t["id"], str(world.tech.user.id)

    unique = await _fc_assigned(engine, tid, "  TECNICO ")  # o nome do técnico, outra caixa
    cut = await _fc_assigned(engine, tid, long_name.strip())
    repeated = await _fc_assigned(engine, tid, "Tecnico Duplo")
    unknown = await _fc_assigned(engine, tid, "Tecnico Sem Cadastro")
    office = await _fc_assigned(engine, tid, "Analista Campo")  # não é técnico
    kept = await _fc_assigned(engine, tid, "Tecnico", technician_id=str(world.tech_other.user.id))
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        here = TicketEvent(
            ticket_id=uuid.UUID(tid),
            event_type=TicketEventType.ASSIGNED,
            to_value="Tecnico",
            data={"to_name": "Tecnico"},
        )
        db.add(here)
        await db.commit()

    sql = _migration_sql("FC_TECHNICIANS")
    assert await _run(engine, sql) == 2
    assert (await _data(engine, unique))["technician_id"] == tech_id
    assert (await _data(engine, cut))["technician_id"] == str(long_id)
    for event_id in (repeated, unknown, office):
        assert "technician_id" not in await _data(engine, event_id)
    assert (await _data(engine, kept))["technician_id"] == str(world.tech_other.user.id)
    assert await _data(engine, here.id) == {"to_name": "Tecnico"}
    assert await _run(engine, sql) == 0  # de novo, nada muda

    # Com o id gravado, a OS fica com o técnico mesmo depois de ele trocar o nome.
    r = await client.patch(
        f"{API}/me/profile", json={"name": "Tecnico Novo Nome"}, headers=world.tech.headers
    )
    assert r.status_code == 200, r.text
    assert await _found(client, world, tech_id, tid)


@requires_db
async def test_migration_fills_the_template_of_old_removals(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    kind = await service_type(client, world, "Preventiva")
    x = await template(client, world, "Checklist X")
    long = await template(client, world, "Checklist " + "de rede " * 9)  # mais de 64 letras
    await template(client, world, "Checklist Duplo")
    await template(client, world, "checklist duplo ")
    twin = await template(client, world, "Checklist Duplo 2")
    tickets: dict[str, str] = {}
    for key, tpl in (("x", x), ("long", long), ("twin", twin), ("fresh", x)):
        t = await create(client, world, title=f"OS {key}", service_type_id=kind["id"])
        tickets[key] = t["id"]
        r = await client.post(
            f"{API}/tickets/{t['id']}/forms", json={"template_id": tpl["id"]}, headers=an
        )
        assert r.status_code == 201, r.text
        r = await client.delete(f"{API}/tickets/{t['id']}/forms/{r.json()['id']}", headers=an)
        assert r.status_code == 204
    async with engine.begin() as conn:
        # Como o remove_from_ticket de antes da subida gravava: só form_id. A "twin" ficou com o
        # nome de dois modelos (sem casamento único).
        await conn.execute(
            text(
                "UPDATE ticket_events SET data = data - 'template_id' "
                "WHERE event_type = 'form_removed' AND ticket_id = ANY(:ids)"
            ),
            {"ids": [uuid.UUID(tickets[k]) for k in ("x", "long", "twin")]},
        )
        await conn.execute(
            text(
                "UPDATE ticket_events SET from_value = 'Checklist Duplo' "
                "WHERE event_type = 'form_removed' AND ticket_id = :id"
            ),
            {"id": uuid.UUID(tickets["twin"])},
        )
        rows = await conn.execute(
            text(
                "SELECT ticket_id, id FROM ticket_events WHERE event_type = 'form_removed' "
                "AND ticket_id = ANY(:ids)"
            ),
            {"ids": [uuid.UUID(v) for v in tickets.values()]},
        )
        removed: dict[str, uuid.UUID] = {str(tid): event_id for tid, event_id in rows}

    assert await _run(engine, _migration_sql("REMOVED_FORMS")) == 2
    got = {k: (await _data(engine, removed[tid])).get("template_id") for k, tid in tickets.items()}
    assert got == {"x": x["id"], "long": long["id"], "twin": None, "fresh": x["id"]}

    # Ligando X ao tipo com "Levar também", ele não volta para as OS de onde uma pessoa o tirou,
    # nem a antiga.
    body = {"name": "Checklist X", "fields": FIELDS, "service_type_ids": [kind["id"]]}
    r = await client.put(
        f"{API}/form-templates/{x['id']}",
        params={"apply_to_pending": True},
        json={**body, "requires_signature": False},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert r.json()["attached_to"] == 2  # só as OS "long" e "twin", de onde X não saiu
    for key in ("x", "fresh"):
        detail = (await client.get(f"{API}/tickets/{tickets[key]}", headers=an)).json()
        assert detail["forms"] == []
