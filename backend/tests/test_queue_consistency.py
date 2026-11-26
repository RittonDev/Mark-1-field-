"""Os mesmos números em todas as telas (Parte 3, QA).

- Cartões da Minha fila e a linha do analista em "Filas da equipe": uma contagem só, pelo
  responsável e sem o limite da lista; as OS que ele só executa vêm à parte (executing_only).
- Em campo agora: a caminho ou em atendimento há até 12 h (services/field.py). A parada há mais
  tempo vai para "precisa de atenção" e sai de "em campo" na fila, no painel, na Início e no
  Dashboard.
- "Atrasada" só 30 min depois do horário e nunca com improdutiva depois dele; "concluída hoje" é a
  resolvida hoje (o fechamento automático não conta de novo).
- Prazo de solução encerrado pelo Field Control (resolution_sla_met_at) nas cláusulas em SQL, no
  SLA % do Dashboard (só com prazo), nos relatórios e na Início; reabrir limpa o veredito.
- Atividades do dia com o mesmo "Atrasada" da fila; "Chegada atrasada" sem a OS que espera data
  nova depois da improdutiva; as partes do cartão Hoje fecham com as planejadas.

"Agora" fixo nos testes da fila: 17/11/2026 15:00 em São Paulo. Só nomes inventados.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes import dashboard
from app.core.enums import OperationalStatus, TicketEventType, UserRole
from app.models import Ticket, TicketEvent
from app.services import activities, home, queues, reports
from tests.conftest import World, requires_db
from tests.test_home_search import (  # noqa: F401 (fixture db)
    API,
    NOW,
    TODAY,
    S,
    add_ticket,
    add_user,
    at,
    db,
    groups,
)
from tests.test_queue_visibility import access_a

pytestmark = requires_db

COUNTED = ("open", "attention", "today", "in_field")


@pytest.fixture
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """ "Agora" fixo para a fila, o painel, a Início e o Dashboard."""
    for module in (queues, home):
        monkeypatch.setattr(module, "utcnow", lambda: NOW)
        monkeypatch.setattr(module, "local_today", lambda: TODAY)
    monkeypatch.setattr(dashboard, "utcnow", lambda: NOW)


def _ago(**delta: float) -> datetime:
    return NOW - timedelta(**delta)


async def _my_queue(client: AsyncClient, world: World) -> dict:
    r = await client.get(f"{API}/my-queue", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    return r.json()


async def _panel_row(client: AsyncClient, world: World, user_id: uuid.UUID) -> dict:
    r = await client.get(f"{API}/queues", headers=world.supervisor.headers)
    assert r.status_code == 200, r.text
    return next(q for q in r.json()["queues"] if q["user"]["id"] == str(user_id))


@pytest.mark.usefixtures("frozen_clock")
async def test_card_and_panel_count_the_same(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    field = {"status": S.IN_PROGRESS}
    mine = await add_ticket(
        db, world, title="Em atendimento agora", work_started_at=_ago(hours=2), **field
    )
    stuck = await add_ticket(
        db, world, title="Esqueceram de concluir", work_started_at=_ago(hours=13), **field
    )
    later = await add_ticket(db, world, title="Visita às 17h", scheduled_start=at(TODAY, 17))
    late = await add_ticket(db, world, title="Atrasada", scheduled_start=_ago(minutes=45))
    tolerated = await add_ticket(db, world, title="Na tolerância", scheduled_start=_ago(minutes=15))
    # Improdutiva às 10h da visita das 9h (OS migrada que manteve a agenda): não está "atrasada".
    bounced = await add_ticket(
        db,
        world,
        title="Improdutiva no horário",
        status=S.ASSIGNED,
        scheduled_start=at(TODAY, 9),
        last_unproductive_at=at(TODAY, 10),
        unproductive_count=1,
    )
    no_access = await add_user(db, "Tecnico Sem Acesso", UserRole.TECHNICIAN, active=False)
    locked = await add_ticket(db, world, title="Técnico sem acesso", assignee_id=no_access.id)
    # O analista só executa: fica na lista dele, fora dos números (que são por responsável).
    executing = await add_ticket(
        db,
        world,
        title="Da fila do supervisor",
        owner_id=world.supervisor.user.id,
        assignee_id=world.analyst.user.id,
    )
    done = await add_ticket(
        db, world, title="Resolvida hoje", status=S.RESOLVED, resolved_at=_ago(hours=1)
    )
    # Resolvida na sexta e fechada hoje pelo fechamento automático: não é "concluída hoje".
    await add_ticket(
        db,
        world,
        title="Fechada hoje",
        status=S.CLOSED,
        resolved_at=_ago(days=4),
        closed_at=_ago(hours=1),
    )
    # Prazo de solução encerrado pelo Field Control: no prazo não é violada; fora, segue violada.
    fc_ok = await add_ticket(
        db,
        world,
        title="Cumprida no prazo no FC",
        resolution_due_at=_ago(days=10),
        resolution_sla_met_at=_ago(days=11),
    )
    fc_late = await add_ticket(
        db,
        world,
        title="Cumprida fora do prazo no FC",
        resolution_due_at=_ago(days=10),
        resolution_sla_met_at=_ago(days=9),
    )
    await db.commit()

    queue = await _my_queue(client, world)
    assert queue["counts"] == {
        "open": 9,
        "attention": 5,  # parada em campo, atrasada, improdutiva, sem acesso e o FC fora do prazo
        "in_field": 1,  # a parada há 13 h não conta
        "today": 4,  # as 4 agendadas para hoje, inclusive as que pedem atenção
        "waiting": 0,
        "upcoming": 1,
        "unscheduled": 0,
        "done": 1,
    }
    assert (queue["total"], queue["truncated"], queue["executing_only"]) == (11, False, 1)
    items = {i["id"]: i for i in queue["items"]}
    assert len(items) == 11 and str(executing.id) in items
    section = {i["title"]: i["section"] for i in queue["items"]}
    assert section[mine.title] == "in_field" and section[stuck.title] == "attention"
    assert section[later.title] == section[tolerated.title] == "today"
    assert section[done.title] == "done" and "Fechada hoje" not in section
    assert section[fc_ok.title] == "upcoming"

    def codes(ticket: Ticket) -> list[str]:
        return [r["code"] for r in items[str(ticket.id)]["reasons"]]

    first = items[str(stuck.id)]["reasons"][0]
    assert first == {
        "code": "field_stuck",
        "label": "Em campo há 13 h: conclua ou corrija",
        "tone": "danger",
    }
    assert codes(late) == ["late_start"] and codes(tolerated) == []
    assert codes(bounced) == ["unproductive"]
    reason = items[str(locked.id)]["reasons"][0]
    assert (reason["code"], reason["label"], reason["tone"]) == (
        "inactive_technician",
        "Técnico sem acesso: libere ou troque",
        "warning",
    )
    assert "sla_violated" not in codes(fc_ok) and "sla_violated" in codes(fc_late)

    # A linha do analista no painel é o mesmo número dos cartões.
    row = await _panel_row(client, world, world.analyst.user.id)
    assert {key: row[key] for key in COUNTED} == {key: queue["counts"][key] for key in COUNTED}

    # A lista corta em 500; os números, não.
    monkeypatch.setattr(queues, "LIMIT", 2)
    short = await _my_queue(client, world)
    assert short["counts"] == queue["counts"] and short["truncated"] is True
    assert (short["total"], len(short["items"])) == (11, 2)

    # Em campo agora é a mesma regra na Início e no Dashboard.
    overview = (await client.get(f"{API}/home/overview", headers=world.supervisor.headers)).json()
    assert overview["kpis"]["in_field_now"] == 1
    assert groups(overview)["field_stuck"]["count"] == 1
    summary = (
        await client.get(f"{API}/dashboard/summary", headers=world.supervisor.headers)
    ).json()
    load = next(a for a in summary["by_assignee"] if a["user_id"] == str(world.tech.user.id))
    # As 8 abertas do técnico; em campo, só a de agora.
    assert (load["open"], load["in_progress"]) == (8, 1)


@pytest.mark.usefixtures("frozen_clock")
async def test_technician_out_of_active_asks_to_swap(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    """Técnico responsável Inativo ou Bloqueado na operação: "Técnico inativo: troque" (aviso) ou
    "Técnico bloqueado: troque" (problema), sem o "sem acesso" junto (com o acesso cortado,
    liberar não resolve). A OS pede atenção na fila e no painel; o sem acesso que está Ativo segue
    com o motivo de antes."""
    inactive = await add_user(db, "Tecnico Inativo", UserRole.TECHNICIAN)
    blocked = await add_user(db, "Tecnico Bloqueado", UserRole.TECHNICIAN, active=False)
    no_access = await add_user(db, "Tecnico Sem Acesso", UserRole.TECHNICIAN, active=False)
    inactive.operational_status = OperationalStatus.INACTIVE
    inactive.operational_reason = "Férias coletivas"
    blocked.operational_status = OperationalStatus.BLOCKED
    blocked.operational_reason = "Documentação vencida"
    await add_ticket(db, world, title="Com técnico inativo", assignee_id=inactive.id)
    await add_ticket(db, world, title="Com técnico bloqueado", assignee_id=blocked.id)
    await add_ticket(db, world, title="Com técnico sem acesso", assignee_id=no_access.id)
    await add_ticket(db, world, title="Tudo certo")
    await db.commit()

    queue = await _my_queue(client, world)
    items = {i["title"]: i for i in queue["items"]}
    assert items["Com técnico inativo"]["reasons"] == [
        {"code": "technician_inactive", "label": "Técnico inativo: troque", "tone": "warning"}
    ]
    assert items["Com técnico bloqueado"]["reasons"] == [
        {"code": "technician_blocked", "label": "Técnico bloqueado: troque", "tone": "danger"}
    ]
    assert [r["code"] for r in items["Com técnico sem acesso"]["reasons"]] == [
        "inactive_technician"
    ]
    assert items["Tudo certo"]["reasons"] == []
    assert {title: i["section"] for title, i in items.items()} == {
        "Com técnico inativo": "attention",
        "Com técnico bloqueado": "attention",
        "Com técnico sem acesso": "attention",
        "Tudo certo": "upcoming",
    }
    # Problema antes de aviso, como nos outros motivos.
    titles = [i["title"] for i in queue["items"]]
    assert titles.index("Com técnico bloqueado") < titles.index("Com técnico inativo")
    assert queue["counts"]["attention"] == 3
    row = await _panel_row(client, world, world.analyst.user.id)
    assert row["attention"] == 3


async def test_executing_only_and_scope_of_another_owner(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    """Fila de um colega vista pela gestão: os números são os dele, sem as que ele só executa."""
    now = datetime.now(UTC)
    await add_ticket(db, world, title="Do analista", scheduled_start=now + timedelta(days=3))
    await add_ticket(
        db,
        world,
        title="Do analista sem responsável",
        owner_id=None,
        assignee_id=world.analyst.user.id,
        scheduled_start=now + timedelta(days=3),
    )
    await db.commit()
    r = await client.get(
        f"{API}/my-queue",
        params={"user_id": str(world.analyst.user.id)},
        headers=world.supervisor.headers,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert (data["counts"]["open"], data["executing_only"], len(data["items"])) == (1, 1, 2)
    row = await _panel_row(client, world, world.analyst.user.id)
    assert row["open"] == data["counts"]["open"]


async def test_own_scope_card_matches_the_own_row(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    """Com "Somente a própria fila" (e as sem analista), os cartões e a única linha do painel
    batem; a OS de outra fila que a pessoa executa conta só em executing_only."""
    await access_a(client, world, unowned=True)
    now = datetime.now(UTC)
    later = now + timedelta(days=3)
    await add_ticket(db, world, title="Da fila do analista", scheduled_start=later)
    await add_ticket(
        db,
        world,
        title="Da fila do supervisor, executada pelo analista",
        owner_id=world.supervisor.user.id,
        assignee_id=world.analyst.user.id,
        scheduled_start=later,
    )
    await add_ticket(db, world, title="Sem analista", owner_id=None, scheduled_start=later)
    await db.commit()

    queue = await _my_queue(client, world)
    panel = (await client.get(f"{API}/queues", headers=world.analyst.headers)).json()
    assert panel["scope"] == "own" and len(panel["queues"]) == 1
    row = panel["queues"][0]
    assert {key: row[key] for key in COUNTED} == {key: queue["counts"][key] for key in COUNTED}
    assert (queue["counts"]["open"], queue["executing_only"]) == (1, 1)
    assert panel["unowned"]["open"] == 1 and panel["total"]["open"] == 2


async def test_sla_percentages_use_the_end_and_the_base(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    now = datetime.now(UTC)

    def ago(**delta: float) -> datetime:
        return now - timedelta(**delta)

    # Abertas há 15 dias (no relógio de verdade: a lista e os relatórios usam o agora real).
    base = {"created_at": ago(days=15), "updated_at": ago(days=1)}
    resolved = {"status": S.RESOLVED, "owner_id": world.supervisor.user.id, **base}
    await add_ticket(
        db,
        world,
        title="No prazo",
        resolved_at=ago(days=2),
        resolution_due_at=ago(days=1),
        **resolved,
    )
    await add_ticket(db, world, title="Sem prazo", resolved_at=ago(days=2), **resolved)
    # Concluída aqui depois do prazo, mas o Field Control já tinha dado o prazo como cumprido.
    await add_ticket(
        db,
        world,
        title="Cumprida no FC",
        status=S.CLOSED,
        owner_id=world.supervisor.user.id,
        resolved_at=ago(days=3),
        resolution_due_at=ago(days=5),
        resolution_sla_met_at=ago(days=6),
        **base,
    )
    late = await add_ticket(
        db,
        world,
        title="Fora do prazo",
        resolved_at=ago(days=1),
        resolution_due_at=ago(days=2),
        **resolved,
    )
    open_ok = await add_ticket(
        db,
        world,
        title="Aberta cumprida no FC",
        resolution_due_at=ago(days=10),
        resolution_sla_met_at=ago(days=11),
        **base,
    )
    open_late = await add_ticket(
        db,
        world,
        title="Aberta fora do prazo no FC",
        resolution_due_at=ago(days=10),
        resolution_sla_met_at=ago(days=9),
        **base,
    )
    running = await add_ticket(
        db, world, title="Vencida correndo", resolution_due_at=ago(days=10), **base
    )
    await db.commit()
    sup = world.supervisor.headers

    # Dashboard: a base é só das resolvidas com prazo (3), e a do FC conta no prazo (2 de 3).
    summary = (await client.get(f"{API}/dashboard/summary", headers=sup)).json()
    assert summary["sla_compliance_30d"] == round(100 * 2 / 3, 1)
    # Das abertas, a cumprida no prazo no FC não está violada.
    assert summary["sla_breached"] == 2

    # Relatórios e Início: o mesmo fim do relógio.
    numbers = await reports.numbers(db, ago(days=7), now + timedelta(hours=1))
    assert numbers.resolved_in_sla == 2
    overview = (await client.get(f"{API}/home/overview", headers=sup)).json()
    assert overview["pulse"]["quality"]["resolution_sla"] == {"count": 2, "base": 3}
    assert overview["kpis"]["late"] == 2

    async def ids(**params: str) -> set[str]:
        r = await client.get(f"{API}/tickets", params=params, headers=sup)
        assert r.status_code == 200, r.text
        return {i["id"] for i in r.json()["items"]}

    assert await ids(sla_breached="true") == {str(open_late.id), str(running.id)}
    assert str(open_ok.id) not in await ids(sla_breached="true")
    assert await ids(violation_pending="true") == {str(late.id)}

    # A violação do Dashboard (por relógio) também usa o fim.
    report = (await client.get(f"{API}/reports/sla-violations", headers=sup)).json()
    assert report["resolution"]["breached"] == 3  # fora do prazo, a aberta do FC e a correndo
    assert report["pending_justification"] == 1


async def test_reopening_clears_the_fc_verdict(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    now = datetime.now(UTC)
    t = await add_ticket(
        db,
        world,
        title="Concluída com o veredito do FC",
        created_at=now - timedelta(days=10),
        status=S.CLOSED,
        resolved_at=now - timedelta(days=3),
        closed_at=now - timedelta(days=2),
        resolution_due_at=now - timedelta(days=5),
        resolution_sla_met_at=now - timedelta(days=6),
    )
    await db.commit()
    sup = world.supervisor.headers
    before = (await client.get(f"{API}/tickets/{t.id}", headers=sup)).json()
    assert before["sla_status"] == "met" and before["resolution_sla_met_at"]
    r = await client.post(
        f"{API}/tickets/{t.id}/transition",
        json={"to_status": "reopened", "expected_version": before["version"], "note": "Voltou"},
        headers=sup,
    )
    assert r.status_code == 200, r.text
    after = r.json()
    # Reaberta: vale o prazo original (já vencido), como em qualquer OS reaberta.
    assert after["resolution_sla_met_at"] is None and after["sla_status"] == "breached"


@pytest.mark.usefixtures("frozen_clock")
async def test_home_late_and_missed_skip_the_unproductive_visit(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    # Hoje: a das 9h deu improdutiva às 10h (fica nas improdutivas); a das 14h ainda não começou.
    await add_ticket(
        db,
        world,
        title="Improdutiva hoje",
        status=S.ASSIGNED,
        scheduled_start=at(TODAY, 9),
        last_unproductive_at=at(TODAY, 10),
    )
    not_started = await add_ticket(db, world, title="Sem início", scheduled_start=at(TODAY, 14))
    # Últimos 7 dias: uma passou sem baixa; a outra teve improdutiva depois do horário.
    missed = await add_ticket(
        db, world, title="Passou sem baixa", scheduled_start=at(TODAY - timedelta(days=2), 10)
    )
    bounced = await add_ticket(
        db,
        world,
        title="Improdutiva há 3 dias",
        status=S.ASSIGNED,
        scheduled_start=at(TODAY - timedelta(days=3), 9),
        last_unproductive_at=at(TODAY - timedelta(days=3), 11),
    )
    await db.commit()

    data = (await client.get(f"{API}/home/overview", headers=world.supervisor.headers)).json()
    g = groups(data)
    assert [i["ticket_id"] for i in g["today_not_started"]["items"]] == [str(not_started.id)]
    assert g["today_not_started"]["count"] == 1
    assert [i["ticket_id"] for i in g["missed_visits"]["items"]] == [str(missed.id)]
    assert g["missed_visits"]["count"] == 1
    # A lista do "Ver todas" não tira a improdutiva (mostraria 2): o grupo vai sem filtro.
    assert g["missed_visits"]["filters"] is None
    assert g["unproductive_pending"]["count"] == 2

    # Sem improdutiva no recorte, o "Ver todas" volta.
    await db.execute(update(Ticket).where(Ticket.id == bounced.id).values(status=S.CANCELLED))
    await db.commit()
    data = (await client.get(f"{API}/home/overview", headers=world.supervisor.headers)).json()
    assert groups(data)["missed_visits"]["filters"] == {
        "status": ["new", "triage", "assigned", "scheduled", "reopened"],
        "scheduled_from": "2026-11-10",
        "scheduled_to": "2026-11-16",
    }


async def _bounce(session: AsyncSession, ticket: Ticket, when: datetime) -> None:
    """Visita improdutiva registrada em `when` (o evento e os campos da OS, como no fluxo)."""
    session.add(
        TicketEvent(
            ticket_id=ticket.id,
            event_type=TicketEventType.UNPRODUCTIVE_VISIT,
            from_value=S.ASSIGNED.value,
            to_value="Loja fechada",
            data={"reason": "Loja fechada"},
            created_at=when,
        )
    )
    ticket.last_unproductive_at = when
    ticket.unproductive_count = (ticket.unproductive_count or 0) + 1
    await session.flush()


@pytest.mark.usefixtures("frozen_clock")
async def test_day_activities_wait_the_tolerance_like_the_queue(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Atividades do dia: "Atrasada" só 30 min depois do horário, como a Minha fila e a Início; a
    visita que deu improdutiva no horário ou depois voltou para a fila (não é atrasada)."""
    monkeypatch.setattr(activities, "utcnow", lambda: NOW)
    monkeypatch.setattr(activities, "local_today", lambda: TODAY)
    tolerated = await add_ticket(db, world, title="Há 15 min", scheduled_start=_ago(minutes=15))
    late = await add_ticket(db, world, title="Há 45 min", scheduled_start=_ago(minutes=45))
    # OS migrada que manteve a agenda: improdutiva às 10h da visita das 9h.
    bounced = await add_ticket(
        db, world, title="Improdutiva das 9h", status=S.ASSIGNED, scheduled_start=at(TODAY, 9)
    )
    await _bounce(db, bounced, at(TODAY, 10))
    # Improdutiva ainda dentro da tolerância: também voltou para a fila, não é "agendada".
    recent = await add_ticket(
        db, world, title="Improdutiva agora", status=S.ASSIGNED, scheduled_start=_ago(minutes=20)
    )
    await _bounce(db, recent, _ago(minutes=10))
    await db.commit()

    r = await client.get(f"{API}/activities/day", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    day = r.json()
    state = {a["ticket"]["title"]: a["state"] for a in day["activities"]}
    assert state == {
        tolerated.title: "scheduled",
        late.title: "late",
        bounced.title: "pending",  # a tela mostra "Improdutiva", com o motivo
        recent.title: "pending",
    }
    summary = day["summary"]
    assert (summary["late"], summary["scheduled"], summary["pending"]) == (1, 1, 2)
    assert summary["unproductive"] == 2

    # A Minha fila e a Início dizem o mesmo das mesmas OS.
    queue = await _my_queue(client, world)
    codes = {i["title"]: [r["code"] for r in i["reasons"]] for i in queue["items"]}
    assert codes[late.title] == ["late_start"] and codes[tolerated.title] == []
    assert codes[bounced.title] == codes[recent.title] == ["unproductive"]
    overview = (await client.get(f"{API}/home/overview", headers=world.supervisor.headers)).json()
    not_started = groups(overview)["today_not_started"]
    assert [i["ticket_id"] for i in not_started["items"]] == [str(late.id)]


@pytest.mark.usefixtures("frozen_clock")
async def test_late_arrival_skips_the_visit_waiting_for_a_new_date(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    """Chegada atrasada (Início e Minha fila) não pega a OS que espera data nova depois da
    improdutiva: o técnico foi, e o prazo que o fluxo recalcula fica no passado. Com a visita nova
    marcada, o atraso dela conta, e a OS sem improdutiva segue como sempre."""
    waiting = await add_ticket(
        db,
        world,
        title="Esperando data nova",
        status=S.ASSIGNED,
        scheduled_start=None,
        arrival_due_at=_ago(hours=3),
    )
    await _bounce(db, waiting, _ago(hours=1))
    # Prazo recalculado para daqui a 30 min: nem "em risco".
    soon = await add_ticket(
        db,
        world,
        title="Improdutiva e prazo perto",
        status=S.ASSIGNED,
        scheduled_start=None,
        arrival_due_at=NOW + timedelta(minutes=30),
    )
    await _bounce(db, soon, _ago(minutes=30))
    # OS migrada que manteve a agenda da visita improdutiva.
    kept = await add_ticket(
        db,
        world,
        title="Agenda antiga mantida",
        status=S.ASSIGNED,
        scheduled_start=at(TODAY, 9),
        arrival_due_at=at(TODAY, 9, 30),
    )
    await _bounce(db, kept, at(TODAY, 10))
    # Visita nova marcada depois da improdutiva e já atrasada: atraso real.
    revisit = await add_ticket(
        db,
        world,
        title="Visita nova atrasada",
        scheduled_start=at(TODAY, 13),
        arrival_due_at=at(TODAY, 13, 30),
    )
    await _bounce(db, revisit, _ago(days=1))
    # Voltou para a loja sem data nova: em campo, sem prazo a cobrar e sem "reagendar".
    back = await add_ticket(
        db,
        world,
        title="Voltou sem data",
        status=S.EN_ROUTE,
        scheduled_start=None,
        arrival_due_at=_ago(hours=5),
    )
    await _bounce(db, back, _ago(hours=2))
    plain = await add_ticket(
        db, world, title="A caminho atrasada", status=S.EN_ROUTE, arrival_due_at=_ago(minutes=40)
    )
    await db.commit()

    overview = (await client.get(f"{API}/home/overview", headers=world.supervisor.headers)).json()
    g = groups(overview)
    assert g["late_arrival"]["count"] == 2
    assert {i["ticket_id"] for i in g["late_arrival"]["items"]} == {str(revisit.id), str(plain.id)}
    assert g["unproductive_pending"]["count"] == 3
    pending = {i["ticket_id"] for i in g["unproductive_pending"]["items"]}
    assert pending == {str(waiting.id), str(soon.id), str(kept.id)}

    queue = await _my_queue(client, world)
    codes = {i["title"]: [r["code"] for r in i["reasons"]] for i in queue["items"]}
    assert codes[waiting.title] == codes[soon.title] == codes[kept.title] == ["unproductive"]
    assert "arrival_late" in codes[revisit.title] and "unproductive" not in codes[revisit.title]
    assert codes[back.title] == [] and codes[plain.title] == ["arrival_late"]
    section = {i["title"]: i["section"] for i in queue["items"]}
    assert section[back.title] == "in_field"
    # A situação da chegada na própria OS segue a regra (as telas pintam o prazo por ela).
    arrival = {i["title"]: i["arrival_status"] for i in queue["items"]}
    assert [arrival[t.title] for t in (waiting, soon, kept, back)] == [None] * 4
    assert arrival[revisit.title] == arrival[plain.title] == "late"
    listed = await client.get(
        f"{API}/tickets", params={"q": "Esperando data nova"}, headers=world.supervisor.headers
    )
    assert [i["arrival_status"] for i in listed.json()["items"]] == [None]


@pytest.mark.usefixtures("frozen_clock")
async def test_today_card_parts_add_up(
    client: AsyncClient,
    world: World,
    db: AsyncSession,  # noqa: F811
) -> None:
    """Cartão Hoje: planejadas = concluídas + em campo + sem início + aguardando + a seguir. A
    visita que ainda não começou e teve improdutiva no horário ou depois sai das planejadas (como
    no fluxo nativo, em que a improdutiva tira a agenda); o técnico dela não tem visita hoje."""
    other = world.tech_other.user.id
    await add_ticket(
        db,
        world,
        title="Feita",
        status=S.RESOLVED,
        scheduled_start=at(TODAY, 8),
        resolved_at=at(TODAY, 10),
    )
    await add_ticket(
        db,
        world,
        title="Na loja",
        status=S.IN_PROGRESS,
        scheduled_start=at(TODAY, 11),
        work_started_at=_ago(hours=1),
    )
    await add_ticket(db, world, title="Sem início", scheduled_start=at(TODAY, 9))
    await add_ticket(
        db, world, title="Aguardando", status=S.ON_HOLD_CUSTOMER, scheduled_start=at(TODAY, 10)
    )
    await add_ticket(db, world, title="Mais tarde", scheduled_start=at(TODAY, 16))
    await add_ticket(db, world, title="Na tolerância", scheduled_start=at(TODAY, 14, 45))
    await add_ticket(
        db, world, title="Cancelada", status=S.CANCELLED, scheduled_start=at(TODAY, 12)
    )
    bounced = await add_ticket(
        db,
        world,
        title="Improdutiva das 9h",
        status=S.ASSIGNED,
        scheduled_start=at(TODAY, 9),
        assignee_id=other,
    )
    await _bounce(db, bounced, at(TODAY, 10))
    recent = await add_ticket(
        db,
        world,
        title="Improdutiva há 10 min",
        status=S.ASSIGNED,
        scheduled_start=at(TODAY, 14, 40),
        assignee_id=other,
    )
    await _bounce(db, recent, at(TODAY, 14, 50))
    # Voltou para a loja no mesmo dia, sem data nova: é visita de hoje, em campo.
    back = await add_ticket(
        db, world, title="Voltou à loja", status=S.EN_ROUTE, scheduled_start=at(TODAY, 8)
    )
    await _bounce(db, back, at(TODAY, 9))
    await db.commit()

    data = (await client.get(f"{API}/home/overview", headers=world.supervisor.headers)).json()
    today = data["pulse"]["today"]
    parts = ("done", "in_field", "not_started", "on_hold", "upcoming")
    assert {key: today[key] for key in ("planned", *parts)} == {
        "planned": 7,
        "done": 1,
        "in_field": 2,  # na loja e a que voltou
        "not_started": 1,
        "on_hold": 1,
        "upcoming": 2,  # 16h e a que está na tolerância
    }
    assert today["planned"] == sum(today[key] for key in parts)
    assert data["kpis"]["scheduled_today"] == today["planned"]
    assert today["technicians"] == 1  # o das improdutivas não tem visita hoje
