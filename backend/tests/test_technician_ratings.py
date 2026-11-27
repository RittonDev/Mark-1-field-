"""Avaliação do cliente registrada pela central na OS concluída (contrato da Entrega 2, §6.5): uma
por OS e técnico (responsável ou auxiliar; quem saiu e tem avaliação corrige ou exclui), nota de 1
a 5, comentário e quem avaliou; o rastro nos históricos da OS (só a gestão) e do cadastro; a média
na ficha. O técnico nunca vê.

Só dados fictícios (Tecnico, Redes, "Gerente da Loja Exemplo").
"""

import asyncio
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import UserRole
from app.models import TechnicianRating, User
from app.services import realtime
from app.services import technician_ratings as ratings
from tests.conftest import Actor, World, requires_db
from tests.test_access import restrict_analyst, set_access
from tests.test_api import create, transition

API = settings.API_PREFIX
NOT_CONCLUDED = {"detail": "Só a OS concluída recebe avaliação", "code": "RATING_NOT_CONCLUDED"}
NOT_IN_TICKET = {"detail": "Este técnico não está nesta OS", "code": "RATING_NOT_IN_TICKET"}
NOT_FOUND = {"detail": "Avaliação não encontrada", "code": "RATING_NOT_FOUND"}


def url(ticket: dict, technician: Actor | uuid.UUID | str | None = None) -> str:
    base = f"{API}/tickets/{ticket['id']}/ratings"
    if technician is None:
        return base
    tech_id = technician.user.id if isinstance(technician, Actor) else technician
    return f"{base}/{tech_id}"


async def resolved(
    client: AsyncClient, world: World, *, helper: Actor | None = None, title: str = "Troca de PDV"
) -> dict:
    """OS resolvida pelo técnico (com um auxiliar, se pedido)."""
    extra = {"helper_ids": [str(helper.user.id)]} if helper else {}
    t = await create(client, world, title=title, assignee_id=str(world.tech.user.id), **extra)
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=world.tech.headers)).json()
    t = await transition(client, world.tech.headers, t, "in_progress")
    return await transition(client, world.tech.headers, t, "resolved", resolution_notes="ok")


async def history(client: AsyncClient, world: World, user_id: object) -> list[tuple[str, str]]:
    r = await client.get(f"{API}/technicians/{user_id}/changes", headers=world.admin.headers)
    assert r.status_code == 200, r.text
    return [
        (row["via"], item["to"])
        for row in r.json()
        for item in row["changes"]
        if item["field"] == "ratings"
    ]


async def rating_events(client: AsyncClient, world: World, ticket: dict) -> list[dict]:
    r = await client.get(f"{API}/tickets/{ticket['id']}/events", headers=world.admin.headers)
    assert r.status_code == 200, r.text
    return [e for e in r.json() if e["event_type"] in ("rating_set", "rating_removed")]


def capture(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    published: list[dict] = []

    async def publish(event: dict) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", publish)
    return published


def test_average_rounds_half_up() -> None:
    assert ratings.average([4, 5, 4, 4]) == 4.3
    assert ratings.average([4]) == 4.0
    assert ratings.average([]) is None
    assert ratings.average([4, 5]) == 4.5
    assert ratings.average([5, 4, 4]) == 4.3
    assert ratings.average([1, 2, 2, 2, 2, 2, 2, 4]) == 2.1  # 2,125
    assert ratings.score_text(4) == "4 de 5"


# =========================================================================== registrar


@requires_db
async def test_central_rates_a_concluded_os(
    client: AsyncClient, world: World, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    published = capture(monkeypatch)
    an = world.analyst.headers
    t = await resolved(client, world)
    code = t["code"]
    r = await client.get(url(t), headers=an)
    assert r.status_code == 200, r.text
    tech_ref = {"id": str(world.tech.user.id), "name": "Tecnico"}
    assert r.json() == {
        "concluded": True,
        "technicians": [{"technician": tech_ref, "role": "assignee", "rating": None}],
    }

    published.clear()
    body = {"score": 4, "comment": "  Atendimento   rápido\n\n ", "rater_name": " Gerente da Loja Exemplo "}
    r = await client.put(url(t, world.tech), json=body, headers=an)
    assert r.status_code == 200, r.text
    saved = r.json()
    assert {k: saved[k] for k in saved if k not in ("id", "created_at", "updated_at", "ticket")} == {
        "technician": tech_ref,
        "score": 4,
        "comment": "Atendimento rápido",
        "rater_name": "Gerente da Loja Exemplo",
        "source": "central",
        "created_by": {"id": str(world.analyst.user.id), "name": "Analista"},
        "updated_by": None,
    }
    assert {k: v for k, v in saved["ticket"].items() if k != "resolved_at"} == {
        "id": t["id"],
        "code": code,
        "title": "Troca de PDV",
        "location": "Matriz",
    }
    assert saved["ticket"]["resolved_at"] is not None

    listed = (await client.get(url(t), headers=an)).json()
    assert listed["technicians"][0]["rating"] == saved
    # A ficha: média, contagem e a lista.
    r = await client.get(f"{API}/technicians/{world.tech.user.id}/ratings", headers=an)
    assert r.status_code == 200, r.text
    assert r.json() == {"average": 4.0, "count": 1, "items": [saved]}

    # Histórico da OS (só a gestão) e do cadastro (via central).
    [event] = await rating_events(client, world, t)
    assert (event["event_type"], event["from_value"], event["to_value"], event["note"]) == (
        "rating_set",
        None,
        "4 de 5",
        "Atendimento rápido",
    )
    assert event["data"] == {"technician_id": str(world.tech.user.id), "technician_name": "Tecnico"}
    assert await history(client, world, world.tech.user.id) == [("central", f"registrou {code}: 4 de 5")]

    # Tempo real: a OS para a gestão (nada ao técnico, sem push) e o aviso do cadastro.
    [ticket_event] = [e for e in published if e.get("ticket_id") == t["id"]]
    assert (ticket_event["type"], ticket_event["data"]) == ("ticket.updated", {"fields": ["ratings"]})
    assert ticket_event["audience"]["managers_only"] is True
    tech_id = str(world.tech.user.id)
    assert not realtime.should_deliver(
        user_id=tech_id, role=UserRole.TECHNICIAN, team_id=None, event=ticket_event
    )
    assert realtime.should_deliver(
        user_id=str(world.analyst.user.id), role=UserRole.ANALYST, team_id=None, event=ticket_event
    )
    changed = [e for e in published if e["type"] == "profile.changed"]
    assert [e["data"]["fields"] for e in changed] == [["ratings"]]
    assert not [e for e in published if e["type"] == "me.profile_changed"]

    # O técnico não vê nada disso.
    th = world.tech.headers
    assert (await client.get(url(t), headers=th)).status_code == 403
    assert (await client.get(f"{API}/tickets/{t['id']}/events", headers=th)).status_code == 403
    r = await client.get(f"{API}/technicians/{tech_id}/ratings", headers=th)
    assert r.status_code == 403
    me = (await client.get(f"{API}/me/profile", headers=th)).json()
    assert not {"ratings", "rating_average", "rating_count"} & set(me)


@requires_db
async def test_correction_records_who_corrected(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an, sup = world.analyst.headers, world.supervisor.headers
    t = await resolved(client, world)
    code = t["code"]
    body = {"score": 4, "comment": "Bom", "rater_name": "Gerente da Loja Exemplo"}
    first = (await client.put(url(t, world.tech), json=body, headers=an)).json()

    # A mesma avaliação de novo: nada muda (sem evento nem histórico).
    r = await client.put(url(t, world.tech), json=body, headers=sup)
    assert (r.status_code, r.json()) == (200, first)
    assert len(await rating_events(client, world, t)) == 1
    assert len(await history(client, world, world.tech.user.id)) == 1

    r = await client.put(url(t, world.tech), json={**body, "score": 5}, headers=sup)
    assert r.status_code == 200, r.text
    corrected = r.json()
    assert (corrected["id"], corrected["score"]) == (first["id"], 5)
    assert corrected["created_by"]["name"] == "Analista"
    assert corrected["updated_by"] == {"id": str(world.supervisor.user.id), "name": "Super"}
    # Só o comentário e quem avaliou (vazio vira null).
    r = await client.put(
        url(t, world.tech), json={"score": 5, "comment": "Muito bom", "rater_name": "  "}, headers=an
    )
    assert (r.json()["comment"], r.json()["rater_name"], r.json()["updated_by"]["name"]) == (
        "Muito bom",
        None,
        "Analista",
    )
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        [row] = list(await db.scalars(select(TechnicianRating)))
        assert (row.score, row.comment, row.rater_name, row.source) == (5, "Muito bom", None, "central")
        assert (row.created_by_id, row.updated_by_id) == (
            world.analyst.user.id,
            world.analyst.user.id,
        )
    events = await rating_events(client, world, t)
    assert [(e["from_value"], e["to_value"], e["note"]) for e in events] == [
        ("5 de 5", "5 de 5", "Muito bom"),
        ("4 de 5", "5 de 5", "Bom"),
        (None, "4 de 5", "Bom"),
    ]
    assert await history(client, world, world.tech.user.id) == [
        ("central", f"corrigiu {code}"),
        ("central", f"corrigiu {code}: 4 → 5 de 5"),
        ("central", f"registrou {code}: 4 de 5"),
    ]


@requires_db
async def test_rating_rules(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    an = world.analyst.headers
    # A OS aberta não recebe avaliação.
    open_ticket = await create(client, world, assignee_id=str(world.tech.user.id))
    r = await client.put(url(open_ticket, world.tech), json={"score": 4}, headers=an)
    assert (r.status_code, r.json()) == (409, NOT_CONCLUDED)
    r = await client.delete(url(open_ticket, world.tech), headers=an)
    assert (r.status_code, r.json()) == (409, NOT_CONCLUDED)
    assert (await client.get(url(open_ticket), headers=an)).json()["concluded"] is False

    t = await resolved(client, world, helper=world.tech_other)
    # Fora da OS: outro técnico, quem não é técnico, id que não existe.
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        outsider = User(
            name="Tecnico Alfa",
            email="tecnico.alfa@exemplo.com",
            password_hash="x",
            role=UserRole.TECHNICIAN,
            is_active=True,
        )
        db.add(outsider)
        await db.commit()
    for who in (outsider.id, world.analyst.user.id, world.supervisor.user.id, uuid.uuid4()):
        r = await client.put(url(t, who), json={"score": 3}, headers=an)
        assert (r.status_code, r.json()) == (422, NOT_IN_TICKET), who
    # Nota inteira de 1 a 5; textos no tamanho.
    for score in (0, 6, 4.5, "4", True, None):
        r = await client.put(url(t, world.tech), json={"score": score}, headers=an)
        assert r.status_code == 422, score
        assert r.json()["detail"][0]["msg"] == "Escolha uma nota de 1 a 5", r.text
    r = await client.put(url(t, world.tech), json={}, headers=an)
    assert r.json()["detail"][0]["msg"] == "Escolha uma nota de 1 a 5"
    r = await client.put(url(t, world.tech), json={"score": 4, "comment": "x" * 1001}, headers=an)
    assert (r.json()["detail"][0]["msg"], r.json()["detail"][0]["label"]) == (
        "No máximo 1000 caracteres",
        "Comentário",
    )
    r = await client.put(url(t, world.tech), json={"score": 4, "rater_name": "x" * 121}, headers=an)
    assert (r.json()["detail"][0]["msg"], r.json()["detail"][0]["label"]) == (
        "No máximo 120 caracteres",
        "Quem avaliou",
    )
    r = await client.put(url(t, world.tech), json={"score": 4, "source": "client"}, headers=an)
    assert r.status_code == 422
    body = {"score": 3, "comment": "x" * 1000, "rater_name": "y" * 120}
    assert (await client.put(url(t, world.tech), json=body, headers=an)).status_code == 200

    # O auxiliar também é avaliado.
    r = await client.put(url(t, world.tech_other), json={"score": 5}, headers=an)
    assert r.status_code == 200, r.text
    roles = [(x["technician"]["name"], x["role"], x["rating"]["score"]) for x in (await client.get(url(t), headers=an)).json()["technicians"]]
    assert roles == [("Tecnico", "assignee", 3), ("Redes", "helper", 5)]

    # Quem saiu da OS e tem avaliação corrige e exclui; sem avaliação, não volta a ser avaliado.
    current = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    r = await client.patch(
        f"{API}/tickets/{t['id']}",
        json={"helper_ids": [], "expected_version": current["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    roles = [(x["technician"]["name"], x["role"]) for x in (await client.get(url(t), headers=an)).json()["technicians"]]
    assert roles == [("Tecnico", "assignee"), ("Redes", "former")]
    r = await client.put(url(t, world.tech_other), json={"score": 4}, headers=an)
    assert (r.status_code, r.json()["score"]) == (200, 4)
    assert (await client.delete(url(t, world.tech_other), headers=an)).status_code == 204
    r = await client.put(url(t, world.tech_other), json={"score": 4}, headers=an)
    assert (r.status_code, r.json()) == (422, NOT_IN_TICKET)
    roles = [x["role"] for x in (await client.get(url(t), headers=an)).json()["technicians"]]
    assert roles == ["assignee"]

    # Dois pedidos juntos: um registro só.
    other = await resolved(client, world, title="Outra OS")
    results = await asyncio.gather(
        client.put(url(other, world.tech), json={"score": 2}, headers=an),
        client.put(url(other, world.tech), json={"score": 5}, headers=world.supervisor.headers),
    )
    assert [r.status_code for r in results] == [200, 200], [r.text for r in results]
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        rows = list(
            await db.scalars(
                select(TechnicianRating).where(TechnicianRating.ticket_id == uuid.UUID(other["id"]))
            )
        )
        assert len(rows) == 1

    # A OS reaberta mantém a avaliação; mexer nela pede a OS concluída de novo.
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    await transition(client, an, t, "reopened", note="Cliente pediu retorno")
    reopened = (await client.get(url(t), headers=an)).json()
    assert reopened["concluded"] is False
    assert reopened["technicians"][0]["rating"]["score"] == 3
    r = await client.put(url(t, world.tech), json={"score": 1}, headers=an)
    assert (r.status_code, r.json()) == (409, NOT_CONCLUDED)


@requires_db
async def test_remove_rating(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    t = await resolved(client, world)
    assert (await client.put(url(t, world.tech), json={"score": 2}, headers=an)).status_code == 200
    r = await client.delete(url(t, world.tech), headers=an)
    assert r.status_code == 204, r.text
    r = await client.delete(url(t, world.tech), headers=an)
    assert (r.status_code, r.json()) == (404, NOT_FOUND)
    assert (await client.get(url(t), headers=an)).json()["technicians"][0]["rating"] is None
    events = await rating_events(client, world, t)
    assert [(e["event_type"], e["from_value"], e["to_value"]) for e in events] == [
        ("rating_removed", "2 de 5", None),
        ("rating_set", None, "2 de 5"),
    ]
    assert (await history(client, world, world.tech.user.id))[0] == (
        "central",
        f"excluiu a avaliação de {t['code']}",
    )
    r = await client.get(f"{API}/technicians/{world.tech.user.id}/ratings", headers=an)
    assert r.json() == {"average": None, "count": 0, "items": []}


@requires_db
async def test_rating_follows_the_queue_and_the_screens(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    t = await resolved(client, world)
    sup = world.supervisor.headers
    assert (await client.put(url(t, world.tech), json={"score": 5}, headers=sup)).status_code == 200
    # Gestão de outra fila: 403 QUEUE_FORBIDDEN (a OS não é dele).
    await set_access(client, world.admin.headers, world.analyst.user.id, scope="own", unowned=False)
    an = world.analyst.headers
    for method, target in (("GET", url(t)), ("PUT", url(t, world.tech)), ("DELETE", url(t, world.tech))):
        kwargs = {"json": {"score": 3}} if method == "PUT" else {}
        r = await client.request(method, target, headers=an, **kwargs)
        assert (r.status_code, r.json()["code"]) == (403, "QUEUE_FORBIDDEN"), (method, r.text)
    # O técnico e o cliente: 403.
    for actor in (world.tech, world.requester):
        assert (await client.get(url(t), headers=actor.headers)).status_code == 403
        r = await client.put(url(t, world.tech), json={"score": 1}, headers=actor.headers)
        assert r.status_code == 403
    # A ficha pede Técnicos em Visualizar (a fila não conta: a avaliação é do técnico).
    ficha = f"{API}/technicians/{world.tech.user.id}/ratings"
    assert (await client.get(ficha, headers=an)).json()["count"] == 1
    await restrict_analyst(client, world, **{"base.technicians": "none"})
    r = await client.get(ficha, headers=an)
    assert (r.status_code, r.json()["code"]) == (403, "MODULE_FORBIDDEN")
    r = await client.get(f"{API}/technicians/{world.admin.user.id}/ratings", headers=sup)
    assert r.status_code == 404


@requires_db
async def test_technician_page_has_the_average_and_pages(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    tickets = [await resolved(client, world, title=f"Visita {n}") for n in range(4)]
    for ticket, score in zip(tickets, (4, 5, 4, 4), strict=True):
        r = await client.put(url(ticket, world.tech), json={"score": score}, headers=an)
        assert r.status_code == 200, r.text
    ficha = f"{API}/technicians/{world.tech.user.id}/ratings"
    page = (await client.get(ficha, params={"limit": 3}, headers=an)).json()
    assert (page["average"], page["count"]) == (4.3, 4)
    # A mais nova primeiro.
    assert [i["ticket"]["title"] for i in page["items"]] == ["Visita 3", "Visita 2", "Visita 1"]
    rest = (await client.get(ficha, params={"limit": 3, "offset": 3}, headers=an)).json()
    assert [i["ticket"]["title"] for i in rest["items"]] == ["Visita 0"]
    assert (rest["average"], rest["count"]) == (4.3, 4)
    for params in ({"limit": 0}, {"limit": 101}, {"offset": -1}):
        assert (await client.get(ficha, params=params, headers=an)).status_code == 422
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        summary = await ratings.summaries(
            db, [world.tech.user.id, world.tech_other.user.id, world.tech.user.id]
        )
        assert summary == {world.tech.user.id: (4.3, 4), world.tech_other.user.id: (None, 0)}
        assert await ratings.summaries(db, []) == {}
