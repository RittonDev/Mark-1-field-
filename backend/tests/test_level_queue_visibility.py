"""Elo do técnico na central com "Somente a própria fila" (services/technician_levels.py).

A ocorrência de OS de outra fila vem mascarada, como no calendário: sem id, sem código e com o
título "OS de outra fila" (`hidden`), sem a nota da reabertura e sem o motivo da desconsideração
(fica quem desconsiderou e quando). Desconsiderar ou voltar a contar uma delas dá 403
QUEUE_FORBIDDEN. Contagens, faixa e critérios continuam com todas. Quem vê todas as filas vê tudo.

Dados fictícios: Tecnico Alfa, Analista Fila Propria e Analista Outra Fila (@exemplo.com), com as
OS na loja do cliente de teste.
"""

import uuid
from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import TicketStatus, UserRole
from app.db.base import utcnow
from app.models import Ticket, User
from app.schemas.ticket import format_ticket_code
from app.services.schedule import HIDDEN_TITLE
from tests.conftest import World, requires_db
from tests.test_technician_levels import _done, _headers, _status_event, _tech

pytestmark = requires_db

API = settings.API_PREFIX
QUEUE_FORBIDDEN = {"detail": "Esta OS é de outra fila.", "code": "QUEUE_FORBIDDEN"}
HIDDEN = {"id": None, "code": None, "title": HIDDEN_TITLE, "hidden": True}
REOPEN_NOTE = "Nota interna da outra fila"
WAIVER_NOTE = "Agenda errada na outra fila"


def _analyst(name: str, **extra: Any) -> User:
    return User(
        name=name,
        email=f"{name.lower().replace(' ', '.')}@exemplo.com",
        password_hash="x",
        role=UserRole.ANALYST,
        is_active=True,
        **extra,
    )


def _owned(ticket: Ticket, owner: User | None) -> Ticket:
    ticket.owner_id = owner.id if owner else None
    return ticket


def _by_ref(body: dict) -> dict[str, dict]:
    return {o["ref_id"]: o for o in body["occurrences"]}


def _totals(body: dict) -> dict:
    """O que não depende da fila: números (sem a janela, que anda), faixa, critérios e totais."""
    metrics = {k: v for k, v in body["metrics"].items() if not k.startswith("window_")}
    keep = ("tier", "since", "at_risk", "computed_tier", "criteria", "next", "waived")
    return {"metrics": metrics, "total": body["occurrences_total"], **{k: body[k] for k in keep}}


async def test_level_detail_follows_queue(
    engine: AsyncEngine, client: AsyncClient, world: World
) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    sched = (now - timedelta(days=8)).replace(microsecond=0)
    async with maker() as db:
        own = _analyst(
            "Analista Fila Propria",
            access_overrides={"queue_scope": "own", "queue_unowned": False},
        )
        other = _analyst("Analista Outra Fila")
        alfa = _tech("Alfa")
        db.add_all([own, other, alfa])
        await db.flush()

        def late(owner: User | None, days_ago: int, minutes: int, title: str) -> Ticket:
            ticket = _done(
                world,
                alfa,
                now=now,
                days_ago=days_ago,
                scheduled=sched,
                arrived=sched + timedelta(minutes=minutes),
                title=title,
            )
            return _owned(ticket, owner)

        mine = late(own, 6, 50, "OS da fila propria")
        theirs = late(other, 4, 120, "OS da outra fila (atraso)")
        unowned = late(None, 3, 90, "OS sem analista (atraso)")
        reopened = _owned(
            _done(
                world,
                alfa,
                now=now,
                days_ago=5,
                status=TicketStatus.REOPENED,
                title="OS da outra fila (reaberta)",
            ),
            other,
        )
        reopened.resolved_at = None
        db.add_all([mine, theirs, unowned, reopened])
        await db.flush()
        reopen = _status_event(
            reopened,
            other,
            to="reopened",
            frm="resolved",
            at=now - timedelta(days=2),
            note=REOPEN_NOTE,
            data={"technician_id": str(alfa.id)},
        )
        db.add_all(
            [
                _status_event(
                    reopened, alfa, to="resolved", frm="in_progress", at=now - timedelta(days=5)
                ),
                reopen,
            ]
        )
        await db.commit()
    url = f"{API}/technicians/{alfa.id}/level"
    waivers = f"{url}/waivers"
    h_own, h_all = _headers(own), _headers(other)

    # Quem vê todas as filas desconsidera o atraso da fila dela e vê tudo.
    r = await client.post(
        waivers, json={"kind": "late", "ref_id": str(theirs.id), "note": WAIVER_NOTE}, headers=h_all
    )
    assert r.status_code == 201, r.text
    full = r.json()
    assert full["occurrences_total"] == 4 and full["waived"] == 1
    for occ in full["occurrences"]:
        assert occ["ticket"]["hidden"] is False and occ["ticket"]["id"], occ
    seen = _by_ref(full)
    assert seen[str(reopen.id)]["detail"].endswith(f" · Motivo: {REOPEN_NOTE}")
    assert seen[str(theirs.id)]["waiver"]["note"] == WAIVER_NOTE
    assert seen[str(theirs.id)]["ticket"] == {
        "id": str(theirs.id),
        "code": format_ticket_code(theirs.number),
        "title": "OS da outra fila (atraso)",
        "hidden": False,
    }

    # Só a própria fila (sem as OS sem analista): as de outra fila vêm mascaradas.
    r = await client.get(url, headers=h_own)
    assert r.status_code == 200, r.text
    body = r.json()
    assert _totals(body) == _totals(full)
    shown = _by_ref(body)
    assert shown[str(mine.id)]["ticket"] == {
        "id": str(mine.id),
        "code": format_ticket_code(mine.number),
        "title": "OS da fila propria",
        "hidden": False,
    }
    for ref in (theirs.id, unowned.id, reopen.id):
        assert shown[str(ref)]["ticket"] == HIDDEN, ref
    rework = shown[str(reopen.id)]
    assert rework["kind"] == "rework" and rework["detail"].startswith("Reaberta ")
    assert " · Motivo" not in rework["detail"]
    assert rework["detail"] == seen[str(reopen.id)]["detail"].split(" · ")[0]
    assert shown[str(theirs.id)]["detail"] == seen[str(theirs.id)]["detail"]  # o atraso, inteiro
    # A desconsideração fica marcada (quem e quando), sem o motivo.
    mark = shown[str(theirs.id)]["waiver"]
    assert mark["note"] is None and mark["created_by"]["name"] == "Analista Outra Fila"
    assert mark["id"] == seen[str(theirs.id)]["waiver"]["id"]
    for secret in (
        REOPEN_NOTE,
        WAIVER_NOTE,
        "OS da outra fila (atraso)",
        "OS da outra fila (reaberta)",
        "OS sem analista (atraso)",
        format_ticket_code(theirs.number),
        format_ticket_code(unowned.number),
        format_ticket_code(reopened.number),
        str(reopened.id),
    ):
        assert secret not in r.text, secret

    # Desconsiderar ou voltar a contar ocorrência de OS de outra fila: 403, e nada muda.
    for kind, ref in (("rework", reopen.id), ("late", unowned.id)):
        body_ = {"kind": kind, "ref_id": str(ref), "note": "Desconsiderada sem ver a OS"}
        r = await client.post(waivers, json=body_, headers=h_own)
        assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN), r.text
    r = await client.delete(f"{waivers}/{mark['id']}", headers=h_own)
    assert (r.status_code, r.json()) == (403, QUEUE_FORBIDDEN), r.text
    # O que não existe continua 422 (antes da fila).
    missing = {"kind": "late", "ref_id": str(uuid.uuid4()), "note": "Nada"}
    r = await client.post(waivers, json=missing, headers=h_own)
    assert r.status_code == 422, r.text
    after = (await client.get(url, headers=h_all)).json()
    assert after["waived"] == 1 and _by_ref(after)[str(theirs.id)]["waiver"]["note"] == WAIVER_NOTE

    # Na própria fila, desconsidera e volta a contar normalmente.
    body_ = {"kind": "late", "ref_id": str(mine.id), "note": "Agenda trocada pela central"}
    r = await client.post(waivers, json=body_, headers=h_own)
    assert r.status_code == 201, r.text
    mine_occ = _by_ref(r.json())[str(mine.id)]
    assert mine_occ["waiver"]["note"] == "Agenda trocada pela central"
    assert _by_ref(r.json())[str(reopen.id)]["ticket"] == HIDDEN  # a resposta também mascara
    r = await client.delete(f"{waivers}/{mine_occ['waiver']['id']}", headers=h_own)
    assert r.status_code == 200, r.text
    assert r.json()["waived"] == 1

    # Com "ver OS sem analista", a OS sem analista entra na fila dele.
    async with maker() as db:
        await db.execute(
            update(User)
            .where(User.id == own.id)
            .values(access_overrides={"queue_scope": "own", "queue_unowned": True})
        )
        await db.commit()
    shown = _by_ref((await client.get(url, headers=h_own)).json())
    assert shown[str(unowned.id)]["ticket"]["id"] == str(unowned.id)
    assert shown[str(theirs.id)]["ticket"] == HIDDEN
    body_ = {"kind": "late", "ref_id": str(unowned.id), "note": "Cliente pediu outro horário"}
    r = await client.post(waivers, json=body_, headers=h_own)
    assert r.status_code == 201, r.text


async def test_technician_sees_own_occurrences_whole(
    engine: AsyncEngine, client: AsyncClient, world: World
) -> None:
    """No app não há fila: as OS das ocorrências são do próprio técnico, nada vem mascarado."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    sched = (now - timedelta(days=4)).replace(microsecond=0)
    async with maker() as db:
        other = _analyst("Analista Outra Fila")
        alfa = _tech("Alfa")
        db.add_all([other, alfa])
        await db.flush()
        ticket = _owned(
            _done(
                world,
                alfa,
                now=now,
                days_ago=3,
                scheduled=sched,
                arrived=sched + timedelta(hours=2),
                title="OS da outra fila (atraso)",
            ),
            other,
        )
        db.add(ticket)
        await db.commit()
    r = await client.get(f"{API}/me/level", headers=_headers(alfa))
    assert r.status_code == 200, r.text
    [occ] = r.json()["occurrences"]
    assert occ["ticket"] == {
        "id": str(ticket.id),
        "code": format_ticket_code(ticket.number),
        "title": "OS da outra fila (atraso)",
    }
