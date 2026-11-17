"""Orçamentos: a fila "Para cobrar" (a mesma regra na lista, no campo de cada orçamento e no
Início), o "Cobrar", as aberturas do link pelo cliente, o pedido de peça solto ao cancelar, a
receita sem OS cancelada, o histórico do Field Control e o catálogo por uso.

Só dados inventados. Os horários no passado são gravados direto no banco, relativos a agora.
"""

import json
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import AsyncEngine

from app.api.routes.tickets import _INTERNAL_EVENT_TYPES
from app.core.config import settings
from app.core.enums import QuoteStatus
from app.db.base import utcnow
from app.models import Quote
from app.services import realtime
from app.services.activities import local_today
from tests.conftest import World, requires_db
from tests.test_api import create, transition
from tests.test_b2_quotes import APPROVAL, new_quote, quote_body, send

pytestmark = requires_db

API = settings.API_PREFIX
CANCELLED_TICKET = "A OS foi cancelada: reabra a OS antes de mexer no orçamento"
# Nada interno do orçamento vai para a página do cliente.
INTERNAL_FIELDS = {
    "client_views",
    "client_first_viewed_at",
    "client_last_viewed_at",
    "reminder_count",
    "last_reminded_at",
    "last_reminded_by",
    "follow_up",
    "legacy_code",
    "legacy_description",
    "legacy_attachments",
}


def ago(**delta: float) -> datetime:
    return utcnow() - timedelta(**delta)


def days(n: int) -> Any:
    """Hoje (no fuso da operação) mais n dias."""
    return local_today() + timedelta(days=n)


async def set_quote(engine: AsyncEngine, quote_id: str, **values: Any) -> None:
    """Grava direto no banco, sem mexer no "atualizado em" (a não ser que venha em values)."""
    values.setdefault("updated_at", Quote.updated_at)
    async with engine.begin() as conn:
        await conn.execute(update(Quote).where(Quote.id == uuid.UUID(quote_id)).values(**values))


async def sent_quote(
    client: AsyncClient, world: World, engine: AsyncEngine, ticket: dict, title: str, **values: Any
) -> dict:
    """Orçamento enviado pela API (com link) e depois ajustado no banco."""
    quote = await new_quote(client, world, ticket["id"], title)
    await send(client, world, quote)
    if values:
        await set_quote(engine, quote["id"], **values)
    return quote


async def queue_ids(client: AsyncClient, world: World) -> list[str]:
    r = await client.get(
        f"{API}/quotes", params={"follow_up": "true"}, headers=world.analyst.headers
    )
    assert r.status_code == 200, r.text
    ids = [q["id"] for q in r.json()]
    assert r.headers["x-total-count"] == str(len(ids))
    return ids


async def home_group(client: AsyncClient, world: World, key: str) -> dict | None:
    r = await client.get(f"{API}/home/overview", headers=world.supervisor.headers)
    assert r.status_code == 200, r.text
    return next((g for g in r.json()["attention"] if g["key"] == key), None)


# =========================================================================== fila "Para cobrar"


async def test_follow_up_rule_is_the_same_in_the_list_the_field_and_the_home(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Loja com orçamentos")
    gone = await create(client, world, title="OS que vai ser cancelada")

    # Os cinco motivos.
    not_opened = await sent_quote(
        client, world, engine, t, "Não abriu", sent_at=ago(days=3), valid_until=days(10)
    )
    no_answer = await sent_quote(
        client, world, engine, t, "Abriu e não respondeu", sent_at=ago(days=4), client_views=2
    )
    expiring = await sent_quote(
        client, world, engine, t, "Vence amanhã", sent_at=ago(hours=26), valid_until=days(1)
    )
    expired = await sent_quote(
        client, world, engine, t, "Venceu anteontem", sent_at=ago(days=9), valid_until=days(-2)
    )
    expired_7 = await sent_quote(
        client,
        world,
        engine,
        t,
        "Venceu há 7 dias",
        status=QuoteStatus.EXPIRED,
        sent_at=ago(days=14),
        valid_until=days(-7),
    )
    # Em revisão: editado depois do envio (volta a rascunho) e parado há 2 dias sem reenviar.
    in_review = await sent_quote(client, world, engine, t, "Em revisão")
    r = await client.put(
        f"{API}/quotes/{in_review['id']}", json=quote_body("Em revisão", "120"), headers=an
    )
    assert r.json()["status"] == "draft"
    await set_quote(engine, in_review["id"], sent_at=ago(days=3), updated_at=ago(days=2))

    # Fora da fila.
    recent = await sent_quote(
        client, world, engine, t, "Enviado ontem", sent_at=ago(days=1), valid_until=days(10)
    )
    old_expired = await sent_quote(
        client,
        world,
        engine,
        t,
        "Venceu há 8 dias",
        status=QuoteStatus.EXPIRED,
        sent_at=ago(days=15),
        valid_until=days(-8),
    )
    reminded = await sent_quote(
        client,
        world,
        engine,
        t,
        "Cobrado ontem",
        sent_at=ago(days=5),
        last_reminded_at=ago(days=1),
        reminder_count=1,
    )
    stale = await sent_quote(client, world, engine, t, "Sem validade", sent_at=ago(days=31))
    draft = await new_quote(client, world, t["id"], "Rascunho nunca enviado")
    lost = await sent_quote(client, world, engine, gone, "Da OS cancelada", sent_at=ago(days=3))
    await transition(client, world.supervisor.headers, gone, "cancelled", note="OS duplicada")

    expected = {
        not_opened["id"]: "not_opened",
        no_answer["id"]: "no_answer",
        expiring["id"]: "expiring",
        expired["id"]: "expired",
        expired_7["id"]: "expired",
        in_review["id"]: "in_review",
        recent["id"]: None,
        old_expired["id"]: None,
        reminded["id"]: None,
        stale["id"]: None,
        draft["id"]: None,
        lost["id"]: None,
    }
    listed = (await client.get(f"{API}/quotes", headers=an)).json()
    assert {q["id"]: q["follow_up"] for q in listed} == expected
    for ticket in (t, gone):
        per_ticket = (await client.get(f"{API}/tickets/{ticket['id']}/quotes", headers=an)).json()
        assert {q["id"]: q["follow_up"] for q in per_ticket} == {
            q["id"]: expected[q["id"]] for q in per_ticket
        }

    # A fila (filtrada no banco) tem exatamente os que têm motivo: quem vence antes primeiro,
    # sem validade no fim e, no empate, o contato mais antigo.
    ids = await queue_ids(client, world)
    assert ids == [
        expired_7["id"],
        expired["id"],
        expiring["id"],
        not_opened["id"],
        no_answer["id"],
        in_review["id"],
    ]
    assert set(ids) == {i for i, reason in expected.items() if reason}

    # O Início conta a mesma fila e mostra os 5 primeiros com o motivo.
    group = await home_group(client, world, "quotes_waiting")
    assert group is not None and group["count"] == len(ids)
    assert (group["title"], group["link"], group["severity"]) == (
        "Orçamentos para cobrar",
        "/orcamentos?cobrar=1",
        "low",
    )
    code = {q["id"]: q["code"] for q in listed}
    assert [i["reason"] for i in group["items"]] == [
        f"{code[expired_7['id']]} (R$ 100,00) venceu em {days(-7):%d/%m}: renove",
        f"{code[expired['id']]} (R$ 100,00) venceu em {days(-2):%d/%m}: renove",
        f"{code[expiring['id']]} (R$ 100,00) vence amanhã",
        f"{code[not_opened['id']]} (R$ 100,00) enviado há 3 dias, não aberto",
        f"{code[no_answer['id']]} (R$ 100,00) enviado há 4 dias, aberto 2x, sem resposta",
    ]

    # Com um filtro (a busca), a fila continua sendo só a dos motivos.
    r = await client.get(f"{API}/quotes", params={"follow_up": "true", "q": "revisão"}, headers=an)
    assert [q["id"] for q in r.json()] == [in_review["id"]]

    # Cobrou hoje o que vence amanhã: sai da fila (volta amanhã, no dia em que vence).
    r = await client.post(f"{API}/quotes/{expiring['id']}/remind", headers=an)
    assert r.status_code == 200
    ids = await queue_ids(client, world)
    assert expiring["id"] not in ids and len(ids) == 5
    listed = (await client.get(f"{API}/quotes", headers=an)).json()
    assert {q["id"] for q in listed if q["follow_up"]} == set(ids)
    group = await home_group(client, world, "quotes_waiting")
    assert group is not None and group["count"] == 5


async def test_remind_records_who_and_when_and_leaves_the_queue(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Troca de fonte")
    q = await sent_quote(client, world, engine, t, "Troca de fonte", sent_at=ago(days=3))
    assert q["id"] in await queue_ids(client, world)
    url = f"{API}/quotes/{q['id']}/remind"
    for actor in (world.tech, world.requester):
        assert (await client.post(url, headers=actor.headers)).status_code == 403

    r = await client.post(url, headers=an)
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["reminder_count"], out["follow_up"], out["status"]) == (1, None, "sent")
    assert out["last_reminded_by"] == {"id": str(world.analyst.user.id), "name": "Analista"}
    assert datetime.fromisoformat(out["last_reminded_at"]) > ago(minutes=1)
    # A cobrança é o último contato: o orçamento sai da fila (e do Início) por 48 h.
    assert q["id"] not in await queue_ids(client, world)
    assert await home_group(client, world, "quotes_waiting") is None

    # O histórico da OS registra quem cobrou, só para a gestão.
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    reminded = [e for e in events if e["event_type"] == "quote_reminded"]
    assert len(reminded) == 1
    assert (reminded[0]["to_value"], reminded[0]["actor"]["id"]) == (
        q["code"],
        str(world.analyst.user.id),
    )
    assert reminded[0]["data"] == {"quote_id": q["id"], "count": 1, "total": "100.00"}
    assert "quote_reminded" in _INTERNAL_EVENT_TYPES
    rq = world.requester.headers
    assert (await client.get(f"{API}/tickets/{t['id']}/events", headers=rq)).status_code == 403
    portal = await client.get(f"{API}/portal/requests/{t['id']}", headers=rq)
    assert portal.status_code == 200 and "quote_reminded" not in json.dumps(portal.json())

    # Cobrar de novo soma e troca quem cobrou.
    again = (await client.post(url, headers=world.supervisor.headers)).json()
    assert (again["reminder_count"], again["last_reminded_by"]["name"]) == (2, "Super")

    # Rascunho, vencido, sem link e OS cancelada não são cobrados.
    draft = await new_quote(client, world, t["id"], "Rascunho")
    overdue = await sent_quote(client, world, engine, t, "Vencido", valid_until=days(-1))
    no_link = await sent_quote(client, world, engine, t, "Sem link", link_id=None, token_hash=None)
    other = await create(client, world, title="OS cancelada")
    lost = await sent_quote(client, world, engine, other, "Da OS cancelada")
    await transition(client, world.supervisor.headers, other, "cancelled", note="OS duplicada")
    for quote, message in (
        (draft, "Só orçamento aguardando o cliente pode ser cobrado"),
        (overdue, "O orçamento venceu: renove a validade antes de cobrar"),
        (no_link, "Gere o link antes de cobrar"),
        (lost, CANCELLED_TICKET),
    ):
        r = await client.post(f"{API}/quotes/{quote['id']}/remind", headers=an)
        assert (r.status_code, r.json()["detail"]) == (422, message), quote["title"]
    r = await client.post(f"{API}/quotes/{uuid.uuid4()}/remind", headers=an)
    assert (r.status_code, r.json()["detail"]) == (404, "Orçamento não encontrado")


async def test_resending_after_a_reminder_is_the_latest_contact(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Cobrado há 3 dias e reenviado (ou renovado) agora: o contato é o reenvio, não a cobrança
    antiga, e o orçamento não volta para a fila logo depois de sair para o cliente."""
    t = await create(client, world, title="Troca de nobreak")
    q = await sent_quote(client, world, engine, t, "Troca de nobreak", sent_at=ago(days=5))
    r = await client.post(f"{API}/quotes/{q['id']}/remind", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    await set_quote(engine, q["id"], last_reminded_at=ago(days=3))
    # Sem reenvio, a cobrança de 3 dias atrás é o último contato: volta para a fila.
    assert q["id"] in await queue_ids(client, world)

    await send(client, world, q)
    assert q["id"] not in await queue_ids(client, world)
    assert await home_group(client, world, "quotes_waiting") is None
    one = await client.get(f"{API}/tickets/{t['id']}/quotes", headers=world.analyst.headers)
    assert [x["follow_up"] for x in one.json() if x["id"] == q["id"]] == [None]

    # Reenviado há 49 h, depois da cobrança de 3 dias atrás: volta à fila, e o motivo fala do envio.
    await set_quote(engine, q["id"], sent_at=ago(hours=49))
    group = await home_group(client, world, "quotes_waiting")
    assert group is not None
    assert [i["reason"] for i in group["items"]] == [
        f"{q['code']} (R$ 100,00) enviado há 2 dias, não aberto"
    ]


# =========================================================================== aberturas do cliente


async def test_client_opens_count_without_the_team_or_the_preview(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Rack da loja")
    q = await new_quote(client, world, t["id"], "Organização do rack")
    token = await send(client, world, q)
    public = f"{API}/public/quotes/{token}"

    async def state() -> Any:
        async with engine.connect() as conn:
            return (
                await conn.execute(
                    text(
                        "SELECT client_views, client_first_viewed_at, client_last_viewed_at, "
                        "updated_at FROM quotes WHERE id = :i"
                    ),
                    {"i": q["id"]},
                )
            ).one()

    async def ten_minutes_pass() -> None:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "UPDATE quotes SET client_last_viewed_at = "
                    "client_last_viewed_at - interval '11 minutes' WHERE id = :i"
                ),
                {"i": q["id"]},
            )

    before = await state()
    assert (before.client_views, before.client_first_viewed_at) == (0, None)

    # A equipe com sessão e a prévia ("Ver como o cliente") não contam.
    for headers in (an, world.supervisor.headers, world.tech.headers):
        assert (await client.get(public, headers=headers)).status_code == 200
    assert (await client.get(public, params={"preview": "1"})).status_code == 200
    assert (await state()).client_views == 0

    # O cliente abre: conta 1. Recarregar em menos de 10 min não soma (só atualiza a hora).
    view = await client.get(public)
    assert view.status_code == 200
    first = await state()
    assert first.client_views == 1 and first.client_first_viewed_at is not None
    assert first.client_last_viewed_at == first.client_first_viewed_at
    await client.get(public)
    again = await state()
    assert again.client_views == 1
    assert again.client_last_viewed_at >= first.client_last_viewed_at

    # 11 min depois conta de novo; a sessão do portal (solicitante) também é o cliente.
    await ten_minutes_pass()
    await client.get(public)
    assert (await state()).client_views == 2
    await ten_minutes_pass()
    await client.get(public, headers=world.requester.headers)
    later = await state()
    assert later.client_views == 3
    # A 1ª abertura fica; o "atualizado em" do orçamento não muda (não reinicia o "em revisão").
    assert later.client_first_viewed_at == first.client_first_viewed_at
    assert later.updated_at == before.updated_at

    # A equipe vê as aberturas; o cliente não.
    out = (await client.get(f"{API}/tickets/{t['id']}/quotes", headers=an)).json()[0]
    assert out["client_views"] == 3
    assert datetime.fromisoformat(out["client_first_viewed_at"]) == first.client_first_viewed_at
    assert datetime.fromisoformat(out["client_last_viewed_at"]) == later.client_last_viewed_at
    assert INTERNAL_FIELDS.isdisjoint(view.json())


async def test_report_preview_does_not_count_as_a_client_view(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Rede lenta")
    link_url = f"{API}/tickets/{t['id']}/report-link"
    token = (await client.post(link_url, headers=an)).json()["token"]
    public = f"{API}/public/reports/{token}"
    assert (await client.get(public, params={"preview": "1"})).status_code == 200
    assert (await client.post(link_url, headers=an)).json()["views"] == 0
    assert (await client.get(public)).status_code == 200
    assert (await client.post(link_url, headers=an)).json()["views"] == 1


# =========================================================================== pedido de peça


async def test_cancelling_the_quote_releases_its_part_requests(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    published: list[dict] = []

    async def capture(event: dict) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", capture)
    t = await create(client, world, title="Fonte queimada", assignee_id=str(world.tech.user.id))

    async def ask(description: str) -> dict:
        r = await client.post(
            f"{API}/tickets/{t['id']}/part-requests", json={"description": description}, headers=th
        )
        assert r.status_code == 201, r.text
        return r.json()

    part = await ask("Fonte ATX 500W")
    dropped = await ask("Cabo de força")
    q = await new_quote(client, world, t["id"], "Troca da fonte")
    await send(client, world, q)
    for request in (part, dropped):
        linked = await client.patch(
            f"{API}/part-requests/{request['id']}", json={"quote_id": q["id"]}, headers=an
        )
        assert linked.json()["status"] == "quoted"
    # Um pedido que a gestão já cancelou continua como está.
    r = await client.patch(
        f"{API}/part-requests/{dropped['id']}", json={"status": "cancelled"}, headers=an
    )
    assert r.json()["status"] == "cancelled"

    published.clear()
    r = await client.post(f"{API}/quotes/{q['id']}/cancel", headers=an)
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    requests = {
        x["id"]: (x["status"], x["quote_id"])
        for x in (await client.get(f"{API}/tickets/{t['id']}/part-requests", headers=an)).json()
    }
    assert requests == {part["id"]: ("open", None), dropped["id"]: ("cancelled", q["id"])}
    # O técnico vê o pedido esperando orçamento de novo.
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    assert {p["id"]: p["status"] for p in detail["part_requests"]}[part["id"]] == "open"

    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    released = [
        e for e in events if e["event_type"] == "part_request_updated" and e["to_value"] == "open"
    ]
    assert len(released) == 1
    assert (released[0]["from_value"], released[0]["note"]) == (
        "quoted",
        f"Orçamento {q['code']} cancelado",
    )
    assert released[0]["data"]["part_request_id"] == part["id"]
    assert released[0]["data"]["quote_id"] == q["id"]
    # As telas abertas atualizam na hora.
    assert any(
        e["type"] == "ticket.updated" and e["data"] == {"fields": ["part_requests"]}
        for e in published
    )


# =========================================================================== receita


async def test_cancelled_ticket_quotes_leave_the_revenue_totals(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    an = world.analyst.headers
    project = (
        await client.post(
            f"{API}/projects",
            json={"name": "Rede de lojas", "customer_id": world.customer_id},
            headers=an,
        )
    ).json()
    kept = await create(client, world, title="OS que segue", project_id=project["id"])
    gone = await create(client, world, title="OS cancelada", project_id=project["id"])
    for ticket, price in ((kept, "100"), (gone, "500")):
        accepted = await new_quote(client, world, ticket["id"], "Aprovado", price)
        token = await send(client, world, accepted)
        r = await client.post(f"{API}/public/quotes/{token}/approve", json=APPROVAL)
        assert r.status_code == 200, r.text
    for ticket, price in ((kept, "30"), (gone, "70")):
        await send(client, world, await new_quote(client, world, ticket["id"], "Espera", price))
    await transition(client, world.supervisor.headers, gone, "cancelled", note="Loja fechou")

    home = (await client.get(f"{API}/home/overview", headers=world.supervisor.headers)).json()
    finance = home["pulse"]["finance"]
    assert (finance["quotes_waiting"], finance["quotes_waiting_total"]) == (1, 30.0)
    assert (finance["quotes_approved_month"], finance["quotes_approved_month_total"]) == (1, 100.0)
    for params in ({}, {"customer_id": world.customer_id}):
        monthly = await client.get(f"{API}/reports/monthly", params=params, headers=an)
        assert monthly.json()["quotes_approved_total"] == 100.0
    stats = (await client.get(f"{API}/projects/{project['id']}", headers=an)).json()["stats"]
    assert stats["quotes_approved_total"] == 100.0
    # A lista de orçamentos continua mostrando o aprovado da OS cancelada.
    approved = await client.get(f"{API}/quotes", params={"status": "approved"}, headers=an)
    assert sorted(q["total"] for q in approved.json()) == [100.0, 500.0]


# =========================================================================== Field Control


async def test_field_control_history_is_visible_and_searchable(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Troca de fonte")
    q = await new_quote(client, world, t["id"], "Troca de fonte da loja")
    same = await new_quote(client, world, t["id"], "Visita técnica")
    native = await new_quote(client, world, t["id"], "Orçamento novo")
    pdf = {
        "url": "https://arquivos.exemplo.com/cotacao-123.pdf",
        "title": "Cotação",
        "type": "application/pdf",
    }
    await set_quote(
        engine,
        q["id"],
        legacy={
            "source": "fieldcontrol",
            "identifier": "AB12CDEFG",
            "signature_url": None,
            "attachments": [pdf, {"url": None, "title": "Sem arquivo", "type": None}],
            "description": "Fonte queimada: troca e limpeza do rack",
        },
    )
    await set_quote(
        engine,
        same["id"],
        legacy={"identifier": "ZZ98YXWVU", "attachments": [], "description": " VISITA TÉCNICA "},
    )

    # A busca acha pelo código do FC, em minúsculas e com espaços.
    for term in ("ab12cdefg", "  AB12cdefg "):
        found = (await client.get(f"{API}/quotes", params={"q": term}, headers=an)).json()
        assert [x["id"] for x in found] == [q["id"]], term
    out = found[0]
    assert out["legacy_code"] == "AB12CDEFG"
    assert out["legacy_description"] == "Fonte queimada: troca e limpeza do rack"
    assert out["legacy_attachments"] == [pdf]  # só os anexos com link
    per_ticket = await client.get(f"{API}/tickets/{t['id']}/quotes", headers=an)
    listed = {x["id"]: x for x in per_ticket.json()}
    # Descrição igual ao título (sem diferença de maiúscula e espaço) não se repete.
    assert (listed[same["id"]]["legacy_code"], listed[same["id"]]["legacy_description"]) == (
        "ZZ98YXWVU",
        None,
    )
    assert (
        listed[native["id"]]["legacy_code"],
        listed[native["id"]]["legacy_description"],
        listed[native["id"]]["legacy_attachments"],
    ) == (None, None, [])

    # A página do cliente não traz nada do Field Control.
    token = await send(client, world, q)
    view = (await client.get(f"{API}/public/quotes/{token}")).json()
    assert INTERNAL_FIELDS.isdisjoint(view) and "legacy" not in view
    assert "AB12CDEFG" not in json.dumps(view) and "cotacao-123" not in json.dumps(view)


# =========================================================================== catálogo


async def test_catalog_usage_and_the_last_approved_price_of_the_customer(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers

    async def item(name: str, price: str) -> dict:
        r = await client.post(
            f"{API}/quote-items", json={"name": name, "price": price, "kind": "service"}, headers=an
        )
        assert r.status_code == 201, r.text
        assert (r.json()["uses_12m"], r.json()["last_used_at"]) == (0, None)
        return r.json()

    def line(catalog: dict, price: str, quantity: int = 1) -> dict:
        return {
            "description": catalog["name"],
            "quantity": quantity,
            "unit": "un",
            "unit_price": price,
            "catalog_item_id": catalog["id"],
        }

    async def quote(ticket: dict, title: str, *lines: dict) -> dict:
        r = await client.post(
            f"{API}/tickets/{ticket['id']}/quotes",
            json={"title": title, "items": list(lines)},
            headers=an,
        )
        assert r.status_code == 201, r.text
        return r.json()

    visit = await item("Visita técnica", "150")
    cable = await item("Cabo de rede (m)", "4.50")
    unused = await item("Fonte 12V", "60")
    t = await create(client, world, title="Loja A")
    await quote(t, "Rascunho", line(visit, "150"))
    # A visita duas vezes no mesmo orçamento conta um uso.
    both = await quote(
        t, "Dois itens", line(visit, "150"), line(visit, "75"), line(cable, "4.5", 20)
    )
    cancelled = await quote(t, "Cancelado", line(cable, "4.50"))
    r = await client.post(f"{API}/quotes/{cancelled['id']}/cancel", headers=an)
    assert r.status_code == 200
    old = await quote(t, "De mais de um ano", line(visit, "150"), line(unused, "60"))
    await set_quote(engine, old["id"], created_at=ago(days=400))

    catalog = {i["id"]: i for i in (await client.get(f"{API}/quote-items", headers=an)).json()}
    assert catalog[visit["id"]]["uses_12m"] == 2
    assert catalog[cable["id"]]["uses_12m"] == 1
    assert (catalog[unused["id"]]["uses_12m"], catalog[unused["id"]]["last_used_at"]) == (0, None)
    last = datetime.fromisoformat(catalog[visit["id"]]["last_used_at"])
    assert last == datetime.fromisoformat(both["created_at"])
    active = (await client.get(f"{API}/quote-items", params={"active": "true"}, headers=an)).json()
    assert {i["id"]: i["uses_12m"] for i in active}[visit["id"]] == 2
    assert (await client.get(f"{API}/quote-items", headers=world.tech.headers)).status_code == 403

    # Último preço aprovado do cliente: o orçamento aprovado mais recente, por item.
    older = await quote(t, "Aprovado antes", line(visit, "100"), line(cable, "5"))
    newer = await quote(t, "Aprovado depois", line(visit, "120"))
    await quote(t, "Ainda em rascunho", line(visit, "999"))
    await set_quote(engine, older["id"], status=QuoteStatus.APPROVED, decided_at=ago(days=10))
    await set_quote(engine, newer["id"], status=QuoteStatus.APPROVED, decided_at=ago(days=2))
    other = (await client.post(f"{API}/customers", json={"name": "Outra Rede"}, headers=an)).json()
    t2 = await create(
        client, world, title="Loja da outra rede", customer_id=other["id"], location_id=None
    )
    theirs = await quote(t2, "Da outra rede", line(visit, "777"))
    await set_quote(engine, theirs["id"], status=QuoteStatus.APPROVED, decided_at=ago(hours=1))

    url = f"{API}/quote-items/last-prices"
    mine = (await client.get(url, params={"customer_id": world.customer_id}, headers=an)).json()
    by_item = {p["catalog_item_id"]: p for p in mine}
    assert set(by_item) == {visit["id"], cable["id"]}
    assert (
        by_item[visit["id"]]["unit_price"],
        by_item[visit["id"]]["quote_id"],
        by_item[visit["id"]]["quote_code"],
    ) == (120.0, newer["id"], newer["code"])
    assert datetime.fromisoformat(by_item[visit["id"]]["decided_at"]) < utcnow()
    assert (by_item[cable["id"]]["unit_price"], by_item[cable["id"]]["quote_code"]) == (
        5.0,
        older["code"],
    )
    their_prices = (await client.get(url, params={"customer_id": other["id"]}, headers=an)).json()
    assert [(p["catalog_item_id"], p["unit_price"]) for p in their_prices] == [(visit["id"], 777.0)]
    # Só a gestão, e o cliente é obrigatório.
    for actor in (world.tech, world.requester):
        r = await client.get(url, params={"customer_id": world.customer_id}, headers=actor.headers)
        assert r.status_code == 403
    assert (await client.get(url, headers=an)).status_code == 422


# =========================================================================== tempo real


async def test_decision_toast_carries_the_total(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    published: list[dict] = []

    async def capture(event: dict) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", capture)
    an = world.analyst.headers
    t = await create(client, world, title="Rack")
    q = await new_quote(client, world, t["id"], "Organização do rack", "350")
    token = await send(client, world, q)
    # Cobrado antes de responder: a resposta do cliente segue normal.
    assert (await client.post(f"{API}/quotes/{q['id']}/remind", headers=an)).status_code == 200
    r = await client.post(f"{API}/public/quotes/{token}/approve", json=APPROVAL)
    assert r.status_code == 200, r.text
    decided = [e for e in published if e["type"] == "quote.decided"]
    assert [(e["quote_code"], e["status"], e["total"]) for e in decided] == [
        (q["code"], "approved", 350.0)
    ]
    out = (await client.get(f"{API}/tickets/{t['id']}/quotes", headers=an)).json()[0]
    assert (out["status"], out["reminder_count"], out["follow_up"]) == ("approved", 1, None)
    assert out["last_reminded_by"]["name"] == "Analista"
