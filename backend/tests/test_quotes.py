"""Orçamento da OS: a gestão monta, envia o link e o cliente aprova (assinando) ou recusa."""

from datetime import date, timedelta

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX
SIGNATURE = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


async def test_quote_approval_flow(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    an, th = world.analyst.headers, world.tech.headers
    velcro = (
        await client.post(
            f"{API}/quote-items", json={"name": "Velcro 3 m", "unit": "rolo", "price": "15.90"}, headers=an
        )
    ).json()
    t = await create(client, world, title="Organizar rack")
    body = {
        "title": "Organização do rack principal",
        "items": [
            {"description": "Velcro 3 m", "quantity": 2, "unit": "rolo", "unit_price": "15.90", "catalog_item_id": velcro["id"]},
            {"description": "Mão de obra", "quantity": 1, "unit": "serviço", "unit_price": "150"},
        ],
        "discount": "10",
        "valid_until": (date.today() + timedelta(days=7)).isoformat(),
        "notes": "Pagamento em 30 dias.",
    }
    url = f"{API}/tickets/{t['id']}/quotes"
    assert (await client.post(url, json=body, headers=th)).status_code == 403
    assert (await client.post(url, json={**body, "discount": "999"}, headers=an)).status_code == 422
    q = (await client.post(url, json=body, headers=an)).json()
    assert (q["code"][:4], q["status"], q["subtotal"], q["total"]) == ("ORC-", "draft", 181.8, 171.8)
    assert q["items"][0]["total"] == 31.8

    token = (await client.post(f"{API}/quotes/{q['id']}/send", headers=an)).json()["token"]
    view = (await client.get(f"{API}/public/quotes/{token}")).json()
    assert (view["status"], view["total"], view["customer"]) == ("sent", 171.8, "Cliente Teste")
    assert "token" not in view and "decision_ip" not in view

    # Mudou o orçamento: o link antigo morre e volta a rascunho.
    r = await client.put(f"{API}/quotes/{q['id']}", json={**body, "discount": "0"}, headers=an)
    assert (r.json()["status"], r.json()["total"]) == ("draft", 181.8)
    assert (await client.get(f"{API}/public/quotes/{token}")).status_code == 410
    token = (await client.post(f"{API}/quotes/{q['id']}/send", headers=an)).json()["token"]

    approve = {"name": "Paula Gerente", "role": "Gerente", "signature": SIGNATURE, "accept": False}
    assert (await client.post(f"{API}/public/quotes/{token}/approve", json=approve)).status_code == 422
    bad = {**approve, "accept": True, "signature": "data:image/png;base64,PHNjcmlwdD4="}
    assert (await client.post(f"{API}/public/quotes/{token}/approve", json=bad)).status_code == 422
    r = await client.post(f"{API}/public/quotes/{token}/approve", json={**approve, "accept": True})
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["approver_name"]) == ("approved", "Paula Gerente")
    again = await client.post(f"{API}/public/quotes/{token}/approve", json={**approve, "accept": True})
    assert again.status_code == 409
    # O cliente continua vendo o orçamento aprovado pelo link.
    assert (await client.get(f"{API}/public/quotes/{token}")).json()["status"] == "approved"

    quotes = (await client.get(url, headers=an)).json()
    assert quotes[0]["status"] == "approved"
    sig = await client.get(quotes[0]["signature_url"])
    assert sig.status_code == 200 and sig.content.startswith(b"\x89PNG")
    events = [e["event_type"] for e in (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()]
    assert "quote_approved" in events and "quote_sent" in events

    # Recusa com motivo; e o vencido não aceita resposta.
    q2 = (await client.post(url, json=body, headers=an)).json()
    tok2 = (await client.post(f"{API}/quotes/{q2['id']}/send", headers=an)).json()["token"]
    r = await client.post(f"{API}/public/quotes/{tok2}/reject", json={"reason": "Vamos fazer internamente"})
    assert (r.json()["status"], r.json()["rejection_reason"]) == ("rejected", "Vamos fazer internamente")

    q3 = (await client.post(url, json=body, headers=an)).json()
    tok3 = (await client.post(f"{API}/quotes/{q3['id']}/send", headers=an)).json()["token"]
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE quotes SET valid_until = current_date - 1 WHERE id = :i"), {"i": q3["id"]}
        )
    assert (await client.get(f"{API}/public/quotes/{tok3}")).json()["status"] == "expired"
    late = await client.post(f"{API}/public/quotes/{tok3}/approve", json={**approve, "accept": True})
    assert late.status_code == 409
    listed = {r["id"]: r["status"] for r in (await client.get(f"{API}/quotes", headers=an)).json()}
    assert listed == {q["id"]: "approved", q2["id"]: "rejected", q3["id"]: "expired"}
