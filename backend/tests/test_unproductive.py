"""Visita improdutiva: o técnico foi e não atendeu; a OS volta para reagendar, com o motivo."""

import uuid

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


async def test_unproductive_visit(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    body = {"name": "Cliente ausente", "responsibility": "customer"}
    assert (
        await client.post(f"{API}/unproductive-reasons", json=body, headers=th)
    ).status_code == 403
    reason = (await client.post(f"{API}/unproductive-reasons", json=body, headers=an)).json()
    # O app do técnico lista os motivos.
    assert [
        r["name"] for r in (await client.get(f"{API}/unproductive-reasons", headers=th)).json()
    ] == ["Cliente ausente"]

    t = await create(
        client,
        world,
        title="Câmera sem imagem",
        assignee_id=str(world.tech.user.id),
        scheduled_start="2030-01-10T13:00:00+00:00",
    )
    t = await transition(client, th, t, "en_route")
    t = await transition(client, th, t, "in_progress")
    r = await client.post(
        f"{API}/tickets/{t['id']}/unproductive",
        json={
            "reason_id": reason["id"],
            "note": "Loja fechada para inventário",
            "latitude": -23.6,
            "longitude": -46.7,
            "expected_version": t["version"],
        },
        headers=th,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert (d["status"], d["scheduled_start"], d["unproductive_count"]) == ("assigned", None, 1)
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    visit = next(e for e in events if e["event_type"] == "unproductive_visit")
    assert visit["to_value"] == "Cliente ausente" and visit["data"]["latitude"] == -23.6
    assert visit["data"]["previous_schedule"].startswith("2030-01-10")

    # Outro técnico não registra na OS que não é dele; OS concluída não tem visita improdutiva.
    other = await client.post(
        f"{API}/tickets/{t['id']}/unproductive",
        json={"reason_id": reason["id"]},
        headers=world.tech_other.headers,
    )
    assert other.status_code == 404

    # Offline: a mesma ação chega pelo sync.
    t2 = await create(client, world, title="Rede", assignee_id=str(world.tech.user.id))
    t2 = await transition(client, th, t2, "en_route")
    op = {
        "client_op_id": uuid.uuid4().hex,
        "type": "unproductive",
        "ticket_id": t2["id"],
        "payload": {"reason_id": reason["id"], "expected_version": t2["version"]},
    }
    res = (await client.post(f"{API}/sync/push", json={"operations": [op]}, headers=th)).json()
    assert res["results"][0]["status"] == "applied", res
    assert res["results"][0]["ticket"]["unproductive_count"] == 1
