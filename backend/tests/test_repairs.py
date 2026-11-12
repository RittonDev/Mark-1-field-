"""Assistência externa: o equipamento passa pelas etapas, da retirada no cliente à devolução."""

import base64
from datetime import date, timedelta

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


async def test_repair_lifecycle(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Impressora com ruído")
    body = {
        "customer_id": world.customer_id,
        "location_id": world.location_id,
        "ticket_id": t["id"],
        "brand": "HP",
        "model": "LaserJet M428",
        "serial_number": "BRB1234567",
        "problem": "Ruído no fusor e papel amassando",
        "accessories": "Cabo de força, toner",
        "vendor_name": "Assistência Print Tec",
    }
    denied = await client.post(f"{API}/repairs", json=body, headers=world.tech.headers)
    assert denied.status_code == 403
    r = (await client.post(f"{API}/repairs", json=body, headers=an)).json()
    assert (r["code"][:3], r["status"], r["ticket"]["name"]) == ("AE-", "withdrawn", t["code"])
    assert r["allowed_next"] == ["received", "cancelled"]

    async def move(to: str, **extra: object) -> dict:
        res = await client.post(
            f"{API}/repairs/{r['id']}/status", json={"to_status": to, **extra}, headers=an
        )
        assert res.status_code == 200, res.text
        return res.json()

    bad = await client.post(
        f"{API}/repairs/{r['id']}/status", json={"to_status": "delivered"}, headers=an
    )
    assert bad.status_code == 422  # não pula etapas
    await move("received")
    late = (date.today() - timedelta(days=1)).isoformat()
    await move("sent_to_vendor", note="Coleta da transportadora", expected_return_date=late)
    out = await move("vendor_quote", vendor_quote_value="480.00")
    assert (out["vendor_quote_value"], out["overdue"]) == (480.0, True)
    summary = (await client.get(f"{API}/repairs/summary", headers=an)).json()
    assert (summary["open_total"], summary["overdue"], summary["by_status"]["vendor_quote"]) == (
        1,
        1,
        1,
    )

    photo = await client.post(
        f"{API}/repairs/{r['id']}/photos",
        files={"file": ("etiqueta.png", PNG, "image/png")},
        data={"caption": "Etiqueta de série"},
        headers=an,
    )
    url = photo.json()["photos"][0]["url"]
    assert (await client.get(url)).content == PNG

    for step in ("in_repair", "ready_at_vendor", "back_in_stock"):
        out = await move(step)
    out = await move("delivered", note="Entregue ao gerente")
    assert (out["status"], out["allowed_next"], out["overdue"]) == ("delivered", [], False)
    assert [e["to_status"] for e in out["events"]] == [
        "withdrawn",
        "received",
        "sent_to_vendor",
        "vendor_quote",
        "in_repair",
        "ready_at_vendor",
        "back_in_stock",
        "delivered",
    ]
    found = (await client.get(f"{API}/repairs", params={"q": "BRB123"}, headers=an)).json()
    assert [f["id"] for f in found] == [r["id"]]
    still_open = await client.get(f"{API}/repairs", params={"open_only": True}, headers=an)
    assert still_open.json() == []
