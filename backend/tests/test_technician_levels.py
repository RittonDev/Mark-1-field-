"""Elo dos técnicos (Bronze, Prata, Ouro e Diamante): as faixas, a carência, as contas no banco, as
desconsiderações da central e o que cada papel vê. A fila de quem pede, na central, fica em
test_level_queue_visibility.py.

Dados fictícios: Tecnico Alfa, Tecnico Bravo e Tecnico Charlie (e-mails @exemplo.com), com as OS
na loja do cliente de teste.
"""

import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app import main as app_main
from app.core.config import settings
from app.core.enums import (
    LevelOccurrenceKind,
    LevelTier,
    Responsibility,
    TicketEventType,
    TicketStatus,
    UserRole,
)
from app.core.security import create_access_token
from app.db.base import utcnow
from app.models import Ticket, TicketEvent, UnproductiveReason, User
from app.models.technician_level import TechnicianLevel
from app.models.ticket import ticket_helpers
from app.schemas.ticket import format_ticket_code
from app.services import technician_levels as levels
from app.services.technician_levels import (
    RULE_BY_TIER,
    RULES,
    TIERS,
    Counts,
    Standing,
    apply_grace,
    computed_tier,
    criteria,
    late_detail,
    rework_detail,
    risk,
    tier_summary,
)
from tests.conftest import World, requires_db
from tests.test_api import create, transition

API = settings.API_PREFIX
B, S, G, D = LevelTier.BRONZE, LevelTier.SILVER, LevelTier.GOLD, LevelTier.DIAMOND
FC = {"source": "fieldcontrol"}


@pytest.fixture
def brasilia(monkeypatch: pytest.MonkeyPatch) -> ZoneInfo:
    """Datas dos textos no fuso da operação."""
    monkeypatch.setattr(settings, "TIMEZONE", "America/Sao_Paulo")
    return ZoneInfo("America/Sao_Paulo")


def _by_key(items: list[Any]) -> dict[str, Any]:
    return {c.key: c for c in items}


# ------------------------------------------------------------------ regras (sem banco)


def test_tiers() -> None:
    assert computed_tier(Counts()) == B
    # Só histórico do Field Control (nenhum atendimento medido): a Prata não pede medidos.
    assert computed_tier(Counts(services=15)) == S
    assert computed_tier(Counts(services=14)) == B
    # O Ouro pede 15 atendimentos medidos.
    assert computed_tier(Counts(services=60, measured=10)) == S
    gold = Counts(services=60, measured=20, arrivals=20, late=1, reworks=1, lost=0)
    assert computed_tier(gold) == G
    # 85% de chegada no horário: abaixo do Ouro (90%), dentro da Prata (80%).
    assert computed_tier(replace(gold, late=3)) == S
    # 4 chegadas, todas atrasadas: com menos de 5 casos a taxa não bloqueia.
    assert computed_tier(replace(gold, arrivals=4, late=4)) == G
    diamond = Counts(services=130, measured=40, arrivals=40, late=2, reworks=1)
    assert computed_tier(diamond) == D
    assert computed_tier(replace(diamond, reworks=2)) == G  # 5% de retorno: acima dos 3%
    # Bordas, em inteiros: 80% exato passa na Prata; 10% de retorno passa, 10,1% não.
    assert computed_tier(Counts(services=20, measured=20, arrivals=20, late=4)) == S
    assert computed_tier(Counts(services=20, measured=20, arrivals=20, late=5)) == B
    assert computed_tier(Counts(services=1000, measured=1000, reworks=100)) == S
    assert computed_tier(Counts(services=1000, measured=1000, reworks=101)) == B
    # Visitas perdidas contra as visitas (medidos + perdidas): 2 em 50 = 4% (Ouro), 3 em 50 não.
    assert computed_tier(Counts(services=60, measured=48, lost=2)) == G
    assert computed_tier(Counts(services=60, measured=47, lost=3)) == S


def test_apply_grace() -> None:
    now = datetime(2026, 11, 18, 15, tzinfo=UTC)
    long_ago = now - timedelta(days=200)
    # Primeiro cálculo: vale a calculada, sem carência.
    assert apply_grace(None, G, now) == Standing(G, now, None)
    # Subir é na hora; ficar igual não mexe na data.
    assert apply_grace(Standing(S, long_ago, None), G, now) == Standing(G, now, None)
    assert apply_grace(Standing(G, long_ago, None), G, now) == Standing(G, long_ago, None)
    # Cair: mantém a faixa e marca o risco.
    at_risk = apply_grace(Standing(D, long_ago, None), S, now)
    assert at_risk == Standing(D, long_ago, now)
    # 29 dias depois ainda mantém; com 30, desce direto para a calculada.
    assert apply_grace(at_risk, S, now + timedelta(days=29)) == at_risk
    later = now + timedelta(days=30)
    assert apply_grace(at_risk, S, later) == Standing(S, later, None)
    # Melhorou, mas ainda abaixo: o risco segue contando da primeira data.
    assert apply_grace(at_risk, G, now + timedelta(days=10)) == at_risk
    # Voltou a cumprir: o risco sai e a faixa continua desde quando era.
    assert apply_grace(at_risk, D, now + timedelta(days=10)) == Standing(D, long_ago, None)


def test_criteria_texts(brasilia: ZoneInfo) -> None:
    gold = RULE_BY_TIER[G]
    c = _by_key(criteria(gold, Counts(services=38, measured=10, arrivals=20, late=3)))
    assert (c["services"].text, c["services"].missing) == ("38 de 50", "Faltam 12 atendimentos")
    assert (c["measured"].text, c["measured"].missing) == (
        "10 de 15",
        "Faltam 5 atendimentos medidos",
    )
    on_time = c["on_time"]
    assert on_time.label == "Chegada no horário combinado"
    assert on_time.text == "85% (17 de 20) · meta 90% ou mais"
    assert on_time.missing == "Faltam 10 chegadas no horário seguidas"
    assert (on_time.met, on_time.enough_data, on_time.value, on_time.base, on_time.target) == (
        False,
        True,
        17,
        20,
        90,
    )
    one = _by_key(criteria(gold, Counts(services=49, measured=14)))
    assert one["services"].missing == "Falta 1 atendimento"
    assert one["measured"].missing == "Falta 1 atendimento medido"
    assert c["services"].label == "Atendimentos nos últimos 12 meses"

    rework = _by_key(criteria(gold, Counts(services=50, measured=40, reworks=3)))["rework"]
    assert rework.label == "Retorno (OS reaberta em até 30 dias)"
    assert rework.text == "8% (3 em 40) · limite 5%"
    assert rework.missing == "Com mais 20 atendimentos sem retorno, volta ao limite"
    lost = _by_key(criteria(gold, Counts(services=50, measured=44, lost=1)))["lost"]
    assert (lost.text, lost.met, lost.missing) == ("3% (1 em 45) · limite 4%", True, None)
    lost = _by_key(criteria(gold, Counts(services=50, measured=47, lost=3)))["lost"]
    assert lost.text == "6% (3 em 50) · limite 4%"
    assert lost.missing == "Com mais 25 atendimentos sem visita perdida, volta ao limite"

    # Menos de 5 casos: ainda sem dados, e o critério conta como cumprido.
    few = _by_key(criteria(gold, Counts(services=50, measured=3, arrivals=3, late=3)))
    assert few["on_time"].text == "Ainda sem dados suficientes (3 de 5 chegadas)"
    assert (few["on_time"].met, few["on_time"].enough_data, few["on_time"].missing) == (
        True,
        False,
        None,
    )
    assert few["rework"].text == "Ainda sem dados suficientes (3 de 5 atendimentos medidos)"
    assert few["lost"].text == "Ainda sem dados suficientes (3 de 5 visitas)"

    # Para baixo na chegada no horário e para cima nos limites: o número mostrado nunca contradiz
    # o "cumprido".
    edge = _by_key(
        criteria(gold, Counts(services=50, measured=10000, arrivals=1000, late=101, reworks=501))
    )
    assert edge["on_time"].text.startswith("89% ") and not edge["on_time"].met
    assert edge["rework"].text.startswith("6% ") and not edge["rework"].met
    ok = _by_key(
        criteria(gold, Counts(services=50, measured=10000, arrivals=1000, late=100, reworks=500))
    )
    assert ok["on_time"].text.startswith("90% ") and ok["on_time"].met
    assert ok["rework"].text.startswith("5% ") and ok["rework"].met

    # O Bronze não pede nada; a Prata não pede atendimentos medidos.
    assert criteria(RULE_BY_TIER[B], Counts()) == []
    assert [x.key for x in criteria(RULE_BY_TIER[S], Counts())] == [
        "services",
        "on_time",
        "rework",
        "lost",
    ]

    # O aviso do risco, com as datas no fuso da operação.
    since = datetime(2026, 12, 1, 15, tzinfo=UTC)
    warning = risk(G, S, since, Counts(services=60, measured=20, arrivals=20, late=3))
    assert warning is not None
    assert warning.text == (
        "Abaixo do critério desde 01/12: chegada no horário combinado. Se não voltar a cumprir "
        "até 31/12, passa para Prata."
    )
    assert (warning.failing, warning.falls_to) == (["Chegada no horário combinado"], S)
    assert warning.until == since + timedelta(days=30)
    several = risk(D, S, since, Counts(services=60, measured=20, arrivals=20, late=3))
    assert several is not None and several.text.startswith(
        "Abaixo do critério desde 01/12: atendimentos nos últimos 12 meses, atendimentos medidos "
        "e chegada no horário combinado."
    )
    assert risk(G, G, None, Counts()) is None

    assert [tier_summary(rule) for rule in TIERS] == [
        "Todo técnico começa aqui.",
        "15 atendimentos · chegada no horário em 80% ou mais · retorno até 10% · visitas "
        "perdidas até 8%",
        "50 atendimentos, 15 medidos · chegada no horário em 90% ou mais · retorno até 5% · "
        "visitas perdidas até 4%",
        "120 atendimentos, 30 medidos · chegada no horário em 95% ou mais · retorno até 3% · "
        "visitas perdidas até 2%",
    ]
    assert (
        "Ao deixar de cumprir um critério, o elo fica por mais 30 dias. Se não voltar a cumprir, "
        "desce."
    ) in RULES
    assert not any("nível" in rule.lower() for rule in RULES)

    # Ocorrências: "52 min", "1h", "2h10"; o atraso nunca aparece como "30 min".
    scheduled = datetime(2026, 11, 12, 13, tzinfo=UTC)  # 10:00 em Brasília
    assert late_detail(scheduled, scheduled + timedelta(minutes=52)) == (
        "Chegou 52 min depois do horário combinado (10:00 de 12/11)"
    )
    assert late_detail(scheduled, scheduled + timedelta(minutes=30, seconds=5)).startswith(
        "Chegou 31 min "
    )
    assert late_detail(scheduled, scheduled + timedelta(hours=1)).startswith("Chegou 1h depois")
    assert late_detail(scheduled, scheduled + timedelta(hours=2, minutes=10)).startswith(
        "Chegou 2h10 depois"
    )
    assert rework_detail(scheduled, scheduled + timedelta(days=6)) == (
        "Reaberta 6 dias depois da conclusão"
    )
    assert rework_detail(scheduled, scheduled + timedelta(days=1)) == (
        "Reaberta 1 dia depois da conclusão"
    )
    assert rework_detail(scheduled, scheduled + timedelta(hours=2)) == (
        "Reaberta no mesmo dia da conclusão"
    )


# ------------------------------------------------------------------ no banco


def _tech(name: str) -> User:
    return User(
        name=f"Tecnico {name}",
        email=f"tecnico.{name.lower()}@exemplo.com",
        password_hash="x",
        role=UserRole.TECHNICIAN,
        is_active=True,
    )


def _headers(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(str(user.id), user.role.value)}"}


def _done(
    world: World,
    assignee: User | None,
    *,
    now: datetime,
    days_ago: float = 10,
    status: TicketStatus = TicketStatus.CLOSED,
    scheduled: datetime | None = None,
    arrived: datetime | None = None,
    visited: bool = True,
    legacy: dict | None = None,
    title: str = "Visita na Loja Exemplo",
) -> Ticket:
    """OS concluída `days_ago` dias atrás (chegada uma hora antes, sem `arrived` nem `visited`)."""
    at = now - timedelta(days=days_ago)
    if arrived is None and visited:
        arrived = at - timedelta(hours=1)
    ticket = Ticket(
        title=title,
        status=status,
        customer_id=uuid.UUID(world.customer_id),
        location_id=uuid.UUID(world.location_id),
        assignee_id=assignee.id if assignee else None,
        scheduled_start=scheduled,
        arrived_at=arrived,
        resolved_at=at,
        closed_at=at if status == TicketStatus.CLOSED else None,
        created_at=at - timedelta(days=1),
        updated_at=at,
    )
    if legacy is not None:
        # Só a OS migrada leva o campo: na OS daqui ele fica NULL no banco (como na abertura).
        ticket.legacy = legacy
    return ticket


def _status_event(
    ticket: Ticket,
    actor: User | None,
    *,
    to: str,
    at: datetime,
    frm: str | None = None,
    note: str | None = None,
    data: dict | None = None,
) -> TicketEvent:
    return TicketEvent(
        ticket_id=ticket.id,
        actor_id=actor.id if actor else None,
        event_type=TicketEventType.STATUS_CHANGED,
        from_value=frm,
        to_value=to,
        note=note,
        data=data,
        created_at=at,
    )


@requires_db
async def test_counts_and_attribution(
    engine: AsyncEngine, client: AsyncClient, world: World, brasilia: ZoneInfo
) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    sched = (now - timedelta(days=12)).replace(microsecond=0)
    async with maker() as db:
        alfa, bravo, charlie = _tech("Alfa"), _tech("Bravo"), _tech("Charlie")
        db.add_all([alfa, bravo, charlie])
        await db.flush()
        on_time = _done(
            world, alfa, now=now, scheduled=sched, arrived=sched + timedelta(minutes=30)
        )
        late = _done(
            world,
            alfa,
            now=now,
            status=TicketStatus.RESOLVED,
            scheduled=sched,
            arrived=sched + timedelta(minutes=31),
        )
        unscheduled = _done(world, alfa, now=now)  # sem agenda: fora da pontualidade
        together = _done(world, alfa, now=now)  # Bravo foi junto
        migrated = _done(world, alfa, now=now, visited=False, legacy=FC)
        cancelled = _done(world, alfa, now=now, status=TicketStatus.CANCELLED)
        too_old = _done(world, alfa, now=now, days_ago=395)
        no_visit = _done(world, alfa, now=now, visited=False)
        charlie_alone = _done(world, charlie, now=now)  # Charlie também na lista de "junto"
        db.add_all(
            [
                on_time,
                late,
                unscheduled,
                together,
                migrated,
                cancelled,
                too_old,
                no_visit,
                charlie_alone,
            ]
        )
        await db.flush()
        await db.execute(
            ticket_helpers.insert().values(
                [
                    {"ticket_id": together.id, "user_id": bravo.id},
                    {"ticket_id": charlie_alone.id, "user_id": charlie.id},
                ]
            )
        )
        await db.commit()

    async with maker() as db:
        everyone = await levels.collect(db, now)
        only_alfa = await levels.collect(db, now, alfa.id)
    c = everyone.counts[alfa.id]
    assert (c.services, c.as_assignee, c.as_helper, c.measured) == (5, 5, 0, 4)
    assert (c.arrivals, c.late, c.on_time, c.reworks, c.lost) == (2, 1, 1, 0, 0)
    assert only_alfa.counts == {alfa.id: c}
    helper = everyone.counts[bravo.id]
    assert (helper.services, helper.as_helper, helper.measured) == (1, 1, 0)
    alone = everyone.counts[charlie.id]
    assert (alone.services, alone.as_assignee, alone.as_helper) == (1, 1, 0)
    [occ] = everyone.occurrences[alfa.id]
    assert (occ.kind, occ.ref_id, occ.ticket_id) == (LevelOccurrenceKind.LATE, late.id, late.id)
    local = sched.astimezone(brasilia)
    assert occ.detail == (
        f"Chegou 31 min depois do horário combinado ({local:%H:%M} de {local:%d/%m})"
    )

    r = await client.get(f"{API}/technicians/{alfa.id}/level", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    body = r.json()
    m = body["metrics"]
    assert (m["services"], m["as_assignee"], m["as_helper"], m["measured"]) == (5, 5, 0, 4)
    assert (m["arrivals"], m["on_time"], m["late"], m["visits"]) == (2, 1, 1, 4)
    assert (m["on_time_pct"], m["rework_pct"], m["lost_pct"]) == (None, None, None)
    assert body["tier"] == "bronze" and body["criteria"] == []
    assert body["next"]["tier"] == "silver"
    assert body["next"]["criteria"][0]["text"] == "5 de 15"
    [shown] = body["occurrences"]
    assert shown["ref_id"] == str(late.id) and shown["waiver"] is None
    assert shown["ticket"] == {
        "id": str(late.id),
        "code": format_ticket_code(late.number),
        "title": "Visita na Loja Exemplo",
        "hidden": False,
    }
    assert body["technician"] == {"id": str(alfa.id), "name": "Tecnico Alfa"}
    assert [t["tier"] for t in body["tiers"]] == ["bronze", "silver", "gold", "diamond"]


@requires_db
async def test_rework(engine: AsyncEngine, client: AsyncClient, world: World) -> None:
    an, th, sup = world.analyst.headers, world.tech.headers, world.supervisor.headers
    tech_id = str(world.tech.user.id)
    t = await create(client, world, title="Nobreak apitando", assignee_id=tech_id)
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Bateria trocada")
    t = await transition(client, sup, t, "closed")
    t = await transition(client, an, t, "reopened", note="Voltou a apitar")
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    reopen = next(
        e for e in events if e["event_type"] == "status_changed" and e["to_value"] == "reopened"
    )
    assert reopen["data"]["technician_id"] == tech_id

    # Reabrir a cancelada não é retorno.
    c = await create(client, world, title="Cancelada por engano", assignee_id=tech_id)
    c = await transition(client, an, c, "cancelled", note="Achei que era duplicada")
    c = await transition(client, an, c, "reopened", note="Não era duplicada")
    events = (await client.get(f"{API}/tickets/{c['id']}/events", headers=an)).json()
    reopen = next(e for e in events if e["to_value"] == "reopened")
    assert "technician_id" not in (reopen["data"] or {})

    # A OS troca de técnico depois da reabertura: o retorno continua com quem concluiu.
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": str(world.tech_other.user.id), "expected_version": t["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text

    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    async with maker() as db:
        alfa, bravo = _tech("Alfa"), _tech("Bravo")
        db.add_all([alfa, bravo])
        await db.flush()
        # Reaberta 31 dias depois da conclusão: não é retorno.
        late_reopen = _done(world, alfa, now=now, days_ago=40)
        # Evento antigo, sem technician_id: vale o técnico autor da conclusão, não o responsável.
        old_event = _done(world, bravo, now=now, days_ago=20)
        # Concluída pela central e sem technician_id: vale o responsável atual.
        by_office = _done(world, bravo, now=now, days_ago=6)
        db.add_all([late_reopen, old_event, by_office])
        await db.flush()
        analyst = world.analyst.user
        db.add_all(
            [
                _status_event(late_reopen, alfa, to="resolved", at=now - timedelta(days=40)),
                _status_event(
                    late_reopen, analyst, to="reopened", frm="closed", at=now - timedelta(days=9)
                ),
                _status_event(old_event, alfa, to="resolved", at=now - timedelta(days=20)),
                _status_event(
                    old_event,
                    analyst,
                    to="reopened",
                    frm="resolved",
                    at=now - timedelta(days=15),
                    note="Cliente ligou de novo",
                ),
                _status_event(by_office, analyst, to="resolved", at=now - timedelta(days=6)),
                _status_event(
                    by_office, analyst, to="reopened", frm="resolved", at=now - timedelta(days=5)
                ),
            ]
        )
        await db.commit()

    async with maker() as db:
        found = await levels.collect(db, utcnow())
    assert found.counts[world.tech.user.id].reworks == 1
    assert world.tech_other.user.id not in found.occurrences
    [alfa_rework] = found.occurrences[alfa.id]
    assert (alfa_rework.ticket_id, alfa_rework.note) == (old_event.id, "Cliente ligou de novo")
    assert alfa_rework.detail == "Reaberta 5 dias depois da conclusão"
    [bravo_rework] = found.occurrences[bravo.id]
    assert bravo_rework.ticket_id == by_office.id

    central = (await client.get(f"{API}/technicians/{tech_id}/level", headers=an)).json()
    assert central["metrics"]["reworks"] == 1
    [occ] = central["occurrences"]
    assert occ["kind"] == "rework" and occ["ticket"]["id"] == t["id"]
    assert occ["detail"].startswith("Reaberta ")
    assert occ["detail"].endswith(" · Motivo: Voltou a apitar")
    # O técnico vê o retorno sem a nota da central.
    mine = (await client.get(f"{API}/me/level", headers=th)).json()
    assert [o["detail"] for o in mine["occurrences"]] == [occ["detail"].split(" · ")[0]]
    other = await client.get(f"{API}/technicians/{world.tech_other.user.id}/level", headers=an)
    assert other.json()["metrics"]["reworks"] == 0


@requires_db
async def test_lost_visits(engine: AsyncEngine, client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tech_id = str(world.tech.user.id)

    async def reason(name: str, responsibility: str) -> dict:
        r = await client.post(
            f"{API}/unproductive-reasons",
            json={"name": name, "responsibility": responsibility},
            headers=an,
        )
        assert r.status_code == 201, r.text
        return r.json()

    tech_fault = await reason("Atraso do técnico", "technician")
    absent = await reason("Cliente ausente", "customer")
    assert tech_fault["responsibility"] == "technician"
    meta = (await client.get(f"{API}/meta")).json()
    assert {"value": "technician", "label": "Técnico"} in meta["responsibilities"]

    # Pelo técnico e pela central: os dois eventos gravam o técnico da OS.
    a = await create(client, world, title="PDV sem rede", assignee_id=tech_id)
    r = await client.post(
        f"{API}/tickets/{a['id']}/unproductive",
        json={"reason_id": tech_fault["id"], "expected_version": a["version"]},
        headers=th,
    )
    assert r.status_code == 200, r.text
    b = await create(client, world, title="Impressora fiscal", assignee_id=tech_id)
    r = await client.post(
        f"{API}/tickets/{b['id']}/unproductive",
        json={"reason_id": absent["id"], "expected_version": b["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    for ticket in (a, b):
        events = (await client.get(f"{API}/tickets/{ticket['id']}/events", headers=an)).json()
        visit = next(e for e in events if e["event_type"] == "unproductive_visit")
        assert visit["data"]["technician_id"] == tech_id

    url = f"{API}/technicians/{tech_id}/level"
    detail = (await client.get(url, headers=an)).json()
    assert (detail["metrics"]["lost"], detail["metrics"]["visits"]) == (1, 1)
    assert detail["technician_reasons"] == 1
    [occ] = detail["occurrences"]
    assert (occ["kind"], occ["detail"]) == ("unproductive", "Visita improdutiva: Atraso do técnico")
    assert occ["ticket"]["id"] == a["id"]

    # Todos calculados agora: a rotina não tem o que refazer.
    r = await client.post(f"{API}/technicians/levels/refresh", headers=an)
    assert r.status_code == 200, r.text
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        assert await levels.refresh_if_stale(db) is False
    # Só o nome do motivo muda: nada a recalcular.
    r = await client.patch(
        f"{API}/unproductive-reasons/{absent['id']}", json={"name": "Loja fechada"}, headers=an
    )
    assert r.status_code == 200, r.text
    async with maker() as db:
        assert await levels.refresh_if_stale(db) is False
    # O motivo passa para o técnico: vale a classificação atual, também para a visita antiga.
    r = await client.patch(
        f"{API}/unproductive-reasons/{absent['id']}",
        json={"responsibility": "technician"},
        headers=an,
    )
    assert r.status_code == 200, r.text
    async with maker() as db:
        assert await levels.refresh_if_stale(db) is True
        await db.commit()
    detail = (await client.get(url, headers=an)).json()
    assert (detail["metrics"]["lost"], detail["technician_reasons"]) == (2, 2)


@requires_db
async def test_quality_only_native(
    engine: AsyncEngine, client: AsyncClient, world: World
) -> None:
    """Retorno e visita perdida só contam em OS deste sistema: a base das taxas (os atendimentos
    medidos) não tem as OS migradas do Field Control, nem as concluídas aqui depois da migração."""
    an = world.analyst.headers
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    async with maker() as db:
        alfa, bravo = _tech("Alfa"), _tech("Bravo")
        fault = UnproductiveReason(
            name="Atraso do técnico", responsibility=Responsibility.TECHNICIAN, is_active=True
        )
        db.add_all([alfa, bravo, fault])
        await db.flush()
        # Os dois com números de Prata: 15 OS do Field Control e 5 medidas (deste sistema).
        for tech in (alfa, bravo):
            db.add_all(
                _done(world, tech, now=now, days_ago=40 + i, visited=False, legacy=FC)
                for i in range(15)
            )
            db.add_all(_done(world, tech, now=now, days_ago=3 + i) for i in range(5))
        # Concluída no Field Control há 12 dias e fechada há 11 (os eventos como o importador
        # grava: a conclusão com o técnico como autor).
        fc_closed = _done(
            world, alfa, now=now, days_ago=12, visited=False, legacy=FC, title="OS migrada"
        )
        fc_closed.closed_at = now - timedelta(days=11)
        # Aberta na migração e concluída já aqui, há 5 dias.
        fc_here = _done(
            world, alfa, now=now, days_ago=5, status=TicketStatus.RESOLVED, legacy=FC
        )
        # Controle: a mesma história numa OS deste sistema, de Bravo.
        native = _done(world, bravo, now=now, days_ago=5, status=TicketStatus.RESOLVED)
        db.add_all([fc_closed, fc_here, native])
        await db.flush()
        db.add_all(
            [
                _status_event(fc_closed, alfa, to="resolved", at=now - timedelta(days=12), data=FC),
                _status_event(
                    fc_closed, None, to="closed", frm="resolved", at=now - timedelta(days=11)
                ),
                _status_event(
                    fc_here, alfa, to="resolved", frm="in_progress", at=now - timedelta(days=5)
                ),
                _status_event(
                    native, bravo, to="resolved", frm="in_progress", at=now - timedelta(days=5)
                ),
            ]
        )
        # Improdutiva com motivo do técnico, registrada aqui: na OS migrada não conta.
        for ticket, tech in ((fc_here, alfa), (native, bravo)):
            db.add(
                TicketEvent(
                    ticket_id=ticket.id,
                    actor_id=tech.id,
                    event_type=TicketEventType.UNPRODUCTIVE_VISIT,
                    data={"reason_id": str(fault.id), "technician_id": str(tech.id)},
                    created_at=now - timedelta(days=6),
                )
            )
        await db.commit()

    # A central reabre as três pela rota de verdade (o evento leva o técnico).
    for ticket in (fc_closed, fc_here, native):
        r = await client.post(
            f"{API}/tickets/{ticket.id}/transition",
            json={"to_status": "reopened", "note": "Cliente ligou de novo"},
            headers=an,
        )
        assert r.status_code == 200, r.text
    async with maker() as db:
        reopen_data = list(
            await db.scalars(
                select(TicketEvent.data).where(
                    TicketEvent.ticket_id.in_([fc_closed.id, fc_here.id]),
                    TicketEvent.to_value == "reopened",
                )
            )
        )
        found = await levels.collect(db, utcnow())
    assert [(d or {}).get("technician_id") for d in reopen_data] == [str(alfa.id)] * 2
    a, b = found.counts[alfa.id], found.counts[bravo.id]
    assert (a.services, a.measured, a.reworks, a.lost) == (20, 5, 0, 0)
    assert alfa.id not in found.occurrences
    assert (b.services, b.measured, b.reworks, b.lost) == (20, 5, 1, 1)
    assert sorted(o.kind for o in found.occurrences[bravo.id]) == [
        LevelOccurrenceKind.REWORK,
        LevelOccurrenceKind.UNPRODUCTIVE,
    ]

    # O veterano continua na Prata (0 em 5); o controle cai para o Bronze.
    vet = (await client.get(f"{API}/technicians/{alfa.id}/level", headers=an)).json()
    assert (vet["tier"], vet["occurrences"]) == ("silver", [])
    rework = _by_key(vet["criteria"])["rework"]
    assert (rework["met"], rework["text"]) == (True, "0% (0 em 5) · limite 10%")
    ctl = (await client.get(f"{API}/technicians/{bravo.id}/level", headers=an)).json()
    assert ctl["tier"] == "bronze"
    assert (ctl["metrics"]["reworks"], ctl["metrics"]["lost"]) == (1, 1)


@requires_db
async def test_me_level_privacy(engine: AsyncEngine, client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tech_id = str(world.tech.user.id)
    t = await create(client, world, title="Balança da loja", assignee_id=tech_id)
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Cabo trocado")
    t = await transition(client, an, t, "reopened", note="Nota reservada da central")

    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    sched = now - timedelta(days=3)
    async with maker() as db:
        late = _done(
            world,
            world.tech.user,
            now=now,
            days_ago=2,
            scheduled=sched,
            arrived=sched + timedelta(hours=1),
            title="Gaveta do caixa",
        )
        other = _done(
            world,
            world.tech_other.user,
            now=now,
            days_ago=2,
            scheduled=sched,
            arrived=sched + timedelta(hours=2),
            title="OS de outro técnico",
        )
        db.add_all([late, other])
        await db.commit()
    r = await client.post(
        f"{API}/technicians/{tech_id}/level/waivers",
        json={"kind": "late", "ref_id": str(late.id), "note": "Agenda trocada pela central"},
        headers=an,
    )
    assert r.status_code == 201, r.text

    mine = await client.get(f"{API}/me/level", headers=th)
    assert mine.status_code == 200, mine.text
    body = mine.json()
    assert body["tier"] == "bronze" and body["at_risk"] is None
    assert not {"technician", "computed_tier", "waived", "technician_reasons"} & set(body)
    # Só o retorno (o atraso foi desconsiderado), sem a nota da central nem a desconsideração.
    assert [o["kind"] for o in body["occurrences"]] == ["rework"]
    assert body["occurrences_total"] == 1
    assert set(body["occurrences"][0]) == {"kind", "ref_id", "ticket", "at", "detail"}
    # Sempre a OS dele, com id e código (o mascaramento de fila é só da central).
    assert set(body["occurrences"][0]["ticket"]) == {"id", "code", "title"}
    for secret in (
        "Nota reservada da central",
        "Agenda trocada pela central",
        "Analista",
        str(world.analyst.user.id),
        str(world.tech_other.user.id),
        world.tech_other.user.name,
        "OS de outro técnico",
        str(other.id),
        str(late.id),
    ):
        assert secret not in mine.text, secret

    # Quem vê o quê.
    for headers in (an, world.requester.headers):
        assert (await client.get(f"{API}/me/level", headers=headers)).status_code == 403
    url = f"{API}/technicians/{tech_id}/level"
    assert (await client.get(url, headers=th)).status_code == 403
    assert (await client.get(url, headers=world.requester.headers)).status_code == 403
    central = await client.get(url, headers=an)
    assert central.status_code == 200, central.text
    by_kind = {o["kind"]: o for o in central.json()["occurrences"]}
    assert by_kind["late"]["waiver"]["note"] == "Agenda trocada pela central"
    assert by_kind["late"]["waiver"]["created_by"]["name"] == "Analista"
    assert by_kind["rework"]["detail"].endswith(" · Motivo: Nota reservada da central")
    for missing in (uuid.uuid4(), world.analyst.user.id):
        r = await client.get(f"{API}/technicians/{missing}/level", headers=an)
        assert r.status_code == 404 and r.json()["detail"] == "Técnico não encontrado"


@requires_db
async def test_waivers(engine: AsyncEngine, client: AsyncClient, world: World) -> None:
    an, sup = world.analyst.headers, world.supervisor.headers
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    sched = (now - timedelta(days=20)).replace(microsecond=0)
    async with maker() as db:
        alfa, bravo = _tech("Alfa"), _tech("Bravo")
        db.add_all([alfa, bravo])
        await db.flush()
        visits = [
            _done(
                world,
                alfa,
                now=now,
                days_ago=15 - i,
                scheduled=sched,
                arrived=sched + timedelta(minutes=10 if i < 4 else 45),
            )
            for i in range(6)
        ]
        bravo_late = _done(
            world, bravo, now=now, scheduled=sched, arrived=sched + timedelta(minutes=50)
        )
        db.add_all([*visits, bravo_late])
        await db.commit()
    late_ids = [str(v.id) for v in visits[4:]]
    url = f"{API}/technicians/{alfa.id}/level"
    before = (await client.get(url, headers=an)).json()["metrics"]
    assert (before["arrivals"], before["late"], before["on_time"], before["on_time_pct"]) == (
        6,
        2,
        4,
        66,
    )

    waivers = f"{url}/waivers"
    body = {"kind": "late", "ref_id": late_ids[0], "note": "  Agenda errada no cadastro  "}
    r = await client.post(waivers, json=body, headers=an)
    assert r.status_code == 201, r.text
    detail = r.json()
    m = detail["metrics"]
    assert (m["late"], m["on_time"], m["on_time_pct"], detail["waived"]) == (1, 5, 83, 1)
    assert detail["occurrences_total"] == 2
    waived = next(o for o in detail["occurrences"] if o["ref_id"] == late_ids[0])
    assert waived["waiver"]["note"] == "Agenda errada no cadastro"
    assert waived["waiver"]["created_by"] == {
        "id": str(world.analyst.user.id),
        "name": "Analista",
    }
    # O técnico não vê a desconsiderada.
    mine = (await client.get(f"{API}/me/level", headers=_headers(alfa))).json()
    assert [o["ref_id"] for o in mine["occurrences"]] == [late_ids[1]]
    assert (mine["metrics"]["late"], mine["occurrences_total"]) == (1, 1)

    again = await client.post(waivers, json=body, headers=sup)
    assert again.status_code == 409
    assert again.json()["detail"] == "Esta ocorrência já foi desconsiderada"
    for wrong in (
        {**body, "ref_id": str(uuid.uuid4())},
        {**body, "kind": "rework"},
        # Atraso de outro técnico: não é ocorrência deste.
        {**body, "ref_id": str(bravo_late.id)},
    ):
        r = await client.post(waivers, json=wrong, headers=an)
        assert r.status_code == 422, wrong
        assert r.json()["detail"] == "Ocorrência não encontrada nos últimos 12 meses"
    for note in ("", "   ", "x" * 301):
        bad = {**body, "ref_id": late_ids[1], "note": note}
        r = await client.post(waivers, json=bad, headers=an)
        assert r.status_code == 422, note
        assert r.json()["detail"][0]["label"] == "Motivo"
    # O técnico não desconsidera.
    r = await client.post(waivers, json={**body, "ref_id": late_ids[1]}, headers=_headers(alfa))
    assert r.status_code == 403

    # Voltar a contar.
    r = await client.delete(f"{waivers}/{waived['waiver']['id']}", headers=an)
    assert r.status_code == 200, r.text
    assert (r.json()["metrics"]["late"], r.json()["waived"]) == (2, 0)
    gone = await client.delete(f"{waivers}/{waived['waiver']['id']}", headers=an)
    assert gone.status_code == 404
    assert gone.json()["detail"] == "Ocorrência desconsiderada não encontrada"


@requires_db
async def test_grace_through_refresh(engine: AsyncEngine, world: World) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    long_ago = now - timedelta(days=100)
    async with maker() as db:
        alfa, bravo = _tech("Alfa"), _tech("Bravo")
        db.add_all([alfa, bravo])
        await db.flush()
        # Números de Prata: 20 atendimentos do Field Control (nenhum medido).
        for tech in (alfa, bravo):
            db.add_all(
                _done(world, tech, now=now, days_ago=5 + i, visited=False, legacy=FC)
                for i in range(20)
            )
        db.add_all(
            [
                TechnicianLevel(
                    user_id=alfa.id,
                    tier=G,
                    computed_tier=G,
                    tier_since=long_ago,
                    computed_at=now - timedelta(hours=1),
                ),
                TechnicianLevel(
                    user_id=bravo.id,
                    tier=B,
                    computed_tier=B,
                    tier_since=long_ago,
                    computed_at=now - timedelta(hours=1),
                ),
            ]
        )
        await db.commit()

    async with maker() as db:
        # Ouro com números de Prata: fica no Ouro, em risco.
        snap = await levels.refresh_one(db, alfa.id, now)
        assert (snap.standing, snap.computed) == (Standing(G, long_ago, now), S)
        # Subir é na hora.
        up = await levels.refresh_one(db, bravo.id, now)
        assert up.standing == Standing(S, now, None)
        await db.commit()
    async with maker() as db:
        detail = await levels.my_level(db, alfa, now + timedelta(days=29))
        assert (detail.tier, detail.at_risk is not None) == (G, True)
        assert detail.at_risk.falls_to == S
        assert [c.key for c in detail.criteria if not c.met] == ["services", "measured"]
        assert detail.at_risk.failing == [
            "Atendimentos nos últimos 12 meses",
            "Atendimentos medidos",
        ]
        later = now + timedelta(days=30)
        fell = await levels.refresh_one(db, alfa.id, later)
        assert fell.standing == Standing(S, later, None)
        await db.commit()
    async with maker() as db:
        row = await db.get(TechnicianLevel, alfa.id)
        assert row is not None
        assert (row.tier, row.computed_tier, row.tier_since, row.at_risk_since) == (
            S,
            S,
            later,
            None,
        )
        assert (row.metrics["services"], row.metrics["measured"]) == (20, 0)


@requires_db
async def test_lists_and_suggestions(
    engine: AsyncEngine, client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    r = await client.get(f"{API}/technicians", headers=an)
    assert r.status_code == 200, r.text
    items = r.json()
    assert len(items) == 2
    # A primeira lista calcula todos (sem histórico: Bronze, com a data).
    for item in items:
        assert set(item["level"]) == {"tier", "since", "at_risk"}
        assert item["level"]["tier"] == "bronze" and item["level"]["since"]
        assert item["level"]["at_risk"] is False

    # Técnico novo, ainda sem conta: a próxima lista calcula todos (não espera a rotina).
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        charlie = _tech("Charlie")
        db.add(charlie)
        await db.commit()
    by_id = {t["id"]: t for t in (await client.get(f"{API}/technicians", headers=an)).json()}
    level = by_id[str(charlie.id)]["level"]
    assert (level["tier"], level["at_risk"]) == ("bronze", False) and level["since"]

    async def ranking(path: str) -> list[tuple[str, float, dict]]:
        r = await client.get(f"{API}{path}", headers=an)
        assert r.status_code == 200, r.text
        return [(s["id"], s["score"], s["level"]) for s in r.json()]

    ticket = await create(client, world, title="Roteador da loja")
    paths = ("/technicians/suggest", f"/tickets/{ticket['id']}/technician-suggestions")
    before = [await ranking(path) for path in paths]
    assert all(len(rows) == 3 for rows in before)
    assert all(level["tier"] == "bronze" for rows in before for _, _, level in rows)
    # Diamante para um deles: o selo muda, a pontuação e a ordem não.
    target = world.tech.user.id
    async with maker() as db:
        await db.execute(
            update(TechnicianLevel)
            .where(TechnicianLevel.user_id == target)
            .values(tier=D, computed_tier=D)
        )
        await db.commit()
    after = [await ranking(path) for path in paths]
    for old, new in zip(before, after, strict=True):
        assert [(i, s) for i, s, _ in new] == [(i, s) for i, s, _ in old]
        assert {i: level["tier"] for i, _, level in new}[str(target)] == "diamond"


@requires_db
async def test_refresh_route_and_job(
    engine: AsyncEngine, client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    url = f"{API}/technicians/levels/refresh"
    assert (await client.post(url, headers=world.tech.headers)).status_code == 403
    r = await client.post(url, headers=an)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "technicians": 2,
        "bronze": 2,
        "silver": 0,
        "gold": 0,
        "diamond": 0,
        "at_risk": 0,
    }
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        assert await levels.refresh_if_stale(db) is False
        assert await app_main._refresh_levels(db) == 0
    # A conta mais antiga com 6 h (as outras, novas): a rotina refaz todos.
    async with maker() as db:
        await db.execute(
            update(TechnicianLevel)
            .where(TechnicianLevel.user_id == world.tech.user.id)
            .values(computed_at=utcnow() - levels.STALE_AFTER)
        )
        await db.commit()
    async with maker() as db:
        assert await app_main._refresh_levels(db) == 1
        await db.commit()
    async with maker() as db:
        assert await levels.refresh_if_stale(db) is False
        # Técnico novo, sem conta: também refaz.
        db.add(_tech("Charlie"))
        await db.commit()
    async with maker() as db:
        assert await levels.refresh_if_stale(db) is True
        await db.commit()
    async with maker() as db:
        total = await db.scalar(select(func.count()).select_from(TechnicianLevel))
        assert total == 3


@requires_db
async def test_ensure_computed_with_loose_row(
    engine: AsyncEngine, client: AsyncClient, world: World
) -> None:
    """A conta solta que o app grava (GET /me/level antes de qualquer lista) não impede a lista de
    calcular os outros. Um cálculo por vez: quem chega junto não espera nem refaz."""
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def rows() -> int:
        async with maker() as db:
            return await db.scalar(select(func.count()).select_from(TechnicianLevel)) or 0

    r = await client.get(f"{API}/me/level", headers=world.tech.headers)
    assert r.status_code == 200, r.text
    assert await rows() == 1
    r = await client.get(f"{API}/technicians", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    listed = {t["id"]: t["level"] for t in r.json()}
    assert set(listed) == {str(world.tech.user.id), str(world.tech_other.user.id)}
    assert all(level["since"] for level in listed.values()), listed
    assert await rows() == 2
    async with maker() as db:
        assert await levels.ensure_computed(db) is False  # ninguém faltando: só lê

    # Técnico novo enquanto outra requisição calcula todos (ela está com a trava).
    async with maker() as db:
        charlie = _tech("Charlie")
        db.add(charlie)
        await db.commit()
    async with engine.connect() as other, other.begin():
        await other.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": levels.ENSURE_LOCK},
        )
        async with maker() as db:
            assert await levels.ensure_computed(db) is False
    assert await rows() == 2
    # Trava solta: calcula.
    async with maker() as db:
        assert await levels.ensure_computed(db) is True
        await db.commit()
    assert await rows() == 3


@requires_db
async def test_refresh_one_keeps_unchanged_row(engine: AsyncEngine, world: World) -> None:
    """Recalcular sem novidade (abrir o cadastro, a rodada do app) não regrava a linha; com
    novidade, grava."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    later = now + timedelta(hours=1)
    async with maker() as db:
        alfa = _tech("Alfa")
        db.add(alfa)
        await db.flush()
        db.add_all(
            _done(world, alfa, now=now, days_ago=5 + i, visited=False, legacy=FC)
            for i in range(3)
        )
        await db.commit()
    async with maker() as db:
        await levels.refresh_one(db, alfa.id, now)
        await db.commit()
    async with maker() as db:
        again = await levels.refresh_one(db, alfa.id, later)
        # A resposta diz quando calculou; a linha guardada não muda.
        assert (again.computed_at, again.counts.services) == (later, 3)
        await db.commit()
    async with maker() as db:
        row = await db.get(TechnicianLevel, alfa.id)
        assert row is not None
        assert (row.computed_at, row.updated_at, row.metrics["services"]) == (now, now, 3)
        db.add(_done(world, alfa, now=now, days_ago=1, visited=False, legacy=FC))
        await db.commit()
    async with maker() as db:
        await levels.refresh_one(db, alfa.id, later)
        await db.commit()
    async with maker() as db:
        row = await db.get(TechnicianLevel, alfa.id)
        assert row is not None
        assert (row.computed_at, row.metrics["services"]) == (later, 4)
