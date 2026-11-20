"""Faturamento do app (GET /me/earnings/months): um cartão por mês de conclusão, com a situação
calculada no servidor (a nota fiscal nunca trava o pagamento) e os totais do topo.

Só dados fictícios ("Tecnico", "Redes", números de nota inventados).
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import InvoiceStatus
from app.services import payouts as payouts_svc
from tests.conftest import Actor, World, requires_db
from tests.test_api import create, transition
from tests.test_invoices import concluded, media, send, still_open  # noqa: F401 (media: fixture)

API = settings.API_PREFIX
URL = f"{API}/me/earnings/months"


# --------------------------------------------------------------------------- apoio


def _first(offset: int = 0) -> date:
    """O dia 1 do mês atual no fuso da operação, `offset` meses depois (antes, se negativo)."""
    today = datetime.now(ZoneInfo(settings.TIMEZONE)).date()
    return payouts_svc.shift_month(today.replace(day=1), offset)


def _key(offset: int = 0) -> str:
    return f"{_first(offset):%Y-%m}"


def _mid(offset: int) -> datetime:
    """Dia 15 ao meio-dia (fuso da operação) do mês `offset`: longe da virada do mês."""
    first = _first(offset)
    return datetime(first.year, first.month, 15, 12, tzinfo=ZoneInfo(settings.TIMEZONE))


async def _resolved_at(engine: AsyncEngine, ticket_id: str, at: datetime) -> None:
    """Muda a conclusão da OS (o mês do valor da OS concluída)."""
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE tickets SET resolved_at = :at WHERE id = :id"), {"at": at, "id": ticket_id}
        )


async def _launched_at(engine: AsyncEngine, payout_id: str, at: datetime) -> None:
    """Muda o lançamento do valor (o mês do valor da OS aberta ou cancelada)."""
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE ticket_payouts SET created_at = :at WHERE id = :id"),
            {"at": at, "id": payout_id},
        )


async def _months(client: AsyncClient, actor: Actor, **params: Any) -> dict:
    r = await client.get(URL, params=params, headers=actor.headers)
    assert r.status_code == 200, r.text
    return r.json()


def _by_month(body: dict) -> dict[str, dict]:
    return {m["month"]: m for m in body["months"]}


def _bucket(count: int, amount: float) -> dict:
    return {"count": count, "amount": amount}


async def _pay(client: AsyncClient, world: World, *payout_ids: str) -> None:
    r = await client.post(
        f"{API}/payouts/pay", json={"ids": list(payout_ids)}, headers=world.analyst.headers
    )
    assert r.status_code == 200 and r.json() == {"changed": len(payout_ids)}, r.text


async def _cancel(client: AsyncClient, world: World, ticket_id: str) -> None:
    sup = world.supervisor.headers
    t = (await client.get(f"{API}/tickets/{ticket_id}", headers=sup)).json()
    await transition(client, sup, t, "cancelled", note="Cliente desistiu")


async def _invoice(
    client: AsyncClient, tech: Actor, offset: int, number: str, *payouts: str
) -> str:
    """Nota do técnico com a competência do mês `offset` (e as OS dadas)."""
    fields = {"number": number, "amount": "100.00", "competence": _key(offset)}
    if payouts:
        fields["payout_ids"] = ",".join(payouts)
    r = await send(client, tech, **fields)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _review(client: AsyncClient, world: World, invoice_id: str, reason: str = "") -> None:
    """A central confere (sem motivo) ou recusa (com o motivo) a nota."""
    action, body = ("reject", {"reason": reason}) if reason else ("check", None)
    r = await client.post(
        f"{API}/technician-invoices/{invoice_id}/{action}",
        json=body,
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text


# --------------------------------------------------------------------------- regras puras


def test_month_state_priority() -> None:
    """A situação sai das contagens (R$ 0,00 também conta), nesta prioridade."""

    def state(*, rejection_open: bool = False, **counts: int) -> str:
        zeros = dict.fromkeys(
            (
                "to_pay",
                "expected",
                "paid",
                "due_without_invoice",
                "due_in_review",
                "paid_without_invoice",
            ),
            0,
        )
        return payouts_svc.month_state(**{**zeros, **counts}, rejection_open=rejection_open)

    assert state() == "empty"
    assert state(expected=2) == "in_progress"
    assert state(to_pay=2, due_without_invoice=1, due_in_review=1) == "no_invoice"
    assert state(to_pay=1, expected=1, due_without_invoice=1) == "no_invoice"
    assert state(to_pay=2, due_in_review=1) == "in_review"
    assert state(to_pay=2) == "to_pay"  # todas com nota conferida
    assert state(paid=1, to_pay=1, due_without_invoice=1) == "partial"
    assert state(paid=1, expected=1, paid_without_invoice=1) == "partial"
    assert state(paid=2, paid_without_invoice=1) == "paid_no_invoice"
    assert state(paid=2) == "paid"
    # Recusa em aberto: mês sem OS, OS a receber sem nota, OS paga sem nota.
    assert state(rejection_open=True) == "rejected"
    assert state(rejection_open=True, to_pay=1, due_without_invoice=1) == "rejected"
    assert state(rejection_open=True, paid=1, paid_without_invoice=1) == "rejected"
    # Tudo coberto por outra nota (ou só OS em andamento): a recusa não marca o mês.
    assert state(rejection_open=True, to_pay=1, due_in_review=1) == "in_review"
    assert state(rejection_open=True, paid=1) == "paid"
    assert state(rejection_open=True, expected=1) == "in_progress"


def test_shift_month() -> None:
    assert payouts_svc.shift_month(date(2026, 11, 1), 0) == date(2026, 11, 1)
    assert payouts_svc.shift_month(date(2026, 1, 1), -1) == date(2025, 12, 1)
    assert payouts_svc.shift_month(date(2026, 12, 1), 1) == date(2027, 1, 1)
    assert payouts_svc.shift_month(date(2026, 11, 1), -23) == date(2024, 12, 1)


def test_open_rejection_per_competence() -> None:
    """A recusa mais recente da competência vale até o técnico enviar outra nota depois dela."""
    at = datetime(2026, 11, 10, 12, tzinfo=UTC)

    def invoice(number: str, month: int, status: InvoiceStatus, sent: int, reviewed: int | None):
        return SimpleNamespace(
            id=uuid.UUID(int=int(number)),
            number=number,
            status=status,
            competence=date(2026, month, 1),
            reject_reason=f"Motivo {number}" if status == InvoiceStatus.REJECTED else None,
            created_at=at + timedelta(hours=sent),
            reviewed_at=None if reviewed is None else at + timedelta(hours=reviewed),
        )

    R, P, C = InvoiceStatus.REJECTED, InvoiceStatus.PENDING, InvoiceStatus.CHECKED
    found = payouts_svc._open_rejections(
        [
            # Outubro: duas recusadas; vale a de recusa mais recente.
            invoice("10", 10, R, sent=0, reviewed=5),
            invoice("11", 10, R, sent=1, reviewed=3),
            # Agosto: a nota conferida foi enviada antes da recusa, então a recusa continua.
            invoice("12", 8, C, sent=1, reviewed=2),
            invoice("13", 8, R, sent=0, reviewed=4),
            # Setembro: nota nova depois da recusa encerra a recusa.
            invoice("14", 9, R, sent=0, reviewed=1),
            invoice("15", 9, P, sent=2, reviewed=None),
            # Julho: só notas em conferência.
            invoice("16", 7, P, sent=0, reviewed=None),
        ]
    )
    assert {key: (r.number, r.reason) for key, r in found.items()} == {
        "2026-10": ("10", "Motivo 10"),
        "2026-08": ("13", "Motivo 13"),
    }
    assert found["2026-10"].rejected_at == at + timedelta(hours=5)
    assert found["2026-10"].invoice_id == uuid.UUID(int=10)


# --------------------------------------------------------------------------- API


@requires_db
async def test_window_totals_and_empty_months(client: AsyncClient, world: World) -> None:
    await concluded(client, world, "Troca de PDV", 100)
    await still_open(client, world, "Em andamento", 90)

    body = await _months(client, world.tech)
    keys = [_key(-back) for back in range(12)]
    assert [m["month"] for m in body["months"]] == keys  # o mais novo primeiro
    assert (body["since"], body["until"]) == (keys[-1], keys[0])
    current = body["months"][0]
    assert (current["state"], current["count"], current["total"]) == ("no_invoice", 2, 190.0)
    assert current["to_pay"] == _bucket(1, 100.0)
    assert current["expected"] == _bucket(1, 90.0)
    assert current["paid"] == _bucket(0, 0.0)
    assert current["due_without_invoice"] == _bucket(1, 100.0)
    assert current["due_in_review"] == current["due_checked"] == _bucket(0, 0.0)
    assert current["paid_without_invoice"] == _bucket(0, 0.0)
    assert (current["last_paid_at"], current["rejection"]) == (None, None)
    for month in body["months"][1:]:
        assert (month["state"], month["count"], month["total"]) == ("empty", 0, 0.0)
        assert month["to_pay"] == month["paid"] == _bucket(0, 0.0)
    assert body["totals"] == {
        "paid": 0.0,
        "to_pay": 100.0,
        "expected": 90.0,
        "to_pay_older": 0.0,
        "last_paid_at": None,
        "reimbursement_to_receive": 0.0,
        "reimbursement_paid": 0.0,
    }


@requires_db
@pytest.mark.usefixtures("media")
async def test_states_across_months(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    """Um mês por situação: as OS concluídas vão para meses passados e as notas têm a competência
    de cada mês."""
    tech = world.tech

    async def done_in(offset: int, title: str, amount: int) -> str:
        ticket, payout = await concluded(client, world, title, amount)
        await _resolved_at(engine, ticket["id"], _mid(offset))
        return payout

    # Mês atual: só OS em andamento.
    await still_open(client, world, "Em andamento", 90)
    # -1: concluída, sem nota.
    await done_in(-1, "Sem nota", 100)
    # -2: nota em conferência.
    await _invoice(client, tech, -2, "201", await done_in(-2, "Em conferência", 110))
    # -3: nota conferida, falta pagar.
    checked = await _invoice(client, tech, -3, "301", await done_in(-3, "Conferida", 120))
    await _review(client, world, checked)
    # -4: uma paga e outra a receber.
    await _pay(client, world, await done_in(-4, "Paga", 130))
    await done_in(-4, "A receber", 140)
    # -5: paga sem nota.
    await _pay(client, world, await done_in(-5, "Paga sem nota", 150))
    # -6: nota conferida e paga.
    paid_with_invoice = await done_in(-6, "Paga com nota", 160)
    await _review(client, world, await _invoice(client, tech, -6, "601", paid_with_invoice))
    await _pay(client, world, paid_with_invoice)
    # -7: nota recusada (a recusa solta as OS).
    rejected = await _invoice(client, tech, -7, "701", await done_in(-7, "Recusada", 170))
    await _review(client, world, rejected, "Valor não confere")
    # -8: nota recusada de uma competência sem OS.
    await _review(client, world, await _invoice(client, tech, -8, "801"), "Arquivo ilegível")
    # -9: recusada e reenviada com a OS: a nota nova encerra a recusa.
    resent = await done_in(-9, "Reenviada", 180)
    await _review(client, world, await _invoice(client, tech, -9, "901", resent), "Número errado")
    await _invoice(client, tech, -9, "902", resent)
    # -10: a OS já está noutra nota, enviada antes da recusa: a recusa não marca o mês.
    covered = await done_in(-10, "Coberta", 190)
    await _invoice(client, tech, -10, "1001", covered)
    await _review(client, world, await _invoice(client, tech, -10, "1002"), "Nota duplicada")

    body = await _months(client, tech)
    months = _by_month(body)
    assert {back: months[_key(-back)]["state"] for back in range(12)} == {
        0: "in_progress",
        1: "no_invoice",
        2: "in_review",
        3: "to_pay",
        4: "partial",
        5: "paid_no_invoice",
        6: "paid",
        7: "rejected",
        8: "rejected",
        9: "in_review",
        10: "in_review",
        11: "empty",
    }
    assert months[_key(0)]["expected"] == _bucket(1, 90.0)
    assert months[_key(-2)]["due_in_review"] == _bucket(1, 110.0)
    assert months[_key(-3)]["due_checked"] == _bucket(1, 120.0)
    partial = months[_key(-4)]
    assert (partial["count"], partial["total"]) == (2, 270.0)
    assert (partial["paid"], partial["to_pay"]) == (_bucket(1, 130.0), _bucket(1, 140.0))
    assert partial["last_paid_at"] is not None
    assert months[_key(-5)]["paid_without_invoice"] == _bucket(1, 150.0)
    assert months[_key(-6)]["paid_without_invoice"] == _bucket(0, 0.0)
    assert months[_key(-6)]["paid"] == _bucket(1, 160.0)
    refused = months[_key(-7)]
    assert refused["due_without_invoice"] == _bucket(1, 170.0)
    assert refused["rejection"]["invoice_id"] == rejected
    assert (refused["rejection"]["number"], refused["rejection"]["reason"]) == (
        "701",
        "Valor não confere",
    )
    assert refused["rejection"]["rejected_at"] is not None
    empty_refused = months[_key(-8)]
    assert (empty_refused["count"], empty_refused["total"]) == (0, 0.0)
    assert empty_refused["rejection"]["reason"] == "Arquivo ilegível"
    assert months[_key(-9)]["rejection"] is None
    # A recusa continua valendo em -10 (nenhuma nota depois dela), mas todas as OS têm nota.
    assert months[_key(-10)]["rejection"]["number"] == "1002"
    assert body["totals"]["paid"] == 440.0
    assert body["totals"]["to_pay"] == 1010.0
    assert body["totals"]["expected"] == 90.0
    assert body["totals"]["last_paid_at"] is not None

    # Nota nova da competência depois da recusa: deixa de ser "recusada" (a OS segue sem nota).
    await _invoice(client, tech, -7, "702")
    months = _by_month(await _months(client, tech))
    assert (months[_key(-7)]["state"], months[_key(-7)]["rejection"]) == ("no_invoice", None)
    # O técnico apaga a recusada de -8: o mês volta a ficar vazio.
    mine = (await client.get(f"{API}/me/invoices", headers=tech.headers)).json()
    gone = next(i for i in mine if i["number"] == "801")
    r = await client.delete(f"{API}/me/invoices/{gone['id']}", headers=tech.headers)
    assert r.status_code == 204, r.text
    months = _by_month(await _months(client, tech))
    assert (months[_key(-8)]["state"], months[_key(-8)]["rejection"]) == ("empty", None)


@requires_db
async def test_same_rules_as_my_earnings(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Cada mês com valor bate com GET /me/earnings?month= (o mês do app)."""
    th = world.tech.headers
    # Mês atual: a receber, previsto e pago.
    await concluded(client, world, "A receber", 100)
    await still_open(client, world, "Aberta", 90)
    _, paid_now = await concluded(client, world, "Paga", 50)
    await _pay(client, world, paid_now)
    # -1: a receber e pago (conclusão), previsto (lançamento).
    old, _ = await concluded(client, world, "Antiga", 70)
    await _resolved_at(engine, old["id"], _mid(-1))
    old_paid, old_payout = await concluded(client, world, "Antiga paga", 30)
    await _pay(client, world, old_payout)
    await _resolved_at(engine, old_paid["id"], _mid(-1))
    _, open_payout = await still_open(client, world, "Aberta antiga", 20)
    await _launched_at(engine, open_payout, _mid(-1))
    # -2: OS cancelada e paga (conta) e OS cancelada com o valor pendente (não conta).
    cancelled_paid, cancelled_payout = await still_open(client, world, "Cancelada paga", 40)
    await _pay(client, world, cancelled_payout)
    await _cancel(client, world, cancelled_paid["id"])
    await _launched_at(engine, cancelled_payout, _mid(-2))
    cancelled, pending_payout = await still_open(client, world, "Cancelada", 25)
    await _cancel(client, world, cancelled["id"])
    await _launched_at(engine, pending_payout, _mid(-2))

    body = await _months(client, world.tech)
    seen = []
    for month in body["months"]:
        if month["count"] == 0:
            continue
        r = await client.get(f"{API}/me/earnings", params={"month": month["month"]}, headers=th)
        assert r.status_code == 200, r.text
        mine = r.json()
        sums = tuple(month[name]["amount"] for name in ("to_pay", "expected", "paid"))
        summary = mine["summary"]
        assert sums == (summary["to_pay"], summary["expected"], summary["paid"]), month["month"]
        assert month["count"] == mine["total_count"] == len(mine["items"]), month["month"]
        seen.append((month["month"], month["count"], month["total"]))
    assert seen == [(_key(0), 3, 240.0), (_key(-1), 3, 120.0), (_key(-2), 1, 40.0)]


@requires_db
@pytest.mark.usefixtures("media")
async def test_cancelled_and_other_technicians_invoice(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    # Pendente de OS cancelada: fora de tudo (ele não vai receber, salvo se a central pagar).
    cancelled, _ = await still_open(client, world, "Cancelada", 80)
    await _cancel(client, world, cancelled["id"])
    # Pago de OS cancelada (o deslocamento até a loja): conta como pago.
    trip, trip_payout = await still_open(client, world, "Cancelada e paga", 60)
    await _pay(client, world, trip_payout)
    await _cancel(client, world, trip["id"])
    # Valor ligado (direto no banco) à nota de outro técnico: para ele, a OS está sem nota.
    _, payout = await concluded(client, world, "Concluída", 100)
    theirs = await _invoice(client, world.tech_other, 0, "5555")
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE ticket_payouts SET invoice_id = :i WHERE id = :p"),
            {"i": theirs, "p": payout},
        )

    body = await _months(client, world.tech)
    current = body["months"][0]
    assert (current["state"], current["count"], current["total"]) == ("partial", 2, 160.0)
    assert current["paid"] == current["paid_without_invoice"] == _bucket(1, 60.0)
    assert current["to_pay"] == current["due_without_invoice"] == _bucket(1, 100.0)
    assert current["expected"] == _bucket(0, 0.0)
    assert (body["totals"]["paid"], body["totals"]["to_pay"], body["totals"]["expected"]) == (
        60.0,
        100.0,
        0.0,
    )
    # A nota do outro técnico não cobre nada dele.
    other = await _months(client, world.tech_other)
    assert other["months"][0]["state"] == "empty" and other["totals"]["to_pay"] == 0.0


@requires_db
async def test_operation_timezone(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    """O mês é o do fuso da operação: dia 1 à 01:00 UTC ainda é o mês anterior em Brasília."""
    turn, _ = await concluded(client, world, "Virada do mês", 100)
    first = _first(0)
    await _resolved_at(engine, turn["id"], datetime(first.year, first.month, 1, 1, tzinfo=UTC))
    # Conclusão corrigida para o futuro: conta no mês atual.
    ahead, _ = await concluded(client, world, "No futuro", 40)
    await _resolved_at(engine, ahead["id"], _mid(2))

    months = _by_month(await _months(client, world.tech))
    assert months[_key(-1)]["to_pay"] == _bucket(1, 100.0)
    assert months[_key(0)]["to_pay"] == _bucket(1, 40.0)

    # O mês atual também é o do fuso: 1º/12 às 02:30 UTC ainda é 30/11 em Brasília.
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        late = await payouts_svc.my_earnings_months(
            db, world.tech.user, 3, now=datetime(2026, 12, 1, 2, 30, tzinfo=UTC)
        )
    assert (late.since, late.until) == ("2026-09", "2026-11")
    assert [m.month for m in late.months] == ["2026-11", "2026-10", "2026-09"]


@requires_db
async def test_older_months_and_reimbursements(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    old, _ = await concluded(client, world, "De 14 meses atrás", 75)
    await _resolved_at(engine, old["id"], _mid(-14))
    await concluded(client, world, "Deste mês", 100)
    # Reembolsos de custos extras: aprovado (a receber), pago e pendente (não conta).
    visit = await create(client, world, title="Com custos", assignee_id=str(world.tech.user.id))
    url = f"{API}/tickets/{visit['id']}/expenses"
    toll = {"kind": "toll", "description": "Pedágio", "quantity": 1}
    ids = {}
    for name, value, status in (
        ("approved", "45", "approved"),
        ("paid", "30", "approved"),
        ("pending", "10", "pending"),
    ):
        r = await client.post(url, json={**toll, "unit_value": value, "status": status}, headers=an)
        assert r.status_code == 201, r.text
        ids[name] = r.json()["id"]
    r = await client.post(f"{API}/expenses/mark-paid", json={"ids": [ids["paid"]]}, headers=an)
    assert r.json() == {"updated": 1}, r.text

    body = await _months(client, world.tech)
    assert [m["count"] for m in body["months"]] == [1] + [0] * 11
    totals = body["totals"]
    assert (totals["to_pay"], totals["to_pay_older"]) == (175.0, 75.0)
    assert (totals["reimbursement_to_receive"], totals["reimbursement_paid"]) == (45.0, 30.0)
    # Com 24 meses, o valor antigo entra na janela.
    wide = await _months(client, world.tech, months=24)
    assert wide["totals"]["to_pay_older"] == 0.0 and wide["totals"]["to_pay"] == 175.0
    assert _by_month(wide)[_key(-14)]["to_pay"] == _bucket(1, 75.0)
    assert _by_month(wide)[_key(-14)]["state"] == "no_invoice"


@requires_db
async def test_access_and_params(client: AsyncClient, world: World) -> None:
    await concluded(client, world, "Do técnico", 100)
    for actor in (world.analyst, world.supervisor, world.admin, world.requester):
        r = await client.get(URL, headers=actor.headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == "Sem permissão para esta ação"
    assert (await client.get(URL)).status_code == 401
    for months in ("0", "25", "-1", "doze"):
        r = await client.get(URL, params={"months": months}, headers=world.tech.headers)
        assert r.status_code == 422, (months, r.text)

    wide = await _months(client, world.tech, months=24)
    assert len(wide["months"]) == 24
    assert (wide["since"], wide["until"]) == (_key(-23), _key(0))
    one = await _months(client, world.tech, months=1)
    assert [m["month"] for m in one["months"]] == [_key(0)] and one["since"] == one["until"]
    # Só os valores dele: o colega não vê os do primeiro.
    assert (await _months(client, world.tech))["totals"]["to_pay"] == 100.0
    theirs = await _months(client, world.tech_other)
    assert theirs["totals"]["to_pay"] == 0.0
    assert {m["state"] for m in theirs["months"]} == {"empty"}


@requires_db
@pytest.mark.usefixtures("media")
async def test_three_queries(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    """Valores agrupados por mês, notas da janela e reembolsos: três consultas, sem N+1 (nenhuma
    linha de OS volta)."""
    for n in range(3):
        await concluded(client, world, f"OS {n}", 100 + n)
    await still_open(client, world, "Aberta", 90)
    await _invoice(client, world.tech, 0, "321")
    statements: list[str] = []

    def record(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        statements.append(statement)

    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        async with maker() as db:
            result = await payouts_svc.my_earnings_months(db, world.tech.user)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)
    assert len(statements) == 3, statements
    assert (result.months[0].state, result.months[0].count) == ("no_invoice", 4)
    assert result.totals.to_pay == Decimal("303") and result.totals.expected == Decimal("90")
