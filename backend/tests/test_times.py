"""Horários reais: só a central corrige (o técnico nunca mexe no horário)."""

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


def _dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


async def test_office_corrects_real_times(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Rack", assignee_id=str(world.tech.user.id))
    # A OS foi aberta de manhã (o teste roda agora; a abertura vai 8 h para trás).
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE tickets SET created_at = created_at - interval '8 hours' WHERE id = :i"),
            {"i": uuid.UUID(t["id"])},
        )
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    t = await transition(client, th, t, "en_route")
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Rack organizado")
    url = f"{API}/tickets/{t['id']}/times"

    now = datetime.now(UTC).replace(microsecond=0)
    body = {
        "en_route_at": (now - timedelta(hours=6)).isoformat(),
        "arrived_at": (now - timedelta(hours=5, minutes=30)).isoformat(),
        "resolved_at": (now - timedelta(hours=3)).isoformat(),
        "reason": "Técnico esqueceu de iniciar e concluir no app",
    }
    # O técnico (e o solicitante) nunca mexem no horário.
    assert (await client.put(url, json=body, headers=th)).status_code == 403
    assert (await client.put(url, json=body, headers=world.requester.headers)).status_code == 403

    r = await client.put(url, json=body, headers=an)
    assert r.status_code == 200, r.text
    fixed = r.json()
    assert _dt(fixed["arrived_at"]) == now - timedelta(hours=5, minutes=30)
    assert _dt(fixed["resolved_at"]) == now - timedelta(hours=3)
    # Sem tempo informado, vale o intervalo entre início e término; o limite na loja acompanha.
    assert fixed["actual_minutes"] == 150
    assert _dt(fixed["onsite_due_at"]) - _dt(fixed["arrived_at"]) == timedelta(hours=4)

    # O histórico de status acompanha (Atividades do dia e o relatório do cliente leem dele) e a
    # correção fica registrada com o motivo, só para a gestão.
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    moved = {
        e["to_value"]: _dt(e["created_at"]) for e in events if e["event_type"] == "status_changed"
    }
    assert moved["en_route"] == now - timedelta(hours=6)
    assert moved["in_progress"] == now - timedelta(hours=5, minutes=30)
    assert moved["resolved"] == now - timedelta(hours=3)
    log = next(e for e in events if e["event_type"] == "times_corrected")
    assert log["note"] == "Técnico esqueceu de iniciar e concluir no app"
    assert set(log["data"]["changes"]) == {
        "en_route_at",
        "arrived_at",
        "resolved_at",
        "work_minutes",
    }
    assert log["actor"]["id"] == str(world.analyst.user.id)

    # Tempo de atendimento informado (houve uma pausa): vale o informado.
    r = await client.put(
        url,
        json={
            "work_minutes": 120,
            "reason": "Parou 30 min esperando a loja",
            "expected_version": fixed["version"],
        },
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert r.json()["actual_minutes"] == 120

    # Validações: ordem, futuro, antes da abertura, tempo maior que o intervalo, versão antiga.
    later = (now - timedelta(hours=1)).isoformat()
    bad = (
        {"arrived_at": later, "reason": "teste"},  # início depois do término
        {"resolved_at": (now + timedelta(hours=2)).isoformat(), "reason": "teste"},
        {"arrived_at": (now - timedelta(days=3)).isoformat(), "reason": "teste"},
        {"work_minutes": 400, "reason": "teste"},
    )
    for payload in bad:
        assert (await client.put(url, json=payload, headers=an)).status_code == 422, payload
    stale = await client.put(
        url, json={"work_minutes": 60, "reason": "teste", "expected_version": 1}, headers=an
    )
    assert stale.status_code == 409
    # Sem motivo não corrige.
    assert (await client.put(url, json={"work_minutes": 60}, headers=an)).status_code == 422

    # Fechada: o término não pode passar do fechamento.
    current = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    await transition(client, world.supervisor.headers, current, "closed")
    async with engine.begin() as conn:  # fechada 2 h atrás (depois do término, 3 h atrás)
        await conn.execute(
            text("UPDATE tickets SET closed_at = :c WHERE id = :i"),
            {"c": now - timedelta(hours=2), "i": uuid.UUID(t["id"])},
        )
    after_close = (now - timedelta(hours=1)).isoformat()
    r = await client.put(url, json={"resolved_at": after_close, "reason": "teste"}, headers=an)
    assert r.status_code == 422 and "fechamento" in r.json()["detail"]


async def test_times_need_a_started_os(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Sem visita", assignee_id=str(world.tech.user.id))
    url = f"{API}/tickets/{t['id']}/times"
    now = datetime.now(UTC).isoformat()
    for payload in (
        {"arrived_at": now, "reason": "teste"},
        {"resolved_at": now, "reason": "teste"},
        {"en_route_at": now, "reason": "teste"},
    ):
        assert (await client.put(url, json=payload, headers=an)).status_code == 422, payload
    # Em atendimento: corrige o início; o tempo só depois de concluir.
    t = await transition(client, world.tech.headers, t, "in_progress")
    early = (datetime.now(UTC) - timedelta(seconds=30)).isoformat()
    r = await client.put(url, json={"arrived_at": early, "reason": "teste"}, headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["work_started_at"] == r.json()["arrived_at"]
    assert (
        await client.put(url, json={"work_minutes": 5, "reason": "teste"}, headers=an)
    ).status_code == 422


async def test_office_edits_everything_on_a_closed_os(client: AsyncClient, world: World) -> None:
    """Como no Field Control: a central altera tudo a qualquer momento, mesmo com a OS fechada."""
    an, th, sup = world.analyst.headers, world.tech.headers, world.supervisor.headers
    t = await create(client, world, title="PDV parado", assignee_id=str(world.tech.user.id))
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Troquei o cabo")
    t = await transition(client, sup, t, "closed")
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert detail["status"] == "closed" and detail["can_edit"] and detail["can_assign"]

    # Outro cliente e loja, agenda, conclusão, etiquetas e recado: tudo pela edição.
    other = (
        await client.post(f"{API}/customers", json={"name": "Loja Nova SA"}, headers=an)
    ).json()
    loc = await client.post(
        f"{API}/customers/{other['id']}/locations", json={"name": "Filial 9"}, headers=an
    )
    assert loc.status_code == 201, loc.text
    body = {
        "customer_id": other["id"],
        "location_id": loc.json()["id"],
        "scheduled_start": "2026-11-10T13:00:00Z",
        "scheduled_end": "2026-11-10T15:00:00Z",
        "resolution_notes": "  Troquei o cabo e organizei o rack  ",
        "tags": [
            {"name": "Adicional Noturno", "color": "#3f51b5"},
            {"name": " adicional noturno "},
            {"name": ""},
        ],
        "visit_note": "Falar com a gerente",
        "expected_version": detail["version"],
    }
    r = await client.patch(f"{API}/tickets/{t['id']}", json=body, headers=an)
    assert r.status_code == 200, r.text
    edited = r.json()
    assert (edited["customer"]["id"], edited["location"]["name"]) == (other["id"], "Filial 9")
    assert edited["resolution_notes"] == "Troquei o cabo e organizei o rack"
    assert edited["tags"] == [{"name": "Adicional Noturno", "color": "#3f51b5"}]
    assert edited["scheduled_start"].startswith("2026-11-10T13:00")
    assert edited["status"] == "closed"  # editar não muda o status

    # Corrigir quem atendeu, mesmo fechada.
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": str(world.tech_other.user.id), "expected_version": edited["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert r.json()["assignee"]["id"] == str(world.tech_other.user.id)

    # As etiquetas usadas aparecem para escolher; o técnico continua sem editar.
    tags = (await client.get(f"{API}/ticket-tags", headers=an)).json()
    assert {"name": "Adicional Noturno", "color": "#3f51b5"} in tags
    assert (await client.get(f"{API}/ticket-tags", headers=th)).status_code == 403
    r = await client.patch(f"{API}/tickets/{t['id']}", json={"title": "Outro"}, headers=th)
    assert r.status_code in (403, 404)
