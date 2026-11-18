"""Correções pedidas pelas telas da central: o que a API passou a mandar (ou deixou de mandar)
para a tela mostrar certo."""

import base64
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from app.services import realtime
from app.services.activities import day_bounds, local_today
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


async def _sql(engine: AsyncEngine, sql: str, **params: object) -> None:
    async with engine.begin() as conn:
        await conn.execute(text(sql), params)


def _dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


async def test_lists_carry_the_start_of_the_current_visit(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O tempo na loja das listas conta da entrada atual, não da 1ª chegada (como o cabeçalho)."""
    an, th = world.analyst.headers, world.tech.headers
    t = await create(
        client,
        world,
        title="Rack",
        assignee_id=str(world.tech.user.id),
        owner_id=str(world.analyst.user.id),
    )
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, an, t, "on_hold_vendor", note="Aguardando peça")
    # A 1ª visita foi há 2 dias e durou 1 h.
    await _sql(
        engine,
        "UPDATE tickets SET arrived_at = now() - interval '2 days', work_seconds = 3600 "
        "WHERE id = :i",
        i=uuid.UUID(t["id"]),
    )
    # Fora da loja não há visita em curso.
    listing = (await client.get(f"{API}/tickets", headers=an)).json()["items"]
    waiting = next(i for i in listing if i["id"] == t["id"])
    assert waiting["work_started_at"] is None

    t = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    t = await transition(client, th, t, "in_progress")
    now = datetime.now(UTC)
    listing = (await client.get(f"{API}/tickets", headers=an)).json()["items"]
    item = next(i for i in listing if i["id"] == t["id"])
    assert now - _dt(item["work_started_at"]) < timedelta(minutes=2)
    assert now - _dt(item["arrived_at"]) > timedelta(days=1)
    assert item["work_started_at"] == t["work_started_at"]
    # A Minha fila usa o mesmo item.
    queue = (await client.get(f"{API}/my-queue", headers=an)).json()
    row = next(i for i in queue["items"] if i["id"] == t["id"])
    assert row["work_started_at"] == t["work_started_at"]


async def test_reopened_report_drops_the_old_result(client: AsyncClient, world: World) -> None:
    """Reaberta, a OS não mostra ao cliente a solução nem a assinatura da conclusão anterior."""
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Impressora", assignee_id=str(world.tech.user.id))
    t = await transition(client, th, t, "en_route")
    t = await transition(client, th, t, "in_progress")
    r = await client.post(
        f"{API}/tickets/{t['id']}/signature",
        files={"file": ("assinatura.png", PNG, "image/png")},
        data={"signer_name": "Gerente da Loja", "signer_role": "Gerente"},
        headers=th,
    )
    assert r.status_code == 200, r.text
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    t = await transition(client, th, t, "resolved", resolution_notes="Rolo trocado")
    link = await client.post(f"{API}/tickets/{t['id']}/report-link", headers=an)
    assert link.status_code == 200, link.text
    public = f"{API}/public/reports/{link.json()['token']}"
    done = (await client.get(public)).json()
    assert done["resolution_notes"] == "Rolo trocado"
    assert done["signature"]["name"] == "Gerente da Loja"

    t = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    t = await transition(client, an, t, "reopened", note="Voltou a falhar")
    await transition(client, th, t, "in_progress")
    current = (await client.get(public)).json()
    assert current["status"] == "in_progress"
    assert current["resolution_notes"] is None
    assert current["signature"] is None
    # A foto da assinatura também não vira foto da visita.
    assert all(p["filename"] != "assinatura.png" for p in current["photos"])


async def test_repair_edit_keeps_what_the_stage_saved(client: AsyncClient, world: World) -> None:
    """Editar os dados do equipamento não apaga o orçamento e a previsão lançados na etapa."""
    an = world.analyst.headers
    body = {
        "customer_id": world.customer_id,
        "location_id": world.location_id,
        "brand": "HP",
        "serial_number": "BRB0000001",
        "problem": "Papel amassando",
    }
    repair = (await client.post(f"{API}/repairs", json=body, headers=an)).json()

    async def move(to: str, **extra: object) -> dict:
        r = await client.post(
            f"{API}/repairs/{repair['id']}/status", json={"to_status": to, **extra}, headers=an
        )
        assert r.status_code == 200, r.text
        return r.json()

    back = (local_today() + timedelta(days=10)).isoformat()
    await move("received")
    await move("sent_to_vendor", expected_return_date=back)
    out = await move("vendor_quote", vendor_quote_value="350.00")
    assert (out["vendor_quote_value"], out["expected_return_date"]) == (350.0, back)

    # O formulário aberto antes da etapa manda só os dados do equipamento.
    r = await client.put(
        f"{API}/repairs/{repair['id']}",
        json={**body, "serial_number": "BRB0000002"},
        headers=an,
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["serial_number"] == "BRB0000002"
    assert (out["vendor_quote_value"], out["expected_return_date"]) == (350.0, back)

    # Mandados no corpo, valem (inclusive para limpar).
    later = (local_today() + timedelta(days=20)).isoformat()
    r = await client.put(
        f"{API}/repairs/{repair['id']}",
        json={**body, "expected_return_date": later, "vendor_quote_value": None},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert (r.json()["vendor_quote_value"], r.json()["expected_return_date"]) == (None, later)


async def test_location_event_carries_the_whole_point(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A posição nova vai com velocidade, direção, precisão, bateria e GPS simulado."""
    published: list[dict] = []

    async def capture(event: dict) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", capture)
    h = world.tech.headers
    assert (await client.post(f"{API}/tracking/consent", headers=h)).status_code == 204
    r = await client.post(f"{API}/tracking/shift/start", json={}, headers=h)
    assert r.status_code == 200, r.text
    now = datetime.now(UTC)
    point = {
        "recorded_at": now.isoformat(),
        "latitude": -23.56,
        "longitude": -46.65,
        "accuracy_m": 8.5,
        "speed_mps": 0.0,
        "heading": 90.0,
        "battery_pct": 64,
        "is_mock": True,
    }
    older = {**point, "recorded_at": (now - timedelta(seconds=20)).isoformat(), "speed_mps": 14.0}
    r = await client.post(f"{API}/tracking/pings", json={"pings": [older, point]}, headers=h)
    assert r.json() == {"accepted": 2, "discarded": 0}
    event = next(e for e in published if e["type"] == "technician.location")
    # O ponto mais novo do lote, inteiro.
    assert {k: event[k] for k in ("accuracy_m", "speed_mps", "heading", "battery_pct")} == {
        "accuracy_m": 8.5,
        "speed_mps": 0.0,
        "heading": 90.0,
        "battery_pct": 64,
    }
    assert event["is_mock"] is True
    assert event["audience"] == {"managers_only": True}

    # Ponto sem esses dados: vão vazios (o mapa não repete os do ponto anterior).
    published.clear()
    plain = {"recorded_at": datetime.now(UTC).isoformat(), "latitude": -23.5, "longitude": -46.6}
    r = await client.post(f"{API}/tracking/pings", json={"pings": [plain]}, headers=h)
    assert r.json() == {"accepted": 1, "discarded": 0}
    event = next(e for e in published if e["type"] == "technician.location")
    assert (event["speed_mps"], event["heading"], event["accuracy_m"], event["is_mock"]) == (
        None,
        None,
        None,
        False,
    )


async def test_portal_waiting_counts_every_page(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O aviso "aguardam um retorno de vocês" conta todas as páginas, com os mesmos filtros."""
    req = world.requester.headers
    created = [await create(client, world, title=f"Chamado {n:02d}") for n in range(25)]
    # A mais antiga (fica na 2ª página) espera o cliente.
    await _sql(
        engine,
        "UPDATE tickets SET status = 'on_hold_customer', created_at = now() - interval '1 day' "
        "WHERE id = :i",
        i=uuid.UUID(created[0]["id"]),
    )
    page = (
        await client.get(f"{API}/portal/requests", params={"page_size": 20}, headers=req)
    ).json()
    assert (page["total"], len(page["items"]), page["waiting"]) == (25, 20, 1)
    assert created[0]["id"] not in {i["id"] for i in page["items"]}
    # Com a busca, conta só o que bate com ela.
    found = (
        await client.get(f"{API}/portal/requests", params={"q": "Chamado 01"}, headers=req)
    ).json()
    assert (found["total"], found["waiting"]) == (1, 0)
    done = (
        await client.get(f"{API}/portal/requests", params={"scope": "done"}, headers=req)
    ).json()
    assert done["waiting"] == 0


async def test_customer_locations_by_number_of_tickets(client: AsyncClient, world: World) -> None:
    """A ficha do cliente pede só as lojas com mais OS, já na ordem."""
    sup = world.supervisor.headers

    async def store(name: str) -> str:
        r = await client.post(
            f"{API}/customers/{world.customer_id}/locations", json={"name": name}, headers=sup
        )
        assert r.status_code == 201, r.text
        return r.json()["id"]

    quiet, busy, some = await store("Loja A"), await store("Loja B"), await store("Loja C")
    for location, count in ((busy, 3), (some, 1)):
        for n in range(count):
            await create(client, world, title=f"OS {n}", location_id=location)
    url = f"{API}/customers/{world.customer_id}/locations"
    top = (await client.get(url, params={"order": "tickets", "limit": 2}, headers=sup)).json()
    assert [(loc["id"], loc["total_tickets"]) for loc in top] == [(busy, 3), (some, 1)]
    # Sem a ordem, continua por nome (e o empate em OS também desempata pelo nome).
    names = [loc["name"] for loc in (await client.get(url, headers=sup)).json()]
    assert names == ["Loja A", "Loja B", "Loja C", "Matriz"]
    tail = (await client.get(url, params={"order": "tickets"}, headers=sup)).json()
    assert [loc["id"] for loc in tail][2:] == [quiet, world.location_id]
    bad = await client.get(url, params={"order": "valor"}, headers=sup)
    assert bad.status_code == 422


async def test_quote_list_carries_the_ticket_status(client: AsyncClient, world: World) -> None:
    """A lista de orçamentos diz quando a OS foi cancelada (a tela esconde o que a API recusa)."""
    an, sup = world.analyst.headers, world.supervisor.headers
    body = {
        "title": "Troca de fonte",
        "items": [{"description": "Fonte", "quantity": 1, "unit": "un", "unit_price": "120"}],
    }
    live = await create(client, world, title="Fonte")
    gone = await create(client, world, title="Fonte da loja fechada")
    for t in (live, gone):
        r = await client.post(f"{API}/tickets/{t['id']}/quotes", json=body, headers=an)
        assert r.status_code == 201, r.text
    await transition(client, sup, gone, "cancelled", note="Loja fechou")
    rows = {q["ticket_id"]: q for q in (await client.get(f"{API}/quotes", headers=an)).json()}
    assert rows[live["id"]]["ticket_status"] == "new"
    assert rows[gone["id"]]["ticket_status"] == "cancelled"


async def test_sla_violations_window_matches_the_list_cut(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O cartão de violações conta desde a 0h do dia de `days` atrás, o mesmo corte da lista que
    ele abre (created_from). Antes a janela corria com a hora e perdia o começo daquele dia."""
    an = world.analyst.headers
    days = 30
    first_day = local_today() - timedelta(days=days)
    start, _ = day_bounds(first_day)
    owner = str(world.analyst.user.id)
    inside = await create(client, world, title="Dentro da janela", owner_id=owner)
    outside = await create(client, world, title="Fora da janela", owner_id=owner)

    async def total() -> int:
        r = await client.get(f"{API}/reports/sla-violations", params={"days": days}, headers=an)
        assert r.status_code == 200, r.text
        return r.json()["tickets_total"]

    before = await total()
    for t, at in ((inside, start + timedelta(minutes=1)), (outside, start - timedelta(minutes=1))):
        await _sql(
            engine, "UPDATE tickets SET created_at = :at WHERE id = :i", at=at, i=uuid.UUID(t["id"])
        )
    assert await total() == before - 1

    day = first_day.isoformat()
    params = {"created_from": day, "created_to": day}
    listing = (await client.get(f"{API}/tickets", params=params, headers=an)).json()["items"]
    ids = {i["id"] for i in listing}
    assert inside["id"] in ids
    assert outside["id"] not in ids


async def test_list_filters_by_the_day_of_the_resolution(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O atalho do ranking de técnicos abre as OS resolvidas no período contado (o dia da
    resolução), e não o histórico inteiro do técnico."""
    an, th = world.analyst.headers, world.tech.headers
    tech = str(world.tech.user.id)
    done = await create(client, world, title="Resolvida", assignee_id=tech)
    other = await create(client, world, title="Em aberto", assignee_id=tech)
    done = await transition(client, th, done, "en_route")
    done = await transition(client, th, done, "in_progress")
    r = await client.post(
        f"{API}/tickets/{done['id']}/signature",
        files={"file": ("assinatura.png", PNG, "image/png")},
        data={"signer_name": "Gerente da Loja", "signer_role": "Gerente"},
        headers=th,
    )
    assert r.status_code == 200, r.text
    done = (await client.get(f"{API}/tickets/{done['id']}", headers=th)).json()
    await transition(client, th, done, "resolved", resolution_notes="Ok")
    # A resolução foi há 3 dias.
    await _sql(
        engine,
        "UPDATE ticket_events SET created_at = now() - interval '3 days' "
        "WHERE ticket_id = :i AND to_value = 'resolved'",
        i=uuid.UUID(done["id"]),
    )
    day = (local_today() - timedelta(days=3)).isoformat()

    async def ids(**params: str) -> set[str]:
        query = {"assignee_id": tech, **params}
        r = await client.get(f"{API}/tickets", params=query, headers=an)
        assert r.status_code == 200, r.text
        return {i["id"] for i in r.json()["items"]}

    that_day = await ids(resolved_from=day, resolved_to=day)
    assert done["id"] in that_day
    assert other["id"] not in that_day
    assert done["id"] not in await ids(resolved_from=local_today().isoformat())
    bad = await client.get(f"{API}/tickets", params={"resolved_from": "1990-01-01"}, headers=an)
    assert bad.status_code == 422
