"""Portal do cliente: abre e acompanha as solicitações da empresa dele, e só dela."""

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX

# O que o cliente pode ver: nada de etiquetas, analista, SLA, custos ou valores do técnico.
ALLOWED = {
    "id",
    "code",
    "title",
    "status",
    "location",
    "requester_name",
    "created_at",
    "updated_at",
    "scheduled_start",
    "scheduled_end",
    "technician",
    "arrived_at",
    "resolved_at",
    "cancelled_at",
    "description",
    "client_reference",
    "contact",
    "resolution_notes",
    "report_url",
    "can_cancel",
    "timeline",
}


async def _other_company(client: AsyncClient, world: World) -> tuple[str, str, dict]:
    """Outra empresa com uma loja e um usuário do cliente dela."""
    sup, admin = world.supervisor.headers, world.admin.headers
    customer = (
        await client.post(f"{API}/customers", json={"name": "Outra Rede"}, headers=sup)
    ).json()
    location = (
        await client.post(
            f"{API}/customers/{customer['id']}/locations",
            json={"name": "Loja Centro", "city": "Santos", "state": "SP"},
            headers=sup,
        )
    ).json()
    r = await client.post(
        f"{API}/users",
        json={
            "name": "Gerente Outra",
            "email": "gerente@outrarede.com.br",
            "password": "senha-teste-123",
            "role": "requester",
            "customer_id": customer["id"],
        },
        headers=admin,
    )
    assert r.status_code == 201, r.text
    assert r.json()["customer"]["name"] == "Outra Rede"
    login = await client.post(
        f"{API}/auth/login",
        json={"email": "gerente@outrarede.com.br", "password": "senha-teste-123", "channel": "web"},
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return customer["id"], location["id"], headers


async def test_client_opens_and_follows_requests(client: AsyncClient, world: World) -> None:
    req, an = world.requester.headers, world.analyst.headers
    me = (await client.get(f"{API}/portal/me", headers=req)).json()
    assert me == {
        "customer": {"id": world.customer_id, "name": "Cliente Teste"},
        "locations": 1,
        "can_open_requests": True,
    }
    stores = (await client.get(f"{API}/portal/locations", headers=req)).json()
    assert [s["name"] for s in stores] == ["Matriz"]

    before = (await client.get(f"{API}/portal/inbox-count", headers=an)).json()["pending"]
    r = await client.post(
        f"{API}/portal/requests",
        json={
            "location_id": world.location_id,
            "title": "PDV 2 sem rede",
            "description": "Desde a abertura da loja",
            "urgency": "high",
            "contact": "Ana (gerente) 11 99999-0000",
            "client_reference": "INC-778",
        },
        headers=req,
    )
    assert r.status_code == 201, r.text
    opened = r.json()
    assert set(opened) == ALLOWED
    assert opened["status"] == "new" and opened["can_cancel"] is True
    assert opened["location"]["name"] == "Matriz"
    assert opened["contact"] == "Ana (gerente) 11 99999-0000"
    assert [e["status"] for e in opened["timeline"]] == ["created"]

    # A central recebe como OS do portal, sem analista, e o contador do menu sobe.
    internal = (await client.get(f"{API}/tickets/{opened['id']}", headers=an)).json()
    assert internal["source"] == "portal"
    assert internal["requester"]["id"] == str(world.requester.user.id)
    assert internal["customer"]["id"] == world.customer_id
    assert internal["owner"] is None and internal["assignee"] is None
    assert internal["urgency"] == "high"
    after = (await client.get(f"{API}/portal/inbox-count", headers=an)).json()["pending"]
    assert after == before + 1

    # A central atende: o cliente acompanha o técnico, a visita e o relatório final.
    t = internal
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": str(world.tech.user.id), "expected_version": t["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    followed = (await client.get(f"{API}/portal/requests/{t['id']}", headers=req)).json()
    assert followed["technician"] == world.tech.user.name
    assert followed["can_cancel"] is False
    t = await transition(client, world.tech.headers, r.json(), "in_progress")
    t = await transition(client, world.tech.headers, t, "resolved", resolution_notes="Cabo trocado")
    done = (await client.get(f"{API}/portal/requests/{t['id']}", headers=req)).json()
    assert done["status"] == "resolved" and done["resolution_notes"] == "Cabo trocado"
    assert done["report_url"] and "/relatorio/" in done["report_url"]
    assert [e["status"] for e in done["timeline"]] == [
        "created",
        "assigned",
        "in_progress",
        "resolved",
    ]

    # Listas: abertas, concluídas e busca pelo nº do cliente.
    open_items = (await client.get(f"{API}/portal/requests", headers=req)).json()
    assert t["id"] not in {i["id"] for i in open_items["items"]}
    finished = (
        await client.get(f"{API}/portal/requests", params={"scope": "done"}, headers=req)
    ).json()
    assert t["id"] in {i["id"] for i in finished["items"]}
    found = (
        await client.get(
            f"{API}/portal/requests", params={"scope": "all", "q": "INC-778"}, headers=req
        )
    ).json()
    assert [i["id"] for i in found["items"]] == [t["id"]]


async def test_company_wide_and_isolated(client: AsyncClient, world: World) -> None:
    """Todos da empresa veem as solicitações dela; de outra empresa, nada (nem por id)."""
    other_id, other_store, other_headers = await _other_company(client, world)
    ours = await create(client, world, title="Aberta pela central")  # empresa do world
    theirs = (
        await client.post(
            f"{API}/portal/requests",
            json={"location_id": other_store, "title": "Impressora atolando"},
            headers=other_headers,
        )
    ).json()

    mine = (
        await client.get(
            f"{API}/portal/requests", params={"scope": "all"}, headers=world.requester.headers
        )
    ).json()
    assert {i["id"] for i in mine["items"]} == {ours["id"]}
    assert (
        await client.get(f"{API}/portal/requests/{theirs['id']}", headers=world.requester.headers)
    ).status_code == 404
    assert (
        await client.get(f"{API}/portal/requests/{ours['id']}", headers=other_headers)
    ).status_code == 404
    # Loja de outra empresa não serve para abrir solicitação.
    wrong = await client.post(
        f"{API}/portal/requests",
        json={"location_id": world.location_id, "title": "Na loja dos outros"},
        headers=other_headers,
    )
    assert wrong.status_code == 422
    stores = (await client.get(f"{API}/portal/locations", headers=other_headers)).json()
    assert [s["name"] for s in stores] == ["Loja Centro"]
    assert other_id != world.customer_id


async def test_cancel_only_before_the_office_starts(client: AsyncClient, world: World) -> None:
    req, an = world.requester.headers, world.analyst.headers
    body = {"location_id": world.location_id, "title": "Era engano"}
    first = (await client.post(f"{API}/portal/requests", json=body, headers=req)).json()
    r = await client.post(
        f"{API}/portal/requests/{first['id']}/cancel",
        json={"reason": "Resolvemos aqui"},
        headers=req,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled" and r.json()["can_cancel"] is False

    second = (await client.post(f"{API}/portal/requests", json=body, headers=req)).json()
    internal = (await client.get(f"{API}/tickets/{second['id']}", headers=an)).json()
    await client.post(
        f"{API}/tickets/{second['id']}/assign",
        json={"assignee_id": str(world.tech.user.id), "expected_version": internal["version"]},
        headers=an,
    )
    late = await client.post(
        f"{API}/portal/requests/{second['id']}/cancel", json={"reason": "Mudou"}, headers=req
    )
    assert late.status_code == 422 and "central" in late.json()["detail"]


async def test_portal_is_only_for_linked_clients(client: AsyncClient, world: World) -> None:
    # A equipe e o técnico não usam o portal.
    for actor in (world.analyst, world.tech):
        assert (await client.get(f"{API}/portal/me", headers=actor.headers)).status_code == 403
    # Usuário do cliente precisa de empresa (o cadastro exige; sem ela o portal orienta).
    r = await client.post(
        f"{API}/users",
        json={
            "name": "Sem Empresa",
            "email": "semempresa@teste.com.br",
            "password": "senha-teste-123",
            "role": "requester",
        },
        headers=world.admin.headers,
    )
    assert r.status_code == 422 and "empresa" in r.json()["detail"]
    # O contador do menu é só da central.
    assert (
        await client.get(f"{API}/portal/inbox-count", headers=world.requester.headers)
    ).status_code == 403
