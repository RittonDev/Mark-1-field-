"""Prazo de solução do Field Control: no FC o prazo fecha quando a visita termina, mesmo
improdutiva. Na OS migrada aberta com esse veredito, o relógio de solução para na visita
(resolution_sla_met_at): cumprido no prazo não vira "SLA violado" correndo para sempre, e fora do
prazo fica violado e congelado. Dados sintéticos."""

import importlib.util
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import SlaStatus, TicketEventType, TicketStatus
from app.importers.fieldcontrol import Importer, Report, map_status, solution_met_at
from app.models import Ticket, TicketEvent
from app.services import sla
from tests.conftest import World, requires_db
from tests.test_api import create

API = settings.API_PREFIX
S = TicketStatus
NOW = datetime(2026, 11, 17, 20, 0, tzinfo=UTC)
DUE = datetime(2026, 1, 28, 23, 52, tzinfo=UTC)  # vencido há ~292 dias em NOW
MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "20261118_b9e4c1a7d5f2_prazo_de_solucao_do_field_control.py"
)


def sla_ticket(**kw: Any) -> SimpleNamespace:
    """OS migrada como a do relato: aberta, respondida, prazo de solução vencido há meses."""
    base: dict[str, Any] = {
        "status": S.ASSIGNED,
        "created_at": datetime(2025, 12, 22, 12, 0, tzinfo=UTC),
        "response_due_at": DUE,
        "resolution_due_at": DUE,
        "first_response_at": datetime(2026, 1, 10, 12, 0, tzinfo=UTC),
        "resolved_at": None,
        "sla_paused_at": None,
        "sla_paused_seconds": 0,
        "resolution_sla_met_at": None,
    }
    base.update(kw)
    return SimpleNamespace(**base)


# ---------------------------------------------------------------------- regra (sem banco)


def test_fc_visit_on_time_closes_the_solution_clock() -> None:
    running = sla_ticket()
    assert sla.compute_sla_status(running, NOW) == SlaStatus.BREACHED  # o relato: 292d corrido

    met = DUE - timedelta(days=1)
    t = sla_ticket(resolution_sla_met_at=met)
    assert sla.compute_sla_status(t, NOW) == SlaStatus.MET
    assert sla.resolution_end(t) == met
    assert sla.resolution_breached(t, NOW) is False


def test_fc_visit_late_stays_breached_and_frozen() -> None:
    late = DUE + timedelta(days=2)
    t = sla_ticket(resolution_sla_met_at=late)
    for moment in (DUE + timedelta(days=3), NOW, NOW + timedelta(days=400)):
        assert sla.compute_sla_status(t, moment) == SlaStatus.BREACHED
        assert sla.resolution_end(t) == late  # não anda com o relógio
    assert sla.resolution_breached(t, NOW) is True


def test_conclusion_keeps_the_fc_verdict() -> None:
    """Concluída aqui meses depois: vale o que veio primeiro (a visita do FC), não entra como
    violada em relatórios e no Dashboard."""
    met = DUE - timedelta(hours=5)
    for status in (S.RESOLVED, S.CLOSED):
        t = sla_ticket(status=status, resolved_at=NOW, resolution_sla_met_at=met)
        assert sla.resolution_end(t) == met
        assert sla.compute_sla_status(t, NOW) == SlaStatus.MET
        assert sla.resolution_breached(t, NOW) is False
    late = sla_ticket(status=S.RESOLVED, resolved_at=NOW, resolution_sla_met_at=DUE + timedelta(1))
    assert sla.compute_sla_status(late, NOW) == SlaStatus.BREACHED
    assert sla.resolution_breached(late, NOW) is True
    # Sem o registro, a conclusão é o fim (como sempre foi).
    plain = sla_ticket(status=S.RESOLVED, resolved_at=DUE - timedelta(hours=1))
    assert sla.resolution_end(plain) == plain.resolved_at
    assert sla.compute_sla_status(plain, NOW) == SlaStatus.MET


def test_rows_without_the_column_keep_todays_rule() -> None:
    """Linhas de consulta que não trazem a coluna (filas, Dashboard): getattr, sem erro."""
    row = sla_ticket()
    del row.resolution_sla_met_at
    assert sla.solution_met_at(row) is None
    assert sla.resolution_end(row) is None
    assert sla.compute_sla_status(row, NOW) == SlaStatus.BREACHED
    assert sla.resolution_breached(row, NOW) is True
    done = sla_ticket(status=S.CLOSED, resolved_at=DUE + timedelta(1))
    del done.resolution_sla_met_at
    assert sla.resolution_end(done) == done.resolved_at
    assert sla.compute_sla_status(done, NOW) == SlaStatus.BREACHED


def test_pending_response_still_counts() -> None:
    met = DUE - timedelta(days=1)
    overdue = sla_ticket(first_response_at=None, resolution_sla_met_at=met)
    assert sla.compute_sla_status(overdue, NOW) == SlaStatus.BREACHED
    # Resposta ainda no prazo: só ela conta (a solução já fechou).
    created = NOW - timedelta(hours=1)
    fresh = sla_ticket(
        created_at=created,
        response_due_at=NOW + timedelta(hours=3),
        resolution_due_at=NOW - timedelta(minutes=1),  # sem o registro, estaria violada
        first_response_at=None,
        resolution_sla_met_at=created + timedelta(minutes=30),
    )
    assert sla.compute_sla_status(fresh, NOW) == SlaStatus.OK
    assert sla.compute_sla_status(fresh, NOW + timedelta(hours=2, minutes=30)) == SlaStatus.AT_RISK
    paused = sla_ticket(**{**vars(fresh), "sla_paused_at": NOW})
    assert sla.compute_sla_status(paused, NOW) == SlaStatus.PAUSED


def test_pause_after_the_verdict_does_not_move_the_solution_deadline() -> None:
    met = DUE - timedelta(days=1)
    t = sla_ticket(
        status=S.ON_HOLD_CUSTOMER,
        sla_paused_at=NOW - timedelta(days=10),
        first_response_at=None,
        resolution_sla_met_at=met,
    )
    sla.resume(t, NOW)
    assert t.resolution_due_at == DUE  # o prazo encerrado não anda
    assert t.response_due_at == DUE + timedelta(days=10)  # a resposta pendente anda
    assert t.sla_paused_seconds == 10 * 86400 and t.sla_paused_at is None
    running = sla_ticket(status=S.ON_HOLD_CUSTOMER, sla_paused_at=NOW - timedelta(days=10))
    sla.resume(running, NOW)
    assert running.resolution_due_at == DUE + timedelta(days=10)  # sem o registro, como sempre


# ---------------------------------------------------------------------- importação (sem banco)

TECH = uuid.uuid4()
IMPORT_NOW = datetime(2026, 11, 12, 18, 0, tzinfo=UTC)


def _task(status: str, **kw: Any) -> dict[str, Any]:
    base = {
        "id": f"t-{uuid.uuid4().hex[:6]}",
        "status": status,
        "position": 0,
        "createdAt": "2026-10-20T10:00:00Z",
        "employee": {"id": 1, "_id": "emp-1", "name": "Técnico Um"},
    }
    base.update(kw)
    return base


def _order(*tasks: dict[str, Any], **kw: Any) -> dict[str, Any]:
    base = {
        "id": f"o-{uuid.uuid4().hex[:6]}",
        "identifier": "12731",
        "status": "pending",
        "createdAt": "2026-10-20T09:00:00Z",
        "updatedAt": "2026-10-21T14:00:00Z",
        "service": {"id": 1, "description": "Manutenção corretiva", "duration": 60},
        "tasks": list(tasks),
        "deadline": None,
    }
    base.update(kw)
    return base


def _importer() -> Importer:
    importer = Importer(None, Path("."), Report(), 120, IMPORT_NOW)  # type: ignore[arg-type]
    importer.refs["user"]["1"] = TECH
    importer.refs["user"]["emp-1"] = TECH
    return importer


DEADLINE = {
    "responseAt": "2026-10-20T15:00:00Z",
    "solutionAt": "2026-10-22T09:00:00Z",
    "firstTaskStartedAt": "2026-10-21T13:00:00Z",
    "responseStatus": "completedOnSchedule",
    "solutionStatus": "completedOnSchedule",
}
REPORTED = _task(
    "reported",
    startedAt="2026-10-21T13:00:00Z",
    completedAt="2026-10-21T13:30:00Z",
    statusDescription="Loja fechada",
    scheduling={"date": "2026-10-21", "time": "10:00:00"},
)


def test_import_brings_the_fc_verdict_and_unschedules_the_unproductive_visit() -> None:
    row, children = _importer().build_ticket(_order(REPORTED, deadline=DEADLINE), {})
    visit = datetime(2026, 10, 21, 13, 30, tzinfo=UTC)
    assert row["status"] == S.ASSIGNED and row["assignee_id"] == TECH
    assert row["last_unproductive_at"] == visit
    assert row["resolution_sla_met_at"] == visit
    # Improdutiva sem agenda, como no fluxo daqui (senão vira "Atrasada"); a data fica no evento.
    assert row["scheduled_start"] is None and row["scheduled_end"] is None
    bounce = next(
        e for e in children["events"] if e["event_type"] == TicketEventType.UNPRODUCTIVE_VISIT
    )
    assert bounce["data"]["previous_schedule"] == "2026-10-21T13:00:00+00:00"  # 10:00 em Brasília


def test_import_verdict_only_for_open_orders() -> None:
    late = {**DEADLINE, "solutionStatus": "completedOutOfSchedule"}
    done = _task("done", startedAt="2026-11-02T13:00:00Z", completedAt="2026-11-02T15:00:00Z")
    tasks = [REPORTED, done]
    # Concluída no FC: o fim é a conclusão (o veredito sai do resolved_at), sem registro.
    assert solution_met_at(late, tasks, S.CLOSED) is None
    assert solution_met_at(late, tasks, S.CANCELLED) is None
    # Aberta: a última visita encerrada (concluída ou improdutiva).
    assert solution_met_at(late, tasks, S.ASSIGNED) == datetime(2026, 11, 2, 15, tzinfo=UTC)
    # Sem prazo encerrado no FC (fora do prazo ou no prazo, ainda correndo): nada.
    for status in ("outOfSchedule", "onSchedule", None):
        assert solution_met_at({**DEADLINE, "solutionStatus": status}, tasks, S.ASSIGNED) is None
    row, _ = _importer().build_ticket(_order(REPORTED, done, deadline=late), {})
    assert row["status"] == S.CLOSED and row["resolution_sla_met_at"] is None


def test_import_scheduled_needs_a_technician() -> None:
    later = {"date": "2026-11-20", "time": "09:00:00"}
    no_one = _task("pending", employee=None, scheduling=later)
    assert map_status(_order(), [no_one], IMPORT_NOW, 120).status == S.NEW
    row, _ = _importer().build_ticket(_order(no_one), {})
    assert row["status"] == S.NEW and row["assignee_id"] is None
    assert row["scheduled_start"] == datetime(2026, 11, 20, 12, 0, tzinfo=UTC)  # a data fica
    # Colaborador que não veio no export: também sem técnico.
    stranger = _task("scheduled", employee={"id": 99, "_id": "emp-99"}, scheduling=later)
    assert map_status(_order(), [stranger], IMPORT_NOW, 120).status == S.SCHEDULED
    row, _ = _importer().build_ticket(_order(stranger), {})
    assert row["status"] == S.NEW and row["assignee_id"] is None
    # Com técnico conhecido: "Agendado".
    row, _ = _importer().build_ticket(_order(_task("scheduled", scheduling=later)), {})
    assert row["status"] == S.SCHEDULED and row["assignee_id"] == TECH


# ---------------------------------------------------------------------- banco


def _backfill_sql() -> str:
    spec = importlib.util.spec_from_file_location("prazo_de_solucao_fc", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.BACKFILL


def _legacy(verdict: str | None) -> dict[str, Any]:
    return {"source": "fieldcontrol", "deadline": {"solution_status": verdict}}


@requires_db
async def test_backfill_touches_only_open_fc_orders_with_the_verdict(
    world: World, engine: AsyncEngine
) -> None:
    visit = datetime(2026, 1, 20, 15, 0, tzinfo=UTC)
    here = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)
    cases: dict[str, tuple[dict[str, Any], datetime | None]] = {
        "no_prazo": ({"legacy": _legacy("completedOnSchedule")}, visit),
        "fora_do_prazo": ({"legacy": _legacy("completedOutOfSchedule")}, visit),
        # Aberta na migração e concluída aqui antes da migração do banco: a visita veio antes.
        "concluida_aqui": (
            {"legacy": _legacy("completedOnSchedule"), "status": S.RESOLVED, "resolved_at": here},
            visit,
        ),
        "sem_veredito": ({"legacy": _legacy("outOfSchedule")}, None),
        "sem_visita": (
            {"legacy": _legacy("completedOnSchedule"), "last_unproductive_at": None},
            None,
        ),
        "cancelada": ({"legacy": _legacy("completedOnSchedule"), "status": S.CANCELLED}, None),
        "fechada_na_importacao": (
            {"legacy": _legacy("completedOutOfSchedule"), "status": S.CLOSED, "resolved_at": here},
            None,
        ),
        "nativa": ({"legacy": None}, None),
    }
    maker = async_sessionmaker(engine, expire_on_commit=False)
    ids: dict[str, uuid.UUID] = {}
    async with maker() as db:
        for name, (fields, _) in cases.items():
            values: dict[str, Any] = {
                "title": f"OS {name}",
                "status": S.ASSIGNED,
                "resolution_due_at": DUE,
                "last_unproductive_at": visit,
                "unproductive_count": 1,
                **fields,
            }
            t = Ticket(**values)
            db.add(t)
            await db.flush()
            ids[name] = t.id
        db.add(
            TicketEvent(
                ticket_id=ids["fechada_na_importacao"],
                event_type=TicketEventType.STATUS_CHANGED,
                to_value=S.CLOSED.value,
                data={"source": "fieldcontrol"},
            )
        )
        await db.commit()

    async with engine.begin() as conn:
        touched = (await conn.execute(text(_backfill_sql()))).rowcount
    async with maker() as db:
        got = dict(
            (await db.execute(select(Ticket.id, Ticket.resolution_sla_met_at))).tuples().all()
        )
    assert touched == 3
    for name, (_, expected) in cases.items():
        assert got[ids[name]] == expected, name


@requires_db
async def test_detail_list_and_queue_follow_the_verdict(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    sup = world.supervisor.headers
    t = await create(client, world, title="Migrada com visita improdutiva")
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def mark(**values: Any) -> None:
        async with maker() as db:
            ticket = await db.get(Ticket, uuid.UUID(t["id"]))
            assert ticket is not None
            for key, value in values.items():
                setattr(ticket, key, value)
            await db.commit()

    due = datetime.now(UTC) - timedelta(days=292)
    on_time = due - timedelta(hours=6)
    await mark(
        response_due_at=due,
        resolution_due_at=due,
        first_response_at=due - timedelta(days=1),
        last_unproductive_at=on_time,
        unproductive_count=1,
        resolution_sla_met_at=on_time,
        legacy=_legacy("completedOnSchedule"),
    )
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()
    assert detail["sla_status"] == "met" and detail["resolution_breached"] is False
    assert datetime.fromisoformat(detail["resolution_sla_met_at"]) == on_time
    listed = (
        await client.get(f"{API}/tickets", params={"number": t["number"]}, headers=sup)
    ).json()
    assert [i["sla_status"] for i in listed["items"]] == ["met"]
    queue = (await client.get(f"{API}/my-queue", headers=sup)).json()
    item = next(i for i in queue["items"] if i["id"] == t["id"])
    assert "sla_violated" not in {r["code"] for r in item["reasons"]}

    # Fora do prazo no FC: violada, sem a contagem andar.
    await mark(resolution_sla_met_at=due + timedelta(days=3))
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()
    assert detail["sla_status"] == "breached" and detail["resolution_breached"] is True

    # Concluída aqui depois: vale a visita (no prazo), sem pendência de justificar.
    await mark(resolution_sla_met_at=on_time, status=S.RESOLVED, resolved_at=datetime.now(UTC))
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()
    assert detail["sla_status"] == "met" and detail["violation_reason_pending"] is False


@requires_db
async def test_resolution_end_in_sql_matches_python(world: World, engine: AsyncEngine) -> None:
    met = DUE - timedelta(days=1)
    resolved = DUE + timedelta(days=30)
    cases = {
        "aberta_com_registro": ({"resolution_sla_met_at": met}, met),
        "concluida_com_registro": (
            {"status": S.CLOSED, "resolved_at": resolved, "resolution_sla_met_at": met},
            met,
        ),
        "concluida": ({"status": S.RESOLVED, "resolved_at": resolved}, resolved),
        "aberta": ({}, None),
        # Reaberta: o resolved_at antigo não conta (só com a OS concluída).
        "reaberta": ({"status": S.REOPENED, "resolved_at": resolved}, None),
    }
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        ids = {}
        for name, (fields, _) in cases.items():
            ticket = Ticket(title=f"OS {name}", status=S.ASSIGNED, resolution_due_at=DUE)
            for key, value in fields.items():
                setattr(ticket, key, value)
            db.add(ticket)
            await db.flush()
            ids[name] = ticket
        await db.commit()
        got = dict((await db.execute(select(Ticket.id, sla.resolution_end_col()))).tuples().all())
    for name, (_, expected) in cases.items():
        assert got[ids[name].id] == expected, name
        assert sla.resolution_end(ids[name]) == expected, name
