"""Fluxo completo da OS pela API, contra PostgreSQL."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX


async def create(client: AsyncClient, world: World, **extra: object) -> dict:
    body = {
        "title": "Impressora atolando",
        "description": "Bandeja 2",
        "customer_id": world.customer_id,
        "location_id": world.location_id,
        **extra,
    }
    r = await client.post(f"{API}/tickets", json=body, headers=world.supervisor.headers)
    assert r.status_code == 201, r.text
    return r.json()


async def transition(
    client: AsyncClient, headers: dict, ticket: dict, to: str, **extra: object
) -> dict:
    r = await client.post(
        f"{API}/tickets/{ticket['id']}/transition",
        json={"to_status": to, "expected_version": ticket["version"], **extra},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


async def test_login_and_me(client: AsyncClient, world: World) -> None:
    r = await client.post(
        f"{API}/auth/login", json={"email": "tecnico@teste.com.br", "password": "senha-teste-123"}
    )
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    me = await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.json()["role"] == "analyst"

    bad = await client.post(
        f"{API}/auth/login", json={"email": "tecnico@teste.com.br", "password": "errada"}
    )
    assert bad.status_code == 401


async def test_meta_is_public(client: AsyncClient) -> None:
    r = await client.get(f"{API}/meta")
    assert r.status_code == 200
    values = {s["value"] for s in r.json()["statuses"]}
    assert {"new", "in_progress", "on_hold_customer", "resolved", "closed"} <= values


async def test_full_lifecycle(client: AsyncClient, world: World) -> None:
    t = await create(client, world, impact="high", urgency="high")
    assert t["code"].startswith("OS-")
    assert t["status"] == "new"
    assert t["priority"] == "critical"
    assert t["resolution_due_at"] is not None

    # Supervisor atribui ao técnico: vira "assigned" e herda o grupo do técnico.
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": str(world.tech.user.id), "expected_version": t["version"]},
        headers=world.supervisor.headers,
    )
    assert r.status_code == 200, r.text
    t = r.json()
    assert t["status"] == "assigned"
    assert t["assignee"]["id"] == str(world.tech.user.id)
    assert t["team"]["id"] == world.team_field_id
    assert t["first_response_at"] is not None

    # Técnico vê só os botões válidos.
    r = await client.get(f"{API}/tickets/{t['id']}", headers=world.tech.headers)
    assert "in_progress" in r.json()["allowed_transitions"]
    assert "resolved" not in r.json()["allowed_transitions"]

    t = await transition(client, world.tech.headers, t, "en_route", latitude=-23.5, longitude=-46.6)
    t = await transition(client, world.tech.headers, t, "in_progress")

    # Pendência de fornecedor pausa o SLA e empurra o prazo ao retomar.
    due_before = datetime.fromisoformat(t["resolution_due_at"])
    t = await transition(client, world.tech.headers, t, "on_hold_vendor", note="Peça")
    assert t["sla_status"] == "paused"
    t = await transition(client, world.tech.headers, t, "in_progress")
    assert datetime.fromisoformat(t["resolution_due_at"]) >= due_before
    assert t["sla_paused_at"] is None

    # Resolver exige a solução.
    r = await client.post(
        f"{API}/tickets/{t['id']}/transition",
        json={"to_status": "resolved"},
        headers=world.tech.headers,
    )
    assert r.status_code == 422
    t = await transition(
        client, world.tech.headers, t, "resolved", resolution_notes="Rolete trocado"
    )
    assert t["resolved_at"] is not None
    assert t["sla_status"] == "met"

    r = await client.post(
        f"{API}/tickets/{t['id']}/transition",
        json={"to_status": "closed"},
        headers=world.supervisor.headers,
    )
    assert r.json()["status"] == "closed"
    assert r.json()["allowed_transitions"] == []

    events = (
        await client.get(f"{API}/tickets/{t['id']}/events", headers=world.admin.headers)
    ).json()
    kinds = [e["event_type"] for e in events]
    assert kinds.count("status_changed") >= 6
    assert "assigned" in kinds and "created" in kinds


async def test_invalid_transition_is_rejected(client: AsyncClient, world: World) -> None:
    t = await create(client, world)
    r = await client.post(
        f"{API}/tickets/{t['id']}/transition",
        json={"to_status": "resolved", "resolution_notes": "x"},
        headers=world.supervisor.headers,
    )
    assert r.status_code == 422
    assert "não permitida" in r.json()["detail"]


async def test_version_conflict(client: AsyncClient, world: World) -> None:
    t = await create(client, world)
    stale = t["version"]
    await transition(client, world.supervisor.headers, t, "triage")
    r = await client.post(
        f"{API}/tickets/{t['id']}/transition",
        json={"to_status": "cancelled", "note": "dup", "expected_version": stale},
        headers=world.supervisor.headers,
    )
    assert r.status_code == 409


async def test_analyst_visibility_and_take(client: AsyncClient, world: World) -> None:
    net_ticket = await create(client, world, team_id=world.team_net_id)
    queue_ticket = await create(client, world)  # sem grupo: fila geral

    r = await client.get(f"{API}/tickets/{net_ticket['id']}", headers=world.tech.headers)
    assert r.status_code == 404
    listing = (await client.get(f"{API}/tickets", headers=world.tech.headers)).json()
    ids = {i["id"] for i in listing["items"]}
    assert queue_ticket["id"] in ids and net_ticket["id"] not in ids

    r = await client.post(f"{API}/tickets/{queue_ticket['id']}/take", headers=world.tech.headers)
    assert r.status_code == 200, r.text
    assert r.json()["assignee"]["id"] == str(world.tech.user.id)
    assert r.json()["status"] == "assigned"

    # Analista não atribui OS para outra pessoa.
    r = await client.post(
        f"{API}/tickets/{queue_ticket['id']}/assign",
        json={"assignee_id": str(world.tech_other.user.id)},
        headers=world.tech.headers,
    )
    assert r.status_code == 403


async def test_analyst_auto_assigns_when_starting(client: AsyncClient, world: World) -> None:
    t = await create(client, world, team_id=world.team_field_id)
    t = await transition(client, world.supervisor.headers, t, "triage")
    t = await transition(client, world.tech.headers, t, "assigned")
    assert t["assignee"]["id"] == str(world.tech.user.id)


async def test_requester_flow_and_internal_notes(client: AsyncClient, world: World) -> None:
    r = await client.post(
        f"{API}/tickets",
        json={
            "title": "PC sem rede",
            "priority": "critical",
            "assignee_id": str(world.tech.user.id),
        },
        headers=world.requester.headers,
    )
    assert r.status_code == 201, r.text
    t = r.json()
    assert t["priority"] == "medium"  # solicitante não escolhe prioridade
    assert t["assignee"] is None
    assert t["requester"]["id"] == str(world.requester.user.id)

    await client.post(
        f"{API}/tickets/{t['id']}/comments",
        json={"body": "nota interna", "is_internal": True},
        headers=world.supervisor.headers,
    )
    await client.post(
        f"{API}/tickets/{t['id']}/comments",
        json={"body": "Estamos verificando"},
        headers=world.supervisor.headers,
    )
    seen = (
        await client.get(f"{API}/tickets/{t['id']}/comments", headers=world.requester.headers)
    ).json()
    assert [c["body"] for c in seen] == ["Estamos verificando"]

    # Solicitante cancela enquanto ninguém pegou.
    r = await client.post(
        f"{API}/tickets/{t['id']}/transition",
        json={"to_status": "cancelled", "note": "Resolvi sozinho"},
        headers=world.requester.headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled"


async def test_requester_reply_resumes_on_hold(client: AsyncClient, world: World) -> None:
    r = await client.post(
        f"{API}/tickets", json={"title": "Câmera offline"}, headers=world.requester.headers
    )
    t = r.json()
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": str(world.tech.user.id)},
        headers=world.supervisor.headers,
    )
    t = await transition(client, world.tech.headers, r.json(), "on_hold_customer")
    await client.post(
        f"{API}/tickets/{t['id']}/comments",
        json={"body": "Pode vir amanhã às 9h"},
        headers=world.requester.headers,
    )
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=world.tech.headers)).json()
    assert t["status"] == "assigned"
    assert t["sla_paused_at"] is None


async def test_worklog_and_attachment(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    t = await create(client, world, assignee_id=str(world.tech.user.id))
    start = datetime.now(UTC) - timedelta(hours=1)
    r = await client.post(
        f"{API}/tickets/{t['id']}/worklogs",
        json={
            "description": "Limpeza do fusor",
            "started_at": start.isoformat(),
            "ended_at": (start + timedelta(minutes=35)).isoformat(),
        },
        headers=world.tech.headers,
    )
    assert r.status_code == 201, r.text
    assert r.json()["minutes"] == 35

    r = await client.post(
        f"{API}/tickets/{t['id']}/attachments",
        files={"file": ("foto.jpg", b"\xff\xd8fake-jpeg", "image/jpeg")},
        data={"kind": "photo"},
        headers=world.tech.headers,
    )
    assert r.status_code == 201, r.text
    url = r.json()["download_url"]
    download = await client.get(url)
    assert download.status_code == 200
    assert download.content == b"\xff\xd8fake-jpeg"


async def test_list_filters_and_sla_breached(client: AsyncClient, world: World) -> None:
    await create(client, world, title="Switch caiu", impact="high", urgency="high")
    await create(client, world, title="Trocar mouse", impact="low", urgency="low")

    r = await client.get(
        f"{API}/tickets",
        params={"priority": "critical", "order_by": "priority"},
        headers=world.admin.headers,
    )
    assert [i["title"] for i in r.json()["items"]] == ["Switch caiu"]

    r = await client.get(f"{API}/tickets", params={"q": "mouse"}, headers=world.admin.headers)
    assert r.json()["total"] == 1

    r = await client.get(
        f"{API}/tickets", params={"status": ["new", "assigned"]}, headers=world.admin.headers
    )
    assert r.json()["total"] == 2

    r = await client.get(
        f"{API}/tickets", params={"sla_breached": "true"}, headers=world.admin.headers
    )
    assert r.json()["total"] == 0


async def test_dashboard(client: AsyncClient, world: World) -> None:
    await create(client, world)
    await create(client, world, assignee_id=str(world.tech.user.id))
    r = await client.get(f"{API}/dashboard/summary", headers=world.supervisor.headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["open_total"] == 2
    assert data["unassigned"] == 1
    assert data["created_today"] == 2
    assert data["by_assignee"][0]["open"] == 1


async def test_sync_pull_and_idempotent_push(client: AsyncClient, world: World) -> None:
    t = await create(client, world, assignee_id=str(world.tech.user.id))

    pulled = (await client.get(f"{API}/sync/pull", headers=world.tech.headers)).json()
    assert t["id"] in {x["id"] for x in pulled["tickets"]}
    cursor = pulled["server_time"]

    ops = {
        "operations": [
            {
                "client_op_id": "op-0001-aaaa",
                "type": "transition",
                "ticket_id": t["id"],
                "payload": {"to_status": "en_route", "latitude": -23.5, "longitude": -46.6},
            },
            {
                "client_op_id": "op-0002-bbbb",
                "type": "comment",
                "ticket_id": t["id"],
                "payload": {"body": "Cheguei no cliente"},
            },
            {
                "client_op_id": "op-0003-cccc",
                "type": "transition",
                "ticket_id": t["id"],
                "payload": {"to_status": "closed"},
            },
        ]
    }
    r = await client.post(f"{API}/sync/push", json=ops, headers=world.tech.headers)
    assert r.status_code == 200, r.text
    statuses = [res["status"] for res in r.json()["results"]]
    assert statuses == ["applied", "applied", "rejected"]
    assert r.json()["results"][0]["ticket"]["status"] == "en_route"

    # Reenvio do mesmo lote (app perdeu a resposta): nada é aplicado de novo.
    r = await client.post(f"{API}/sync/push", json=ops, headers=world.tech.headers)
    assert [res["status"] for res in r.json()["results"]] == ["duplicate"] * 3
    comments = (
        await client.get(f"{API}/tickets/{t['id']}/comments", headers=world.tech.headers)
    ).json()
    assert len(comments) == 1

    delta = (
        await client.get(f"{API}/sync/pull", params={"since": cursor}, headers=world.tech.headers)
    ).json()
    assert [x["id"] for x in delta["tickets"]] == [t["id"]]
    assert len(delta["comments"]) == 1

    # Reatribuída a outro técnico: o app do primeiro recebe o id em revoked_ticket_ids.
    current = (await client.get(f"{API}/tickets/{t['id']}", headers=world.admin.headers)).json()
    await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={
            "assignee_id": str(world.tech_other.user.id),
            "team_id": world.team_net_id,
            "expected_version": current["version"],
        },
        headers=world.supervisor.headers,
    )
    delta = (
        await client.get(f"{API}/sync/pull", params={"since": cursor}, headers=world.tech.headers)
    ).json()
    assert t["id"] in delta["revoked_ticket_ids"]
