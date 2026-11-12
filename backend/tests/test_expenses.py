"""Custos extras: só a gestão lança e altera; o técnico vê; o solicitante não vê."""

from datetime import UTC, datetime, timedelta

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX


async def test_extra_costs(client: AsyncClient, world: World) -> None:
    an, th, sup = world.analyst.headers, world.tech.headers, world.supervisor.headers
    t = await create(client, world, title="Organizar rack", assignee_id=str(world.tech.user.id))
    url = f"{API}/tickets/{t['id']}/expenses"

    km = await client.post(
        url, json={"kind": "km", "description": "Ida e volta", "quantity": "42.5"}, headers=an
    )
    assert km.status_code == 201, km.text
    assert (km.json()["unit_value"], km.json()["total"]) == (1.2, 51.0)  # valor do km padrão
    assert km.json()["technician"]["id"] == str(world.tech.user.id)  # reembolsa o responsável

    velcro = {"kind": "material", "description": "Velcro 3m", "quantity": 2, "unit_value": "15.90"}
    assert (await client.post(url, json=velcro, headers=th)).status_code == 403  # técnico não lança
    mat = await client.post(url, json=velcro, headers=an)
    assert mat.json()["total"] == 31.8
    no_value = {"kind": "toll", "description": "Pedágio", "quantity": 1}
    assert (await client.post(url, json=no_value, headers=an)).status_code == 422

    # Técnico vê os custos da OS dele, sem poder mexer.
    assert [e["total"] for e in (await client.get(url, headers=th)).json()] == [51.0, 31.8]
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    assert len(detail["expenses"]) == 2
    eid = mat.json()["id"]
    assert (
        await client.patch(f"{API}/expenses/{eid}", json={"quantity": 3}, headers=th)
    ).status_code == 403
    assert (await client.delete(f"{API}/expenses/{eid}", headers=th)).status_code == 403
    r = await client.patch(
        f"{API}/expenses/{eid}", json={"quantity": 3, "status": "approved"}, headers=an
    )
    assert (r.json()["total"], r.json()["status"]) == (47.7, "approved")

    # Valor do km: supervisor/admin configuram.
    body = {"km_rate": "1.50"}
    assert (await client.put(f"{API}/settings/expenses", json=body, headers=an)).status_code == 403
    assert (await client.put(f"{API}/settings/expenses", json=body, headers=sup)).json() == {
        "km_rate": 1.5
    }
    km2 = await client.post(
        url, json={"kind": "km", "description": "Volta", "quantity": 10}, headers=an
    )
    assert km2.json()["total"] == 15.0

    # Relatório de reembolso no período.
    now = datetime.now(UTC)
    params = {
        "start": (now - timedelta(hours=1)).isoformat(),
        "end": (now + timedelta(hours=1)).isoformat(),
    }
    rep = (await client.get(f"{API}/expenses", params=params, headers=an)).json()
    assert rep["total"] == 113.7
    tech_row = rep["by_technician"][0]
    assert (tech_row["technician"]["id"], tech_row["count"], tech_row["to_pay"]) == (
        str(world.tech.user.id),
        3,
        47.7,
    )
    assert rep["items"][0]["ticket"]["code"] == t["code"]
    paid = await client.post(f"{API}/expenses/mark-paid", json={"ids": [eid]}, headers=an)
    assert paid.json() == {"updated": 1}
    pending = (
        await client.get(f"{API}/expenses", params={**params, "status": "paid"}, headers=an)
    ).json()
    assert [i["id"] for i in pending["items"]] == [eid]


async def test_requester_never_sees_costs(client: AsyncClient, world: World) -> None:
    r = await client.post(
        f"{API}/tickets",
        json={"title": "Impressora sem toner", "description": "Sala 3"},
        headers=world.requester.headers,
    )
    tid = r.json()["id"]
    await client.post(
        f"{API}/tickets/{tid}/expenses",
        json={"kind": "material", "description": "Toner", "quantity": 1, "unit_value": 300},
        headers=world.analyst.headers,
    )
    rh = world.requester.headers
    assert (await client.get(f"{API}/tickets/{tid}", headers=rh)).json()["expenses"] == []
    assert (await client.get(f"{API}/tickets/{tid}/expenses", headers=rh)).json() == []
    events = (await client.get(f"{API}/tickets/{tid}/events", headers=rh)).json()
    assert not any(e["event_type"].startswith("expense") for e in events)
