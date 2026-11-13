"""Valor por chamado: os técnicos são parceiros e recebem por OS."""

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


async def test_fee_per_technician_on_the_os(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tech_id, other_id = str(world.tech.user.id), str(world.tech_other.user.id)
    service = await client.post(
        f"{API}/service-types",
        json={"name": "Troca de PDV", "estimated_minutes": 60, "technician_fee": 150},
        headers=an,
    )
    assert service.status_code == 201, service.text
    assert service.json()["technician_fee"] == 150.0

    # Ao colocar o técnico, entra o valor padrão do tipo de serviço.
    t = await create(
        client, world, title="PDV parado", service_type_id=service.json()["id"], assignee_id=tech_id
    )
    assert [(p["technician"]["id"], p["amount"], p["status"]) for p in t["payouts"]] == [
        (tech_id, 150.0, "pending")
    ]
    # O técnico vê só o dele (não a lista nem o do colega).
    seen = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    assert seen["payouts"] == [] and seen["my_payout"]["amount"] == 150.0

    url = f"{API}/tickets/{t['id']}/payouts/{tech_id}"
    r = await client.put(url, json={"amount": 180, "note": "Loja longe"}, headers=an)
    assert r.status_code == 200, r.text
    assert [(p["amount"], p["note"]) for p in r.json()] == [(180.0, "Loja longe")]
    assert (await client.put(url, json={"amount": 999}, headers=th)).status_code == 403
    assert (
        await client.put(url, json={"amount": 9}, headers=world.requester.headers)
    ).status_code == 403

    # O colega precisa estar na OS para ter valor; saindo dela, perde o que não foi pago.
    other_url = f"{API}/tickets/{t['id']}/payouts/{other_id}"
    assert (await client.put(other_url, json={"amount": 80}, headers=an)).status_code == 422
    r = await client.patch(f"{API}/tickets/{t['id']}", json={"helper_ids": [other_id]}, headers=an)
    assert r.status_code == 200, r.text
    assert (await client.put(other_url, json={"amount": 80}, headers=an)).status_code == 200
    mine = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    assert mine["my_payout"]["amount"] == 180.0 and mine["payouts"] == []
    r = await client.patch(f"{API}/tickets/{t['id']}", json={"helper_ids": []}, headers=an)
    assert [p["technician"]["id"] for p in r.json()["payouts"]] == [tech_id]

    # Histórico interno: a central vê quem mudou o valor.
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    assert any(e["event_type"] == "payout_set" for e in events)


async def test_new_technician_takes_the_unpaid_fee(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Rack", assignee_id=str(world.tech.user.id))
    url = f"{API}/tickets/{t['id']}/payouts/{world.tech.user.id}"
    assert (await client.put(url, json={"amount": 120}, headers=an)).status_code == 200
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": str(world.tech_other.user.id), "expected_version": t["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert [(p["technician"]["id"], p["amount"]) for p in r.json()["payouts"]] == [
        (str(world.tech_other.user.id), 120.0)
    ]


async def test_closing_payments_and_my_earnings(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tech_id = str(world.tech.user.id)
    done = await create(client, world, title="Concluída", assignee_id=tech_id)
    put = f"{API}/tickets/{done['id']}/payouts/{tech_id}"
    assert (await client.put(put, json={"amount": 200}, headers=an)).status_code == 200
    done = (await client.get(f"{API}/tickets/{done['id']}", headers=th)).json()
    done = await transition(client, th, done, "in_progress")
    done = await transition(client, th, done, "resolved", resolution_notes="ok")
    still_open = await create(client, world, title="Em aberto", assignee_id=tech_id)
    put_open = f"{API}/tickets/{still_open['id']}/payouts/{tech_id}"
    assert (await client.put(put_open, json={"amount": 90}, headers=an)).status_code == 200

    # Fechamento: concluída entra no "a pagar"; aberta é previsão.
    listing = (
        await client.get(f"{API}/payouts", params={"technician_id": tech_id}, headers=an)
    ).json()
    assert listing["summary"] == {"to_pay": 200.0, "expected": 90.0, "paid": 0.0}
    line = next(i for i in listing["items"] if i["ticket"]["id"] == done["id"])
    assert line["concluded"] is True and line["ticket"]["code"] == done["code"]
    paid = await client.post(f"{API}/payouts/pay", json={"ids": [line["id"]]}, headers=an)
    assert paid.json() == {"changed": 1}
    # Pago não muda mais de valor (desfaça antes).
    assert (await client.put(put, json={"amount": 1}, headers=an)).status_code == 422

    # Meus ganhos: só o técnico, só os dele.
    mine = (await client.get(f"{API}/me/earnings", headers=th)).json()
    assert mine["summary"] == {"to_pay": 0.0, "expected": 90.0, "paid": 200.0}
    assert {i["ticket"]["title"] for i in mine["items"]} == {"Concluída", "Em aberto"}
    assert (await client.get(f"{API}/me/earnings", headers=an)).status_code == 403
    assert (await client.get(f"{API}/me/earnings?month=2026-13", headers=th)).status_code == 422
    assert (await client.get(f"{API}/payouts", headers=th)).status_code == 403
    assert (await client.get(f"{API}/payouts", headers=world.tech_other.headers)).status_code == 403

    undo = await client.post(f"{API}/payouts/unpay", json={"ids": [line["id"]]}, headers=an)
    assert undo.json() == {"changed": 1}
    assert (await client.put(put, json={"amount": 210}, headers=an)).status_code == 200
