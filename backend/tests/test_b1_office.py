"""Telas da central: agenda com os outros técnicos da visita, filas (corte e analista que saiu),
sugestão de técnicos, texto do WhatsApp e o que é só da central."""

import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from app.services import queues
from app.services.map_distances import ROAD_FACTOR, travel_minutes
from app.services.suggestions import km_between
from tests.conftest import World, requires_db
from tests.test_api import create, transition
from tests.test_b1_tickets import _sql, _store
from tests.test_tracking import ping, start_shift

pytestmark = requires_db

API = settings.API_PREFIX
PAULISTA = (-23.5614, -46.6559)


def _slot(days: int = 3) -> datetime:
    """13:00 UTC (10:00 em Brasília) daqui a alguns dias."""
    return (datetime.now(UTC) + timedelta(days=days)).replace(
        hour=13, minute=0, second=0, microsecond=0
    )


# ------------------------------------------------------------------ agenda


async def test_helper_double_booking_shows_on_the_agenda(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    tech, helper = str(world.tech.user.id), str(world.tech_other.user.id)
    day = _slot()

    def at(hours: float) -> str:
        return (day + timedelta(hours=hours)).isoformat()

    a = await create(
        client,
        world,
        title="Rack em dupla",
        assignee_id=tech,
        helper_ids=[helper],
        scheduled_start=at(0),
        scheduled_end=at(1),
    )
    second = {"title": "Câmera", "assignee_id": helper, "scheduled_start": at(0.5)}
    r = await client.post(
        f"{API}/tickets",
        json={**second, "customer_id": world.customer_id, "scheduled_end": at(1.5)},
        headers=an,
    )
    assert r.status_code == 409 and "Redes" in r.json()["detail"]  # vai junto na outra
    b = await create(client, world, **second, scheduled_end=at(1.5), allow_conflict=True)

    # A agenda marca o choque de quem vai junto (não só do responsável).
    events = (
        await client.get(f"{API}/calendar", params={"start": at(-1), "end": at(3)}, headers=an)
    ).json()
    assert {e["id"]: e["conflict_with"] for e in events} == {
        a["id"]: [b["id"]],
        b["id"]: [a["id"]],
    }

    # A prévia confere cada técnico da visita e diz de quem é cada choque.
    preview = await client.get(
        f"{API}/calendar/conflicts",
        params={"start": at(0.25), "end": at(0.75), "assignee_id": tech, "helper_id": [helper]},
        headers=an,
    )
    assert preview.status_code == 200, preview.text
    assert sorted((i["who"], i["id"]) for i in preview.json()) == sorted(
        [("Tecnico", a["id"]), ("Redes", a["id"]), ("Redes", b["id"])]
    )
    r = await client.get(
        f"{API}/calendar/conflicts",
        params={"start": at(1), "end": at(0), "assignee_id": tech},
        headers=an,
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "O fim da visita deve ser depois do início"
    r = await client.get(
        f"{API}/calendar/conflicts",
        params={"start": at(1), "estimated_minutes": 0, "assignee_id": tech},
        headers=an,
    )
    assert r.status_code == 422


# ------------------------------------------------------------------ filas


async def test_long_queue_keeps_the_most_urgent(
    client: AsyncClient, world: World, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(queues, "LIMIT", 2)
    owner = str(world.analyst.user.id)
    now = datetime.now(UTC)
    ids: dict[str, str] = {}
    for name, due in (("folga", 48), ("vencida", -1), ("apertada", 1)):
        t = await create(client, world, title=f"Prazo {name}", owner_id=owner)
        ids[name] = t["id"]
        await _sql(
            engine,
            "UPDATE tickets SET resolution_due_at = :due WHERE id = :i",
            due=now + timedelta(hours=due),
            i=uuid.UUID(t["id"]),
        )
    queue = (await client.get(f"{API}/my-queue", headers=world.analyst.headers)).json()
    # A fila avisa que cortou e fica com as de prazo mais apertado.
    assert (queue["total"], queue["truncated"], queue["counts"]["open"]) == (3, True, 3)
    assert {i["id"] for i in queue["items"]} == {ids["vencida"], ids["apertada"]}


async def test_queue_of_a_former_analyst_counts_as_unowned(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    sup = world.supervisor.headers
    analyst = world.analyst.user.id
    orphan = await create(client, world, title="Fila de quem saiu", owner_id=str(analyst))
    await create(client, world, title="Fila do supervisor")
    await _sql(engine, "UPDATE users SET is_active = false WHERE id = :u", u=analyst)

    team = (await client.get(f"{API}/queues", headers=sup)).json()
    assert team["unowned"]["open"] == 1
    assert str(analyst) not in {q["user"]["id"] for q in team["queues"]}
    listed = (await client.get(f"{API}/tickets", params={"no_owner": "true"}, headers=sup)).json()
    assert [i["id"] for i in listed["items"]] == [orphan["id"]]


# ------------------------------------------------------------------ sugestão de técnicos


async def test_suggestion_sees_who_goes_along_as_busy(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    tech, helper = str(world.tech.user.id), str(world.tech_other.user.id)
    day = _slot()
    await create(
        client,
        world,
        title="Visita em dupla",
        assignee_id=tech,
        helper_ids=[helper],
        scheduled_start=day.isoformat(),
        scheduled_end=(day + timedelta(hours=1)).isoformat(),
    )
    when = {
        "city": "São Paulo",
        "state": "SP",
        "start": (day + timedelta(minutes=30)).isoformat(),
        "end": (day + timedelta(minutes=90)).isoformat(),
    }
    rows = (await client.get(f"{API}/technicians/suggest", params=when, headers=an)).json()
    assert {r["id"]: r["busy"] for r in rows} == {tech: True, helper: True}
    assert all("Ocupado no horário" in r["reasons"] for r in rows)


async def test_store_history_counts_only_real_visits(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tech = str(world.tech.user.id)
    store = await _store(
        client,
        world,
        name="Loja Paulista",
        city="São Paulo",
        state="SP",
        latitude=PAULISTA[0],
        longitude=PAULISTA[1],
    )
    pending = await create(
        client, world, title="Ainda não atendida", location_id=store, assignee_id=tech
    )
    new = await create(client, world, title="Nova na mesma loja", location_id=store)

    async def visits() -> int:
        url = f"{API}/tickets/{new['id']}/technician-suggestions"
        rows = (await client.get(url, headers=an)).json()
        return next(r for r in rows if r["id"] == tech)["visits_at_location"]

    assert await visits() == 0  # só atribuída: ele ainda não esteve na loja
    await transition(client, th, pending, "in_progress")
    assert await visits() == 1


# ------------------------------------------------------------------ texto do WhatsApp


async def test_whatsapp_eta_uses_the_road_speed(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    store = await _store(
        client,
        world,
        name="Loja Paulista",
        city="São Paulo",
        state="SP",
        latitude=PAULISTA[0],
        longitude=PAULISTA[1],
    )
    t = await create(
        client, world, title="Loja longe", location_id=store, assignee_id=str(world.tech.user.id)
    )
    await start_shift(client, th)
    far = (-22.9056, -47.0608)  # Campinas: ~85 km em linha reta da loja
    await client.post(
        f"{API}/tracking/pings", json={"pings": [ping(datetime.now(UTC), *far)]}, headers=th
    )
    body = {"templates": [{"name": "Previsão", "body": "{chegada_prevista} | {distancia}"}]}
    assert (await client.put(f"{API}/message-templates", json=body, headers=an)).status_code == 200

    road_km = km_between(far, PAULISTA) * ROAD_FACTOR
    minutes = travel_minutes(road_km)
    before = datetime.now(UTC)
    rendered = (await client.get(f"{API}/tickets/{t['id']}/messages", headers=an)).json()
    after = datetime.now(UTC)
    tz = ZoneInfo(settings.TIMEZONE)
    expected = {
        (moment + timedelta(minutes=minutes)).astimezone(tz).strftime("%H:%M")
        for moment in (before, after)
    }
    eta, distance = rendered[0]["text"].split(" | ")
    assert eta in expected and distance == f"{road_km:.0f} km"
    assert minutes < road_km / 25 * 60  # na estrada anda mais que no trânsito da cidade


# ------------------------------------------------------------------ só a central


async def test_only_the_office_justifies_the_sla(client: AsyncClient, world: World) -> None:
    t = await create(client, world, assignee_id=str(world.tech.user.id))
    url = f"{API}/tickets/{t['id']}/violation"
    body = {"violation_note": "Trânsito na marginal"}
    r = await client.patch(url, json=body, headers=world.tech.headers)
    assert r.status_code == 403 and r.json()["detail"] == "Só a central justifica a violação de SLA"
    r = await client.patch(url, json=body, headers=world.analyst.headers)
    assert r.status_code == 200 and r.json()["violation_note"] == "Trânsito na marginal"


async def test_client_stays_out_of_field_settings_and_sync(
    client: AsyncClient, world: World
) -> None:
    req = world.requester.headers
    assert (await client.get(f"{API}/settings/field", headers=req)).status_code == 403
    assert (await client.get(f"{API}/sync/pull", headers=req)).status_code == 403
    pushed = await client.post(f"{API}/sync/push", json={"operations": []}, headers=req)
    assert pushed.status_code == 403
    # O app do técnico continua lendo os prazos de campo.
    rules = await client.get(f"{API}/settings/field", headers=world.tech.headers)
    assert rules.status_code == 200
