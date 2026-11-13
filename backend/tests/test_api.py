"""Fluxo completo da OS pela API, contra PostgreSQL."""

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

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
    assert me.json()["role"] == "technician"

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

    async def office() -> dict:
        r = await client.get(f"{API}/tickets/{t['id']}", headers=world.analyst.headers)
        return r.json()

    # Pendência de fornecedor pausa o SLA e empurra o prazo ao retomar. Os prazos são da gestão:
    # o técnico (terceiro) recebe a OS sem eles.
    assert t["resolution_due_at"] is None and t["response_due_at"] is None
    due_before = datetime.fromisoformat((await office())["resolution_due_at"])
    # O técnico não pausa (o tempo dele só para ao concluir): a pendência é da central.
    r = await client.post(
        f"{API}/tickets/{t['id']}/transition",
        json={"to_status": "on_hold_vendor", "note": "Peça"},
        headers=world.tech.headers,
    )
    assert r.status_code == 403
    t = await transition(client, world.analyst.headers, t, "on_hold_vendor", note="Peça")
    assert (await office())["sla_status"] == "paused"
    t = await transition(client, world.tech.headers, t, "in_progress")
    seen = await office()
    assert datetime.fromisoformat(seen["resolution_due_at"]) >= due_before
    assert seen["sla_paused_at"] is None

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
    assert (await office())["sla_status"] == "met"

    r = await client.post(
        f"{API}/tickets/{t['id']}/transition",
        json={"to_status": "closed"},
        headers=world.supervisor.headers,
    )
    assert r.json()["status"] == "closed"
    # Fechada: a central só pode reabrir (com motivo).
    assert r.json()["allowed_transitions"] == ["reopened"]

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


async def test_technician_sees_only_assigned(client: AsyncClient, world: World) -> None:
    # Dinâmica: o cliente abre a OS, o analista coloca o técnico nela, e só então ele a vê.
    # Do grupo dele, mas sem responsável: continua invisível para ele.
    team_ticket = await create(client, world, team_id=world.team_field_id)
    queue_ticket = await create(client, world)  # fila geral
    mine = await create(client, world, assignee_id=str(world.tech.user.id))

    # O técnico não lista OS pela API: o app usa o sync, que só traz as dele.
    assert (await client.get(f"{API}/tickets", headers=world.tech.headers)).status_code == 403
    pulled = (await client.get(f"{API}/sync/pull", headers=world.tech.headers)).json()
    assert {i["id"] for i in pulled["tickets"]} == {mine["id"]}
    for other in (team_ticket, queue_ticket):
        r = await client.get(f"{API}/tickets/{other['id']}", headers=world.tech.headers)
        assert r.status_code == 404

    # Não assume da fila nem atribui a outra pessoa.
    r = await client.post(f"{API}/tickets/{queue_ticket['id']}/take", headers=world.tech.headers)
    assert r.status_code in (403, 404)
    r = await client.post(
        f"{API}/tickets/{mine['id']}/assign",
        json={"assignee_id": str(world.tech_other.user.id)},
        headers=world.tech.headers,
    )
    assert r.status_code == 403

    # O analista o coloca na OS do grupo: agora ela aparece e ele pode atender.
    r = await client.post(
        f"{API}/tickets/{team_ticket['id']}/assign",
        json={"assignee_id": str(world.tech.user.id)},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    detail = (
        await client.get(f"{API}/tickets/{team_ticket['id']}", headers=world.tech.headers)
    ).json()
    assert "in_progress" in detail["allowed_transitions"]


async def test_clients_only_use_the_portal(client: AsyncClient, world: World) -> None:
    """O cliente abre e acompanha pelo portal; as rotas internas não mostram nada a ele."""
    req = world.requester.headers
    t = await create(client, world, title="PC sem rede")  # da empresa dele, aberta pela central
    assert (await client.get(f"{API}/tickets", headers=req)).status_code == 403
    by_internal = await client.post(f"{API}/tickets", json={"title": "Pelo atalho"}, headers=req)
    assert by_internal.status_code == 403
    for path in (f"/tickets/{t['id']}", f"/tickets/{t['id']}/expenses"):
        assert (await client.get(f"{API}{path}", headers=req)).status_code == 404, path
    for path in ("/customers", "/locations", "/teams", "/categories", "/dashboard/summary"):
        assert (await client.get(f"{API}{path}", headers=req)).status_code == 403, path
    # Pelo portal ele acompanha a OS da empresa dele.
    seen = await client.get(f"{API}/portal/requests/{t['id']}", headers=req)
    assert seen.status_code == 200 and seen.json()["code"] == t["code"]


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
        headers=world.analyst.headers,
    )
    assert r.status_code == 201, r.text
    assert r.json()["minutes"] == 35
    # Horas só a gestão aponta: o tempo do técnico é o da OS (do início à conclusão).
    r = await client.post(
        f"{API}/tickets/{t['id']}/worklogs",
        json={"description": "x", "started_at": start.isoformat(), "minutes": 10},
        headers=world.tech.headers,
    )
    assert r.status_code == 403 and "horário" in r.json()["detail"]

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
    # Acompanhamento não faz parte do app do técnico (a central fala com ele pelo WhatsApp).
    assert statuses == ["applied", "rejected", "rejected"]
    assert "WhatsApp" in r.json()["results"][1]["error"]
    assert r.json()["results"][0]["ticket"]["status"] == "en_route"

    # Reenvio do mesmo lote (app perdeu a resposta): nada é aplicado de novo.
    r = await client.post(f"{API}/sync/push", json=ops, headers=world.tech.headers)
    assert [res["status"] for res in r.json()["results"]] == ["duplicate"] * 3
    comments_url = f"{API}/tickets/{t['id']}/comments"
    assert (await client.get(comments_url, headers=world.tech.headers)).status_code == 403
    assert (await client.get(comments_url, headers=world.analyst.headers)).json() == []

    delta = (
        await client.get(f"{API}/sync/pull", params={"since": cursor}, headers=world.tech.headers)
    ).json()
    assert [x["id"] for x in delta["tickets"]] == [t["id"]]
    assert delta["comments"] == []

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


async def test_analyst_manages_everything_on_web(client: AsyncClient, world: World) -> None:
    # OS do grupo Redes, do qual o analista não faz parte: mesmo assim ele vê e gerencia.
    t = await create(client, world, team_id=world.team_net_id)
    listing = (await client.get(f"{API}/tickets", headers=world.analyst.headers)).json()
    assert t["id"] in {i["id"] for i in listing["items"]}

    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=world.analyst.headers)).json()
    assert detail["can_assign"] and detail["can_edit"]

    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": str(world.tech_other.user.id), "expected_version": detail["version"]},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    t = await transition(client, world.analyst.headers, r.json(), "in_progress")
    r = await client.patch(
        f"{API}/tickets/{t['id']}",
        json={"priority": "high", "expected_version": t["version"]},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["priority"] == "high"

    # Cadastro operacional e abertura de OS já atribuída a um técnico.
    r = await client.post(
        f"{API}/customers", json={"name": "Novo cliente"}, headers=world.analyst.headers
    )
    assert r.status_code == 201, r.text
    r = await client.post(
        f"{API}/tickets",
        json={"title": "Troca de toner", "assignee_id": str(world.tech.user.id)},
        headers=world.analyst.headers,
    )
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "assigned"

    data = (await client.get(f"{API}/dashboard/summary", headers=world.analyst.headers)).json()
    assert data["open_total"] == 2


async def test_analyst_self_assigns_when_starting(client: AsyncClient, world: World) -> None:
    t = await create(client, world)
    t = await transition(client, world.analyst.headers, t, "assigned")
    assert t["assignee"]["id"] == str(world.analyst.user.id)


async def test_technician_scope_is_restricted(client: AsyncClient, world: World) -> None:
    r = await client.post(f"{API}/customers", json={"name": "X"}, headers=world.tech.headers)
    assert r.status_code == 403
    t = await create(client, world, assignee_id=str(world.tech.user.id))
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=world.tech.headers)).json()
    assert detail["can_assign"] is False
    # Editar a OS (escopo, agenda) é da central; no app ele só anda com a visita.
    assert detail["can_edit"] is False
    assert set(detail["allowed_transitions"]) <= {"en_route", "in_progress", "resolved"}
    th = world.tech.headers
    url = f"{API}/tickets/{t['id']}"
    edit = await client.patch(url, json={"scheduled_start": "2030-01-01T10:00:00Z"}, headers=th)
    assert edit.status_code == 403
    # Nem pela mudança de status ele mexe no horário (agendar, ou mandar a hora junto).
    for body in (
        {"to_status": "scheduled", "scheduled_start": "2030-01-01T10:00:00Z"},
        {"to_status": "en_route", "scheduled_start": "2030-01-01T10:00:00Z"},
        {"to_status": "on_hold_customer"},
        {"to_status": "cancelled", "note": "x"},
    ):
        assert (await client.post(f"{url}/transition", json=body, headers=th)).status_code == 403

    # O técnico é terceiro: fora das OS dele (pelo app) não vê cadastros, usuários, painéis,
    # relatórios nem as notas e o histórico das OS.
    blocked = (
        "/users",
        "/users/assignable",
        f"/users/{world.analyst.user.id}",
        "/teams",
        "/customers",
        f"/customers/{world.customer_id}",
        f"/customers/{world.customer_id}/locations",
        "/locations",
        f"/locations/{world.location_id}",
        "/assets",
        "/dashboard/summary",
        "/reports/sla-violations",
        "/activities/day",
        "/categories",
        "/sla-policies",
        "/service-types",
        "/tickets",
        f"/tickets/{t['id']}/comments",
        f"/tickets/{t['id']}/events",
    )
    for path in blocked:
        assert (await client.get(f"{API}{path}", headers=th)).status_code == 403, path
    # O que o app usa continua liberado.
    for path in (
        "/violation-reasons",
        "/unproductive-reasons",
        "/settings/field",
        f"/tickets/{t['id']}/attachments",
        f"/tickets/{t['id']}/worklogs",
    ):
        assert (await client.get(f"{API}{path}", headers=th)).status_code == 200, path


async def test_access_channels(client: AsyncClient, world: World) -> None:
    async def login(email: str, channel: str, password: str = "senha-teste-123"):  # noqa: ANN202
        return await client.post(
            f"{API}/auth/login", json={"email": email, "password": password, "channel": channel}
        )

    # Navegador: analistas, gestores e o portal do solicitante. Celular: técnicos de campo.
    r = await login("tecnico@teste.com.br", "web")
    assert r.status_code == 403
    assert "app" in r.json()["detail"]
    r = await login("analista@teste.com.br", "mobile")
    assert r.status_code == 403
    assert "navegador" in r.json()["detail"]
    assert (await login("analista@teste.com.br", "web")).status_code == 200
    assert (await login("super@teste.com.br", "web")).status_code == 200
    assert (await login("cliente@teste.com.br", "web")).status_code == 200
    r = await login("tecnico@teste.com.br", "mobile")
    assert r.status_code == 200
    refresh_token = r.json()["refresh_token"]

    # Senha errada é 401 em qualquer canal: não revela o papel de ninguém.
    assert (await login("tecnico@teste.com.br", "web", password="errada")).status_code == 401

    # Técnico promovido a analista: a sessão do app termina na próxima renovação.
    r = await client.patch(
        f"{API}/users/{world.tech.user.id}", json={"role": "analyst"}, headers=world.admin.headers
    )
    assert r.status_code == 200, r.text
    r = await client.post(f"{API}/auth/refresh", json={"refresh_token": refresh_token})
    assert r.status_code == 401

    meta = (await client.get(f"{API}/meta")).json()
    assert meta["access_channels"]["mobile"] == ["technician"]


async def test_locations_are_first_class(client: AsyncClient, world: World) -> None:
    from app.core.documents import cnpj_with_check_digits

    doc = cnpj_with_check_digits("112223330041")
    formatted = f"{doc[:2]}.{doc[2:5]}.{doc[5:8]}/{doc[8:12]}-{doc[12:]}"
    r = await client.post(
        f"{API}/customers/{world.customer_id}/locations",
        json={"name": "Loja 41 - Outlet", "code": "LJ-41", "document": formatted},
        headers=world.analyst.headers,
    )
    assert r.status_code == 201, r.text
    loja = r.json()
    assert loja["document"] == doc  # guardado sem pontuação
    bad = await client.post(
        f"{API}/customers/{world.customer_id}/locations",
        json={"name": "Loja X", "document": "11.222.333/0001-00"},
        headers=world.analyst.headers,
    )
    assert bad.status_code == 422

    # Endereço do atendimento separado do endereço do local.
    t1 = await create(client, world, location_id=loja["id"], service_address="Doca 3, fundos")
    assert t1["service_address"] == "Doca 3, fundos"
    assert t1["location"]["code"] == "LJ-41"
    t2 = await create(client, world, location_id=loja["id"])
    await transition(client, world.supervisor.headers, t2, "cancelled", note="Duplicada")
    await create(client, world)  # outro local do mesmo cliente

    page = (
        await client.get(f"{API}/locations", params={"q": "lj-41"}, headers=world.analyst.headers)
    ).json()
    assert page["total"] == 1
    item = page["items"][0]
    assert (item["total_tickets"], item["open_tickets"]) == (2, 1)
    assert item["last_ticket_at"] is not None
    by_cnpj = (
        await client.get(
            f"{API}/locations", params={"q": formatted[:10]}, headers=world.analyst.headers
        )
    ).json()
    assert [i["id"] for i in by_cnpj["items"]] == [loja["id"]]

    # Métricas são do próprio cliente, não um total global (defeito visto no Field Control).
    r = await client.post(
        f"{API}/customers", json={"name": "Outro cliente"}, headers=world.analyst.headers
    )
    other_id = r.json()["id"]
    customers = {
        c["id"]: c
        for c in (await client.get(f"{API}/customers", headers=world.analyst.headers)).json()
    }
    mine = customers[world.customer_id]
    assert (mine["total_tickets"], mine["open_tickets"], mine["locations_count"]) == (3, 2, 2)
    assert customers[other_id]["total_tickets"] == 0

    r = await client.get(
        f"{API}/tickets", params={"location_id": loja["id"]}, headers=world.analyst.headers
    )
    assert r.json()["total"] == 2

    bad_customer = await client.post(
        f"{API}/customers",
        json={"name": "CNPJ errado", "document": "11.222.333/0001-80"},
        headers=world.analyst.headers,
    )
    assert bad_customer.status_code == 422


async def test_service_type_estimate_learns(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    h = world.analyst.headers
    r = await client.post(
        f"{API}/service-types",
        json={"name": "Impressora A4 - Instalação", "estimated_minutes": 20},
        headers=h,
    )
    assert r.status_code == 201, r.text
    st = r.json()
    assert (st["observed_count"], st["suggested_minutes"]) == (0, None)

    # A OS herda a estimativa do tipo; agendar só com o início usa a estimativa para o fim.
    t = await create(client, world, service_type_id=st["id"], assignee_id=str(world.tech.user.id))
    assert t["estimated_minutes"] == 20
    assert t["service_type"]["name"] == "Impressora A4 - Instalação"
    start = datetime(2026, 12, 1, 13, 0, tzinfo=UTC)
    t = await transition(
        client, world.analyst.headers, t, "scheduled", scheduled_start=start.isoformat()
    )
    assert datetime.fromisoformat(t["scheduled_end"]) == start + timedelta(minutes=20)

    # A duração real vem do tempo em "Em atendimento".
    t = await transition(client, world.tech.headers, t, "in_progress")
    assert t["work_started_at"] is not None
    t = await transition(client, world.tech.headers, t, "resolved", resolution_notes="Instalada")
    assert t["work_started_at"] is None
    ids = [t["id"]]
    for _ in range(2):
        x = await create(
            client, world, service_type_id=st["id"], assignee_id=str(world.tech.user.id)
        )
        x = await transition(client, world.tech.headers, x, "in_progress")
        x = await transition(client, world.tech.headers, x, "resolved", resolution_notes="ok")
        ids.append(x["id"])

    # O que aconteceu de verdade: 3h55, 2h e 3h (a estimativa era 20 min).
    async with engine.begin() as conn:
        for ticket_id, minutes in zip(ids, (235, 120, 180), strict=True):
            await conn.execute(
                text("UPDATE tickets SET work_seconds = :s WHERE id = :i"),
                {"s": minutes * 60, "i": uuid.UUID(ticket_id)},
            )

    listed = {x["id"]: x for x in (await client.get(f"{API}/service-types", headers=h)).json()}
    st = listed[st["id"]]
    assert st["observed_count"] == 3
    assert st["observed_median_minutes"] == 180.0
    assert st["suggested_minutes"] == 180

    r = await client.post(f"{API}/service-types/{st['id']}/apply-observed", headers=h)
    assert r.status_code == 200, r.text
    assert (r.json()["estimated_minutes"], r.json()["suggested_minutes"]) == (180, None)

    # A OS antiga mantém a estimativa com que foi agendada e mostra o real ao lado.
    old = (await client.get(f"{API}/tickets/{ids[0]}", headers=h)).json()
    assert (old["estimated_minutes"], old["actual_minutes"]) == (20, 235)
    r = await client.get(f"{API}/tickets", params={"service_type_id": st["id"]}, headers=h)
    assert r.json()["total"] == 3


async def test_customer_specific_service_type(client: AsyncClient, world: World) -> None:
    h = world.analyst.headers
    other = (await client.post(f"{API}/customers", json={"name": "Outro"}, headers=h)).json()
    st = (
        await client.post(
            f"{API}/service-types",
            json={
                "name": "Preventiva de loja - Outro",
                "estimated_minutes": 240,
                "customer_id": other["id"],
            },
            headers=h,
        )
    ).json()
    r = await client.post(
        f"{API}/tickets",
        json={"title": "Preventiva", "customer_id": world.customer_id, "service_type_id": st["id"]},
        headers=world.supervisor.headers,
    )
    assert r.status_code == 422
    mine = (
        await client.get(
            f"{API}/service-types", params={"customer_id": world.customer_id}, headers=h
        )
    ).json()
    assert st["id"] not in {x["id"] for x in mine}


async def test_day_activities(client: AsyncClient, world: World) -> None:
    from zoneinfo import ZoneInfo

    h, tech_h = world.analyst.headers, world.tech.headers
    tech_id = str(world.tech.user.id)

    # Dia futuro: só a visita agendada para ele, com o horário previsto.
    start = datetime(2030, 1, 15, 13, 0, tzinfo=ZoneInfo(settings.TIMEZONE))
    a = await create(client, world, title="Visita agendada", assignee_id=tech_id)
    a = await transition(client, h, a, "scheduled", scheduled_start=start.isoformat())
    day = (
        await client.get(f"{API}/activities/day", params={"date": "2030-01-15"}, headers=h)
    ).json()
    assert [x["ticket"]["id"] for x in day["activities"]] == [a["id"]]
    assert day["activities"][0]["state"] == "scheduled"
    assert day["summary"]["scheduled"] == 1
    assert day["is_today"] is False

    # Hoje: uma em atendimento (com GPS no deslocamento) e uma concluída.
    b = await create(client, world, title="Em atendimento", assignee_id=tech_id)
    b = await transition(client, tech_h, b, "en_route", latitude=-23.56, longitude=-46.65)
    b = await transition(client, tech_h, b, "in_progress")
    c = await create(client, world, title="Concluída", assignee_id=tech_id)
    c = await transition(client, tech_h, c, "in_progress")
    c = await transition(client, tech_h, c, "resolved", resolution_notes="ok")
    await create(client, world, title="Só aberta, sem agenda")

    today = (await client.get(f"{API}/activities/day", headers=h)).json()
    assert today["is_today"] is True
    by_id = {x["ticket"]["id"]: x for x in today["activities"]}
    assert set(by_id) == {b["id"], c["id"]}  # a agendada é de outro dia; a só aberta não entra
    assert by_id[b["id"]]["state"] == "in_progress"
    assert by_id[b["id"]]["started_at"] and by_id[b["id"]]["arrived_at"]
    assert by_id[b["id"]]["start_has_gps"] is True
    assert by_id[c["id"]]["state"] == "done"
    assert by_id[c["id"]]["finished_at"] is not None
    assert (today["summary"]["in_progress"], today["summary"]["done"]) == (1, 1)

    # Técnico de campo (terceiro) não vê o painel do dia: ele usa o app, com as OS dele.
    other = await client.get(f"{API}/activities/day", headers=world.tech_other.headers)
    assert other.status_code == 403


async def test_day_activities_follow_the_clock(client: AsyncClient, world: World) -> None:
    """Atividades do dia pela hora de atuação, a manhã primeiro (não pelo nome do técnico)."""
    from zoneinfo import ZoneInfo

    h = world.analyst.headers
    tz = ZoneInfo(settings.TIMEZONE)
    plan = (  # "Redes" vem antes de "Tecnico" no alfabeto, mas a visita dele é mais tarde
        ("Tarde", str(world.tech_other.user.id), datetime(2030, 2, 4, 14, 0, tzinfo=tz)),
        ("Manhã cedo", str(world.tech.user.id), datetime(2030, 2, 4, 8, 0, tzinfo=tz)),
        ("Fim da manhã", str(world.tech_other.user.id), datetime(2030, 2, 4, 11, 30, tzinfo=tz)),
    )
    for title, tech_id, start in plan:
        t = await create(client, world, title=title, assignee_id=tech_id)
        await transition(client, h, t, "scheduled", scheduled_start=start.isoformat())
    day = (
        await client.get(f"{API}/activities/day", params={"date": "2030-02-04"}, headers=h)
    ).json()
    assert [a["ticket"]["title"] for a in day["activities"]] == [
        "Manhã cedo",
        "Fim da manhã",
        "Tarde",
    ]


async def test_day_activities_carry_over_and_rescheduled(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    tech_h, tech_id = world.tech.headers, str(world.tech.user.id)

    # Em atendimento desde ontem: aparece hoje (está em campo) com o início real de ontem.
    b = await create(client, world, title="Em campo desde ontem", assignee_id=tech_id)
    b = await transition(client, tech_h, b, "en_route")
    b = await transition(client, tech_h, b, "in_progress")
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE ticket_events SET created_at = created_at - interval '1 day' "
                "WHERE ticket_id = :i"
            ),
            {"i": uuid.UUID(b["id"])},
        )

    # Atendida hoje e remarcada para outro dia: "reagendada", não "na fila".
    c = await create(client, world, title="Nova visita", assignee_id=tech_id)
    c = await transition(client, tech_h, c, "in_progress")
    c = await transition(
        client, world.analyst.headers, c, "scheduled", scheduled_start="2030-01-20T10:00:00-03:00"
    )

    today = (await client.get(f"{API}/activities/day", headers=world.analyst.headers)).json()
    by_id = {x["ticket"]["id"]: x for x in today["activities"]}
    assert by_id[b["id"]]["state"] == "in_progress"
    assert by_id[b["id"]]["started_at"] is not None
    assert by_id[b["id"]]["arrived_at"] is None  # a chegada não foi hoje
    assert by_id[c["id"]]["state"] == "rescheduled"
    assert today["summary"]["rescheduled"] == 1


async def test_violation_reasons(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    sup, an, tech_h = world.supervisor.headers, world.analyst.headers, world.tech.headers

    async def reason(name: str, scope: str, responsibility: str) -> str:
        r = await client.post(
            f"{API}/violation-reasons",
            json={"name": name, "applies_to": scope, "responsibility": responsibility},
            headers=sup,
        )
        assert r.status_code == 201, r.text
        return r.json()["id"]

    slow_triage = await reason("Triagem demorada", "response", "internal")
    no_part = await reason("Peça em falta no fornecedor", "resolution", "third_party")

    t = await create(client, world, assignee_id=str(world.tech.user.id))
    # Os dois prazos já venceram (simula uma OS que furou resposta e solução).
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE tickets SET response_due_at = created_at - interval '1 minute', "
                "resolution_due_at = created_at - interval '1 minute' WHERE id = :i"
            ),
            {"i": uuid.UUID(t["id"])},
        )
    t = await transition(client, tech_h, t, "in_progress")

    # O relógio errado é recusado.
    r = await client.post(
        f"{API}/tickets/{t['id']}/transition",
        json={
            "to_status": "resolved",
            "resolution_notes": "Peça trocada",
            "resolution_violation_reason_id": slow_triage,
        },
        headers=tech_h,
    )
    assert r.status_code == 422

    # O técnico resolve informando só o motivo da solução: fica pendente o da resposta.
    t = await transition(
        client,
        tech_h,
        t,
        "resolved",
        resolution_notes="Peça trocada",
        resolution_violation_reason_id=no_part,
    )
    # O técnico não recebe os prazos nem os motivos (são da gestão); a gestão vê tudo.
    assert (t["response_breached"], t["resolution_breached"]) == (False, False)
    assert t["resolution_violation_reason"] is None
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert (t["response_breached"], t["resolution_breached"]) == (True, True)
    assert t["resolution_violation_reason"]["name"] == "Peça em falta no fornecedor"
    assert t["violation_reason_pending"] is True
    pending = await client.get(f"{API}/tickets", params={"violation_pending": "true"}, headers=an)
    assert pending.json()["total"] == 1

    # Fechada pelo supervisor e justificada depois pelo analista.
    t = await transition(client, sup, t, "closed")
    r = await client.patch(
        f"{API}/tickets/{t['id']}/violation",
        json={"response_violation_reason_id": slow_triage, "violation_note": "Fila acumulada"},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert r.json()["violation_reason_pending"] is False
    assert r.json()["violation_note"] == "Fila acumulada"
    pending = await client.get(f"{API}/tickets", params={"violation_pending": "true"}, headers=an)
    assert pending.json()["total"] == 0

    report = (await client.get(f"{API}/reports/sla-violations", headers=an)).json()
    assert (report["response"]["breached"], report["response"]["justified"]) == (1, 1)
    assert report["resolution"]["by_reason"][0]["name"] == "Peça em falta no fornecedor"
    assert report["by_responsibility"] == {"internal": 1, "customer": 0, "third_party": 1}
    assert report["pending_justification"] == 0

    # Técnico de outro grupo não justifica OS que não é dele.
    r = await client.patch(
        f"{API}/tickets/{t['id']}/violation",
        json={"violation_note": "x"},
        headers=world.tech_other.headers,
    )
    assert r.status_code in (403, 404)
