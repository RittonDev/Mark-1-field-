"""Relatórios: o ranking credita o técnico da OS, a série do mês usa o dia de São Paulo, datas
fora do período aceito e o recorte por cliente."""

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from app.services.activities import local_today
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


async def resolved_by_the_office(client: AsyncClient, world: World, title: str) -> dict:
    """OS do técnico que a central marcou como resolvida (ele esqueceu de concluir no app)."""
    an = world.analyst.headers
    t = await create(client, world, title=title, assignee_id=str(world.tech.user.id))
    t = await transition(client, an, t, "in_progress")
    return await transition(client, an, t, "resolved", resolution_notes="Concluída pela central")


async def test_ranking_credits_the_ticket_technician(client: AsyncClient, world: World) -> None:
    await resolved_by_the_office(client, world, "Esqueceu de concluir")
    day = (
        await client.get(
            f"{API}/reports/daily",
            params={"date": local_today().isoformat()},
            headers=world.analyst.headers,
        )
    ).json()
    assert [(t["name"], t["count"]) for t in day["technicians"]] == [("Tecnico", 1)]


async def test_month_series_uses_the_local_day(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    first_of_month = local_today().replace(day=1)
    previous = (first_of_month - timedelta(days=1)).replace(day=10)
    # 23h30 em São Paulo: em UTC já é o dia seguinte.
    late = datetime.combine(previous, time(23, 30), tzinfo=ZoneInfo(settings.TIMEZONE))
    t = await resolved_by_the_office(client, world, "Tarde da noite")
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE tickets SET created_at = :at WHERE id = :i"), {"at": late, "i": t["id"]}
        )
        await conn.execute(
            text("UPDATE ticket_events SET created_at = :at WHERE ticket_id = :i"),
            {"at": late, "i": t["id"]},
        )
    month = (
        await client.get(
            f"{API}/reports/monthly",
            params={"month": previous.strftime("%Y-%m")},
            headers=world.analyst.headers,
        )
    ).json()
    points = {p["date"]: p for p in month["days"]}
    same_day, next_day = points[previous.isoformat()], points[(previous + timedelta(1)).isoformat()]
    assert (same_day["opened"], same_day["resolved"]) == (1, 1)
    assert (next_day["opened"], next_day["resolved"]) == (0, 0)
    assert len(month["days"]) == (first_of_month - previous.replace(day=1)).days
    assert month["numbers"]["opened"] == 1


async def test_dates_out_of_range_are_refused(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    r = await client.get(f"{API}/reports/daily", params={"date": "0001-01-01"}, headers=an)
    assert r.status_code == 422
    r = await client.get(f"{API}/reports/monthly", params={"month": "0000-01"}, headers=an)
    assert r.status_code == 422
    r = await client.get(f"{API}/reports/monthly", params={"month": "2026-13"}, headers=an)
    assert r.status_code == 422


async def test_reports_for_one_customer(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    other = (await client.post(f"{API}/customers", json={"name": "Rede B"}, headers=an)).json()
    store = (
        await client.post(
            f"{API}/customers/{other['id']}/locations", json={"name": "Loja B"}, headers=an
        )
    ).json()
    await create(client, world, title="Do cliente teste")
    rede_b = {"customer_id": other["id"], "location_id": store["id"]}
    await create(client, world, title="Da rede B", **rede_b)
    await create(client, world, title="Outra da rede B", **rede_b)
    today = local_today().isoformat()
    mine = (
        await client.get(
            f"{API}/reports/daily",
            params={"date": today, "customer_id": world.customer_id},
            headers=an,
        )
    ).json()
    assert mine["numbers"]["opened"] == 1
    assert [c["name"] for c in mine["customers"]] == ["Cliente Teste"]
    theirs = (
        await client.get(f"{API}/reports/monthly", params={"customer_id": other["id"]}, headers=an)
    ).json()
    assert theirs["numbers"]["opened"] == 2
    everyone = (await client.get(f"{API}/reports/monthly", headers=an)).json()
    assert everyone["numbers"]["opened"] == 3
