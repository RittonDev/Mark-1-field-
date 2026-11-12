"""Fechamento diário e mensal: entraram, resolvidos, cancelados, improdutivos e agendados."""

from datetime import timedelta

from httpx import AsyncClient

from app.core.config import settings
from app.services.activities import local_today
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


async def test_daily_and_monthly(client: AsyncClient, world: World) -> None:
    an, th, sup = world.analyst.headers, world.tech.headers, world.supervisor.headers
    tech = str(world.tech.user.id)
    reason = (
        await client.post(
            f"{API}/unproductive-reasons",
            json={"name": "Loja fechada", "responsibility": "customer"},
            headers=an,
        )
    ).json()

    done = await create(client, world, title="Resolvida", assignee_id=tech)
    done = await transition(client, th, done, "en_route")
    done = await transition(client, th, done, "in_progress")
    await transition(client, th, done, "resolved", resolution_notes="ok")

    gone = await create(client, world, title="Cancelada")
    await transition(client, sup, gone, "cancelled", note="Duplicada")

    later = await create(client, world, title="Agendada", assignee_id=tech)
    tomorrow = f"{local_today() + timedelta(days=1)}T13:00:00-03:00"
    await transition(client, sup, later, "scheduled", scheduled_start=tomorrow)

    bad = await create(client, world, title="Improdutiva", assignee_id=tech)
    bad = await transition(client, th, bad, "en_route")
    await client.post(
        f"{API}/tickets/{bad['id']}/unproductive",
        json={"reason_id": reason["id"], "expected_version": bad["version"]},
        headers=th,
    )

    today = local_today().isoformat()
    day = (await client.get(f"{API}/reports/daily", params={"date": today}, headers=an)).json()
    n = day["numbers"]
    assert (n["opened"], n["resolved"], n["cancelled"], n["unproductive"], n["scheduled_end"]) == (
        4,
        1,
        1,
        1,
        1,
    )
    assert n["backlog_end"] == 2  # agendada + a improdutiva (voltou para reagendar)
    assert day["closed"] is False  # hoje ainda é parcial
    assert (day["top_customer"]["name"], day["top_customer"]["count"]) == ("Cliente Teste", 4)
    assert day["technicians"][0]["name"] == "Tecnico"
    assert day["unproductive_reasons"] == [{"id": None, "name": "Loja fechada", "count": 1}]

    # Sem data: o painel mostra o dia anterior, já fechado.
    yesterday = (await client.get(f"{API}/reports/daily", headers=an)).json()
    assert yesterday["closed"] is True and yesterday["numbers"]["opened"] == 0

    month = (await client.get(f"{API}/reports/monthly", headers=an)).json()
    assert month["numbers"]["opened"] == 4
    assert month["days"][-1] == {
        "date": today,
        "opened": 4,
        "resolved": 1,
        "cancelled": 1,
        "unproductive": 1,
    }
    assert (
        await client.get(f"{API}/reports/monthly", params={"month": "2026-13"}, headers=an)
    ).status_code == 422
    assert (await client.get(f"{API}/reports/daily", headers=th)).status_code == 403
