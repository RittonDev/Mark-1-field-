"""Calendário e conflito de horário: o mesmo técnico não fica com duas OS no mesmo horário."""

from datetime import UTC, datetime, timedelta

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX
DAY = (datetime.now(UTC) + timedelta(days=2)).replace(hour=13, minute=0, second=0, microsecond=0)


def at(hours: float) -> str:
    return (DAY + timedelta(hours=hours)).isoformat()


async def test_conflicts_block_unless_confirmed(client: AsyncClient, world: World) -> None:
    tech = str(world.tech.user.id)
    sup = world.supervisor.headers
    first = await create(
        client, world, assignee_id=tech, scheduled_start=at(0), scheduled_end=at(1)
    )

    # Outro cliente, mesmo técnico, horário sobreposto: recusado com a OS em choque.
    body = {
        "title": "Câmera sem imagem",
        "customer_id": world.customer_id,
        "assignee_id": tech,
        "scheduled_start": at(0.5),
        "scheduled_end": at(1),
    }
    r = await client.post(f"{API}/tickets", json=body, headers=sup)
    assert r.status_code == 409, r.text
    assert r.json()["code"] == "SCHEDULE_CONFLICT"
    assert [c["code"] for c in r.json()["conflicts"]] == [first["code"]]

    # Prévia antes de agendar mostra o mesmo choque.
    r = await client.get(
        f"{API}/calendar/conflicts",
        params={"assignee_id": tech, "start": at(0.5), "estimated_minutes": 30},
        headers=sup,
    )
    assert [c["id"] for c in r.json()] == [first["id"]]

    # Confirmando, passa; outro técnico no mesmo horário, também; começando quando a outra
    # termina, também (sem fim informado, a visita ocupa 1 hora).
    forced = await create(client, world, **body, allow_conflict=True)
    # A tentativa barrada não consumiu número de OS (a numeração segue sem buracos).
    assert int(forced["code"][3:]) == int(first["code"][3:]) + 1
    other = str(world.tech_other.user.id)
    await create(client, world, title="Switch", assignee_id=other, scheduled_start=at(0))
    later = await create(client, world, title="Impressora", assignee_id=tech, scheduled_start=at(1))

    # Remarcar por cima de outra OS (transição para agendada) também é barrado.
    r = await client.post(
        f"{API}/tickets/{later['id']}/transition",
        json={
            "to_status": "scheduled",
            "scheduled_start": at(0.25),
            "expected_version": later["version"],
        },
        headers=sup,
    )
    assert r.status_code == 409

    # Atribuir a OS agendada a quem já está ocupado no horário: barrado.
    queue = await create(
        client, world, title="Rede lenta", scheduled_start=at(0.25), scheduled_end=at(0.75)
    )
    r = await client.post(
        f"{API}/tickets/{queue['id']}/assign", json={"assignee_id": tech}, headers=sup
    )
    assert r.status_code == 409
    r = await client.post(
        f"{API}/tickets/{queue['id']}/assign",
        json={"assignee_id": tech, "allow_conflict": True},
        headers=sup,
    )
    assert r.status_code == 200

    # Calendário: as três OS sobrepostas do técnico aparecem marcadas entre si.
    r = await client.get(
        f"{API}/calendar",
        params={"start": at(-2), "end": at(10), "assignee_id": tech},
        headers=world.analyst.headers,
    )
    events = {e["id"]: e for e in r.json()}
    assert set(events) == {first["id"], forced["id"], later["id"], queue["id"]}
    assert set(events[first["id"]]["conflict_with"]) == {forced["id"], queue["id"]}
    assert events[later["id"]]["conflict_with"] == []
    assert events[later["id"]]["end_is_estimated"] is True  # sem fim: 1 hora

    # O técnico não vê a agenda da equipe pela API do calendário.
    r = await client.get(
        f"{API}/calendar", params={"start": at(-2), "end": at(10)}, headers=world.tech.headers
    )
    assert r.status_code == 403
