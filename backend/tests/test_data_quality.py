"""Erros de dado que viram tela errada: técnico desativado com OS aberta e coordenada fora do
Brasil (latitude e longitude trocadas, ou o mesmo número nas duas)."""

from httpx import AsyncClient

from app.core.config import settings
from app.services import geo
from tests.conftest import World, requires_db
from tests.test_api import create

API = settings.API_PREFIX


@requires_db
async def test_open_ticket_with_inactive_technician_needs_attention(
    client: AsyncClient, world: World
) -> None:
    an, tech = world.analyst.headers, str(world.tech.user.id)
    body = {"title": "Impressora parada", "customer_id": world.customer_id, "assignee_id": tech}
    t = (await client.post(f"{API}/tickets", json=body, headers=an)).json()

    r = await client.patch(f"{API}/technicians/{tech}", json={"is_active": False}, headers=an)
    assert r.status_code == 200, r.text

    # A OS mostra que o técnico está inativo...
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert detail["assignee"]["is_active"] is False
    # ...e entra em "precisa de atenção" na fila do analista, com o motivo.
    queue = (await client.get(f"{API}/my-queue", headers=an)).json()
    item = next(i for i in queue["items"] if i["id"] == t["id"])
    assert item["section"] == "attention"
    assert any(r["code"] == "inactive_technician" for r in item["reasons"])
    team = (await client.get(f"{API}/queues", headers=an)).json()
    mine = next(q for q in team["queues"] if q["user"]["id"] == str(world.analyst.user.id))
    assert mine["attention"] >= 1


def test_coordinates_outside_brazil_are_ignored() -> None:
    assert geo.valid_coords(-23.5200406, -46.3486683)  # Poá-SP
    assert geo.valid_coords(-3.8547, -32.4245)  # Fernando de Noronha
    assert not geo.valid_coords(-46.3486683, -23.5200406)  # latitude e longitude trocadas
    assert not geo.valid_coords(-23.558418, -23.558418)  # o mesmo número nas duas
    assert not geo.valid_coords(40.7128, -74.006)  # fora do país
    assert not geo.valid_coords(-14.2350, -51.9253)  # centro do Brasil (ponto padrão)
