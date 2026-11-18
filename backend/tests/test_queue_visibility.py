"""Visibilidade de filas ("Somente a própria fila") em todos os pontos que mostram OS.

Cenário: o Analista A só vê a própria fila (com ou sem as OS sem analista) e o Analista B vê todas.
- T_A: dono A (técnico de campo executa); T_B: dono B (o mesmo técnico);
- T_U: sem analista; T_X: dono desativado (conta como sem analista);
- T_E: dono B, executada pelo próprio A.
"""

import dataclasses
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.api.routes import ws
from app.core import permissions
from app.core.config import settings
from app.core.enums import TicketPriority, TicketStatus, UserRole
from app.core.security import create_access_token
from app.models import Ticket
from app.schemas.ticket import format_ticket_code
from app.services.realtime import (
    Connection,
    ConnectionManager,
    PendingEvent,
    render_event,
    should_deliver,
)
from tests.conftest import World, requires_db
from tests.test_b2_forms import template as form_template

pytestmark = requires_db

API = settings.API_PREFIX
QUEUE_FORBIDDEN = {"detail": "Esta OS é de outra fila.", "code": "QUEUE_FORBIDDEN"}


@dataclass
class Scene:
    a: dict[str, str]  # headers do Analista A (só a própria fila)
    b: dict[str, str]  # headers do Analista B (todas as filas)
    a_id: str
    b_id: str
    x_id: str
    t_a: dict
    t_b: dict
    t_u: dict
    t_x: dict
    t_e: dict

    def code(self, ticket: dict) -> str:
        return format_ticket_code(ticket["number"])


async def _analyst(client: AsyncClient, world: World, name: str, email: str) -> dict:
    body = {"name": name, "email": email, "password": "senha-teste-123", "role": "analyst"}
    r = await client.post(f"{API}/users", json=body, headers=world.admin.headers)
    assert r.status_code == 201, r.text
    return r.json()


async def _ticket(client: AsyncClient, world: World, title: str, **extra: object) -> dict:
    body = {
        "title": title,
        "customer_id": world.customer_id,
        "location_id": world.location_id,
        **extra,
    }
    r = await client.post(f"{API}/tickets", json=body, headers=world.supervisor.headers)
    assert r.status_code == 201, r.text
    return r.json()


async def access_a(
    client: AsyncClient, world: World, *, unowned: bool = True, items: dict | None = None
) -> dict:
    """O Analista A só com a própria fila (com ou sem as sem analista) e as telas dadas."""
    overrides = {"items": items, "queue_scope": "own", "queue_unowned": unowned}
    r = await client.patch(
        f"{API}/users/{world.analyst.user.id}",
        json={"access": {"profile_id": None, "overrides": overrides}},
        headers=world.admin.headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["access"]["queues"] == {"scope": "own", "unowned": unowned}
    return r.json()


@pytest.fixture
async def scene(client: AsyncClient, world: World) -> Scene:
    b = await _analyst(client, world, "Analista B", "analista.b@teste.com.br")
    x = await _analyst(client, world, "Analista X", "analista.x@teste.com.br")
    a_id, tech = str(world.analyst.user.id), str(world.tech.user.id)
    t_a = await _ticket(client, world, "OS da fila A", owner_id=a_id, assignee_id=tech)
    t_b = await _ticket(client, world, "OS da fila B", owner_id=b["id"], assignee_id=tech)
    t_u = await _ticket(client, world, "OS sem analista", owner_id=None)
    t_x = await _ticket(client, world, "OS de analista desativado", owner_id=x["id"])
    t_e = await _ticket(
        client, world, "OS de B executada por A", owner_id=b["id"], assignee_id=a_id
    )
    # X sai da gestão: a OS dele vira "sem analista".
    r = await client.patch(
        f"{API}/users/{x['id']}", json={"is_active": False}, headers=world.admin.headers
    )
    assert r.status_code == 200, r.text
    await access_a(client, world, unowned=True)
    token_b = create_access_token(b["id"], "analyst")
    return Scene(
        a=world.analyst.headers,
        b={"Authorization": f"Bearer {token_b}"},
        a_id=a_id,
        b_id=b["id"],
        x_id=x["id"],
        t_a=t_a,
        t_b=t_b,
        t_u=t_u,
        t_x=t_x,
        t_e=t_e,
    )


async def _ids(client: AsyncClient, headers: dict, query: str = "") -> set[str]:
    r = await client.get(f"{API}/tickets?page_size=100{query}", headers=headers)
    assert r.status_code == 200, r.text
    return {t["id"] for t in r.json()["items"]}


def _local_day(days: int = 0) -> datetime:
    """Meia-noite (no fuso da operação) daqui a `days` dias."""
    now = datetime.now(ZoneInfo(settings.TIMEZONE))
    return now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=days)


def _q(value: datetime) -> str:
    return value.isoformat().replace("+", "%2B")


# ------------------------------------------------------------------------------- filas


async def test_team_queues_show_only_own_row(
    client: AsyncClient, world: World, scene: Scene
) -> None:
    data = (await client.get(f"{API}/queues", headers=scene.a)).json()
    assert data["scope"] == "own"
    assert [q["user"]["id"] for q in data["queues"]] == [scene.a_id]
    assert data["queues"][0]["open"] == 1  # T_A (T_E é da fila de B)
    assert data["unowned"]["open"] == 2  # T_U e T_X (dono desativado)
    assert data["total"]["open"] == 3

    await access_a(client, world, unowned=False)
    data = (await client.get(f"{API}/queues", headers=scene.a)).json()
    assert data["unowned"] is None
    assert data["total"]["open"] == 1

    full = (await client.get(f"{API}/queues", headers=scene.b)).json()
    assert full["scope"] == "all"
    rows = {q["user"]["id"]: q["open"] for q in full["queues"]}
    assert scene.x_id not in rows  # desativado não tem fila
    assert {scene.a_id, scene.b_id, str(world.admin.user.id)} <= set(rows)
    assert (rows[scene.a_id], rows[scene.b_id]) == (1, 2)
    assert full["unowned"]["open"] == 2
    assert full["total"]["open"] == 5


async def test_my_queue_of_another_analyst(client: AsyncClient, scene: Scene) -> None:
    r = await client.get(f"{API}/my-queue?user_id={scene.b_id}", headers=scene.a)
    assert r.status_code == 403
    assert r.json() == {"detail": "Seu acesso mostra só a sua fila.", "code": "QUEUE_FORBIDDEN"}
    other = await client.get(f"{API}/my-queue?user_id={scene.a_id}", headers=scene.b)
    assert other.status_code == 200 and other.json()["user"]["id"] == scene.a_id
    mine = (await client.get(f"{API}/my-queue", headers=scene.a)).json()
    assert {i["id"] for i in mine["items"]} == {scene.t_a["id"], scene.t_e["id"]}


async def test_ticket_list_and_filters(client: AsyncClient, world: World, scene: Scene) -> None:
    s = scene
    assert await _ids(client, s.a) == {s.t_a["id"], s.t_u["id"], s.t_x["id"], s.t_e["id"]}
    assert await _ids(client, s.a, f"&owner_id={s.b_id}") == set()  # a fila de B
    assert await _ids(client, s.a, "&no_owner=true") == {s.t_u["id"], s.t_x["id"]}
    assert await _ids(client, s.b, f"&owner_id={s.b_id}") == {s.t_b["id"], s.t_e["id"]}
    await access_a(client, world, unowned=False)
    assert await _ids(client, s.a) == {s.t_a["id"], s.t_e["id"]}
    assert await _ids(client, s.a, "&no_owner=true") == set()
    assert len(await _ids(client, s.b)) == 5


OTHER_QUEUE_CALLS: list[tuple[str, str, Any]] = [
    ("GET", "/tickets/{id}", None),
    ("PATCH", "/tickets/{id}", {"title": "Título trocado"}),
    ("POST", "/tickets/{id}/claim", None),
    ("POST", "/tickets/{id}/transition", {"to_status": "triage"}),
    ("POST", "/tickets/{id}/assign", {"assignee_id": None}),
    ("GET", "/tickets/{id}/comments", None),
    ("POST", "/tickets/{id}/comments", {"body": "Recado"}),
    ("GET", "/tickets/{id}/events", None),
    ("GET", "/tickets/{id}/worklogs", None),
    ("GET", "/tickets/{id}/attachments", None),
    ("GET", "/tickets/{id}/forms/suggestions", None),
    ("GET", "/tickets/{id}/quotes", None),
    ("POST", "/tickets/{id}/report-link", None),
    ("GET", "/tickets/{id}/messages", None),
    ("PUT", "/tickets/{id}/payouts/{tech}", {"amount": "10.00"}),
    ("GET", "/tickets/{id}/expenses", None),
    (
        "POST",
        "/tickets/{id}/expenses",
        {"kind": "material", "description": "Cabo", "quantity": 1, "unit_value": "10.00"},
    ),
    ("GET", "/tickets/{id}/part-requests", None),
    ("GET", "/tickets/{id}/technician-suggestions", None),
]


async def test_other_queue_ticket_is_forbidden_everywhere(
    client: AsyncClient, world: World, scene: Scene
) -> None:
    for method, path, body in OTHER_QUEUE_CALLS:
        url = API + path.format(id=scene.t_b["id"], tech=world.tech.user.id)
        r = await client.request(method, url, json=body, headers=scene.a)
        assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN), (method, path, r.text)
    # Quem vê todas as filas abre normalmente.
    assert (
        await client.get(f"{API}/tickets/{scene.t_b['id']}", headers=scene.b)
    ).status_code == 200
    # Técnico e cliente continuam com 404 na OS que não é deles.
    for headers in (world.tech_other.headers, world.requester.headers):
        r = await client.get(f"{API}/tickets/{scene.t_b['id']}", headers=headers)
        assert r.status_code == 404


async def test_claim_unowned_depends_on_the_option(
    client: AsyncClient, world: World, scene: Scene
) -> None:
    await access_a(client, world, unowned=False)
    url = f"{API}/tickets/{scene.t_u['id']}/claim"
    r = await client.post(url, headers=scene.a)
    assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN)
    await access_a(client, world, unowned=True)
    r = await client.post(url, headers=scene.a)
    assert r.status_code == 200, r.text
    assert r.json()["owner"]["id"] == scene.a_id


async def test_export_and_bulk_tags_skip_other_queues(client: AsyncClient, scene: Scene) -> None:
    s = scene
    r = await client.get(f"{API}/tickets/export?ids={s.t_a['id']}&ids={s.t_b['id']}", headers=s.a)
    assert r.status_code == 200, r.text
    assert s.t_a["title"] in r.text and s.t_b["title"] not in r.text
    r = await client.post(
        f"{API}/tickets/bulk-tags",
        json={"ids": [s.t_a["id"], s.t_b["id"]], "add": [{"name": "Lote"}]},
        headers=s.a,
    )
    assert r.status_code == 200, r.text
    assert r.json()["updated"] == 1


async def test_search_respects_the_queue(client: AsyncClient, scene: Scene) -> None:
    s = scene
    number = str(s.t_b["number"])
    found = (await client.get(f"{API}/search/smart?q={number}", headers=s.a)).json()
    assert s.t_b["id"] not in {t["id"] for t in found["tickets"]}
    assert not any(chip["kind"] == "number" for chip in found["chips"])
    seen = (await client.get(f"{API}/search/smart?q={number}", headers=s.b)).json()
    assert any(chip["kind"] == "number" for chip in seen["chips"])

    def open_count(result: dict) -> int:
        return next(c["open_count"] for c in result["customers"] if c["name"] == "Cliente Teste")

    q = "Cliente Teste"
    assert open_count((await client.get(f"{API}/search/smart?q={q}", headers=s.a)).json()) == 4
    assert open_count((await client.get(f"{API}/search/smart?q={q}", headers=s.b)).json()) == 5


async def test_home_respects_queue_and_screens(
    client: AsyncClient, world: World, scene: Scene
) -> None:
    s = scene
    cost = {"kind": "material", "description": "Conector", "quantity": 1, "unit_value": "5.00"}
    for t in (s.t_a, s.t_b):
        r = await client.post(
            f"{API}/tickets/{t['id']}/expenses", json=cost, headers=world.supervisor.headers
        )
        assert r.status_code == 201, r.text

    data = (await client.get(f"{API}/home/overview", headers=s.a)).json()
    assert data["kpis"]["open"] == 4
    items = [i["ticket_id"] for g in data["attention"] for i in g["items"]]
    assert s.t_b["id"] not in items
    groups = {g["key"]: g for g in data["attention"]}
    assert groups["costs_pending"]["count"] == 1  # só o custo de T_A
    assert data["pulse"]["finance"] is not None
    assert data["pulse"]["finance"]["costs_pending"] == 1
    assert (await client.get(f"{API}/home/overview", headers=s.b)).json()["kpis"]["open"] == 5

    await access_a(client, world, items={"commercial.expenses": "none"})
    data = (await client.get(f"{API}/home/overview", headers=s.a)).json()
    assert "costs_pending" not in {g["key"] for g in data["attention"]}
    assert data["pulse"]["finance"] is None  # precisa de Custos extras e de Pagamentos
    assert data["pulse"]["quotes"] is not None
    await access_a(client, world, items={"commercial.quotes": "none"})
    assert (await client.get(f"{API}/home/overview", headers=s.a)).json()["pulse"]["quotes"] is None


async def test_calendar_and_conflicts_redact_other_queues(
    client: AsyncClient, world: World, scene: Scene
) -> None:
    s = scene
    at = _local_day(1) + timedelta(hours=10)
    r = await client.patch(
        f"{API}/tickets/{s.t_b['id']}",
        json={"scheduled_start": at.isoformat()},
        headers=world.supervisor.headers,
    )
    assert r.status_code == 200, r.text
    later = at + timedelta(hours=4)
    r = await client.patch(
        f"{API}/tickets/{s.t_a['id']}", json={"scheduled_start": later.isoformat()}, headers=s.a
    )
    assert r.status_code == 200, r.text

    window = f"start={_q(_local_day(1))}&end={_q(_local_day(2))}"
    seen = {e["id"] for e in (await client.get(f"{API}/calendar?{window}", headers=s.a)).json()}
    assert seen == {s.t_a["id"]}
    seen_b = {e["id"] for e in (await client.get(f"{API}/calendar?{window}", headers=s.b)).json()}
    assert seen_b == {s.t_a["id"], s.t_b["id"]}

    tech = world.tech.user.id
    url = f"{API}/calendar/conflicts?start={_q(at)}&assignee_id={tech}&exclude_id={s.t_a['id']}"
    hidden = (await client.get(url, headers=s.a)).json()
    assert len(hidden) == 1
    item = hidden[0]
    assert (item["hidden"], item["id"], item["code"], item["customer"], item["location"]) == (
        True,
        None,
        None,
        None,
        None,
    )
    assert item["title"] == "OS de outra fila" and item["who"] == "Tecnico"
    full = (await client.get(url, headers=s.b)).json()
    assert (full[0]["hidden"], full[0]["code"]) == (False, s.code(s.t_b))

    # Ao salvar, o 409 traz a mesma redação.
    r = await client.patch(
        f"{API}/tickets/{s.t_a['id']}", json={"scheduled_start": at.isoformat()}, headers=s.a
    )
    assert r.status_code == 409, r.text
    assert r.json()["code"] == "SCHEDULE_CONFLICT"
    assert [(c["hidden"], c["id"], c["title"]) for c in r.json()["conflicts"]] == [
        (True, None, "OS de outra fila")
    ]


async def test_reports_and_dashboard_count_only_visible(
    client: AsyncClient, world: World, scene: Scene
) -> None:
    s, adm = scene, world.admin.headers
    summary = await client.get(f"{API}/dashboard/summary", headers=s.a)
    assert summary.json()["open_total"] == 4
    assert (await client.get(f"{API}/dashboard/summary", headers=adm)).json()["open_total"] == 5
    monthly = (await client.get(f"{API}/reports/monthly", headers=s.a)).json()
    assert monthly["numbers"]["opened"] == 4
    assert (await client.get(f"{API}/reports/monthly", headers=adm)).json()["numbers"][
        "opened"
    ] == 5
    today = _local_day().date().isoformat()
    daily = (await client.get(f"{API}/reports/daily?date={today}", headers=s.a)).json()
    assert daily["numbers"]["opened"] == 4
    daily_all = (await client.get(f"{API}/reports/daily?date={today}", headers=adm)).json()
    assert daily_all["numbers"]["opened"] == 5


async def test_commercial_lists_and_actions(
    client: AsyncClient, world: World, scene: Scene
) -> None:
    s, sup = scene, world.supervisor.headers
    tech = world.tech.user.id
    quote = {
        "title": "Troca de peça",
        "items": [{"description": "Peça", "quantity": 1, "unit_price": 50}],
    }
    quote_ids = {}
    for name, t in (("a", s.t_a), ("b", s.t_b)):
        r = await client.post(f"{API}/tickets/{t['id']}/quotes", json=quote, headers=sup)
        assert r.status_code == 201, r.text
        quote_ids[name] = r.json()["id"]
    rows = (await client.get(f"{API}/quotes", headers=s.a)).json()
    assert {q["ticket_code"] for q in rows} == {s.code(s.t_a)}
    summary = (await client.get(f"{API}/quotes/summary", headers=s.a)).json()
    assert summary["by_status"]["draft"]["count"] == 1
    r = await client.put(f"{API}/quotes/{quote_ids['b']}", json=quote, headers=s.a)
    assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN)
    r = await client.post(f"{API}/quotes/{quote_ids['b']}/cancel", headers=s.a)
    assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN)

    cost = {
        "kind": "material",
        "description": "Conector",
        "quantity": 1,
        "unit_value": "5.00",
        "status": "approved",
    }
    expense_ids = {}
    for name, t in (("a", s.t_a), ("b", s.t_b)):
        r = await client.post(f"{API}/tickets/{t['id']}/expenses", json=cost, headers=sup)
        assert r.status_code == 201, r.text
        expense_ids[name] = r.json()["id"]
        r = await client.put(
            f"{API}/tickets/{t['id']}/payouts/{tech}", json={"amount": "80.00"}, headers=sup
        )
        assert r.status_code == 200, r.text
    period = f"start={_q(_local_day(-1))}&end={_q(_local_day(1))}"
    report = (await client.get(f"{API}/expenses?{period}", headers=s.a)).json()
    assert {e["ticket"]["id"] for e in report["items"]} == {s.t_a["id"]}
    r = await client.post(
        f"{API}/expenses/mark-paid", json={"ids": [expense_ids["b"]]}, headers=s.a
    )
    assert r.json() == {"updated": 0}
    r = await client.patch(f"{API}/expenses/{expense_ids['b']}", json={"quantity": 2}, headers=s.a)
    assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN)

    payouts = (await client.get(f"{API}/payouts", headers=s.a)).json()["items"]
    assert {p["ticket"]["id"] for p in payouts} == {s.t_a["id"]}
    every = (await client.get(f"{API}/payouts", headers=sup)).json()["items"]
    other = next(p["id"] for p in every if p["ticket"]["id"] == s.t_b["id"])
    mine = next(p["id"] for p in every if p["ticket"]["id"] == s.t_a["id"])
    assert (await client.post(f"{API}/payouts/pay", json={"ids": [other]}, headers=s.a)).json() == {
        "changed": 0
    }
    assert (
        await client.post(f"{API}/payouts/pay", json={"ids": [other, mine]}, headers=s.a)
    ).json() == {"changed": 1}


async def test_day_activities_respect_the_queue(
    client: AsyncClient, world: World, scene: Scene
) -> None:
    s, sup = scene, world.supervisor.headers
    tomorrow = _local_day(1)
    for t, hour in ((s.t_a, 9), (s.t_b, 15)):
        at = (tomorrow + timedelta(hours=hour)).isoformat()
        r = await client.patch(
            f"{API}/tickets/{t['id']}", json={"scheduled_start": at}, headers=sup
        )
        assert r.status_code == 200, r.text
    url = f"{API}/activities/day?date={tomorrow.date().isoformat()}"
    seen = {a["ticket"]["id"] for a in (await client.get(url, headers=s.a)).json()["activities"]}
    assert seen == {s.t_a["id"]}
    seen_b = {a["ticket"]["id"] for a in (await client.get(url, headers=s.b)).json()["activities"]}
    assert {s.t_a["id"], s.t_b["id"]} <= seen_b


async def test_live_map_hides_other_queue_ticket(
    client: AsyncClient, world: World, scene: Scene, engine: AsyncEngine
) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE tickets SET status = 'in_progress' WHERE id = :i"),
            {"i": scene.t_b["id"]},
        )
    tech = str(world.tech.user.id)

    def row(data: list[dict]) -> dict:
        return next(t for t in data if t["id"] == tech)

    mine = row((await client.get(f"{API}/tracking/live", headers=scene.a)).json())
    assert (mine["current_ticket"], mine["current_ticket_hidden"]) == (None, True)
    full = row((await client.get(f"{API}/tracking/live", headers=scene.b)).json())
    assert full["current_ticket"]["id"] == scene.t_b["id"]
    assert full["current_ticket_hidden"] is False


async def test_portal_intake_and_recurrence(
    client: AsyncClient, world: World, scene: Scene, engine: AsyncEngine
) -> None:
    s = scene
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE tickets SET source = 'portal' WHERE id = :i"), {"i": s.t_u["id"]}
        )
    inbox = f"{API}/portal/inbox-count"
    assert (await client.get(inbox, headers=s.a)).json() == {"pending": 1}
    intake = f"{API}/intake/context?location_id={world.location_id}"
    assert (await client.get(intake, headers=s.a)).json()["other_queues_open"] == 1  # T_B
    assert (await client.get(intake, headers=s.b)).json()["other_queues_open"] == 0

    detail = (await client.get(f"{API}/tickets/{s.t_a['id']}", headers=s.a)).json()
    assert detail["recurrence"]["count_30d"] == 3
    previous = {p["id"] for p in detail["recurrence"]["previous"]}
    assert previous == {s.t_u["id"], s.t_x["id"], s.t_e["id"]}
    full = (await client.get(f"{API}/tickets/{s.t_a['id']}", headers=s.b)).json()
    assert full["recurrence"]["count_30d"] == 4

    await access_a(client, world, unowned=False)
    assert (await client.get(inbox, headers=s.a)).json() == {"pending": 0}
    assert (await client.get(inbox, headers=s.b)).json() == {"pending": 1}
    assert (await client.get(intake, headers=s.a)).json()["other_queues_open"] == 3


async def test_lookup_by_number(client: AsyncClient, world: World, scene: Scene) -> None:
    s = scene
    url = f"{API}/tickets/lookup?number="
    r = await client.get(url + str(s.t_b["number"]), headers=s.a)
    assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN)
    r = await client.get(url + str(s.t_a["number"]), headers=s.a)
    assert r.json() == {"id": s.t_a["id"], "code": s.code(s.t_a)}
    assert (await client.get(url + "999999", headers=s.a)).status_code == 404
    for headers in (world.tech_other.headers, world.requester.headers):
        assert (await client.get(url + str(s.t_a["number"]), headers=headers)).status_code == 404


async def test_full_access_without_profile(
    client: AsyncClient, world: World, scene: Scene, engine: AsyncEngine
) -> None:
    """Regressão: admin, supervisor sem perfil e analista sem perfil veem tudo, como antes."""
    for headers in (world.admin.headers, world.supervisor.headers, scene.b):
        assert len(await _ids(client, headers)) == 5
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE users SET access_profile_id = NULL, access_overrides = NULL WHERE id = :i"
            ),
            {"i": scene.b_id},
        )
    assert len(await _ids(client, scene.b)) == 5
    me = (await client.get(f"{API}/auth/me", headers=scene.b)).json()
    assert me["access"]["queues"] == {"scope": "all", "unowned": True}


async def test_passing_ticket_to_another_queue(client: AsyncClient, scene: Scene) -> None:
    s = scene
    r = await client.patch(f"{API}/tickets/{s.t_a['id']}", json={"owner_id": s.b_id}, headers=s.a)
    assert r.status_code == 200, r.text
    r = await client.get(f"{API}/tickets/{s.t_a['id']}", headers=s.a)
    assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN)
    # O evento da troca leva os ids (a web compara por id).
    events = (await client.get(f"{API}/tickets/{s.t_a['id']}/events", headers=s.b)).json()
    moved = next(e for e in events if e["event_type"] == "owner_changed")
    assert (moved["data"]["from_id"], moved["data"]["to_id"]) == (s.a_id, s.b_id)


async def test_passing_to_another_queue_goes_last(
    client: AsyncClient, world: World, scene: Scene
) -> None:
    """O Salvar da OS (GeneralTab) troca o técnico e os horários antes do analista responsável:
    depois da troca de fila, a OS já não é de quem salva e o resto daria 403."""
    s = scene
    await access_a(client, world, unowned=False)
    url = f"{API}/tickets/{s.t_a['id']}"
    version = (await client.get(url, headers=s.a)).json()["version"]
    r = await client.patch(
        url, json={"title": "Título novo", "expected_version": version}, headers=s.a
    )
    assert r.status_code == 200, r.text
    other_tech = str(world.tech_other.user.id)
    r = await client.post(
        f"{url}/assign",
        json={"assignee_id": other_tech, "expected_version": r.json()["version"]},
        headers=s.a,
    )
    assert r.status_code == 200, r.text
    r = await client.patch(
        url, json={"owner_id": s.b_id, "expected_version": r.json()["version"]}, headers=s.a
    )
    assert r.status_code == 200, r.text
    after = (await client.get(url, headers=s.b)).json()
    assert (after["title"], after["owner"]["id"]) == ("Título novo", s.b_id)
    assert after["assignee"]["id"] == other_tech
    # Por isso a fila vai por último: já não dá para mexer na OS.
    r = await client.post(
        f"{url}/assign",
        json={"assignee_id": str(world.tech.user.id), "expected_version": after["version"]},
        headers=s.a,
    )
    assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN)


async def test_new_ticket_without_owner_gets_forms_before_leaving(
    client: AsyncClient, world: World, scene: Scene
) -> None:
    """Nova OS "Sem analista" de quem não vê as OS sem analista: a tela cria na fila de quem abre,
    anexa os formulários e só no fim deixa a OS sem analista (direto sem analista, os formulários
    dariam 403 e a OS ficaria sem os obrigatórios)."""
    s = scene
    tpl = await form_template(client, world)
    await access_a(client, world, unowned=False)
    body = {"title": "OS nova", "customer_id": world.customer_id, "location_id": world.location_id}
    r = await client.post(f"{API}/tickets", json=body, headers=s.a)
    assert r.status_code == 201, r.text
    tid = r.json()["id"]
    assert r.json()["owner"]["id"] == s.a_id  # sem owner_id, quem abre assume
    r = await client.post(
        f"{API}/tickets/{tid}/forms", json={"template_id": tpl["id"], "required": True}, headers=s.a
    )
    assert r.status_code == 201, r.text
    version = (await client.get(f"{API}/tickets/{tid}", headers=s.a)).json()["version"]
    r = await client.patch(
        f"{API}/tickets/{tid}", json={"owner_id": None, "expected_version": version}, headers=s.a
    )
    assert r.status_code == 200, r.text
    detail = (await client.get(f"{API}/tickets/{tid}", headers=s.b)).json()
    assert detail["owner"] is None and len(detail["forms"]) == 1
    # E saiu da fila de quem criou.
    r = await client.get(f"{API}/tickets/{tid}", headers=s.a)
    assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN)


# ------------------------------------------------------------------------------- tempo real


def test_should_deliver_follows_the_queue() -> None:
    me, other = "analista-a", "analista-b"
    own = permissions.Access(
        full=False,
        items=dict(permissions.ROLE_DEFAULTS["analyst"]),
        queue_scope="own",
        queue_unowned=True,
    )

    def event(**audience: Any) -> dict[str, Any]:
        base = {"owner_id": None, "assignee_id": None, "unowned": False, "managers_only": False}
        return {"type": "ticket.updated", "ticket_id": "os-1", "audience": {**base, **audience}}

    def deliver(ev: dict[str, Any], access: permissions.Access | None = own) -> bool:
        return should_deliver(
            user_id=me, role=UserRole.ANALYST, team_id=None, event=ev, access=access
        )

    assert deliver(event(owner_id=me))
    assert deliver(event(owner_id=other, assignee_id=me))  # executor
    assert deliver(event(owner_id=other, previous_owner_id=me))  # passou para outra fila
    assert deliver(event(unowned=True))
    assert not deliver(event(owner_id=other))
    assert not deliver(event(unowned=True), dataclasses.replace(own, queue_unowned=False))
    assert deliver(event(owner_id=other), None)  # sem acesso informado: como antes
    assert deliver({"type": "technician.location", "audience": {}})  # não é de OS

    # Posição e jornada dos técnicos (nome e GPS ao vivo): só com o Mapa ao vivo, como o
    # /tracking/*.
    no_map = dataclasses.replace(own, items={**own.items, "operation.map": "none"})
    for kind in ("technician.location", "technician.shift"):
        ping = {"type": kind, "user_id": "tecnico", "audience": {"managers_only": True}}
        assert deliver(ping)  # padrão do analista: Mapa em Visualizar
        assert deliver(ping, None)  # sem acesso informado: como antes
        assert not deliver(ping, no_map)
        admin = permissions.FULL_ACCESS
        assert should_deliver(
            user_id=me, role=UserRole.ADMIN, team_id=None, event=ping, access=admin
        )

    changed = {"type": "access.changed", "audience": {"user_ids": [me]}}
    assert deliver(changed)
    assert not should_deliver(
        user_id=other, role=UserRole.ADMIN, team_id=None, event=changed, access=None
    )

    decided = {"type": "quote.decided", "ticket_id": "os-1", "audience": {"owner_id": me}}
    no_quotes = dataclasses.replace(
        own, items={**own.items, "commercial.quotes": "none"}, queue_scope="all"
    )
    assert not deliver(decided, no_quotes)
    assert deliver(decided)


def test_session_ok_checks_the_access_fingerprint() -> None:
    user = SimpleNamespace(
        is_active=True,
        role=UserRole.ANALYST,
        team_id=None,
        access_overrides=None,
        token_revoked=lambda _payload: False,
    )
    payload = {"exp": int(time.time()) + 600}
    fp = permissions.of(user).fingerprint
    now = time.time()
    assert ws.session_ok(user, payload, role=UserRole.ANALYST, team_id=None, now=now, access_fp=fp)
    assert not ws.session_ok(
        user, payload, role=UserRole.ANALYST, team_id=None, now=now, access_fp="0" * 16
    )
    # Sem o fingerprint, a regra de antes.
    assert ws.session_ok(user, payload, role=UserRole.ANALYST, team_id=None, now=now)


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed_with: int | None = None

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed_with = code


async def test_access_changed_reaches_only_the_target_and_reconnects() -> None:
    manager = ConnectionManager()
    target, other = FakeSocket(), FakeSocket()
    for socket, user_id in ((target, "analista-a"), (other, "analista-b")):
        manager.add(
            Connection(ws=socket, user_id=user_id, role=UserRole.ANALYST, team_id=None)  # type: ignore[arg-type]
        )
    await manager.dispatch({"type": "access.changed", "audience": {"user_ids": ["analista-a"]}})
    assert target.sent == [{"type": "access.changed"}]
    assert target.closed_with == 4401  # reconecta com o acesso novo
    assert (other.sent, other.closed_with) == ([], None)
    assert manager.count == 1


def test_render_event_carries_the_owner() -> None:
    """O aviso leva o analista responsável (a web avisa só a fila dele) e se a OS está sem
    analista, sem ir ao banco."""
    owner = uuid.uuid4()
    ticket = Ticket(
        id=uuid.uuid4(),
        number=7,
        status=TicketStatus.NEW,
        priority=TicketPriority.MEDIUM,
        owner_id=owner,
        version=1,
    )
    previous = uuid.uuid4()
    ev = render_event(PendingEvent("updated", ticket, None, previous_owner_id=previous))
    assert ev["owner_id"] == str(owner)
    assert ev["audience"]["owner_id"] == str(owner)
    assert ev["audience"]["previous_owner_id"] == str(previous)
    assert ev["audience"]["unowned"] is False  # dono não carregado: na dúvida, não é
    ticket.owner_id = None
    assert render_event(PendingEvent("updated", ticket, None))["audience"]["unowned"] is True
