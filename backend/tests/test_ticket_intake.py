"""Abertura da OS: nº do chamado do cliente, observação da visita, outros técnicos da visita,
contexto do cliente/loja, sugestão de técnicos e "assumir" (vai para a fila do analista)."""

import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import TicketStatus, UserRole
from app.models import Customer, Location, Ticket
from app.services.push import _push_targets
from app.services.realtime import should_deliver
from tests.conftest import World, requires_db
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX


def _tomorrow(hour: int, minute: int = 0) -> datetime:
    now = datetime.now(ZoneInfo(settings.TIMEZONE))
    return (now + timedelta(days=1)).replace(hour=hour, minute=minute, second=0, microsecond=0)


async def test_create_with_reference_note_and_helpers(client: AsyncClient, world: World) -> None:
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    t = await create(
        client,
        world,
        client_reference="  INC   2041 ",
        visit_note="  Falar com o gerente Carlos. Acesso pela doca.  ",
        assignee_id=tech,
        # O responsável repetido na lista é ignorado.
        helper_ids=[other, tech, other],
    )
    assert t["client_reference"] == "INC 2041"
    assert t["visit_note"] == "Falar com o gerente Carlos. Acesso pela doca."
    assert [h["id"] for h in t["helpers"]] == [other]

    # Busca pelo nº do chamado do cliente.
    found = (
        await client.get(f"{API}/tickets", params={"q": "inc 2041"}, headers=world.analyst.headers)
    ).json()
    assert [item["id"] for item in found["items"]] == [t["id"]]

    events = (
        await client.get(f"{API}/tickets/{t['id']}/events", headers=world.analyst.headers)
    ).json()
    created = next(e for e in events if e["event_type"] == "created")
    assert created["data"]["helpers"] == ["Redes"]

    # O outro técnico vê a OS no app (lista "minhas" e detalhe), comenta e aponta horas...
    helper = world.tech_other.headers
    mine = (await client.get(f"{API}/tickets", params={"mine": "true"}, headers=helper)).json()
    assert [item["id"] for item in mine["items"]] == [t["id"]]
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=helper)).json()
    assert detail["visit_note"].startswith("Falar com o gerente")
    # ...mas iniciar, concluir e editar a OS ficam com o responsável.
    assert detail["allowed_transitions"] == []
    assert detail["can_edit"] is False
    r = await client.post(
        f"{API}/tickets/{t['id']}/comments", json={"body": "Cheguei junto"}, headers=helper
    )
    assert r.status_code == 201, r.text
    r = await client.post(
        f"{API}/tickets/{t['id']}/worklogs",
        json={"description": "Cabeamento", "started_at": datetime.now(UTC).isoformat(), "minutes": 30},
        headers=helper,
    )
    assert r.status_code == 201, r.text
    r = await client.patch(f"{API}/tickets/{t['id']}", json={"title": "Outro"}, headers=helper)
    assert r.status_code == 403


async def test_update_helpers(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    t = await create(client, world, assignee_id=tech)
    url = f"{API}/tickets/{t['id']}"

    # Só a gestão escolhe; técnico (mesmo o responsável) não.
    r = await client.patch(url, json={"helper_ids": [other]}, headers=world.tech.headers)
    assert r.status_code == 403
    r = await client.patch(url, json={"helper_ids": [str(world.requester.user.id)]}, headers=an)
    assert r.status_code == 422 and "inválido" in r.json()["detail"]

    r = await client.patch(url, json={"helper_ids": [other]}, headers=an)
    assert r.status_code == 200, r.text
    assert [h["name"] for h in r.json()["helpers"]] == ["Redes"]
    assert (await client.get(url, headers=world.tech_other.headers)).status_code == 200
    events = (await client.get(f"{url}/events", headers=an)).json()
    changed = next(e for e in events if e["event_type"] == "helpers_changed")
    assert changed["data"] == {"added": ["Redes"], "removed": []}

    # Virar responsável tira da lista de outros técnicos.
    r = await client.post(f"{url}/assign", json={"assignee_id": other}, headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["assignee"]["id"] == other and r.json()["helpers"] == []

    r = await client.patch(url, json={"helper_ids": [tech]}, headers=an)
    assert [h["id"] for h in r.json()["helpers"]] == [tech]
    r = await client.patch(url, json={"helper_ids": []}, headers=an)
    assert r.json()["helpers"] == []
    # Saiu da visita: não vê mais a OS.
    assert (await client.get(url, headers=world.tech.headers)).status_code == 404


async def test_helpers_share_the_schedule(client: AsyncClient, world: World) -> None:
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    await create(
        client,
        world,
        title="Visita das 10h",
        assignee_id=other,
        scheduled_start=_tomorrow(10).isoformat(),
        estimated_minutes=60,
    )
    slot = {"scheduled_start": _tomorrow(10, 30).isoformat(), "estimated_minutes": 60}
    body = {"title": "Rack", "customer_id": world.customer_id, **slot}
    r = await client.post(
        f"{API}/tickets",
        json={**body, "assignee_id": tech, "helper_ids": [other]},
        headers=world.supervisor.headers,
    )
    assert r.status_code == 409, r.text
    assert r.json()["conflicts"][0]["who"] == "Redes"
    assert r.json()["detail"] == "Redes já tem 1 OS neste horário."

    r = await client.post(
        f"{API}/tickets",
        json={**body, "assignee_id": tech, "helper_ids": [other], "allow_conflict": True},
        headers=world.supervisor.headers,
    )
    assert r.status_code == 201, r.text
    # A visita em que ele vai junto também ocupa a agenda dele.
    r = await client.post(
        f"{API}/tickets",
        json={**body, "title": "Outra", "assignee_id": other},
        headers=world.supervisor.headers,
    )
    assert r.status_code == 409
    assert {c["title"] for c in r.json()["conflicts"]} == {"Visita das 10h", "Rack"}


async def test_assume_goes_to_my_queue(client: AsyncClient, world: World) -> None:
    an, analyst_id = world.analyst.headers, str(world.analyst.user.id)
    body = {"title": "Switch sem link", "customer_id": world.customer_id}

    # Quem abre assume (vai para a fila dele); null deixa sem analista, para alguém assumir.
    mine = (await client.post(f"{API}/tickets", json=body, headers=an)).json()
    assert mine["owner"]["id"] == analyst_id
    pool = (await client.post(f"{API}/tickets", json={**body, "owner_id": None}, headers=an)).json()
    assert pool["owner"] is None
    claimed = await client.post(f"{API}/tickets/{pool['id']}/claim", headers=an)
    assert claimed.json()["owner"]["id"] == analyst_id

    # Atender eu mesmo (take) leva para a minha fila, mesmo vindo da fila de outro analista.
    other = await create(client, world, title="Da fila do supervisor")
    assert other["owner"]["id"] == str(world.supervisor.user.id)
    took = (await client.post(f"{API}/tickets/{other['id']}/take", headers=an)).json()
    assert took["owner"]["id"] == analyst_id and took["assignee"]["id"] == analyst_id

    # Técnico não assume nem tem fila.
    assert (
        await client.post(f"{API}/tickets/{pool['id']}/claim", headers=world.tech.headers)
    ).status_code == 403


async def test_intake_context(client: AsyncClient, engine: AsyncEngine, world: World) -> None:
    an = world.analyst.headers
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        customer = await db.get(Customer, uuid.UUID(world.customer_id))
        assert customer is not None
        customer.tags = [{"name": "Contrato", "color": "indigo"}]
        customer.legacy = {"rating": {"average": 4.25, "last_star": 5}}
        location = await db.get(Location, uuid.UUID(world.location_id))
        assert location is not None
        location.city, location.state = "São Paulo", "SP"
        location.address_line = "Av. Paulista, 1000"
        location.latitude, location.longitude = -14.235, -51.925  # centro do Brasil: inválida
        await db.commit()

    done = await create(client, world, title="Troca de toner", assignee_id=str(world.tech.user.id))
    await create(client, world, title="Agendada", scheduled_start=_tomorrow(9).isoformat())
    async with maker() as db:
        ticket = await db.get(Ticket, uuid.UUID(done["id"]))
        assert ticket is not None
        ticket.status = TicketStatus.CLOSED
        ticket.resolved_at = ticket.closed_at = datetime.now(UTC) - timedelta(days=2)
        await db.commit()

    r = await client.get(
        f"{API}/intake/context", params={"location_id": world.location_id}, headers=an
    )
    assert r.status_code == 200, r.text
    ctx = r.json()
    assert ctx["upcoming_days"] == 7
    assert ctx["customer"]["tags"] == [{"name": "Contrato", "color": "indigo"}]
    assert ctx["customer"]["rating_average"] == 4.2 and ctx["customer"]["rating_last"] == 5
    assert ctx["customer"]["total_tickets"] == 2 and ctx["customer"]["upcoming"] == 1
    loc = ctx["location"]
    assert loc["total_tickets"] == 2 and loc["open_tickets"] == 1 and loc["tickets_30d"] == 2
    assert loc["last_visit"]["code"] == done["code"]
    assert loc["last_visit"]["technician"] == "Tecnico"
    assert loc["is_capital"] is True and loc["arrival_hours"] == 4
    assert loc["latitude"] is None  # coordenada de preenchimento não vale

    # Só o cliente (sem loja) também serve; técnico não acessa.
    r = await client.get(
        f"{API}/intake/context", params={"customer_id": world.customer_id}, headers=an
    )
    assert r.json()["location"] is None and r.json()["customer"]["name"] == "Cliente Teste"
    r = await client.get(
        f"{API}/intake/context", params={"customer_id": world.customer_id}, headers=world.tech.headers
    )
    assert r.status_code == 403


async def test_suggestions_for_a_new_ticket(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    await create(
        client,
        world,
        title="Já agendada",
        assignee_id=tech,
        scheduled_start=_tomorrow(14).isoformat(),
        estimated_minutes=60,
    )
    params = {
        "location_id": world.location_id,
        "start": _tomorrow(14, 30).isoformat(),
        "estimated_minutes": 30,
        "title": "Rede caiu",
    }
    r = await client.get(f"{API}/technicians/suggest", params=params, headers=an)
    assert r.status_code == 200, r.text
    by_id = {s["id"]: s for s in r.json()}
    assert by_id[tech]["busy"] is True and by_id[tech]["day_load"] == 1
    assert "Ocupado no horário" in by_id[tech]["reasons"]
    assert by_id[other]["busy"] is False and by_id[other]["day_load"] == 0
    assert r.json()[0]["id"] == other  # livre no horário vem antes
    # Sem fuso no horário: recusa (evita agenda deslocada).
    r = await client.get(
        f"{API}/technicians/suggest", params={**params, "start": "2026-12-01T10:00:00"}, headers=an
    )
    assert r.status_code == 422


def test_realtime_and_push_reach_helpers() -> None:
    helper, actor = str(uuid.uuid4()), str(uuid.uuid4())
    event = {"audience": {"assignee_id": None, "helper_ids": [helper]}}
    assert should_deliver(user_id=helper, role=UserRole.TECHNICIAN, team_id=None, event=event)
    gone = {"audience": {"helper_ids": [], "previous_helper_ids": [helper]}}
    assert should_deliver(user_id=helper, role=UserRole.TECHNICIAN, team_id=None, event=gone)
    stranger = {"audience": {"helper_ids": [actor]}}
    assert not should_deliver(user_id=helper, role=UserRole.TECHNICIAN, team_id=None, event=stranger)

    push = {
        "type": "ticket.helpers_changed",
        "ticket_code": "OS-000123",
        "actor_id": actor,
        "actor_name": "Analista",
        "data": {"added_ids": [helper, actor]},
    }
    assert _push_targets(push) == [
        (helper, "Você vai na visita da OS-000123", "Incluído por Analista")
    ]
