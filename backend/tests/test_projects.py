"""Projetos: OS marcadas como de projeto, com valor, equipe e o acompanhamento financeiro."""

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


async def test_project_tracking(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    body = {
        "name": "Recabeamento lojas Zona Sul",
        "customer_id": world.customer_id,
        "contract_value": "12000",
        "pricing_notes": "R$ 400 por loja",
        "team_id": world.team_field_id,
        "member_ids": [str(world.tech.user.id)],
        "start_date": "2026-11-01",
        "end_date": "2026-10-01",
    }
    assert (await client.post(f"{API}/projects", json=body, headers=an)).status_code == 422
    body["end_date"] = "2026-12-20"
    assert (await client.post(f"{API}/projects", json=body, headers=th)).status_code == 403
    p = (await client.post(f"{API}/projects", json=body, headers=an)).json()
    assert p["code"].startswith("PRJ-") and p["members"][0]["name"] == "Tecnico"

    # Só a gestão vincula OS ao projeto.
    t1 = await create(client, world, title="Loja 1", project_id=p["id"], assignee_id=str(world.tech.user.id))
    assert t1["project"]["name"] == "Recabeamento lojas Zona Sul"
    t2 = await create(client, world, title="Loja 2")
    r = await client.patch(f"{API}/tickets/{t2['id']}", json={"project_id": p["id"]}, headers=an)
    assert r.json()["project"]["id"] == p["id"]
    await create(client, world, title="Avulsa")  # fora do projeto

    t1 = await transition(client, th, t1, "en_route")
    t1 = await transition(client, th, t1, "in_progress")
    await transition(client, th, t1, "resolved", resolution_notes="ok")
    await client.post(
        f"{API}/tickets/{t1['id']}/expenses",
        json={"kind": "material", "description": "Cabo", "quantity": 1, "unit_value": "350"},
        headers=an,
    )

    p = (await client.get(f"{API}/projects/{p['id']}", headers=an)).json()
    s = p["stats"]
    assert (s["tickets_total"], s["tickets_done"], s["tickets_open"], s["progress"]) == (2, 1, 1, 0.5)
    assert (s["expenses_total"], p["margin"]) == (350.0, 11650.0)
    listed = (await client.get(f"{API}/tickets", params={"project_id": p["id"]}, headers=an)).json()
    assert {i["title"] for i in listed["items"]} == {"Loja 1", "Loja 2"}
