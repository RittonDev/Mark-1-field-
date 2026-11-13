"""Reabrir OS fechada ou cancelada: só a central, com motivo, a qualquer momento."""

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


async def test_office_reopens_a_closed_os(client: AsyncClient, world: World) -> None:
    an, th, sup = world.analyst.headers, world.tech.headers, world.supervisor.headers
    t = await create(client, world, title="Nobreak apitando", assignee_id=str(world.tech.user.id))
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Bateria trocada")
    t = await transition(client, sup, t, "closed")
    assert t["closed_at"] and t["resolved_at"]

    office = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert office["allowed_transitions"] == ["reopened"]

    # O técnico e o solicitante não reabrem; sem motivo, nem a central.
    url = f"{API}/tickets/{t['id']}/transition"
    body = {"to_status": "reopened", "note": "Voltou a apitar", "expected_version": t["version"]}
    assert (await client.post(url, json=body, headers=th)).status_code == 403
    by_requester = await client.post(url, json=body, headers=world.requester.headers)
    assert by_requester.status_code in (403, 404)
    assert (await client.post(url, json={**body, "note": " "}, headers=an)).status_code == 422

    t = await transition(client, an, office, "reopened", note="Voltou a apitar")
    assert t["status"] == "reopened"
    assert t["closed_at"] is None and t["resolved_at"] is None
    assert t["reopen_count"] == 1
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    reopen = next(
        e for e in events if e["event_type"] == "status_changed" and e["to_value"] == "reopened"
    )
    assert (reopen["from_value"], reopen["note"]) == ("closed", "Voltou a apitar")
    assert reopen["actor"]["id"] == str(world.analyst.user.id)

    # Volta ao fluxo normal: o técnico atende de novo e a central fecha outra vez.
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Nobreak trocado")
    t = await transition(client, sup, t, "closed")
    assert t["status"] == "closed" and t["closed_at"] and t["reopen_count"] == 1
    assert t["resolution_notes"] == "Nobreak trocado"


async def test_office_reopens_a_cancelled_os(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Cancelada por engano")
    t = await transition(client, an, t, "cancelled", note="Achei que era duplicada")
    assert t["cancelled_at"]
    assert t["allowed_transitions"] == ["reopened"]

    t = await transition(client, an, t, "reopened", note="Não era duplicada")
    assert t["status"] == "reopened" and t["cancelled_at"] is None
    assert t["reopen_count"] == 1

    # Segue como qualquer OS na fila: ao receber o técnico, fica atribuída.
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": str(world.tech.user.id), "expected_version": t["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "assigned"
