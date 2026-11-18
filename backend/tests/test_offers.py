"""Oferta de OS com preço: a central manda a OS sem técnico com o valor; o primeiro técnico que
aceita fica com ela. Sem contraproposta, e o técnico só vê o recorte do convite."""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import UserRole
from app.core.security import create_access_token
from app.models import User
from app.services import offers as offers_svc
from app.services import realtime
from app.services.push import _push_targets
from app.services.realtime import field_event, should_deliver
from tests.conftest import Actor, World, requires_db
from tests.test_access import restrict_analyst
from tests.test_api import create, transition
from tests.test_forms import PREVENTIVA

pytestmark = requires_db

API = settings.API_PREFIX
OFFER_EVENTS = {"offer_sent", "offer_accepted", "offer_declined", "offer_cancelled"}


def later(hours: float = 2) -> str:
    return (datetime.now(UTC) + timedelta(hours=hours)).isoformat()


async def make_technician(engine: AsyncEngine, name: str, *, active: bool = True) -> Actor:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = User(
            name=name,
            email=f"{name.lower().replace(' ', '.')}@teste.com.br",
            password_hash="x",
            role=UserRole.TECHNICIAN,
            is_active=active,
        )
        db.add(user)
        await db.commit()
    token = create_access_token(str(user.id), user.role.value)
    return Actor(user=user, headers={"Authorization": f"Bearer {token}"})


async def send(
    client: AsyncClient,
    headers: dict,
    ticket_id: str,
    technicians: list[Actor],
    amount: str = "90.00",
    **extra: object,
) -> list[dict]:
    r = await client.post(
        f"{API}/tickets/{ticket_id}/offers",
        json={"technician_ids": [str(t.user.id) for t in technicians], "amount": amount, **extra},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def open_offer(client: AsyncClient, actor: Actor, offer_id: str) -> dict:
    r = await client.get(f"{API}/me/offers/{offer_id}", headers=actor.headers)
    assert r.status_code == 200, r.text
    return r.json()


async def central_offers(client: AsyncClient, headers: dict, ticket_id: str) -> list[dict]:
    r = await client.get(f"{API}/tickets/{ticket_id}/offers", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def history(client: AsyncClient, headers: dict, ticket_id: str) -> list[dict]:
    r = await client.get(f"{API}/tickets/{ticket_id}/events", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def capture(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    published: list[dict] = []

    async def publish(event: dict) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", publish)
    return published


async def test_technician_sees_only_the_invitation_cut(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Antes de estar na OS, o técnico vê serviço, escopo, formulários, bairro e cidade, data e
    valor. Cliente, loja, endereço, contato, CNPJ, SLA, analista e etiquetas ficam de fora."""
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE locations SET district = 'Centro', city = 'Cidade Teste', state = 'SP',"
                " address_line = 'Rua Teste, 100', contact_name = 'Contato Teste',"
                " contact_phone = '(11) 90000-0000', document = '11222333000181' WHERE id = :id"
            ),
            {"id": world.location_id},
        )
    sup = world.supervisor.headers
    service = await client.post(
        f"{API}/service-types",
        json={"name": "Troca de PDV", "estimated_minutes": 60, "technician_fee": 150},
        headers=sup,
    )
    assert service.status_code == 201, service.text
    start = (datetime.now(UTC) + timedelta(days=1)).replace(microsecond=0)
    t = await create(
        client,
        world,
        title="PDV parado",
        description="Trocar a fonte do PDV 3",
        service_type_id=service.json()["id"],
        client_reference="CHAMADO-77",
        requester_name="Gerente Teste",
        tags=[{"name": "Avulso"}],
        scheduled_start=start.isoformat(),
    )
    tpl = await client.post(f"{API}/form-templates", json=PREVENTIVA, headers=sup)
    assert tpl.status_code == 201, tpl.text
    r = await client.post(
        f"{API}/tickets/{t['id']}/forms", json={"template_id": tpl.json()["id"]}, headers=sup
    )
    assert r.status_code in (200, 201), r.text

    sent = await send(
        client,
        sup,
        t["id"],
        [world.tech, world.tech_other],
        note="  Levar escada  ",
        expires_at=later(4),
    )
    assert {o["technician"]["name"] for o in sent} == {"Tecnico", "Redes"}
    assert set(sent[0]) == {
        "id",
        "ticket_id",
        "technician",
        "amount",
        "state",
        "expires_at",
        "note",
        "decline_reason",
        "cancel_reason",
        "viewed_at",
        "responded_at",
        "created_by",
        "created_at",
    }
    summary = {(o["state"], o["amount"], o["note"]) for o in sent}
    assert summary == {("pending", 90.0, "Levar escada")}
    assert sent[0]["created_by"]["name"] == "Super"
    mine = next(o for o in sent if o["technician"]["id"] == str(world.tech.user.id))
    other = next(o for o in sent if o["technician"]["id"] == str(world.tech_other.user.id))

    r = await client.get(f"{API}/me/offers", headers=world.tech.headers)
    assert r.status_code == 200, r.text
    listed = r.json()
    assert [o["id"] for o in listed] == [mine["id"]]
    offer = listed[0]
    assert set(offer) == {
        "id",
        "state",
        "amount",
        "expires_at",
        "note",
        "cancel_reason",
        "viewed_at",
        "responded_at",
        "created_at",
        "ticket",
    }
    assert set(offer["ticket"]) == {
        "id",
        "code",
        "title",
        "description",
        "service_type",
        "forms",
        "district",
        "city",
        "state",
        "scheduled_start",
        "scheduled_end",
    }
    seen = offer["ticket"]
    assert (seen["code"], seen["title"], seen["description"]) == (
        t["code"],
        "PDV parado",
        "Trocar a fonte do PDV 3",
    )
    assert seen["service_type"]["name"] == "Troca de PDV"
    assert seen["forms"] == [{"name": "Preventiva de rack", "required": True}]
    assert (seen["district"], seen["city"], seen["state"]) == ("Centro", "Cidade Teste", "SP")
    assert datetime.fromisoformat(seen["scheduled_start"]) == start
    assert seen["scheduled_end"] is not None
    assert (offer["amount"], offer["note"], offer["viewed_at"]) == (90.0, "Levar escada", None)
    for secret in (
        "Cliente Teste",
        "Matriz",
        "Rua Teste",
        "Contato Teste",
        "90000-0000",
        "11222333000181",
        "CHAMADO-77",
        "Gerente Teste",
        "Avulso",
    ):
        assert secret not in r.text, secret

    # A oferta de outro técnico não existe para ele; quem não é técnico não usa estas rotas.
    r = await client.get(f"{API}/me/offers/{other['id']}", headers=world.tech.headers)
    assert r.status_code == 404
    assert (await client.get(f"{API}/me/offers", headers=world.analyst.headers)).status_code == 403
    r = await client.get(f"{API}/me/offers/{uuid.uuid4()}", headers=world.tech.headers)
    assert r.status_code == 404

    # Abrir o detalhe grava a leitura (uma vez), e a central vê quem já abriu.
    opened = await open_offer(client, world.tech, mine["id"])
    assert opened["viewed_at"] is not None and opened["ticket"] == seen
    again = await open_offer(client, world.tech, mine["id"])
    assert again["viewed_at"] == opened["viewed_at"]
    viewed = {o["id"]: o["viewed_at"] for o in await central_offers(client, sup, t["id"])}
    assert viewed[mine["id"]] is not None and viewed[other["id"]] is None

    # O técnico continua sem ver a OS em si até aceitar.
    r = await client.get(f"{API}/tickets/{t['id']}", headers=world.tech.headers)
    assert r.status_code == 404
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()
    assert detail["open_offers"] == 2


async def test_who_can_offer_and_which_os(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    sup, an = world.supervisor.headers, world.analyst.headers
    t = await create(client, world)
    url = f"{API}/tickets/{t['id']}/offers"
    body = {"technician_ids": [str(world.tech.user.id)], "amount": "80.00"}

    # Técnico e cliente não ofertam (nem listam).
    for actor in (world.tech, world.requester):
        assert (await client.post(url, json=body, headers=actor.headers)).status_code == 403
        assert (await client.get(url, headers=actor.headers)).status_code == 403
    # Pagamentos em Visualizar: vê as ofertas, não manda.
    await restrict_analyst(client, world, **{"commercial.payouts": "view"})
    r = await client.post(url, json=body, headers=an)
    assert r.status_code == 403
    assert r.json()["code"] == "MODULE_FORBIDDEN" and r.json()["required"] == "edit"
    assert (await client.get(url, headers=an)).status_code == 200

    # Só técnico de campo ativo e que ainda não está na OS.
    inactive = await make_technician(engine, "Tecnico Inativo", active=False)
    with_helper = await create(client, world, helper_ids=[str(world.tech_other.user.id)])
    cases = [
        (url, [inactive.user.id], "Tecnico Inativo está sem acesso ao app"),
        (url, [world.analyst.user.id], "Analista não é técnico de campo"),
        (url, [uuid.uuid4()], "Técnico não encontrado"),
        (f"{API}/tickets/{with_helper['id']}/offers", [world.tech_other.user.id], "já está na OS"),
    ]
    for target, ids, message in cases:
        r = await client.post(
            target, json={**body, "technician_ids": [str(i) for i in ids]}, headers=sup
        )
        assert r.status_code == 422, r.text
        assert message in r.json()["detail"]

    # OS com técnico ou encerrada: 422.
    assigned = await create(client, world, assignee_id=str(world.tech.user.id))
    r = await client.post(f"{API}/tickets/{assigned['id']}/offers", json=body, headers=sup)
    assert r.status_code == 422 and "sem técnico" in r.json()["detail"]
    closed = await create(client, world)
    await transition(client, sup, closed, "cancelled", note="Duplicada")
    r = await client.post(f"{API}/tickets/{closed['id']}/offers", json=body, headers=sup)
    assert r.status_code == 422 and "em aberto" in r.json()["detail"]

    # Validação em português, com o nome do campo da tela.
    past = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
    r = await client.post(url, json={**body, "expires_at": past}, headers=sup)
    assert r.status_code == 422
    assert r.json()["detail"] == "O prazo para responder precisa ser no futuro"
    labels = {
        "amount": ({**body, "amount": "-1"}, "Valor"),
        "decimais": ({**body, "amount": "10.555"}, "Valor"),
        "nenhum": ({**body, "technician_ids": []}, "Técnicos"),
        "muitos": ({**body, "technician_ids": [str(uuid.uuid4()) for _ in range(11)]}, "Técnicos"),
        "recado": ({**body, "note": "x" * 501}, "Recado"),
        "prazo": ({**body, "expires_at": "amanhã"}, "Prazo para responder"),
    }
    for case, (payload, label) in labels.items():
        r = await client.post(url, json=payload, headers=sup)
        assert r.status_code == 422, (case, r.text)
        assert r.json()["detail"][0]["label"] == label, (case, r.json())
    assert await central_offers(client, sup, t["id"]) == []


async def test_resending_replaces_the_previous_offer(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    sup, th = world.supervisor.headers, world.tech.headers
    t = await create(client, world)
    first = (await send(client, sup, t["id"], [world.tech], amount="80.00"))[0]
    second = (await send(client, sup, t["id"], [world.tech], amount="95.50"))[0]

    listed = await central_offers(client, sup, t["id"])
    assert [o["id"] for o in listed] == [second["id"], first["id"]]  # a mais nova primeiro
    assert [(o["state"], o["cancel_reason"], o["amount"]) for o in listed] == [
        ("pending", None, 95.5),
        ("cancelled", "replaced", 80.0),
    ]
    # O app mostra só a nova; a antiga responde como cancelada pela central.
    mine = (await client.get(f"{API}/me/offers", headers=th)).json()
    assert [o["id"] for o in mine] == [second["id"]]
    r = await client.post(f"{API}/me/offers/{first['id']}/accept", headers=th)
    assert r.status_code == 409 and r.json()["code"] == "OFFER_CANCELLED"

    # A vencida também é substituída (e não conta como em aberto).
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE ticket_offers SET expires_at = now() - interval '1 hour' WHERE id = :id"),
            {"id": second["id"]},
        )
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()
    assert detail["open_offers"] == 0
    third = (await send(client, sup, t["id"], [world.tech, world.tech_other]))[0]
    listed = await central_offers(client, sup, t["id"])
    states = {o["id"]: (o["state"], o["cancel_reason"]) for o in listed}
    assert states[second["id"]] == ("cancelled", "replaced")
    assert states[third["id"]] == ("pending", None)
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()
    assert detail["open_offers"] == 2

    # Um evento por envio, com o valor; a troca aparece no envio (sem evento próprio).
    sent = [e for e in await history(client, sup, t["id"]) if e["event_type"] in OFFER_EVENTS]
    assert [e["event_type"] for e in sent] == ["offer_sent"] * 3
    newest = max(sent, key=lambda e: e["created_at"])
    assert newest["data"]["replaced"] == ["Tecnico"]
    assert newest["data"]["amount"] == "R$ 90,00" and newest["to_value"] == "90.00"
    assert sorted(o["technician"] for o in newest["data"]["offers"]) == ["Redes", "Tecnico"]


async def test_first_to_accept_takes_the_os(
    client: AsyncClient, world: World, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    sup = world.supervisor.headers
    tech_id, other_id = str(world.tech.user.id), str(world.tech_other.user.id)
    third = await make_technician(engine, "Tecnico Tres")
    service = await client.post(
        f"{API}/service-types",
        json={"name": "Instalação de rack", "estimated_minutes": 90, "technician_fee": 150},
        headers=sup,
    )
    assert service.status_code == 201, service.text
    start = (datetime.now(UTC) + timedelta(days=2)).replace(microsecond=0).isoformat()
    t = await create(client, world, service_type_id=service.json()["id"], scheduled_start=start)
    assert (t["status"], t["assignee"]) == ("new", None)
    sent = await send(client, sup, t["id"], [world.tech, world.tech_other, third])
    by_tech = {o["technician"]["id"]: o for o in sent}
    mine, other = by_tech[tech_id], by_tech[other_id]

    # Sem abrir a oferta: 422.
    r = await client.post(f"{API}/me/offers/{mine['id']}/accept", headers=world.tech.headers)
    assert r.status_code == 422
    assert r.json() == {
        "detail": "Abra a oferta e leia o escopo antes de aceitar.",
        "code": "OFFER_NOT_VIEWED",
    }
    # A oferta de outro técnico: 404.
    r = await client.post(f"{API}/me/offers/{other['id']}/accept", headers=world.tech.headers)
    assert r.status_code == 404

    await open_offer(client, world.tech, mine["id"])
    await open_offer(client, world.tech_other, other["id"])
    published = capture(monkeypatch)
    r = await client.post(f"{API}/me/offers/{mine['id']}/accept", headers=world.tech.headers)
    assert r.status_code == 200, r.text
    taken = r.json()
    # A OS é dele, na visão do app (cliente e loja agora aparecem), com o valor da oferta (e não
    # o padrão do tipo de serviço). A agenda fica e o status é o da atribuição pela tela.
    assert taken["assignee"]["id"] == tech_id
    assert taken["status"] == "assigned" and taken["scheduled_start"] is not None
    assert taken["customer"]["name"] == "Cliente Teste" and taken["location"]["name"] == "Matriz"
    assert taken["my_payout"]["amount"] == 90.0
    assert taken["payouts"] == [] and taken["open_offers"] == 0
    assert taken["first_response_at"] is None  # SLA é da gestão (o app não recebe)

    # O segundo aceite perde: 409 OFFER_TAKEN (a recusa também).
    r = await client.post(f"{API}/me/offers/{other['id']}/accept", headers=world.tech_other.headers)
    assert r.status_code == 409
    assert r.json() == {"detail": "Outro técnico já aceitou esta OS.", "code": "OFFER_TAKEN"}
    r = await client.post(
        f"{API}/me/offers/{other['id']}/decline", json={}, headers=world.tech_other.headers
    )
    assert r.status_code == 409 and r.json()["code"] == "OFFER_TAKEN"
    # Aceite repetido de quem ganhou (toque duplo): a OS, sem mudar nada.
    r = await client.post(f"{API}/me/offers/{mine['id']}/accept", headers=world.tech.headers)
    assert r.status_code == 200 and r.json()["version"] == taken["version"]
    # Depois de aceita, ele não recusa.
    r = await client.post(f"{API}/me/offers/{mine['id']}/decline", headers=world.tech.headers)
    assert r.status_code == 409 and r.json()["code"] == "OFFER_ANSWERED"

    # A central vê o resultado: aceita, as outras canceladas (outro técnico aceitou).
    states = {
        o["technician"]["id"]: (o["state"], o["cancel_reason"], o["responded_at"] is not None)
        for o in await central_offers(client, sup, t["id"])
    }
    assert states == {
        tech_id: ("accepted", None, True),
        other_id: ("cancelled", "taken", False),
        str(third.user.id): ("cancelled", "taken", False),
    }
    full = (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()
    assert [(p["technician"]["id"], p["amount"], p["note"]) for p in full["payouts"]] == [
        (tech_id, 90.0, "Valor da oferta aceita")
    ]
    assert full["open_offers"] == 0 and full["first_response_at"] is not None
    # O mesmo status da central colocando o técnico pela tela numa OS igual (com agenda).
    twin = await create(client, world, service_type_id=service.json()["id"], scheduled_start=start)
    r = await client.post(
        f"{API}/tickets/{twin['id']}/assign",
        json={"assignee_id": tech_id, "expected_version": twin["version"], "allow_conflict": True},
        headers=sup,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == full["status"] == "assigned"

    # Histórico: o envio, o aceite (do técnico), as outras fechadas, a atribuição pela oferta e o
    # valor da oferta lançado depois do padrão.
    events = await history(client, sup, t["id"])
    kinds = {e["event_type"] for e in events}
    assert {"offer_sent", "offer_accepted", "offer_cancelled", "assigned", "payout_set"} <= kinds
    accepted = next(e for e in events if e["event_type"] == "offer_accepted")
    assert accepted["actor"]["id"] == tech_id and accepted["to_value"] == "90.00"
    assigned = next(e for e in events if e["event_type"] == "assigned")
    assert assigned["data"]["via"] == "offer" and assigned["actor"]["id"] == tech_id
    assert assigned["note"] == "Aceitou a oferta"
    closed = next(e for e in events if e["event_type"] == "offer_cancelled")
    assert closed["data"]["reason"] == "taken" and closed["actor"] is None
    assert sorted(o["technician"] for o in closed["data"]["offers"]) == ["Redes", "Tecnico Tres"]
    payouts = sorted(
        (e for e in events if e["event_type"] == "payout_set"), key=lambda e: e["created_at"]
    )
    assert [e["to_value"] for e in payouts] == ["150.00", "90.00"]

    # Tempo real: a gestão sem valores; os técnicos de fora, um aviso só para eles.
    management = [
        e["data"]["offer"]
        for e in published
        if e["type"] == "ticket.updated" and e["data"].get("fields") == ["offers"]
    ]
    assert {(o["action"], o["reason"]) for o in management} == {
        ("cancelled", "taken"),
        ("accepted", None),
    }
    for event in published:
        if event["type"] == "ticket.updated" and "offer" in event["data"]:
            assert event["audience"]["managers_only"] and "R$" not in json.dumps(event["data"])
    to_technicians = {
        e["data"]["action"]: sorted(e["audience"]["user_ids"])
        for e in published
        if e["type"] == "ticket.offer"
    }
    assert to_technicians == {
        "cancelled": sorted([other_id, str(third.user.id)]),
        "accepted": [tech_id],
    }
    assert "ticket.assigned" in {e["type"] for e in published}

    # No app de quem perdeu: a oferta fechada (outro técnico aceitou), com o recorte mínimo.
    theirs = (await client.get(f"{API}/me/offers", headers=world.tech_other.headers)).json()
    assert [
        (o["state"], o["cancel_reason"], o["ticket"]["description"], o["ticket"]["district"])
        for o in theirs
    ] == [("cancelled", "taken", None, None)]


async def test_two_accepts_at_the_same_time_only_one_wins(
    client: AsyncClient, world: World
) -> None:
    sup = world.supervisor.headers
    t = await create(client, world)
    sent = await send(client, sup, t["id"], [world.tech, world.tech_other], amount="120.00")
    actors = {str(world.tech.user.id): world.tech, str(world.tech_other.user.id): world.tech_other}
    for offer in sent:
        await open_offer(client, actors[offer["technician"]["id"]], offer["id"])

    results = await asyncio.gather(
        *(
            client.post(
                f"{API}/me/offers/{offer['id']}/accept",
                headers=actors[offer["technician"]["id"]].headers,
            )
            for offer in sent
        )
    )
    codes = sorted(r.status_code for r in results)
    assert codes == [200, 409], [r.text for r in results]
    loser = next(r for r in results if r.status_code == 409)
    assert loser.json()["code"] == "OFFER_TAKEN"
    winner = next(r for r in results if r.status_code == 200).json()
    full = (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()
    assert full["assignee"]["id"] == winner["assignee"]["id"]
    assert [p["amount"] for p in full["payouts"]] == [120.0]


async def test_expired_and_cancelled_offers(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    sup = world.supervisor.headers
    t = await create(client, world)
    sent = await send(client, sup, t["id"], [world.tech, world.tech_other], expires_at=later(1))
    mine = next(o for o in sent if o["technician"]["id"] == str(world.tech.user.id))
    other = next(o for o in sent if o["technician"]["id"] == str(world.tech_other.user.id))
    await open_offer(client, world.tech, mine["id"])
    await open_offer(client, world.tech_other, other["id"])

    # A central cancela a oferta de um técnico.
    url = f"{API}/tickets/{t['id']}/offers/{other['id']}/cancel"
    r = await client.post(url, headers=sup)
    assert r.status_code == 200, r.text
    assert (r.json()["state"], r.json()["cancel_reason"]) == ("cancelled", "central")
    assert (await client.post(url, headers=sup)).status_code == 200  # de novo: como está
    for action in ("accept", "decline"):
        r = await client.post(
            f"{API}/me/offers/{other['id']}/{action}", headers=world.tech_other.headers
        )
        assert r.status_code == 409
        assert r.json() == {"detail": "A central cancelou esta oferta.", "code": "OFFER_CANCELLED"}
    # Oferta de outra OS no caminho: 404.
    u = await create(client, world)
    r = await client.post(f"{API}/tickets/{u['id']}/offers/{mine['id']}/cancel", headers=sup)
    assert r.status_code == 404

    # Prazo vencido: sem rotina, o estado passa a "expired" e o aceite é recusado.
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE ticket_offers SET expires_at = now() - interval '1 min' WHERE id = :id"),
            {"id": mine["id"]},
        )
    states = {o["id"]: o["state"] for o in await central_offers(client, sup, t["id"])}
    assert states == {mine["id"]: "expired", other["id"]: "cancelled"}
    assert (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()["open_offers"] == 0
    r = await client.post(f"{API}/me/offers/{mine['id']}/accept", headers=world.tech.headers)
    assert r.status_code == 409
    assert r.json() == {
        "detail": "O prazo para responder esta oferta acabou.",
        "code": "OFFER_EXPIRED",
    }
    # O app ainda mostra a vencida (fechou há pouco), com o recorte mínimo.
    mine_now = (await client.get(f"{API}/me/offers", headers=world.tech.headers)).json()
    assert [(o["state"], o["ticket"]["description"]) for o in mine_now] == [("expired", None)]
    # A central ainda pode cancelar a vencida.
    r = await client.post(f"{API}/tickets/{t['id']}/offers/{mine['id']}/cancel", headers=sup)
    assert r.status_code == 200 and r.json()["cancel_reason"] == "central"


async def test_technician_declines_with_a_reason(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    sup, th = world.supervisor.headers, world.tech.headers
    t = await create(client, world)
    offer = (await send(client, sup, t["id"], [world.tech], amount="70.00"))[0]
    url = f"{API}/me/offers/{offer['id']}/decline"

    r = await client.post(url, json={"reason": "x" * 301}, headers=th)
    assert r.status_code == 422 and r.json()["detail"][0]["label"] == "Motivo"
    # Recusar não exige abrir a oferta.
    r = await client.post(url, json={"reason": "  Estou em outra cidade  "}, headers=th)
    assert r.status_code == 200, r.text
    declined = r.json()
    assert declined["state"] == "declined" and declined["responded_at"] is not None
    assert (await client.post(url, headers=th)).status_code == 200  # de novo: como está
    r = await client.post(f"{API}/me/offers/{offer['id']}/accept", headers=th)
    assert r.status_code == 409
    assert r.json() == {"detail": "Você já respondeu esta oferta.", "code": "OFFER_ANSWERED"}

    seen = (await central_offers(client, sup, t["id"]))[0]
    assert (seen["state"], seen["decline_reason"]) == ("declined", "Estou em outra cidade")
    event = next(
        e for e in await history(client, sup, t["id"]) if e["event_type"] == "offer_declined"
    )
    assert event["actor"]["id"] == str(world.tech.user.id)
    assert (event["note"], event["data"]["amount"]) == ("Estou em outra cidade", "R$ 70,00")
    assert (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()["open_offers"] == 0
    # A central cancelar uma oferta já respondida: 422.
    r = await client.post(f"{API}/tickets/{t['id']}/offers/{offer['id']}/cancel", headers=sup)
    assert r.status_code == 422

    # Sem corpo também recusa; a recusa de mais de 24 h sai da lista do app.
    other = (await send(client, sup, t["id"], [world.tech_other]))[0]
    r = await client.post(
        f"{API}/me/offers/{other['id']}/decline", headers=world.tech_other.headers
    )
    assert r.status_code == 200 and r.json()["state"] == "declined"
    assert len((await client.get(f"{API}/me/offers", headers=th)).json()) == 1
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE ticket_offers SET updated_at = now() - interval '2 days' WHERE id = :id"),
            {"id": offer["id"]},
        )
    assert (await client.get(f"{API}/me/offers", headers=th)).json() == []


async def test_assigning_or_closing_the_os_closes_its_offers(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    sup = world.supervisor.headers
    tech_id, other_id = str(world.tech.user.id), str(world.tech_other.user.id)

    # A central coloca o técnico na mão (POST /assign): as ofertas fecham.
    t = await create(client, world)
    sent = await send(client, sup, t["id"], [world.tech, world.tech_other])
    await open_offer(client, world.tech, sent[0]["id"])
    published = capture(monkeypatch)
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": other_id, "expected_version": t["version"]},
        headers=sup,
    )
    assert r.status_code == 200, r.text
    assert r.json()["open_offers"] == 0
    listed = await central_offers(client, sup, t["id"])
    states = {o["technician"]["id"]: (o["state"], o["cancel_reason"]) for o in listed}
    assert states == {tech_id: ("cancelled", "assigned"), other_id: ("cancelled", "assigned")}
    told = [sorted(e["audience"]["user_ids"]) for e in published if e["type"] == "ticket.offer"]
    assert told == [sorted([tech_id, other_id])]
    mine = next(o for o in sent if o["technician"]["id"] == tech_id)
    r = await client.post(f"{API}/me/offers/{mine['id']}/accept", headers=world.tech.headers)
    assert r.status_code == 409
    assert r.json() == {"detail": "Esta OS não está mais disponível.", "code": "OFFER_UNAVAILABLE"}
    closed = next(
        e for e in await history(client, sup, t["id"]) if e["event_type"] == "offer_cancelled"
    )
    assert closed["actor"]["id"] == str(world.supervisor.user.id)
    assert (closed["data"]["reason"], closed["note"]) == (
        "assigned",
        "A central definiu o técnico da OS",
    )

    # O técnico pelo editor (PATCH com assignee_id) também.
    u = await create(client, world)
    await send(client, sup, u["id"], [world.tech])
    r = await client.patch(
        f"{API}/tickets/{u['id']}",
        json={"assignee_id": tech_id, "expected_version": u["version"]},
        headers=sup,
    )
    assert r.status_code == 200, r.text
    assert [o["cancel_reason"] for o in await central_offers(client, sup, u["id"])] == ["assigned"]

    # Cancelar a OS (central) e o cliente cancelar pelo portal também fecham.
    v = await create(client, world)
    await send(client, sup, v["id"], [world.tech])
    await transition(client, sup, v, "cancelled", note="Cliente desistiu")
    w = await create(client, world)
    await send(client, sup, w["id"], [world.tech])
    r = await client.post(
        f"{API}/portal/requests/{w['id']}/cancel",
        json={"reason": "Resolvemos aqui"},
        headers=world.requester.headers,
    )
    assert r.status_code == 200, r.text
    for ticket in (v, w):
        seen = await central_offers(client, sup, ticket["id"])
        assert [(o["state"], o["cancel_reason"]) for o in seen] == [("cancelled", "ticket_closed")]
        note = next(
            e["note"]
            for e in await history(client, sup, ticket["id"])
            if e["event_type"] == "offer_cancelled"
        )
        assert note == "OS cancelada"
    # Na OS encerrada, ninguém mais oferta nem aceita.
    r = await client.post(
        f"{API}/tickets/{v['id']}/offers",
        json={"technician_ids": [tech_id], "amount": "10"},
        headers=sup,
    )
    assert r.status_code == 422


async def test_without_payouts_screen_only_the_counter(client: AsyncClient, world: World) -> None:
    """O preço é dado de Pagamentos: sem a tela, a pessoa vê só que há oferta em aberto."""
    sup, an = world.supervisor.headers, world.analyst.headers
    t = await create(client, world)
    await send(client, sup, t["id"], [world.tech, world.tech_other])
    await restrict_analyst(client, world, **{"commercial.payouts": "none"})

    detail = await client.get(f"{API}/tickets/{t['id']}", headers=an)
    assert detail.status_code == 200 and detail.json()["open_offers"] == 2
    r = await client.get(f"{API}/tickets/{t['id']}/offers", headers=an)
    assert r.status_code == 403 and r.json()["code"] == "MODULE_FORBIDDEN"
    kinds = {e["event_type"] for e in await history(client, an, t["id"])}
    assert not kinds & OFFER_EVENTS and "created" in kinds
    assert "offer_sent" in {e["event_type"] for e in await history(client, sup, t["id"])}


def test_offer_event_goes_only_to_its_technicians() -> None:
    event = {
        "type": "ticket.offer",
        "ticket_id": "os-1",
        "ticket_code": "OS-000001",
        "status": "new",
        "priority": "medium",
        "assignee_id": None,
        "team_id": None,
        "actor_id": "central",
        "actor_name": "Analista",
        "version": 3,
        "occurred_at": "2026-11-18T13:00:00+00:00",
        "data": {"action": "sent"},
        "audience": {"user_ids": ["tec-a"], "assignee_id": None, "internal": False},
    }

    def deliver(user_id: str, role: UserRole) -> bool:
        return should_deliver(user_id=user_id, role=role, team_id=None, event=event)

    assert deliver("tec-a", UserRole.TECHNICIAN)
    assert not deliver("tec-b", UserRole.TECHNICIAN)
    assert not deliver("analista", UserRole.ANALYST)
    assert not deliver("cliente", UserRole.REQUESTER)
    # No app: só que a oferta mudou (sem versão, quem fez nem quem ficou com a OS).
    assert field_event(event) == {
        "type": "ticket.offer",
        "ticket_id": "os-1",
        "ticket_code": "OS-000001",
        "status": None,
        "assignee_id": None,
        "actor_id": None,
        "version": None,
        "occurred_at": "2026-11-18T13:00:00+00:00",
        "data": {"action": "sent"},
    }
    # Os outros eventos seguem iguais para o técnico.
    other = {**event, "type": "ticket.assigned", "data": {"to_name": "Tecnico"}}
    assert field_event(other)["version"] == 3 and field_event(other)["data"] == {}
    # O aviso (push) da oferta nova vai só para os técnicos dela.
    assert _push_targets(event) == [
        ("tec-a", "OS para aceitar: OS-000001", "Veja o valor e o escopo no app e responda")
    ]
    assert _push_targets({**event, "data": {"action": "cancelled"}}) == []


# ------------------------------------------------------------------ revisão (2026-11-18)


async def test_technician_with_paid_value_on_the_os(
    client: AsyncClient, world: World, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O valor pago não muda e é um por técnico na OS: quem já foi pago nela não recebe oferta
    dela e, pago depois do envio, não aceita (ele tem de ficar com o valor que aceitou)."""
    sup = world.supervisor.headers
    tech_id = str(world.tech.user.id)
    service = await client.post(
        f"{API}/service-types",
        json={"name": "Visita técnica", "estimated_minutes": 60, "technician_fee": 150},
        headers=sup,
    )
    assert service.status_code == 201, service.text
    # Ele foi o técnico da OS e recebeu; depois a central tirou o técnico (o pago fica).
    t = await create(client, world, service_type_id=service.json()["id"])
    url = f"{API}/tickets/{t['id']}/assign"
    r = await client.post(url, json={"assignee_id": tech_id}, headers=sup)
    assert r.status_code == 200, r.text
    payout = r.json()["payouts"][0]
    r = await client.post(f"{API}/payouts/pay", json={"ids": [payout["id"]]}, headers=sup)
    assert r.json() == {"changed": 1}
    r = await client.post(url, json={"assignee_id": None}, headers=sup)
    assert r.status_code == 200 and r.json()["assignee"] is None, r.text

    offers_url = f"{API}/tickets/{t['id']}/offers"
    for ids in ([tech_id], [str(world.tech_other.user.id), tech_id]):
        r = await client.post(
            offers_url, json={"technician_ids": ids, "amount": "90.00"}, headers=sup
        )
        assert r.status_code == 422, r.text
        assert r.json()["detail"] == (
            "Tecnico já tem valor pago nesta OS e não pode receber oferta dela"
        )
    assert await central_offers(client, sup, t["id"]) == []
    assert len(await send(client, sup, t["id"], [world.tech_other])) == 1

    async def pay_now(ticket_id: str) -> None:
        """O pagamento depois do envio (linha paga do técnico nesta OS, como a de antes)."""
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO ticket_payouts (id, ticket_id, technician_id, amount, status,"
                    " paid_at) VALUES (gen_random_uuid(), :ticket, :tech, 50, 'paid', now())"
                ),
                {"ticket": ticket_id, "tech": tech_id},
            )

    async def nothing_changed(ticket_id: str, offer_id: str) -> None:
        listed = await central_offers(client, sup, ticket_id)
        assert [(o["id"], o["state"]) for o in listed] == [(offer_id, "pending")]
        full = (await client.get(f"{API}/tickets/{ticket_id}", headers=sup)).json()
        assert (full["assignee"], full["status"], full["open_offers"]) == (None, "new", 1)
        assert [(p["amount"], p["status"]) for p in full["payouts"]] == [(50.0, "paid")]
        kinds = {e["event_type"] for e in await history(client, sup, ticket_id)}
        assert not kinds & {"assigned", "offer_accepted", "payout_set"}, kinds

    # Pago depois do envio: 409 antes de mudar qualquer coisa.
    u = await create(client, world)
    offer = (await send(client, sup, u["id"], [world.tech]))[0]
    await open_offer(client, world.tech, offer["id"])
    await pay_now(u["id"])
    r = await client.post(f"{API}/me/offers/{offer['id']}/accept", headers=world.tech.headers)
    assert r.status_code == 409
    assert r.json() == {"detail": "Esta OS não está mais disponível.", "code": "OFFER_UNAVAILABLE"}
    await nothing_changed(u["id"], offer["id"])

    # Pago no meio do aceite (depois da conferência): o aceite inteiro é desfeito.
    v = await create(client, world)
    offer = (await send(client, sup, v["id"], [world.tech]))[0]
    await open_offer(client, world.tech, offer["id"])
    await pay_now(v["id"])
    real = offers_svc._paid_technicians
    calls: list[int] = []

    async def paid_after_the_check(*args: object) -> set[uuid.UUID]:
        """A conferência do aceite não acha o pago; a gravação do valor, sim."""
        calls.append(1)
        return set() if len(calls) == 1 else await real(*args)  # type: ignore[arg-type]

    monkeypatch.setattr(offers_svc, "_paid_technicians", paid_after_the_check)
    r = await client.post(f"{API}/me/offers/{offer['id']}/accept", headers=world.tech.headers)
    assert r.status_code == 409 and r.json()["code"] == "OFFER_UNAVAILABLE", r.text
    assert len(calls) == 2
    await nothing_changed(v["id"], offer["id"])


async def test_my_offers_keep_every_live_offer(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O app apaga do aparelho a oferta que não vem: o limite de 50 é só das que fecharam, e a
    pendente antiga não some atrás de 50 fechadas mais novas."""
    sup, th = world.supervisor.headers, world.tech.headers
    t = await create(client, world)
    live = (await send(client, sup, t["id"], [world.tech]))[0]
    u = await create(client, world)
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE ticket_offers SET created_at = now() - interval '3 hours' WHERE id = :id"),
            {"id": live["id"]},
        )
        # 51 recusadas na última hora, todas mais novas que a pendente.
        await conn.execute(
            text(
                "INSERT INTO ticket_offers (id, ticket_id, technician_id, amount, status,"
                " responded_at, created_at, updated_at)"
                " SELECT gen_random_uuid(), :ticket, :tech, 10, 'declined', now(),"
                " now() - interval '1 hour' + n * interval '1 second', now()"
                " FROM generate_series(1, 51) AS n"
            ),
            {"ticket": u["id"], "tech": str(world.tech.user.id)},
        )
    listed = (await client.get(f"{API}/me/offers", headers=th)).json()
    assert len(listed) == 51
    assert [o["state"] for o in listed] == ["declined"] * 50 + ["pending"]
    assert listed[-1]["id"] == live["id"]
    created = [datetime.fromisoformat(o["created_at"]) for o in listed]
    assert created == sorted(created, reverse=True)


async def test_technician_without_app_access_loses_his_offers(
    client: AsyncClient, world: World, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Desativado (em Técnicos ou em Usuários) ou fora do papel de técnico, ninguém responde as
    ofertas dele: fecham como canceladas pela central e a OS volta a "Sem técnico"."""
    sup, adm = world.supervisor.headers, world.admin.headers
    alfa = await make_technician(engine, "Tecnico Alfa")
    alfa_id = str(alfa.user.id)
    t1 = await create(client, world)
    t2 = await create(client, world)
    await send(client, sup, t1["id"], [alfa])
    await send(client, sup, t2["id"], [alfa, world.tech_other], expires_at=later(4))
    published = capture(monkeypatch)

    r = await client.patch(f"{API}/technicians/{alfa_id}", json={"is_active": False}, headers=sup)
    assert r.status_code == 200 and r.json()["is_active"] is False, r.text

    def states(listed: list[dict]) -> dict[str, tuple[str, str | None]]:
        return {o["technician"]["name"]: (o["state"], o["cancel_reason"]) for o in listed}

    assert states(await central_offers(client, sup, t1["id"])) == {
        "Tecnico Alfa": ("cancelled", "central")
    }
    assert states(await central_offers(client, sup, t2["id"])) == {
        "Tecnico Alfa": ("cancelled", "central"),
        "Redes": ("pending", None),
    }
    detail = (await client.get(f"{API}/tickets/{t1['id']}", headers=sup)).json()
    assert (detail["open_offers"], detail["next_offer_expires_at"]) == (0, None)
    assert (await client.get(f"{API}/tickets/{t2['id']}", headers=sup)).json()["open_offers"] == 1
    for ticket in (t1, t2):
        closed = [
            e
            for e in await history(client, sup, ticket["id"])
            if e["event_type"] == "offer_cancelled"
        ]
        assert len(closed) == 1
        assert closed[0]["actor"]["id"] == str(world.supervisor.user.id)
        assert (closed[0]["data"]["reason"], closed[0]["note"]) == (
            "central",
            "Técnico sem acesso ao app",
        )
        assert [o["technician"] for o in closed[0]["data"]["offers"]] == ["Tecnico Alfa"]
    # O tempo real sai no commit da rota de Técnicos: a gestão e o técnico de cada OS.
    management = [
        (e["ticket_id"], e["data"]["offer"]["action"], e["data"]["offer"]["reason"])
        for e in published
        if e["type"] == "ticket.updated" and e["data"].get("fields") == ["offers"]
    ]
    assert sorted(management) == sorted(
        [(t1["id"], "cancelled", "central"), (t2["id"], "cancelled", "central")]
    )
    told = [(e["ticket_id"], e["audience"]["user_ids"]) for e in published if e["type"] == "ticket.offer"]
    assert sorted(told) == sorted([(t1["id"], [alfa_id]), (t2["id"], [alfa_id])])

    # Reativar não traz as ofertas de volta.
    r = await client.patch(f"{API}/technicians/{alfa_id}", json={"is_active": True}, headers=sup)
    assert r.status_code == 200, r.text
    assert (await client.get(f"{API}/tickets/{t1['id']}", headers=sup)).json()["open_offers"] == 0

    # Em Usuários: tirar o papel de técnico e desativar também fecham (autor: quem alterou).
    beta = await make_technician(engine, "Tecnico Beta")
    gama = await make_technician(engine, "Tecnico Gama")
    t3 = await create(client, world)
    await send(client, sup, t3["id"], [beta, gama])
    r = await client.patch(f"{API}/users/{beta.user.id}", json={"role": "analyst"}, headers=adm)
    assert r.status_code == 200 and r.json()["role"] == "analyst", r.text
    r = await client.patch(f"{API}/users/{gama.user.id}", json={"is_active": False}, headers=adm)
    assert r.status_code == 200 and r.json()["is_active"] is False, r.text
    assert states(await central_offers(client, sup, t3["id"])) == {
        "Tecnico Beta": ("cancelled", "central"),
        "Tecnico Gama": ("cancelled", "central"),
    }
    assert (await client.get(f"{API}/tickets/{t3['id']}", headers=sup)).json()["open_offers"] == 0
    closed = [
        e for e in await history(client, sup, t3["id"]) if e["event_type"] == "offer_cancelled"
    ]
    assert {(e["actor"]["id"], e["note"]) for e in closed} == {
        (str(world.admin.user.id), "Técnico sem acesso ao app")
    }
    assert sorted(o["technician"] for e in closed for o in e["data"]["offers"]) == [
        "Tecnico Beta",
        "Tecnico Gama",
    ]


async def test_technician_put_in_the_visit_loses_his_offer(
    client: AsyncClient, world: World
) -> None:
    """Colocado entre os outros técnicos da visita, a oferta dele fecha: se aceitasse, sairia da
    visita para ser o responsável."""
    sup = world.supervisor.headers
    tech_id, other_id = str(world.tech.user.id), str(world.tech_other.user.id)
    t = await create(client, world)
    by_tech = {
        o["technician"]["id"]: o for o in await send(client, sup, t["id"], [world.tech, world.tech_other])
    }
    await open_offer(client, world.tech_other, by_tech[other_id]["id"])

    r = await client.patch(
        f"{API}/tickets/{t['id']}",
        json={"helper_ids": [other_id], "expected_version": t["version"]},
        headers=sup,
    )
    assert r.status_code == 200, r.text
    assert r.json()["open_offers"] == 1
    states = {
        o["technician"]["id"]: (o["state"], o["cancel_reason"])
        for o in await central_offers(client, sup, t["id"])
    }
    assert states == {tech_id: ("pending", None), other_id: ("cancelled", "assigned")}
    r = await client.post(
        f"{API}/me/offers/{by_tech[other_id]['id']}/accept", headers=world.tech_other.headers
    )
    assert r.status_code == 409 and r.json()["code"] == "OFFER_UNAVAILABLE"
    closed = next(
        e for e in await history(client, sup, t["id"]) if e["event_type"] == "offer_cancelled"
    )
    assert closed["actor"]["id"] == str(world.supervisor.user.id)
    assert (closed["data"]["reason"], closed["note"]) == (
        "assigned",
        "A central incluiu o técnico na visita",
    )
    assert [o["technician"] for o in closed["data"]["offers"]] == ["Redes"]

    # O outro aceita e fica responsável; quem está na visita continua nela.
    await open_offer(client, world.tech, by_tech[tech_id]["id"])
    r = await client.post(
        f"{API}/me/offers/{by_tech[tech_id]['id']}/accept", headers=world.tech.headers
    )
    assert r.status_code == 200, r.text
    full = (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()
    assert full["assignee"]["id"] == tech_id
    assert [h["id"] for h in full["helpers"]] == [other_id]


async def test_offer_title_hides_the_store_and_the_customer(
    client: AsyncClient, world: World
) -> None:
    """O título automático da Nova OS é "<Tipo de OS> · <Localização>": antes de aceitar, o
    técnico não lê a loja nem o cliente nele (nem no recorte mínimo da oferta fechada)."""
    sup, th = world.supervisor.headers, world.tech.headers
    service = await client.post(
        f"{API}/service-types", json={"name": "Troca de PDV", "estimated_minutes": 60}, headers=sup
    )
    assert service.status_code == 201, service.text
    service_id = service.json()["id"]
    expected: dict[str, str] = {}
    offer_ids: list[str] = []
    for title, shown in (
        ("Troca de PDV · Matriz", "Troca de PDV"),
        ("Cliente Teste: PDV parado na MATRIZ", "PDV parado"),
        ("matriz", "Troca de PDV"),
    ):
        t = await create(client, world, title=title, service_type_id=service_id)
        offer = (await send(client, sup, t["id"], [world.tech]))[0]
        expected[offer["id"]] = shown
        offer_ids.append(offer["id"])
    # O título da OS em si não muda (a central vê como gravou).
    full = (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()
    assert full["title"] == "matriz"

    def check(body: str) -> None:
        assert "matriz" not in body.lower() and "cliente teste" not in body.lower(), body

    r = await client.get(f"{API}/me/offers", headers=th)
    check(r.text)
    assert {o["id"]: o["ticket"]["title"] for o in r.json()} == expected
    for offer_id in offer_ids:
        r = await client.get(f"{API}/me/offers/{offer_id}", headers=th)
        check(r.text)
        assert r.json()["ticket"]["title"] == expected[offer_id]

    # A oferta fechada (recorte mínimo) também.
    first = offer_ids[0]
    r = await client.post(f"{API}/me/offers/{first}/decline", headers=th)
    assert r.status_code == 200 and r.json()["ticket"]["title"] == "Troca de PDV", r.text
    r = await client.get(f"{API}/me/offers", headers=th)
    check(r.text)
    closed = next(o for o in r.json() if o["id"] == first)
    assert (closed["state"], closed["ticket"]["title"]) == ("declined", "Troca de PDV")


def test_offer_title_cut() -> None:
    """O corte do título: sem caixa nem acento, só palavra inteira, com a ligação e os separadores
    que sobram; sobrando menos de 3 caracteres, o tipo de serviço ou "Atendimento técnico"."""

    def title(
        text: str,
        *,
        store: str | None = "Loja São Paulo",
        code: str | None = None,
        customer: str | None = "Cliente Exemplo",
        project: str | None = None,
        reference: str | None = None,
        service: str | None = "Troca de PDV",
    ) -> str:
        ticket = SimpleNamespace(
            title=text,
            location=SimpleNamespace(name=store, code=code) if store else None,
            customer=SimpleNamespace(name=customer) if customer else None,
            project=SimpleNamespace(name=project) if project else None,
            client_reference=reference,
            service_type=SimpleNamespace(name=service) if service else None,
        )
        return offers_svc._offer_title(ticket)  # type: ignore[arg-type]

    assert title("Troca de PDV · Loja São Paulo") == "Troca de PDV"
    assert title("LOJA SAO PAULO - Troca de PDV") == "Troca de PDV"
    assert title("PDV parado na loja são paulo, urgente") == "PDV parado, urgente"
    assert title("Cliente Exemplo | Loja São Paulo | PDV 3 sem rede") == "PDV 3 sem rede"
    assert title("Troca de PDV (Loja São Paulo)") == "Troca de PDV"
    assert title("Série de testes na Sé", store="Sé") == "Série de testes"
    assert title("0123 · Troca de PDV", code="0123") == "Troca de PDV"
    assert title("PDV 41 travado", code="41") == "PDV 41 travado"
    assert title("Expansão 2026: troca de rack", project="Expansão 2026") == "troca de rack"
    assert title("CHAMADO-77 – PDV parado", reference="CHAMADO-77") == "PDV parado"
    assert title("Impressora atolando") == "Impressora atolando"
    assert title("Loja São Paulo") == "Troca de PDV"
    assert title("Loja São Paulo", service=None) == "Atendimento técnico"
    assert title("Cliente Exemplo", service="Preventiva Cliente Exemplo") == "Preventiva"


async def test_next_offer_deadline_in_the_detail(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Sem rotina de vencimento, a web relê a OS no prazo mais próximo das ofertas em aberto."""
    sup = world.supervisor.headers
    gama = await make_technician(engine, "Tecnico Gama")
    delta = await make_technician(engine, "Tecnico Delta")
    t = await create(client, world, helper_ids=[str(world.tech_other.user.id)])
    url = f"{API}/tickets/{t['id']}"

    async def next_deadline() -> datetime | None:
        value = (await client.get(url, headers=sup)).json()["next_offer_expires_at"]
        return datetime.fromisoformat(value) if value else None

    assert await next_deadline() is None
    soon, after = later(1), later(3)
    first = (await send(client, sup, t["id"], [world.tech], expires_at=after))[0]
    second = (await send(client, sup, t["id"], [gama], expires_at=soon))[0]
    await send(client, sup, t["id"], [delta])  # sem prazo: não entra no cálculo
    assert await next_deadline() == datetime.fromisoformat(soon)
    # O técnico da visita vê a OS sem nada das ofertas.
    seen = (await client.get(url, headers=world.tech_other.headers)).json()
    assert (seen["open_offers"], seen["next_offer_expires_at"]) == (0, None)

    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE ticket_offers SET expires_at = now() - interval '1 min' WHERE id = :id"),
            {"id": second["id"]},
        )
    assert await next_deadline() == datetime.fromisoformat(after)
    r = await client.post(f"{API}/tickets/{t['id']}/offers/{first['id']}/cancel", headers=sup)
    assert r.status_code == 200, r.text
    detail = (await client.get(url, headers=sup)).json()
    assert (detail["open_offers"], detail["next_offer_expires_at"]) == (1, None)


async def test_accept_and_decline_say_who_sent_the_offer(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O aviso de aceite e recusa na web vai também para quem mandou a oferta (sender_id), mesmo
    sem ser o analista da OS."""
    tech_id, other_id = str(world.tech.user.id), str(world.tech_other.user.id)
    t = await create(client, world)  # aberta pelo supervisor: a OS é da fila dele
    published = capture(monkeypatch)
    sent = await send(client, world.analyst.headers, t["id"], [world.tech, world.tech_other])
    by_tech = {o["technician"]["id"]: o for o in sent}
    r = await client.post(
        f"{API}/me/offers/{by_tech[other_id]['id']}/decline", headers=world.tech_other.headers
    )
    assert r.status_code == 200, r.text
    await open_offer(client, world.tech, by_tech[tech_id]["id"])
    r = await client.post(
        f"{API}/me/offers/{by_tech[tech_id]['id']}/accept", headers=world.tech.headers
    )
    assert r.status_code == 200, r.text
    senders = {
        e["data"]["offer"]["action"]: e["data"]["offer"]["sender_id"]
        for e in published
        if e["type"] == "ticket.updated" and e["data"].get("fields") == ["offers"]
    }
    analyst_id = str(world.analyst.user.id)
    assert senders == {"sent": None, "declined": analyst_id, "viewed": None, "accepted": analyst_id}
