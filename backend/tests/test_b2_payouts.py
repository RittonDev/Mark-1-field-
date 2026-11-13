"""Pagamentos dos técnicos: OS cancelada sai do previsto, o resumo soma tudo (não só o que coube
na lista) e o histórico da OS registra pagar, desfazer e transferir o valor."""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.services import payouts as payouts_svc
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


async def with_fee(client: AsyncClient, world: World, title: str, amount: int) -> dict:
    """OS do técnico com o valor dele definido; devolve a OS atualizada (versão em dia)."""
    tech_id = str(world.tech.user.id)
    t = await create(client, world, title=title, assignee_id=tech_id)
    r = await client.put(
        f"{API}/tickets/{t['id']}/payouts/{tech_id}",
        json={"amount": amount},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    return (await client.get(f"{API}/tickets/{t['id']}", headers=world.analyst.headers)).json()


async def test_cancelled_ticket_is_not_expected_money(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await with_fee(client, world, "Cancelada depois", 120)
    await transition(client, world.supervisor.headers, t, "cancelled", note="Cliente desistiu")

    ongoing = (await client.get(f"{API}/payouts", params={"concluded": False}, headers=an)).json()
    assert ongoing["items"] == [] and ongoing["summary"]["expected"] == 0.0
    listing = (await client.get(f"{API}/payouts", headers=an)).json()
    assert [(i["cancelled"], i["concluded"]) for i in listing["items"]] == [(True, False)]
    assert listing["summary"] == {"to_pay": 0.0, "expected": 0.0, "paid": 0.0, "cancelled": 120.0}
    # O técnico parceiro não vê como "previsto" um dinheiro que não vai receber.
    mine = (await client.get(f"{API}/me/earnings", headers=th)).json()
    assert mine["items"] == [] and mine["summary"]["expected"] == 0.0

    # A central ainda pode pagar (ex.: o deslocamento até a loja): aí aparece como recebido.
    paid = await client.post(
        f"{API}/payouts/pay", json={"ids": [listing["items"][0]["id"]]}, headers=an
    )
    assert paid.json() == {"changed": 1}
    mine = (await client.get(f"{API}/me/earnings", headers=th)).json()
    assert [i["status"] for i in mine["items"]] == ["paid"]
    assert mine["summary"]["paid"] == 120.0


async def test_summary_counts_every_value_not_only_the_listed_ones(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    for n, amount in enumerate((100, 50, 25)):
        await with_fee(client, world, f"OS {n}", amount)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        page = await payouts_svc.list_payouts(db, limit=1)
    assert len(page.items) == 1 and page.total_count == 3
    assert page.summary.expected == 175


async def test_paying_undoing_and_transfers_go_to_the_ticket_history(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    t = await with_fee(client, world, "Rack", 150)
    line_id = (await client.get(f"{API}/payouts", headers=an)).json()["items"][0]["id"]
    pay = await client.post(f"{API}/payouts/pay", json={"ids": [line_id]}, headers=an)
    assert pay.json() == {"changed": 1}
    undo = await client.post(f"{API}/payouts/unpay", json={"ids": [line_id]}, headers=an)
    assert undo.json() == {"changed": 1}
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    by_action = {(e["data"] or {}).get("action"): e for e in events}
    assert by_action["paid"]["actor"]["id"] == str(world.analyst.user.id)
    assert by_action["paid"]["data"]["amount"] == "R$ 150,00"
    assert by_action["unpaid"]["to_value"] == "pending"

    # Trocar o técnico: o valor não pago vai para o novo, e o histórico diz de quem para quem.
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": str(world.tech_other.user.id), "expected_version": t["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    moved = next(e for e in events if (e["data"] or {}).get("action") == "transferred")
    assert (moved["data"]["from_technician"], moved["data"]["technician"]) == ("Tecnico", "Redes")


async def test_periods_out_of_range_are_refused(client: AsyncClient, world: World) -> None:
    r = await client.get(
        f"{API}/me/earnings", params={"month": "9999-12"}, headers=world.tech.headers
    )
    assert r.status_code == 422
    r = await client.get(
        f"{API}/payouts", params={"date_from": "0001-01-01"}, headers=world.analyst.headers
    )
    assert r.status_code == 422
