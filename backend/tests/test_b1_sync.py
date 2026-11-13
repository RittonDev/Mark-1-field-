"""Sincronização do app do técnico: lote robusto, idempotência, resposta enxuta, revogação e
paginação do pull."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.models import SyncOperation
from app.services import parts, sync
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


def op(ticket_id: str, kind: str, payload: dict, **extra: object) -> dict:
    return {
        "client_op_id": uuid.uuid4().hex,
        "type": kind,
        "ticket_id": ticket_id,
        "payload": payload,
        **extra,
    }


async def push(client: AsyncClient, headers: dict, *ops: dict) -> dict:
    r = await client.post(f"{API}/sync/push", json={"operations": list(ops)}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def test_bad_operation_does_not_block_the_batch(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    th = world.tech.headers
    t = await create(client, world, assignee_id=str(world.tech.user.id))
    res = await push(
        client,
        th,
        op(t["id"], "transition", {"to_status": "en_route"}),
        op(t["id"], "form_answers", {"answers": {"x": 1}}),  # sem form_id
        op(t["id"], "form_answers", {"form_id": str(uuid.uuid4()), "answers": {}}),
    )
    assert [r["status"] for r in res["results"]] == ["applied", "rejected", "rejected"]
    assert res["results"][1]["error"] == "Formulário inválido"
    assert res["results"][0]["ticket"]["status"] == "en_route"

    # Defeito inesperado numa operação: ela volta recusada (sem 500) e as outras seguem.
    async def boom(*_: object, **__: object) -> None:
        raise RuntimeError("falha inesperada")

    monkeypatch.setattr(parts, "create", boom)
    res = await push(
        client,
        th,
        op(t["id"], "part_request", {"description": "Fonte ATX"}),
        op(t["id"], "transition", {"to_status": "in_progress"}),
    )
    assert [r["status"] for r in res["results"]] == ["rejected", "applied"]
    assert res["results"][0]["error"] == sync.UNEXPECTED
    assert res["results"][1]["ticket"]["status"] == "in_progress"


async def test_operation_recorded_by_another_send_is_duplicate(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O primeiro envio (que o app abandonou) gravou a operação: o reenvio não aplica de novo."""
    t = await create(client, world, assignee_id=str(world.tech.user.id))
    client_op_id = "op-reenvio-0001"
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add(
            SyncOperation(
                user_id=world.tech.user.id,
                client_op_id=client_op_id,
                op_type="transition",
                ticket_id=uuid.UUID(t["id"]),
                status="applied",
            )
        )
        await db.commit()
    again = op(t["id"], "transition", {"to_status": "en_route"}, client_op_id=client_op_id)
    res = await push(client, world.tech.headers, again)
    assert res["results"][0]["status"] == "duplicate"
    assert res["results"][0]["ticket"]["status"] == "assigned"  # nada foi reaplicado


async def test_results_share_the_final_ticket(client: AsyncClient, world: World) -> None:
    t = await create(client, world, assignee_id=str(world.tech.user.id))
    res = await push(
        client,
        world.tech.headers,
        op(t["id"], "transition", {"to_status": "en_route"}),
        op(t["id"], "transition", {"to_status": "in_progress"}),
        op(t["id"], "comment", {"body": "não faz parte do app"}),
    )
    assert [r["status"] for r in res["results"]] == ["applied", "applied", "rejected"]
    versions = {r["ticket"]["version"] for r in res["results"]}
    statuses = {r["ticket"]["status"] for r in res["results"]}
    assert len(versions) == 1 and statuses == {"in_progress"}


async def test_change_already_done_by_the_office_is_applied(
    client: AsyncClient, world: World
) -> None:
    """O técnico esqueceu de iniciar, a central iniciou por ele; o que ele fez offline chega
    depois e não vira "recusado"."""
    t = await create(client, world, assignee_id=str(world.tech.user.id))
    await transition(client, world.analyst.headers, t, "in_progress")
    res = await push(
        client, world.tech.headers, op(t["id"], "transition", {"to_status": "in_progress"})
    )
    assert res["results"][0]["status"] == "applied"
    assert res["results"][0]["error"] is None
    events = (
        await client.get(f"{API}/tickets/{t['id']}/events", headers=world.analyst.headers)
    ).json()
    starts = [e for e in events if e["to_value"] == "in_progress"]
    assert len(starts) == 1  # nenhum evento repetido


async def test_offline_action_keeps_the_device_time_as_evidence(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    t = await create(client, world, assignee_id=str(world.tech.user.id))
    async with engine.begin() as conn:  # aberta de manhã
        await conn.execute(
            text("UPDATE tickets SET created_at = created_at - interval '3 hours' WHERE id = :i"),
            {"i": uuid.UUID(t["id"])},
        )
    pressed = datetime.now(UTC) - timedelta(minutes=90)
    res = await push(
        client,
        world.tech.headers,
        op(
            t["id"],
            "transition",
            {"to_status": "in_progress"},
            client_timestamp=pressed.isoformat(),
        ),
    )
    assert res["results"][0]["status"] == "applied"
    # O horário da OS é o do servidor; a hora do botão fica como evidência.
    arrived = datetime.fromisoformat(res["results"][0]["ticket"]["arrived_at"])
    assert datetime.now(UTC) - arrived < timedelta(minutes=5)
    events = (
        await client.get(f"{API}/tickets/{t['id']}/events", headers=world.analyst.headers)
    ).json()
    start = next(
        e for e in events if e["event_type"] == "status_changed" and e["to_value"] == "in_progress"
    )
    assert datetime.fromisoformat(start["data"]["declared_at"]) == pressed
    assert 5300 < start["data"]["sync_delay_s"] < 5500
    day = (await client.get(f"{API}/activities/day", headers=world.analyst.headers)).json()
    item = next(a for a in day["activities"] if a["ticket"]["id"] == t["id"])
    assert datetime.fromisoformat(item["arrived_declared_at"]) == pressed

    # Relógio do aparelho no futuro: ignorado.
    other = await create(client, world, title="Outra", assignee_id=str(world.tech.user.id))
    future = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    await push(
        client,
        world.tech.headers,
        op(other["id"], "transition", {"to_status": "en_route"}, client_timestamp=future),
    )
    events = (
        await client.get(f"{API}/tickets/{other['id']}/events", headers=world.analyst.headers)
    ).json()
    going = next(e for e in events if e["to_value"] == "en_route")
    assert "declared_at" not in (going["data"] or {})


async def test_pull_revokes_the_visit_the_helper_left(client: AsyncClient, world: World) -> None:
    helper = world.tech_other
    t = await create(
        client,
        world,
        assignee_id=str(world.tech.user.id),
        helper_ids=[str(helper.user.id)],
    )
    first = (await client.get(f"{API}/sync/pull", headers=helper.headers)).json()
    assert t["id"] in {x["id"] for x in first["tickets"]}
    current = (await client.get(f"{API}/tickets/{t['id']}", headers=world.analyst.headers)).json()
    r = await client.patch(
        f"{API}/tickets/{t['id']}",
        json={"helper_ids": [], "expected_version": current["version"]},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    delta = (
        await client.get(
            f"{API}/sync/pull", params={"since": first["server_time"]}, headers=helper.headers
        )
    ).json()
    assert t["id"] in delta["revoked_ticket_ids"]
    # O responsável continua com a OS.
    mine = (
        await client.get(
            f"{API}/sync/pull", params={"since": first["server_time"]}, headers=world.tech.headers
        )
    ).json()
    assert t["id"] not in mine["revoked_ticket_ids"]


async def test_pull_pages_through_a_mass_update(
    client: AsyncClient, world: World, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Mais OS com o mesmo updated_at do que cabe na página: o cursor avança mesmo assim."""
    monkeypatch.setattr(sync, "PULL_LIMIT", 2)
    ids = {
        (await create(client, world, title=f"Lote {n}", assignee_id=str(world.tech.user.id)))["id"]
        for n in range(3)
    }
    async with engine.begin() as conn:  # atualização em massa: o mesmo instante para todas
        await conn.execute(text("UPDATE tickets SET updated_at = now() - interval '1 hour'"))
    page = (await client.get(f"{API}/sync/pull", headers=world.tech.headers)).json()
    assert page["has_more"] is True
    assert {x["id"] for x in page["tickets"]} == ids
    rest = (
        await client.get(
            f"{API}/sync/pull", params={"since": page["server_time"]}, headers=world.tech.headers
        )
    ).json()
    assert rest["tickets"] == [] and rest["has_more"] is False
