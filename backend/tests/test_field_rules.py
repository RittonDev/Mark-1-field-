"""Regras de campo da Maxx Field: dois relógios de 4h, pedido de peça, reincidência e os números
de chegada nos relatórios. (A autorização do cliente antes da visita foi retirada em 2026-11-12.)"""

import base64
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from app.schemas.field import FieldRules
from app.services.field import is_capital
from tests.conftest import World, requires_db
from tests.test_api import create, transition

API = settings.API_PREFIX
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)
SIGNATURE = "data:image/png;base64," + base64.b64encode(PNG).decode()
RULES = {
    "arrival_hours_capital": 4,
    "arrival_hours_interior": 24,
    "onsite_hours": 4,
    "onsite_warning_minutes": 30,
}


def _dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


def test_capitals_and_defaults() -> None:
    assert is_capital("São Paulo", "sp") and is_capital("Sao  Paulo", None)
    assert is_capital("BRASÍLIA", "DF") and is_capital("Florianópolis", "SC")
    assert not is_capital("Santos", "SP") and not is_capital("Vitória da Conquista", "BA")
    assert not is_capital("Vitória", "BA") and not is_capital(None, "SP")
    rules = FieldRules()
    assert (rules.arrival_hours_capital, rules.onsite_hours) == (4, 4)
    # Regras antigas guardadas com a autorização do cliente continuam lendo (a chave é ignorada).
    old = FieldRules.model_validate({"require_authorization": True, "onsite_hours": 3})
    assert old.onsite_hours == 3 and not hasattr(old, "require_authorization")


async def _location(client: AsyncClient, world: World, name: str, city: str, uf: str) -> str:
    r = await client.post(
        f"{API}/customers/{world.customer_id}/locations",
        json={"name": name, "city": city, "state": uf},
        headers=world.analyst.headers,
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _sql(engine: AsyncEngine, sql: str, **params: object) -> None:
    async with engine.begin() as conn:
        await conn.execute(text(sql), params)


@requires_db
async def test_settings_and_arrival_due(client: AsyncClient, world: World) -> None:
    an, sup = world.analyst.headers, world.supervisor.headers
    assert (await client.put(f"{API}/settings/field", json=RULES, headers=an)).status_code == 403
    # Tela antiga mandando a autorização do cliente: a chave é ignorada (a função saiu).
    saved = await client.put(
        f"{API}/settings/field", json={**RULES, "require_authorization": True}, headers=sup
    )
    assert saved.status_code == 200 and saved.json()["onsite_warning_minutes"] == 30
    assert "require_authorization" not in saved.json()
    # O técnico lê as regras (o app usa nos avisos de permanência), mas não altera.
    tech_rules = await client.get(f"{API}/settings/field", headers=world.tech.headers)
    assert tech_rules.status_code == 200 and tech_rules.json()["onsite_warning_minutes"] == 30
    assert (
        await client.put(f"{API}/settings/field", json=RULES, headers=world.tech.headers)
    ).status_code == 403

    capital = await _location(client, world, "Loja Paulista", "São Paulo", "SP")
    interior = await _location(client, world, "Loja Santos", "Santos", "SP")
    t1 = await create(client, world, title="PDV parado", location_id=capital)
    t2 = await create(client, world, title="Impressora", location_id=interior)
    assert "authorization_status" not in t1
    assert _dt(t1["arrival_due_at"]) - _dt(t1["created_at"]) == timedelta(hours=4)
    assert _dt(t2["arrival_due_at"]) - _dt(t2["created_at"]) == timedelta(hours=24)
    assert t1["arrival_status"] == "pending" and t1["onsite_status"] is None
    # Trocou a loja antes da chegada: o prazo segue a nova cidade.
    moved = await client.patch(
        f"{API}/tickets/{t2['id']}", json={"location_id": capital}, headers=an
    )
    assert _dt(moved.json()["arrival_due_at"]) - _dt(t2["created_at"]) == timedelta(hours=4)


@requires_db
async def test_no_client_authorization(client: AsyncClient, world: World) -> None:
    """A autorização do cliente antes da visita saiu: o técnico sai sem esperar registro."""
    an, th, sup = world.analyst.headers, world.tech.headers, world.supervisor.headers
    await client.put(f"{API}/settings/field", json={**RULES, "require_authorization": True}, headers=sup)
    capital = await _location(client, world, "Loja Centro", "Recife", "PE")
    t = await create(
        client,
        world,
        title="Rede caiu",
        location_id=capital,
        assignee_id=str(world.tech.user.id),
        # Tela antiga mandando a autorização na abertura: ignorada.
        authorization={"status": "authorized", "by_name": "Marcos", "channel": "maxxcon"},
    )
    assert "authorization_status" not in t and "authorized_by_name" not in t
    # O relógio de chegada corre da abertura, sem esperar ninguém.
    assert _dt(t["arrival_due_at"]) - _dt(t["created_at"]) == timedelta(hours=4)
    going = await transition(client, th, t, "en_route")
    assert going["status"] == "en_route"
    # A rota de registrar a autorização não existe mais.
    gone = await client.post(
        f"{API}/tickets/{t['id']}/authorization", json={"status": "authorized"}, headers=an
    )
    assert gone.status_code in (404, 405)
    q = (await client.get(f"{API}/my-queue", headers=an)).json()
    codes = {r["code"] for i in q["items"] for r in i["reasons"]}
    assert "authorization_pending" not in codes


@requires_db
async def test_onsite_clock_and_queue_reasons(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    mine = {"owner_id": str(world.analyst.user.id), "assignee_id": str(world.tech.user.id)}
    t = await create(client, world, title="Rack", **mine)
    t = await transition(client, th, t, "en_route")
    t = await transition(client, th, t, "in_progress")
    assert t["arrived_at"] and t["arrival_status"] == "met" and t["onsite_status"] == "ok"
    assert _dt(t["onsite_due_at"]) - _dt(t["arrived_at"]) == timedelta(hours=4)
    # Segunda passagem por "Em atendimento" não muda a chegada.
    first_arrival = t["arrived_at"]
    t = await transition(client, an, t, "on_hold_vendor", note="Aguardando peça")
    t = await transition(client, th, t, "in_progress")
    assert t["arrived_at"] == first_arrival

    tid = uuid.UUID(t["id"])
    await _sql(
        engine,
        "UPDATE tickets SET onsite_warning_at = now() - interval '5 minutes', "
        "onsite_due_at = now() + interval '25 minutes' WHERE id = :id",
        id=tid,
    )
    assert (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()[
        "onsite_status"
    ] == "warning"
    await _sql(
        engine,
        "UPDATE tickets SET onsite_warning_at = now() - interval '40 minutes', "
        "onsite_due_at = now() - interval '10 minutes' WHERE id = :id",
        id=tid,
    )
    q = (await client.get(f"{API}/my-queue", headers=an)).json()
    item = next(i for i in q["items"] if i["id"] == t["id"])
    assert item["section"] == "in_field" and item["onsite_status"] == "over"
    assert [r["code"] for r in item["reasons"]] == ["onsite_over"]
    # Em campo com alerta conta como atenção na visão da equipe.
    teams = (await client.get(f"{API}/queues", headers=an)).json()
    me = next(x for x in teams["queues"] if x["user"]["id"] == str(world.analyst.user.id))
    assert me["attention"] == 1 and me["in_field"] == 1

    # Prazo de chegada: em risco (falta menos de 1h) e atrasada.
    waiting = await create(client, world, title="Switch", **mine)
    wid = uuid.UUID(waiting["id"])
    await _sql(
        engine,
        "UPDATE tickets SET arrival_due_at = now() + interval '30 minutes' WHERE id = :id",
        id=wid,
    )
    q = (await client.get(f"{API}/my-queue", headers=an)).json()
    item = next(i for i in q["items"] if i["id"] == waiting["id"])
    assert item["arrival_status"] == "at_risk" and item["section"] == "attention"
    assert "arrival_at_risk" in [r["code"] for r in item["reasons"]]
    await _sql(
        engine,
        "UPDATE tickets SET arrival_due_at = now() - interval '5 minutes' WHERE id = :id",
        id=wid,
    )
    q = (await client.get(f"{API}/my-queue", headers=an)).json()
    item = next(i for i in q["items"] if i["id"] == waiting["id"])
    assert item["arrival_status"] == "late" and item["reasons"][0]["code"] == "arrival_late"



@requires_db
async def test_part_request_lifecycle(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(
        client,
        world,
        title="PDV não liga",
        owner_id=str(world.analyst.user.id),
        assignee_id=str(world.tech.user.id),
    )
    tid = t["id"]
    photo = await client.post(
        f"{API}/tickets/{tid}/attachments",
        files={"file": ("fonte.png", PNG, "image/png")},
        data={"kind": "photo"},
        headers=th,
    )
    assert photo.status_code == 201
    att = photo.json()["id"]
    body = {
        "description": "Fonte ATX  500W",
        "quantity": 1,
        "note": "Queimou",
        "attachment_ids": [att],
    }
    r = await client.post(f"{API}/tickets/{tid}/part-requests", json=body, headers=th)
    assert r.status_code == 201, r.text
    req = r.json()
    assert (req["description"], req["status"], req["unit"]) == ("Fonte ATX 500W", "open", "un")
    assert req["requested_by"]["name"] == "Tecnico"
    assert req["attachments"][0]["url"].startswith(f"{API}/attachments/{att}/download?token=")
    # Foto de outra OS, outro técnico e o solicitante ficam de fora.
    other = await create(client, world, title="Outra")
    bad = await client.post(f"{API}/tickets/{other['id']}/part-requests", json=body, headers=an)
    assert bad.status_code == 422
    stranger = await client.post(
        f"{API}/tickets/{tid}/part-requests", json=body, headers=world.tech_other.headers
    )
    assert stranger.status_code == 404
    listed = await client.get(f"{API}/tickets/{tid}/part-requests", headers=world.requester.headers)
    assert listed.status_code == 403

    q = (await client.get(f"{API}/my-queue", headers=an)).json()
    item = next(i for i in q["items"] if i["id"] == tid)
    assert "part_request" in [r["code"] for r in item["reasons"]]

    # A gestão monta o orçamento a partir do pedido e liga os dois.
    quote = (
        await client.post(
            f"{API}/tickets/{tid}/quotes",
            json={
                "title": "Troca da fonte",
                "items": [
                    {"description": "Fonte ATX 500W", "quantity": "1", "unit_price": "189.90"}
                ],
            },
            headers=an,
        )
    ).json()
    sent = (await client.post(f"{API}/quotes/{quote['id']}/send", headers=an)).json()
    linked = await client.patch(
        f"{API}/part-requests/{req['id']}", json={"quote_id": quote["id"]}, headers=an
    )
    assert linked.status_code == 200, linked.text
    assert linked.json()["status"] == "quoted" and linked.json()["quote_code"] == quote["code"]
    assert (
        await client.patch(
            f"{API}/part-requests/{req['id']}", json={"status": "cancelled"}, headers=th
        )
    ).status_code == 403

    # O cliente aprova pelo link: o pedido fica aprovado (e o técnico é avisado).
    approved = await client.post(
        f"{API}/public/quotes/{sent['token']}/approve",
        json={"name": "Paula Gerente", "signature": SIGNATURE, "accept": True},
    )
    assert approved.status_code == 200, approved.text
    detail = (await client.get(f"{API}/tickets/{tid}", headers=th)).json()
    assert detail["part_requests"][0]["status"] == "approved"
    events = (await client.get(f"{API}/tickets/{tid}/events", headers=an)).json()
    kinds = [e["event_type"] for e in events]
    assert "part_requested" in kinds and kinds.count("part_request_updated") == 2

    # Offline: pedido pela fila do app, sem duplicar no reenvio.
    op = {
        "client_op_id": "op-part-0001",
        "type": "part_request",
        "ticket_id": tid,
        "payload": {"description": "Cabo de força", "client_id": "app-123"},
    }
    r = await client.post(f"{API}/sync/push", json={"operations": [op]}, headers=th)
    assert r.json()["results"][0]["status"] == "applied"
    op2 = {**op, "client_op_id": "op-part-0002"}
    r = await client.post(f"{API}/sync/push", json={"operations": [op2]}, headers=th)
    assert r.json()["results"][0]["status"] == "applied"
    requests = (await client.get(f"{API}/tickets/{tid}/part-requests", headers=an)).json()
    assert [x["description"] for x in requests] == ["Fonte ATX 500W", "Cabo de força"]


@requires_db
async def test_recurrence_reports_and_client_report(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tech = str(world.tech.user.id)
    first = await create(client, world, title="Primeira", assignee_id=tech)
    await create(client, world, title="Segunda")
    third = await create(client, world, title="Terceira")
    other = await _location(client, world, "Loja Nova", "Curitiba", "PR")
    alone = await create(client, world, title="Sozinha", location_id=other)

    listing = (await client.get(f"{API}/tickets", headers=an)).json()["items"]
    counts = {i["title"]: i["recurrence_30d"] for i in listing}
    assert counts == {"Primeira": 2, "Segunda": 2, "Terceira": 2, "Sozinha": 0}
    detail = (await client.get(f"{API}/tickets/{third['id']}", headers=an)).json()
    assert detail["recurrence"]["count_30d"] == 2
    assert [p["title"] for p in detail["recurrence"]["previous"]] == ["Segunda", "Primeira"]
    assert detail["recurrence"]["previous"][0]["code"].startswith("OS-")
    assert (await client.get(f"{API}/tickets/{alone['id']}", headers=an)).json()["recurrence"][
        "count_30d"
    ] == 0

    # Chegada no prazo e tempo na loja entram no fechamento do dia e no relatório do cliente.
    t = await transition(client, th, first, "en_route")
    t = await transition(client, th, t, "in_progress")
    await _sql(
        engine, "UPDATE tickets SET work_seconds = 3600 WHERE id = :id", id=uuid.UUID(t["id"])
    )
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    t = await transition(client, th, t, "resolved", resolution_notes="Fonte trocada")
    today = datetime.now(ZoneInfo(settings.TIMEZONE)).date().isoformat()
    daily = (await client.get(f"{API}/reports/daily", params={"date": today}, headers=an)).json()
    n = daily["numbers"]
    assert (n["arrivals"], n["arrivals_on_time"], n["arrival_on_time_pct"]) == (1, 1, 100.0)
    assert n["avg_arrival_minutes"] == 0 and n["avg_onsite_minutes"] >= 60
    month = (
        await client.get(f"{API}/reports/monthly", params={"month": today[:7]}, headers=an)
    ).json()
    assert month["numbers"]["arrivals"] == 1

    link = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()["report_link"]
    rep = (await client.get(f"{API}/public/reports/{link['token']}")).json()
    assert rep["arrival_on_time"] is True and rep["arrival_minutes"] == 0
    assert rep["arrival_due_at"] == t["arrival_due_at"]


@requires_db
async def test_requester_does_not_see_part_requests(client: AsyncClient, world: World) -> None:
    req, th = world.requester.headers, world.tech.headers
    mine = (await client.post(f"{API}/tickets", json={"title": "Impressora"}, headers=req)).json()
    await client.post(
        f"{API}/tickets/{mine['id']}/assign",
        json={"assignee_id": str(world.tech.user.id)},
        headers=world.analyst.headers,
    )
    r = await client.post(
        f"{API}/tickets/{mine['id']}/part-requests", json={"description": "Rolo fusor"}, headers=th
    )
    assert r.status_code == 201, r.text
    seen = (await client.get(f"{API}/tickets/{mine['id']}", headers=req)).json()
    assert seen["part_requests"] == []
    events = (await client.get(f"{API}/tickets/{mine['id']}/events", headers=req)).json()
    assert all(e["event_type"] not in ("part_requested", "part_request_updated") for e in events)
