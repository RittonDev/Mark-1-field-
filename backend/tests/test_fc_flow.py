"""Fluxo do Field Control na Maxx Field: textos para o grupo do cliente (o da vez marcado),
etiquetas automáticas (abertura, projeto, custo extra, técnico pago), a lista de atividades
(filtros, ordem e exportação) e as etiquetas em lote."""

import csv
import io
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.models import Ticket, TicketEvent
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX
TZ = ZoneInfo(settings.TIMEZONE)
PENDING_PAYMENT = {"name": "Pendente Envio PGTO", "color": "field-pale"}
ONE_OFF = {"name": "Ticket Avulso", "color": "green"}
OPENING = [PENDING_PAYMENT, ONE_OFF]
PROJECT = {"name": "Projeto", "color": "purple"}
EXTRA_COST = {"name": "Custo Extra", "color": "yellow"}
DEFAULT_RULES = {
    "on_create": OPENING,
    "on_project": [PROJECT],
    "on_extra_cost": [EXTRA_COST],
    "remove_on_payout_paid": ["Pendente Envio PGTO"],
}


async def set_columns(engine: AsyncEngine, ticket_id: str, **values: Any) -> None:
    """Grava direto no banco o que a API não deixa escolher (data de abertura, prazo)."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        await db.execute(update(Ticket).where(Ticket.id == uuid.UUID(ticket_id)).values(**values))
        await db.commit()


async def set_history_at(engine: AsyncEngine, ticket_id: str, when: datetime) -> None:
    """Leva todo o histórico da OS (as mudanças de status) para `when`."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        await db.execute(
            update(TicketEvent)
            .where(TicketEvent.ticket_id == uuid.UUID(ticket_id))
            .values(created_at=when)
        )
        await db.commit()


def at(iso: str) -> datetime:
    return datetime.fromisoformat(iso).astimezone(TZ)


def minute(delta: timedelta) -> datetime:
    """Agora + `delta`, no minuto cheio."""
    return (datetime.now(UTC) + delta).replace(second=0, microsecond=0)


async def suggested_of(client: AsyncClient, world: World, ticket: dict) -> list[str]:
    r = await client.get(f"{API}/tickets/{ticket['id']}/messages", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    return [m["key"] for m in r.json() if m["suggested"]]


async def texts_of(client: AsyncClient, world: World, ticket: dict) -> dict[str, str]:
    r = await client.get(f"{API}/tickets/{ticket['id']}/messages", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    return {m["key"]: m["text"] for m in r.json()}


def tag_events(events: list[dict]) -> list[dict]:
    return [
        e
        for e in events
        if e["event_type"] == "updated" and "tags" in ((e["data"] or {}).get("changes") or {})
    ]


# ------------------------------------------------------------------ textos para o grupo


async def test_group_texts_follow_the_ticket(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tech = str(world.tech.user.id)
    start = (datetime.now(UTC) + timedelta(days=1)).replace(second=0, microsecond=0)
    t = await create(
        client, world, title="PDV parado", assignee_id=tech, scheduled_start=start.isoformat()
    )

    async def texts(ticket: dict) -> list[dict]:
        r = await client.get(f"{API}/tickets/{ticket['id']}/messages", headers=an)
        assert r.status_code == 200, r.text
        return r.json()

    async def suggested(ticket: dict) -> list[str]:
        return [m["key"] for m in await texts(ticket) if m["suggested"]]

    msgs = await texts(t)
    assert [(m["key"], m["name"]) for m in msgs] == [
        ("agendamento", "Atividade confirmada"),
        ("deslocamento", "Técnico em deslocamento"),
        ("chegada", "Técnico chegou"),
        ("atraso", "Atraso na chegada"),
        ("fechamento", "Atividade encerrada"),
        ("improdutiva", "Visita improdutiva"),
    ]
    assert [m["key"] for m in msgs if m["suggested"]] == ["agendamento"]
    text = {m["key"]: m["text"] for m in msgs}
    head = f"*{t['code']}* · Cliente Teste\n"
    assert text["agendamento"] == (
        f"{head}Atividade confirmada para {at(start.isoformat()):%d/%m às %H:%M} em Matriz.\n"
        "Técnico: Tecnico."
    )
    # O link do relatório vai em qualquer status (antes de concluir, a página mostra o andamento).
    link = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()["report_link"]
    assert text["fechamento"].endswith(f"\nRelatório do atendimento: {link['url']}")
    assert (await client.get(f"{API}/tickets/{t['id']}/messages", headers=th)).status_code == 403

    # Sem técnico (ou sem agenda) ainda não há o que confirmar.
    assert await suggested(await create(client, world, title="Sem técnico")) == []

    t = await transition(client, th, t, "en_route")
    assert await suggested(t) == ["deslocamento"]
    # Passou do prazo de chegada: o texto da vez é o do atraso.
    await set_columns(engine, t["id"], arrival_due_at=datetime.now(UTC) - timedelta(minutes=5))
    assert await suggested(t) == ["atraso"]
    # Sem o modelo de atraso (a gestão tirou), vale o de deslocamento.
    templates = (await client.get(f"{API}/message-templates", headers=an)).json()["templates"]
    kept = [tpl for tpl in templates if tpl["key"] != "atraso"]
    r = await client.put(f"{API}/message-templates", json={"templates": kept}, headers=an)
    assert r.status_code == 200, r.text
    assert await suggested(t) == ["deslocamento"]
    await client.post(f"{API}/message-templates/reset", headers=an)

    t = await transition(client, th, t, "in_progress")
    office = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    msgs = await texts(t)
    assert [m["key"] for m in msgs if m["suggested"]] == ["chegada"]
    arrival = next(m["text"] for m in msgs if m["key"] == "chegada")
    assert arrival == (
        f"{head}O técnico Tecnico chegou em Matriz às {at(office['arrived_at']):%H:%M} "
        "e iniciou o atendimento."
    )

    t = await transition(client, th, t, "resolved", resolution_notes="Fonte trocada")
    msgs = await texts(t)
    assert [m["key"] for m in msgs if m["suggested"]] == ["fechamento"]
    closing = next(m["text"] for m in msgs if m["key"] == "fechamento")
    assert closing == (
        f"{head}Atividade encerrada em Matriz às {at(t['resolved_at']):%H:%M}.\n"
        f"Técnico: Tecnico.\nRelatório do atendimento: {link['url']}"
    )
    t = await transition(client, an, t, "closed")
    assert await suggested(t) == ["fechamento"]


async def test_unproductive_and_cancelled_texts(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tech = str(world.tech.user.id)
    start = (datetime.now(UTC) + timedelta(days=2)).replace(second=0, microsecond=0)
    reason = (
        await client.post(
            f"{API}/unproductive-reasons",
            json={"name": "Loja fechada", "responsibility": "customer"},
            headers=an,
        )
    ).json()

    async def suggested(ticket: dict) -> list[str]:
        msgs = (await client.get(f"{API}/tickets/{ticket['id']}/messages", headers=an)).json()
        return [m["key"] for m in msgs if m["suggested"]]

    u = await create(
        client, world, title="Câmera", assignee_id=tech, scheduled_start=start.isoformat()
    )
    u = await transition(client, th, u, "en_route")
    r = await client.post(
        f"{API}/tickets/{u['id']}/unproductive",
        json={"reason_id": reason["id"], "expected_version": u["version"]},
        headers=th,
    )
    assert r.status_code == 200, r.text
    u = r.json()
    assert await suggested(u) == ["improdutiva"]
    msgs = (await client.get(f"{API}/tickets/{u['id']}/messages", headers=an)).json()
    text = next(m["text"] for m in msgs if m["key"] == "improdutiva")
    assert text.endswith(
        "Visita improdutiva em Matriz (Loja fechada). Vamos reagendar e avisamos o novo horário."
    )
    # Remarcada: o texto da vez volta a ser a confirmação da atividade.
    later = (start + timedelta(days=1)).isoformat()
    u = await transition(client, an, u, "scheduled", scheduled_start=later)
    assert await suggested(u) == ["agendamento"]

    # Cancelada: nenhum texto combina.
    c = await create(
        client,
        world,
        title="Desistiu",
        assignee_id=tech,
        scheduled_start=(start + timedelta(hours=6)).isoformat(),
    )
    c = await transition(client, an, c, "cancelled", note="Cliente desistiu")
    assert await suggested(c) == []


async def test_revisit_lateness_follows_the_new_visit(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Na revisita o prazo de chegada é o da primeira ida (já vencido; não muda depois da
    chegada): o atraso se mede pela visita remarcada, com a mesma tolerância."""
    an, th = world.analyst.headers, world.tech.headers
    reason = (
        await client.post(
            f"{API}/unproductive-reasons",
            json={"name": "Sem acesso ao rack", "responsibility": "customer"},
            headers=an,
        )
    ).json()
    t = await create(
        client,
        world,
        title="Rack trancado",
        assignee_id=str(world.tech.user.id),
        scheduled_start=minute(timedelta(hours=1)).isoformat(),
    )
    t = await transition(client, th, t, "en_route")
    t = await transition(client, th, t, "in_progress")
    r = await client.post(
        f"{API}/tickets/{t['id']}/unproductive",
        json={"reason_id": reason["id"], "expected_version": t["version"]},
        headers=th,
    )
    assert r.status_code == 200, r.text
    t = r.json()
    assert t["status"] == "assigned" and t["scheduled_start"] is None
    await set_columns(engine, t["id"], arrival_due_at=datetime.now(UTC) - timedelta(hours=1))
    assert await suggested_of(client, world, t) == ["improdutiva"]

    t = await transition(
        client, an, t, "scheduled", scheduled_start=minute(timedelta(days=2)).isoformat()
    )
    assert await suggested_of(client, world, t) == ["agendamento"]
    t = await transition(client, th, t, "en_route")
    assert await suggested_of(client, world, t) == ["deslocamento"]

    # A visita remarcada passou da tolerância: agora, sim, o texto da vez é o do atraso.
    left = datetime.now(UTC) - timedelta(hours=3)
    await set_history_at(engine, t["id"], left)
    await set_columns(
        engine,
        t["id"],
        arrived_at=left - timedelta(hours=1),
        scheduled_start=datetime.now(UTC) - timedelta(hours=1),
    )
    assert await suggested_of(client, world, t) == ["atraso"]
    # Agenda de antes da última saída do local (a da ida anterior) não conta.
    await set_columns(engine, t["id"], scheduled_start=left - timedelta(minutes=30))
    assert await suggested_of(client, world, t) == ["deslocamento"]


async def test_old_visit_is_not_confirmed_again(client: AsyncClient, world: World) -> None:
    """A confirmação da atividade só vale para a agenda em dia: nem a de um dia que já passou nem
    a da visita anterior de uma OS reaberta (concluir e reabrir não tiram a agenda)."""
    an, th = world.analyst.headers, world.tech.headers
    tech = str(world.tech.user.id)
    yesterday = await create(
        client,
        world,
        title="Ficou para trás",
        assignee_id=tech,
        scheduled_start=minute(-timedelta(days=1)).isoformat(),
    )
    assert yesterday["scheduled_start"] is not None
    assert await suggested_of(client, world, yesterday) == []

    t = await create(
        client,
        world,
        title="Voltou a falhar",
        assignee_id=tech,
        scheduled_start=minute(-timedelta(hours=2)).isoformat(),
    )
    t = await transition(client, th, t, "en_route")
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Cabo trocado")
    t = await transition(client, an, t, "reopened", note="Parou de novo")
    assert t["scheduled_start"] is not None and t["assignee"] is not None
    assert await suggested_of(client, world, t) == []
    t = await transition(
        client, an, t, "scheduled", scheduled_start=minute(timedelta(days=1)).isoformat()
    )
    assert await suggested_of(client, world, t) == ["agendamento"]


async def test_default_texts_leave_out_missing_data(client: AsyncClient, world: World) -> None:
    """Os textos padrão vão para o grupo do cliente com um clique: a frase sem o dado (sem
    previsão de chegada, sem técnico) sai. Nos escritos pela gestão, a marca fica."""
    an, th = world.analyst.headers, world.tech.headers
    # Horário combinado já passou e o técnico não está com a localização ligada: sem previsão.
    t = await create(
        client,
        world,
        title="Atrasado sem posição",
        assignee_id=str(world.tech.user.id),
        scheduled_start=minute(-timedelta(hours=1)).isoformat(),
    )
    t = await transition(client, th, t, "en_route")
    head = f"*{t['code']}* · Cliente Teste\n"
    text = await texts_of(client, world, t)
    assert text["deslocamento"] == f"{head}O técnico Tecnico está a caminho de Matriz."
    assert text["atraso"] == f"{head}O técnico Tecnico está a caminho de Matriz, com atraso."

    # O padrão gravado pela gestão sem mudança continua padrão.
    defaults = (await client.get(f"{API}/message-templates", headers=an)).json()["templates"]
    r = await client.put(f"{API}/message-templates", json={"templates": defaults}, headers=an)
    assert r.status_code == 200, r.text
    assert (await texts_of(client, world, t))["deslocamento"] == text["deslocamento"]
    # Texto escrito pela gestão: a marca fica, para o analista completar antes de mandar.
    own = {"name": "Previsão", "body": "Chegada às {chegada_prevista}. Técnico: {tecnico}."}
    r = await client.put(f"{API}/message-templates", json={"templates": [own]}, headers=an)
    assert r.status_code == 200, r.text
    assert await texts_of(client, world, t) == {"previsao": "Chegada às __:__. Técnico: Tecnico."}
    await client.post(f"{API}/message-templates/reset", headers=an)

    # Concluída no remoto, sem técnico: sai só a linha do técnico.
    remote = await create(client, world, title="Senha do Wi-Fi")
    remote = await transition(client, an, remote, "on_hold_customer")
    remote = await transition(client, an, remote, "resolved", resolution_notes="Senha trocada")
    link = (await client.get(f"{API}/tickets/{remote['id']}", headers=an)).json()["report_link"]
    assert (await texts_of(client, world, remote))["fechamento"] == (
        f"*{remote['code']}* · Cliente Teste\n"
        f"Atividade encerrada em Matriz às {at(remote['resolved_at']):%H:%M}.\n"
        f"Relatório do atendimento: {link['url']}"
    )


# ------------------------------------------------------------------ etiquetas automáticas


async def test_tag_rules_defaults_validation_and_permissions(
    client: AsyncClient, world: World
) -> None:
    an, sup = world.analyst.headers, world.supervisor.headers
    url = f"{API}/ticket-tag-rules"
    assert (await client.get(url, headers=an)).json() == DEFAULT_RULES
    assert (await client.get(url, headers=world.tech.headers)).status_code == 403
    assert (await client.get(url, headers=world.requester.headers)).status_code == 403
    # Só supervisor e admin mudam as regras.
    assert (await client.put(url, json=DEFAULT_RULES, headers=an)).status_code == 403

    def rules(**change: Any) -> dict:
        return {**DEFAULT_RULES, **change}

    invalid = [
        rules(on_create=[{"name": "x" * 41, "color": None}]),
        rules(on_create=[{"name": "   ", "color": "green"}]),
        rules(on_project=[{"name": "Projeto", "color": "magenta"}]),
        rules(on_extra_cost=[{"name": "Custo Extra"}, {"name": " custo  EXTRA "}]),
        rules(on_create=[{"name": f"Etiqueta {n}"} for n in range(11)]),
        rules(remove_on_payout_paid=["PGTO", "pgto"]),
        {"on_create": OPENING},
    ]
    for body in invalid:
        r = await client.put(url, json=body, headers=sup)
        assert r.status_code == 422, body

    body = rules(
        on_create=[{"name": "  Ticket   Avulso ", "color": "green"}],
        on_extra_cost=[EXTRA_COST, {"name": "Custo KM Rodado", "color": None}],
        remove_on_payout_paid=[" Pendente Envio PGTO "],
    )
    r = await client.put(url, json=body, headers=sup)
    assert r.status_code == 200, r.text
    saved = rules(
        on_create=[ONE_OFF], on_extra_cost=[EXTRA_COST, {"name": "Custo KM Rodado", "color": None}]
    )
    assert r.json() == saved
    assert (await client.get(url, headers=an)).json() == saved
    r = await client.put(url, json=DEFAULT_RULES, headers=world.admin.headers)
    assert r.status_code == 200 and r.json() == DEFAULT_RULES


async def test_new_ticket_gets_the_opening_tags(client: AsyncClient, world: World) -> None:
    an, sup = world.analyst.headers, world.supervisor.headers
    assert (await create(client, world, title="Avulsa"))["tags"] == OPENING
    # null explícito: o mesmo que não mandar.
    assert (await create(client, world, title="Nula", tags=None))["tags"] == OPENING
    body = {"name": "Lojas novas", "customer_id": world.customer_id}
    project = await client.post(f"{API}/projects", json=body, headers=an)
    assert project.status_code == 201, project.text
    from_project = await create(client, world, title="Do projeto", project_id=project.json()["id"])
    assert from_project["tags"] == [PROJECT]

    # A lista que o analista mandou vale como está, mesmo vazia (sem repetir nem espaços sobrando).
    assert (await create(client, world, title="Sem etiqueta", tags=[]))["tags"] == []
    chosen = await create(
        client,
        world,
        title="Escolhidas",
        tags=[{"name": " Ticket  Contratual ", "color": "pink"}, {"name": "ticket contratual"}],
    )
    assert chosen["tags"] == [{"name": "Ticket Contratual", "color": "pink"}]
    too_many = [{"name": f"Etiqueta {n}"} for n in range(21)]
    body = {"title": "Demais", "customer_id": world.customer_id, "tags": too_many}
    assert (await client.post(f"{API}/tickets", json=body, headers=sup)).status_code == 422

    # Regra mudada vale para as próximas OS.
    rules = {**DEFAULT_RULES, "on_create": [ONE_OFF]}
    assert (await client.put(f"{API}/ticket-tag-rules", json=rules, headers=sup)).status_code == 200
    assert (await create(client, world, title="Depois da regra"))["tags"] == [ONE_OFF]


async def test_extra_cost_adds_its_tag_once(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Com custo", tags=[ONE_OFF])
    url = f"{API}/tickets/{t['id']}"
    expense = {"kind": "material", "description": "Cabo de rede", "quantity": 1, "unit_value": "30"}
    r = await client.post(f"{url}/expenses", json=expense, headers=an)
    assert r.status_code == 201, r.text
    after = (await client.get(url, headers=an)).json()
    assert after["tags"] == [ONE_OFF, EXTRA_COST]
    # Etiqueta é da gestão: a versão da OS não muda (o app do técnico não entra em conflito por
    # ela), só o "atualizado em".
    assert after["version"] == t["version"]
    assert datetime.fromisoformat(after["updated_at"]) > datetime.fromisoformat(t["updated_at"])
    tagged = tag_events((await client.get(f"{url}/events", headers=an)).json())
    assert len(tagged) == 1
    assert tagged[0]["note"] == "Custo extra lançado. Incluída: Custo Extra"
    assert tagged[0]["data"]["added"] == ["Custo Extra"] and tagged[0]["data"]["removed"] == []
    assert tagged[0]["actor"]["id"] == str(world.analyst.user.id)

    # Outro custo: a etiqueta já está lá (não repete nem gera outro evento).
    other = {**expense, "description": "Conector"}
    r = await client.post(f"{url}/expenses", json=other, headers=an)
    assert r.status_code == 201, r.text
    assert (await client.get(url, headers=an)).json()["tags"] == [ONE_OFF, EXTRA_COST]
    assert len(tag_events((await client.get(f"{url}/events", headers=an)).json())) == 1

    # A grafia e a cor que a OS já tem ficam (o nome se compara sem maiúsculas).
    marked = await create(client, world, title="Já marcada", tags=[{"name": "custo extra"}])
    await client.post(f"{API}/tickets/{marked['id']}/expenses", json=expense, headers=an)
    seen = (await client.get(f"{API}/tickets/{marked['id']}", headers=an)).json()
    assert seen["tags"] == [{"name": "custo extra", "color": None}]


async def test_editor_tag_edit_keeps_what_changed_meanwhile(
    client: AsyncClient, world: World
) -> None:
    """O editor estava aberto quando a automação (ou o lote) mudou as etiquetas, sem mudar a
    versão da OS. Com `tags_base` (o que o editor carregou), a edição vale como diferença."""
    an = world.analyst.headers
    night = {"name": "Adicional Noturno", "color": "indigo"}
    t = await create(client, world, title="Editor aberto", tags=[ONE_OFF])
    url = f"{API}/tickets/{t['id']}"
    expense = {"kind": "material", "description": "Cabo de rede", "quantity": 1, "unit_value": "30"}
    assert (await client.post(f"{url}/expenses", json=expense, headers=an)).status_code == 201

    body = {
        "tags": [ONE_OFF, night],
        "tags_base": ["Ticket Avulso"],
        "expected_version": t["version"],
    }
    r = await client.patch(url, json=body, headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["tags"] == [ONE_OFF, night, EXTRA_COST]
    events = (await client.get(f"{url}/events", headers=an)).json()
    changes = [e["data"]["changes"]["tags"] for e in tag_events(events)]
    # O histórico da edição parte das etiquetas de agora (com o "Custo Extra").
    assert [[ONE_OFF, EXTRA_COST], [ONE_OFF, night, EXTRA_COST]] in changes

    # A que o analista tirou sai; a que saiu nesse meio-tempo (técnico pago) não volta; a que
    # entrou pelo lote fica.
    b = await create(client, world, title="Outra aberta")
    lote = {"ids": [b["id"]], "add": [PROJECT], "remove": ["Pendente Envio PGTO"]}
    assert (await client.post(f"{API}/tickets/bulk-tags", json=lote, headers=an)).status_code == 200
    body = {
        "tags": [PENDING_PAYMENT],
        "tags_base": ["Pendente Envio PGTO", "Ticket Avulso"],
        "expected_version": b["version"],
    }
    r = await client.patch(f"{API}/tickets/{b['id']}", json=body, headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["tags"] == [PROJECT]

    # Sem `tags_base`, a lista substitui a da OS (quem chama a API sem o editor).
    body = {"tags": [ONE_OFF], "expected_version": r.json()["version"]}
    r = await client.patch(f"{API}/tickets/{b['id']}", json=body, headers=an)
    assert r.status_code == 200 and r.json()["tags"] == [ONE_OFF]


async def test_paying_every_technician_removes_the_pending_payment_tag(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    t = await create(client, world, title="Dois técnicos", assignee_id=tech, helper_ids=[other])
    solo = await create(client, world, title="Um técnico", assignee_id=other)
    assert t["tags"] == OPENING and solo["tags"] == OPENING

    async def set_fee(ticket: dict, who: str, amount: int) -> str:
        r = await client.put(
            f"{API}/tickets/{ticket['id']}/payouts/{who}", json={"amount": amount}, headers=an
        )
        assert r.status_code == 200, r.text
        return next(p["id"] for p in r.json() if p["technician"]["id"] == who)

    tech_fee = await set_fee(t, tech, 150)
    helper_fee = await set_fee(t, other, 80)
    solo_fee = await set_fee(solo, other, 120)

    async def tags(ticket: dict) -> list[dict]:
        return (await client.get(f"{API}/tickets/{ticket['id']}", headers=an)).json()["tags"]

    # Um técnico pago e o outro não: a OS ainda tem pagamento pendente.
    pay = await client.post(f"{API}/payouts/pay", json={"ids": [tech_fee]}, headers=an)
    assert pay.json() == {"changed": 1}
    assert await tags(t) == OPENING
    # Todos pagos (as duas OS no mesmo fechamento): sai só "Pendente Envio PGTO".
    pay = await client.post(f"{API}/payouts/pay", json={"ids": [helper_fee, solo_fee]}, headers=an)
    assert pay.json() == {"changed": 2}
    assert await tags(t) == [ONE_OFF] and await tags(solo) == [ONE_OFF]
    tagged = tag_events((await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json())
    assert [e["note"] for e in tagged] == ["Todos os técnicos pagos. Retirada: Pendente Envio PGTO"]
    assert tagged[0]["data"]["removed"] == ["Pendente Envio PGTO"]

    # Desfazer o pagamento não traz a etiqueta de volta (nada mais mexe nas etiquetas sozinho).
    undo = await client.post(f"{API}/payouts/unpay", json={"ids": [helper_fee]}, headers=an)
    assert undo.json() == {"changed": 1}
    assert await tags(t) == [ONE_OFF]

    # OS cancelada: o valor ainda pendente não vai ser pago (conta como cancelado, como na lista
    # de pagamentos). Pago o deslocamento de um técnico, a etiqueta sai.
    c = await create(client, world, title="Cancelada", assignee_id=tech, helper_ids=[other])
    trip_fee = await set_fee(c, tech, 60)
    await set_fee(c, other, 60)
    c = (await client.get(f"{API}/tickets/{c['id']}", headers=an)).json()
    c = await transition(client, an, c, "cancelled", note="Cliente desistiu")
    pay = await client.post(f"{API}/payouts/pay", json={"ids": [trip_fee]}, headers=an)
    assert pay.json() == {"changed": 1}
    assert await tags(c) == [ONE_OFF]


# ------------------------------------------------------------------ lista de atividades


async def _customer(client: AsyncClient, world: World, name: str, **location: Any) -> tuple:
    an = world.analyst.headers
    customer = (await client.post(f"{API}/customers", json={"name": name}, headers=an)).json()
    r = await client.post(
        f"{API}/customers/{customer['id']}/locations",
        json={"name": f"Loja {name}", **location},
        headers=an,
    )
    assert r.status_code == 201, r.text
    return customer["id"], r.json()["id"]


async def test_activity_list_filters_and_order(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    alfa, alfa_store = await _customer(client, world, "Alfa Lojas")
    a = await create(client, world, title="Primeira", scheduled_start="2026-03-12T13:00:00+00:00")
    b = await create(
        client,
        world,
        title="Segunda",
        customer_id=alfa,
        location_id=alfa_store,
        scheduled_start="2026-03-11T02:30:00+00:00",  # 10/03 às 23:30 em Brasília
        tags=[PROJECT],
    )
    r = await client.post(
        f"{API}/tickets",
        json={"title": "Terceira, sem cliente", "tags": [EXTRA_COST]},
        headers=world.supervisor.headers,
    )
    assert r.status_code == 201, r.text
    c = r.json()
    # Abertura às 23:30 de 09/03 em Brasília (02:30 do dia 10 em UTC).
    await set_columns(engine, a["id"], created_at=datetime(2026, 3, 10, 2, 30, tzinfo=UTC))
    await set_columns(engine, b["id"], created_at=datetime(2026, 3, 10, 12, 0, tzinfo=UTC))
    await set_columns(engine, c["id"], created_at=datetime(2026, 3, 11, 15, 0, tzinfo=UTC))

    async def numbers(**params: Any) -> list[int]:
        r = await client.get(f"{API}/tickets", params=params, headers=an)
        assert r.status_code == 200, r.text
        page = r.json()
        assert page["total"] == len(page["items"])
        return [item["number"] for item in page["items"]]

    na, nb, nc = a["number"], b["number"], c["number"]
    assert await numbers(number=nb) == [nb]
    assert sorted(await numbers(created_from="2026-03-10")) == [nb, nc]
    assert await numbers(created_to="2026-03-09") == [na]
    assert await numbers(created_from="2026-03-10", created_to="2026-03-10") == [nb]
    assert await numbers(scheduled_from="2026-03-10", scheduled_to="2026-03-10") == [nb]
    assert await numbers(scheduled_from="2026-03-12") == [na]
    assert await numbers(tag="projeto") == [nb]
    assert sorted(await numbers(tag=["PROJETO", "  custo   extra "])) == [nb, nc]
    assert await numbers(tag="ticket avulso") == [na]

    assert await numbers(order_by="number") == [na, nb, nc]
    assert await numbers(order_by="-number") == [nc, nb, na]
    # Sem agenda e sem cliente vão para o fim, nas duas direções.
    assert await numbers(order_by="scheduled_start") == [nb, na, nc]
    assert await numbers(order_by="-scheduled_start") == [na, nb, nc]
    assert await numbers(order_by="customer") == [nb, na, nc]
    assert await numbers(order_by="-customer") == [na, nb, nc]

    assert (await numbers(page_size=500)) != []
    for bad in ({"page_size": 501}, {"number": 0}, {"created_from": "1999-12-31"}):
        r = await client.get(f"{API}/tickets", params=bad, headers=an)
        assert r.status_code == 422, bad


async def test_activity_list_export(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    an = world.analyst.headers
    market, store = await _customer(client, world, "+Mercado Central", city="Cuiabá", state="MT")
    kind = await client.post(
        f"{API}/service-types",
        json={"name": "Manutenção corretiva", "estimated_minutes": 60},
        headers=an,
    )
    assert kind.status_code == 201, kind.text
    first = await create(
        client,
        world,
        title="Troca de switch",
        description="-1 porta queimada",
        customer_id=market,
        location_id=store,
        assignee_id=str(world.tech.user.id),
        scheduled_start="2026-12-01T13:00:00+00:00",
        tags=[{"name": "@Urgente"}, ONE_OFF],
    )
    second = await create(
        client,
        world,
        title="=SOMA(A1:A2)",
        description="",
        service_type_id=kind.json()["id"],
    )
    await set_columns(engine, first["id"], created_at=datetime(2026, 3, 10, 2, 30, tzinfo=UTC))

    async def export(**params: Any) -> list[list[str]]:
        r = await client.get(f"{API}/tickets/export", params=params, headers=an)
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "text/csv; charset=utf-8"
        today = datetime.now(UTC).astimezone(TZ).date().isoformat()
        assert r.headers["content-disposition"] == f'attachment; filename="chamados-{today}.csv"'
        assert r.content.startswith(b"\xef\xbb\xbf")  # BOM: o Excel abre com os acentos certos
        return list(csv.reader(io.StringIO(r.content.decode("utf-8-sig")), delimiter=";"))

    rows = await export(order_by="number")
    assert rows[0] == [
        "Identificador",
        "Etiquetas",
        "Data do agendamento",
        "Cliente",
        "Localização",
        "Cidade",
        "Situação",
        "Técnico",
        "Tipo de OS",
        "Escopo",
        "Analista",
        "Criada em",
    ]
    # Célula que começa com =, +, - ou @ ganha um apóstrofo (a planilha não roda como fórmula).
    assert rows[1:] == [
        [
            str(first["number"]),
            "'@Urgente, Ticket Avulso",
            "01/12/2026 10:00",
            "'+Mercado Central",
            "Loja +Mercado Central",
            "Cuiabá/MT",
            "Atribuído",
            "Tecnico",
            "",
            "'-1 porta queimada",
            "Super",
            "09/03/2026 23:30",
        ],
        [
            str(second["number"]),
            "Pendente Envio PGTO, Ticket Avulso",
            "",
            "Cliente Teste",
            "Matriz",
            "",
            "Novo",
            "",
            "Manutenção corretiva",
            "'=SOMA(A1:A2)",
            "Super",
            f"{at(second['created_at']):%d/%m/%Y %H:%M}",
        ],
    ]
    # Os mesmos filtros e a mesma ordem da lista; `ids` exporta só as escolhidas.
    assert [row[0] for row in (await export(order_by="-number"))[1:]] == [
        str(second["number"]),
        str(first["number"]),
    ]
    assert [row[0] for row in (await export(tag="@urgente"))[1:]] == [str(first["number"])]
    assert [row[0] for row in (await export(ids=[second["id"]]))[1:]] == [str(second["number"])]
    assert (await export(ids=[str(uuid.uuid4())]))[1:] == []
    # Os ids vão na URL: seleção grande exporta pelos filtros.
    many = [("ids", str(uuid.uuid4())) for _ in range(301)]
    assert (await client.get(f"{API}/tickets/export", params=many, headers=an)).status_code == 422
    r = await client.get(f"{API}/tickets/export", headers=world.tech.headers)
    assert r.status_code == 403


async def test_activity_list_brings_service_type_and_scope(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    kind = await client.post(
        f"{API}/service-types", json={"name": "Instalação", "estimated_minutes": 90}, headers=an
    )
    assert kind.status_code == 201, kind.text
    scope = "Trocar o rack. " * 40  # 600 caracteres
    ticket = await create(
        client, world, title="Rack", description=scope, service_type_id=kind.json()["id"]
    )
    r = await client.get(f"{API}/tickets", params={"number": ticket["number"]}, headers=an)
    assert r.status_code == 200, r.text
    [item] = r.json()["items"]
    # Colunas opcionais "Tipo de OS" e "Escopo": na lista, só o começo do escopo.
    assert item["service_type"]["name"] == "Instalação"
    assert len(item["description"]) <= 300
    assert item["description"].endswith("…")
    assert scope.startswith(item["description"][:-1])
    # A OS completa traz o escopo inteiro.
    detail = await client.get(f"{API}/tickets/{ticket['id']}", headers=an)
    assert detail.json()["description"].strip() == scope.strip()


async def test_bulk_tags(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    a = await create(client, world, title="Lote A")
    b = await create(client, world, title="Lote B", tags=[PROJECT])
    url = f"{API}/tickets/bulk-tags"
    body = {
        "ids": [a["id"], b["id"], str(uuid.uuid4())],
        "add": [PROJECT],
        "remove": ["TICKET AVULSO"],
    }
    r = await client.post(url, json=body, headers=an)
    assert r.status_code == 200, r.text
    # B já estava assim; o id que não existe fica de fora.
    assert r.json() == {"updated": 1}
    seen = (await client.get(f"{API}/tickets/{a['id']}", headers=an)).json()
    assert seen["tags"] == [PENDING_PAYMENT, PROJECT]
    assert seen["version"] == a["version"]
    tagged = tag_events((await client.get(f"{API}/tickets/{a['id']}/events", headers=an)).json())
    assert [e["note"] for e in tagged] == [
        "Etiquetas alteradas em lote. Incluída: Projeto · Retirada: Ticket Avulso"
    ]
    untouched = (await client.get(f"{API}/tickets/{b['id']}/events", headers=an)).json()
    assert tag_events(untouched) == []
    assert (await client.post(url, json=body, headers=an)).json() == {"updated": 0}

    for headers in (world.tech.headers, world.requester.headers):
        assert (await client.post(url, json=body, headers=headers)).status_code == 403
    invalid = [
        {"ids": [], "add": [PROJECT]},
        {"ids": [a["id"]]},
        {"ids": [a["id"]], "add": [{"name": "  "}]},
        {"ids": [a["id"]], "add": [PROJECT], "remove": [" projeto "]},
        {"ids": [str(uuid.uuid4()) for _ in range(501)], "add": [PROJECT]},
    ]
    for bad in invalid:
        assert (await client.post(url, json=bad, headers=an)).status_code == 422, bad
