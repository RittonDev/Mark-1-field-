"""Custos extras: reembolsado não muda de valor nem é excluído (volta para aprovado antes), a
situação segue o fluxo e o reembolso chega ao app do técnico (a OS muda e o histórico registra)."""

from datetime import datetime

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX
CABLE = {"kind": "material", "description": "Cabo de rede", "quantity": 2, "unit_value": "15.50"}


async def test_reimbursed_cost_is_locked_until_reversed(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Troca de cabo", assignee_id=str(world.tech.user.id))
    url = f"{API}/tickets/{t['id']}/expenses"
    r = await client.post(url, json={**CABLE, "status": "approved"}, headers=an)
    assert r.status_code == 201, r.text
    eid = r.json()["id"]
    before = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()["updated_at"]

    paid = await client.post(f"{API}/expenses/mark-paid", json={"ids": [eid]}, headers=an)
    assert paid.json() == {"updated": 1}
    # A OS muda (o app do técnico baixa de novo e passa a ver "Reembolsado") e o histórico guarda.
    after = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()["updated_at"]
    assert datetime.fromisoformat(after) > datetime.fromisoformat(before)
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    assert any(
        e["event_type"] == "expense_updated" and e["data"]["status"] == "paid" for e in events
    )
    assert [e["status"] for e in (await client.get(url, headers=th)).json()] == ["paid"]

    edit = f"{API}/expenses/{eid}"
    r = await client.patch(edit, json={"quantity": 3}, headers=an)
    assert r.status_code == 422
    assert r.json()["detail"] == "Custo já reembolsado: volte para Aprovado antes de alterar"
    assert (await client.delete(edit, headers=an)).status_code == 422
    # A observação pode ser corrigida sem desfazer o reembolso.
    r = await client.patch(edit, json={"notes": "Nota fiscal 123"}, headers=an)
    assert (r.status_code, r.json()["status"]) == (200, "paid")
    # Estorno: volta para aprovado (sem a data do reembolso) e aí pode mudar.
    r = await client.patch(edit, json={"status": "approved"}, headers=an)
    assert (r.json()["status"], r.json()["paid_at"]) == ("approved", None)
    r = await client.patch(edit, json={"quantity": 3}, headers=an)
    assert (r.status_code, r.json()["total"]) == (200, 46.5)


async def test_status_follows_the_flow_and_refunds_go_to_the_team(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Visita")
    url = f"{API}/tickets/{t['id']}/expenses"
    pending = (await client.post(url, json=CABLE, headers=an)).json()
    r = await client.patch(f"{API}/expenses/{pending['id']}", json={"status": "paid"}, headers=an)
    assert r.status_code == 422
    assert r.json()["detail"] == "Só custo aprovado pode ser marcado como reembolsado"

    approved = (await client.post(url, json={**CABLE, "status": "approved"}, headers=an)).json()
    await client.post(f"{API}/expenses/mark-paid", json={"ids": [approved["id"]]}, headers=an)
    back = {"status": "pending"}
    r = await client.patch(f"{API}/expenses/{approved['id']}", json=back, headers=an)
    assert r.status_code == 422
    assert r.json()["detail"] == "Custo reembolsado só volta para Aprovado (estorno)"

    # Reembolso é para alguém da equipe, nunca para um usuário do cliente.
    r = await client.post(
        url,
        json={**CABLE, "technician_id": str(world.requester.user.id)},
        headers=an,
    )
    assert r.status_code == 422
