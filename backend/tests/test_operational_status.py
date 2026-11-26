"""Situação do técnico na operação (Ativo, Inativo, Bloqueado), separada do acesso ao app, e quem
recebe OS: sugestões, ofertas, atribuição e auxiliares, Colaborador e favoritos automáticos. E a
indisponibilidade informada pelo técnico (fora das sugestões e das ofertas; a atribuição manual
só é avisada pela web).

Dados fictícios (Tecnico Alfa, Cidade Exemplo).
"""

import asyncio
import uuid
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from app.core.enums import AccountTokenPurpose, OperationalStatus, UserRole
from app.db.base import utcnow
from app.models import AccountToken, User
from app.services import technician_status, unavailability
from app.services.errors import WorkflowError
from app.services.technician_favorites import Visit, rank_city
from tests.conftest import World, requires_db
from tests.test_api import create
from tests.test_offers import central_offers, history, make_technician, open_offer, send

API = settings.API_PREFIX


def status_url(user_id: object) -> str:
    return f"{API}/technicians/{user_id}/operational-status"


async def set_status(
    client: AsyncClient, headers: dict, user_id: object, status: str, reason: str, **extra: object
) -> dict:
    r = await client.post(
        status_url(user_id), json={"status": status, "reason": reason, **extra}, headers=headers
    )
    assert r.status_code == 200, r.text
    return r.json()


async def set_periods(engine: AsyncEngine, user_id: object, periods: list[tuple[date, date]]) -> None:
    """Indisponibilidade direto na coluna (o técnico grava pelo app, em PATCH /me/profile)."""
    stored = [
        {"id": str(uuid.uuid4()), "start": start.isoformat(), "end": end.isoformat()}
        for start, end in periods
    ]
    async with engine.begin() as conn:
        await conn.execute(update(User).where(User.id == user_id).values(unavailability=stored))


async def suggested(client: AsyncClient, world: World, **params: object) -> dict[str, dict]:
    r = await client.get(
        f"{API}/technicians/suggest",
        params={"city": "Cidade Exemplo", "state": "SP", "limit": 10, **params},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    return {row["id"]: row for row in r.json()}


# ------------------------------------------------------------------ sem banco


def _user(**values: object) -> SimpleNamespace:
    base = {
        "name": "Tecnico Alfa",
        "role": UserRole.TECHNICIAN,
        "is_active": True,
        "operational_status": OperationalStatus.ACTIVE,
        "operational_reason": None,
        "unavailability": [],
    }
    return SimpleNamespace(**{**base, **values})


def test_receive_block_and_ensure_can_receive() -> None:
    ok = _user()
    assert technician_status.receive_block(ok) is None
    technician_status.ensure_can_receive(ok)  # type: ignore[arg-type]
    assert technician_status.receive_block(_user(is_active=False)) == "Sem acesso ao app"
    inactive = _user(operational_status="inactive", operational_reason=" Férias  coletivas ")
    assert technician_status.receive_block(inactive) == "Inativo: Férias coletivas"
    with pytest.raises(WorkflowError) as caught:
        technician_status.ensure_can_receive(inactive)  # type: ignore[arg-type]
    assert str(caught.value) == "Tecnico Alfa está inativo e não recebe OS: Férias coletivas"
    blocked = _user(operational_status="blocked", operational_reason=None)
    assert technician_status.receive_block(blocked) == "Bloqueado"
    with pytest.raises(WorkflowError, match="^Tecnico Alfa está bloqueado e não recebe OS$"):
        technician_status.ensure_can_receive(blocked)  # type: ignore[arg-type]
    # Quem não é técnico (analista responsável pela OS) não tem situação na operação.
    technician_status.ensure_can_receive(_user(role=UserRole.ANALYST, operational_status="blocked"))  # type: ignore[arg-type]
    assert technician_status.LABELS == {
        "active": "Ativo",
        "inactive": "Inativo",
        "blocked": "Bloqueado",
    }


def test_unavailable_between_counts_both_ends() -> None:
    stored = [
        {"id": "b", "start": "2026-12-10", "end": "2026-12-20"},
        {"id": "a", "start": "2026-11-20", "end": "2026-11-30"},
    ]
    between = technician_status.unavailable_between
    assert between(stored, date(2026, 11, 30), date(2026, 11, 30))["id"] == "a"
    assert between(stored, date(2026, 12, 1), date(2026, 12, 9)) is None
    assert between(stored, date(2026, 12, 5), date(2026, 12, 10))["id"] == "b"
    # O primeiro pelo início, quando a visita toca os dois.
    assert between(stored, date(2026, 11, 29), date(2026, 12, 11))["id"] == "a"
    assert between(stored, date(2026, 12, 21), date(2027, 1, 5)) is None


def test_automatic_favorites_only_for_active() -> None:
    """Inativo e Bloqueado ficam no ranking da cidade, mas fora do automático (o próximo sobe); o
    sem acesso ao app continua no automático (a central libera por ali)."""
    now = datetime(2026, 11, 25, 12, tzinfo=UTC)

    def v(name: str, visits: int, status: str = "active", active: bool = True) -> Visit:
        return Visit(uuid.uuid4(), name, active, visits, now, OperationalStatus(status))

    ana, bia, caio = v("Ana", 6, "inactive"), v("Bia", 5, "blocked"), v("Caio", 4)
    davi, eva, fabi = v("Davi", 3, active=False), v("Eva", 2), v("Fabi", 2)
    ranked, auto = rank_city([fabi, eva, davi, caio, bia, ana])
    assert [r.name for r in ranked] == ["Ana", "Bia", "Caio", "Davi", "Eva", "Fabi"]
    assert auto == [caio.user_id, davi.user_id, eva.user_id]


# ------------------------------------------------------------------ com banco


@requires_db
async def test_change_needs_reason_and_goes_to_history(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    tech_id = str(world.tech.user.id)
    url = status_url(tech_id)

    # Motivo de 3 a 500 (limpo), situação conhecida e nada além do formulário.
    cases = [
        ({"status": "inactive", "reason": "  x  "}, "Motivo", "Informe o motivo"),
        ({"status": "inactive", "reason": "x" * 501}, "Motivo", "No máximo 500 caracteres"),
        ({"status": "pausado", "reason": "Férias"}, "Situação", "Escolha a situação"),
        ({"status": "inactive"}, "Motivo", "Campo obrigatório"),
    ]
    for body, label, message in cases:
        r = await client.post(url, json=body, headers=an)
        assert r.status_code == 422, r.text
        [issue] = r.json()["detail"]
        assert (issue["label"], issue["msg"]) == (label, message), body
    extra = {"status": "inactive", "reason": "Férias", "revoke_access": True}
    assert (await client.post(url, json=extra, headers=an)).status_code == 422
    # Técnicos em Editar: o técnico não muda a própria situação.
    body = {"status": "inactive", "reason": "Férias"}
    assert (await client.post(url, json=body, headers=world.tech.headers)).status_code == 403
    # Quem não é técnico: 404.
    r = await client.post(status_url(world.analyst.user.id), json=body, headers=an)
    assert r.status_code == 404

    # A mesma situação: 409.
    r = await client.post(url, json={"status": "active", "reason": "Tudo certo"}, headers=an)
    assert r.status_code == 409
    assert r.json() == {"detail": "O técnico já está ativo", "code": "OPERATIONAL_STATUS_UNCHANGED"}

    out = await set_status(client, an, tech_id, "inactive", "  Férias   até dezembro ")
    assert (out["operational_status"], out["operational_reason"]) == (
        "inactive",
        "Férias até dezembro",
    )
    assert out["operational_changed_by"] == {"id": str(world.analyst.user.id), "name": "Analista"}
    assert out["operational_changed_at"] is not None
    assert out["is_active"] is True  # a situação não mexe no acesso ao app
    r = await client.post(url, json={"status": "inactive", "reason": "De novo"}, headers=an)
    assert r.status_code == 409 and r.json()["detail"] == "O técnico já está inativo"

    # Na lista também (o selo da central), com quem mudou.
    rows = {t["id"]: t for t in (await client.get(f"{API}/technicians", headers=an)).json()}
    assert rows[tech_id]["operational_status"] == "inactive"
    assert rows[tech_id]["operational_reason"] == "Férias até dezembro"
    assert rows[tech_id]["operational_changed_by"]["name"] == "Analista"
    assert rows[str(world.tech_other.user.id)]["operational_status"] == "active"

    out = await set_status(client, world.supervisor.headers, tech_id, "blocked", "Falta grave")
    assert (out["operational_status"], out["operational_changed_by"]["name"]) == (
        "blocked",
        "Super",
    )
    out = await set_status(client, an, tech_id, "active", "Situação resolvida")
    assert out["operational_status"] == "active"

    # Histórico via central, com o motivo em `note`; `field` traz só as linhas da situação.
    r = await client.get(
        f"{API}/technicians/{tech_id}/changes",
        params={"field": "operational_status"},
        headers=an,
    )
    assert r.status_code == 200, r.text
    lines = [
        (row["via"], row["actor"]["name"], row["note"], row["changes"]) for row in r.json()
    ]
    assert lines == [
        (
            "central",
            "Analista",
            "Situação resolvida",
            [{"field": "operational_status", "from": "Bloqueado", "to": "Ativo"}],
        ),
        (
            "central",
            "Super",
            "Falta grave",
            [{"field": "operational_status", "from": "Inativo", "to": "Bloqueado"}],
        ),
        (
            "central",
            "Analista",
            "Férias até dezembro",
            [{"field": "operational_status", "from": "Ativo", "to": "Inativo"}],
        ),
    ]
    bad = await client.get(
        f"{API}/technicians/{tech_id}/changes", params={"field": "x; drop"}, headers=an
    )
    assert bad.status_code == 422


@requires_db
async def test_not_active_leaves_suggestions_offers_and_new_assignments(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Inativo ou Bloqueado sai das sugestões e das ofertas (as em aberto fecham) e não entra numa
    OS (responsável ou auxiliar). A OS que ele já tem fica com ele: salvar a OS com o mesmo
    responsável não confere de novo."""
    an, sup = world.analyst.headers, world.supervisor.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    for user_id in (tech, other):
        r = await client.patch(
            f"{API}/technicians/{user_id}",
            json={"home_city": "Cidade Exemplo", "home_state": "SP"},
            headers=an,
        )
        assert r.status_code == 200, r.text
    assert set(await suggested(client, world)) == {tech, other}

    # A OS que ele já tem e uma oferta em aberto para ele.
    kept = await create(client, world, assignee_id=tech)
    open_os = await create(client, world)
    [offer] = await send(client, sup, open_os["id"], [world.tech])

    await set_status(client, an, tech, "inactive", "Férias coletivas")
    assert set(await suggested(client, world)) == {other}
    states = {o["technician"]["name"]: o["state"] for o in await central_offers(client, sup, open_os["id"])}
    assert states == {"Tecnico": "cancelled"}
    [closed] = [e for e in await history(client, sup, open_os["id"]) if e["event_type"] == "offer_cancelled"]
    assert closed["note"] == "Técnico inativo na operação"
    # O técnico vê só que a central cancelou (nada da situação).
    r = await client.post(f"{API}/me/offers/{offer['id']}/accept", headers=world.tech.headers)
    assert r.status_code == 409 and r.json()["code"] == "OFFER_CANCELLED"
    assert "inativ" not in r.text.lower() and "Férias" not in r.text

    message = "Tecnico está inativo e não recebe OS: Férias coletivas"
    # Oferta nova: recusada.
    r = await client.post(
        f"{API}/tickets/{open_os['id']}/offers",
        json={"technician_ids": [tech], "amount": "80.00"},
        headers=sup,
    )
    assert r.status_code == 422 and r.json()["detail"] == message
    # Responsável na abertura, na atribuição e na edição: recusado, sem gastar número de OS.
    r = await client.post(
        f"{API}/tickets",
        json={
            "title": "Impressora atolando",
            "customer_id": world.customer_id,
            "location_id": world.location_id,
            "assignee_id": tech,
        },
        headers=sup,
    )
    assert r.status_code == 422 and r.json()["detail"] == message
    fresh = await create(client, world)
    assert fresh["number"] == open_os["number"] + 1
    r = await client.post(
        f"{API}/tickets/{fresh['id']}/assign",
        json={"assignee_id": tech, "expected_version": fresh["version"]},
        headers=sup,
    )
    assert r.status_code == 422 and r.json()["detail"] == message
    r = await client.patch(
        f"{API}/tickets/{fresh['id']}",
        json={"assignee_id": tech, "expected_version": fresh["version"]},
        headers=sup,
    )
    assert r.status_code == 422 and r.json()["detail"] == message
    # Auxiliar na abertura e na edição: recusado.
    r = await client.post(
        f"{API}/tickets",
        json={
            "title": "Impressora atolando",
            "customer_id": world.customer_id,
            "location_id": world.location_id,
            "helper_ids": [tech],
        },
        headers=sup,
    )
    assert r.status_code == 422 and r.json()["detail"] == message
    r = await client.patch(
        f"{API}/tickets/{fresh['id']}",
        json={"helper_ids": [tech], "expected_version": fresh["version"]},
        headers=sup,
    )
    assert r.status_code == 422 and r.json()["detail"] == message

    # A OS que ele já tinha continua com ele, e salvar com o mesmo responsável passa.
    r = await client.patch(
        f"{API}/tickets/{kept['id']}",
        json={
            "title": "Impressora atolando na bandeja 2",
            "assignee_id": tech,
            "expected_version": kept["version"],
        },
        headers=sup,
    )
    assert r.status_code == 200, r.text
    assert r.json()["assignee"]["id"] == tech

    # Já auxiliar de uma OS: continua, e mexer nos outros auxiliares não confere quem fica.
    both = await create(client, world, helper_ids=[other])
    r = await client.patch(
        f"{API}/tickets/{both['id']}",
        json={"helper_ids": [other], "expected_version": both["version"]},
        headers=sup,
    )
    assert r.status_code == 200, r.text
    await set_status(client, an, other, "blocked", "Documentação vencida")
    both = (await client.get(f"{API}/tickets/{both['id']}", headers=sup)).json()
    r = await client.patch(
        f"{API}/tickets/{both['id']}",
        json={"title": "Troca de toner", "helper_ids": [other], "expected_version": both["version"]},
        headers=sup,
    )
    assert r.status_code == 200, r.text
    assert [h["id"] for h in r.json()["helpers"]] == [other]
    assert await suggested(client, world) == {}

    # Reativado, volta a receber.
    await set_status(client, an, tech, "active", "Voltou das férias")
    assert set(await suggested(client, world)) == {tech}
    r = await client.post(
        f"{API}/tickets/{fresh['id']}/assign",
        json={"assignee_id": tech, "expected_version": fresh["version"]},
        headers=sup,
    )
    assert r.status_code == 200, r.text


@requires_db
async def test_block_with_access_cut(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Bloquear com `cut_access` corta também o acesso: sai do app na hora, os links de senha
    deixam de valer e o histórico tem as duas mudanças com o motivo. Reativar não devolve o
    acesso. Sem acesso, cut_access não muda nada; em Ativo, é ignorado."""
    an = world.analyst.headers
    tech_id = world.tech.user.id
    me = await client.get(f"{API}/auth/me", headers=world.tech.headers)
    assert me.status_code == 200
    async with engine.begin() as conn:
        await conn.execute(
            AccountToken.__table__.insert().values(
                id=uuid.uuid4(),
                purpose=AccountTokenPurpose.RESET_PASSWORD.value,
                reason="central",
                token_hash="b" * 64,
                user_id=tech_id,
                email="tecnico@teste.com.br",
                expires_at=utcnow() + timedelta(hours=2),
                created_at=utcnow(),
            )
        )
    await asyncio.sleep(1.05)  # o iat do token é em segundos inteiros

    out = await set_status(client, an, tech_id, "blocked", "Conduta inadequada", cut_access=True)
    assert (out["operational_status"], out["is_active"]) == ("blocked", False)
    assert (await client.get(f"{API}/auth/me", headers=world.tech.headers)).status_code == 401
    async with engine.connect() as conn:
        revoked = await conn.scalar(
            select(func.count())
            .select_from(AccountToken)
            .where(AccountToken.user_id == tech_id, AccountToken.revoked_at.is_not(None))
        )
    assert revoked == 1
    [row] = (await client.get(f"{API}/technicians/{tech_id}/changes", headers=an)).json()
    assert row["note"] == "Conduta inadequada"
    assert {c["field"]: (c["from"], c["to"]) for c in row["changes"]} == {
        "is_active": ("Liberado", "Sem acesso"),
        "operational_status": ("Ativo", "Bloqueado"),
    }

    # Reativar não devolve o acesso (é o "Liberar acesso" de Técnicos).
    out = await set_status(client, an, tech_id, "active", "Revisão concluída", cut_access=True)
    assert (out["operational_status"], out["is_active"]) == ("active", False)
    out = await set_status(client, an, tech_id, "inactive", "Afastado", cut_access=True)
    assert (out["operational_status"], out["is_active"]) == ("inactive", False)


@requires_db
async def test_inactive_keeps_using_the_app_and_never_sees_the_status(
    client: AsyncClient, world: World
) -> None:
    """Inativo (sem cortar o acesso) continua entrando no app, e nada de /me/* nem do login conta
    a situação ou o motivo."""
    th = world.tech.headers
    await set_status(client, world.analyst.headers, world.tech.user.id, "inactive", "Motivo Secreto")
    login = await client.post(
        f"{API}/auth/login",
        json={"email": "tecnico@teste.com.br", "password": "senha-teste-123", "channel": "mobile"},
    )
    assert login.status_code == 200, login.text
    for path in ("/auth/me", "/me/profile", "/me/offers"):
        r = await client.get(f"{API}{path}", headers=th)
        assert r.status_code == 200, (path, r.text)
        assert "operational" not in r.text and "Motivo Secreto" not in r.text, path
        assert "inativ" not in r.text.lower(), path
    assert "operational" not in login.text and "Motivo Secreto" not in login.text


@requires_db
async def test_accept_by_not_active_is_unavailable(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """A oferta que escapou do fechamento (a situação mudou no meio): o aceite de quem saiu de
    Ativo é OFFER_UNAVAILABLE, sem dizer a situação, e a OS continua sem técnico."""
    sup = world.supervisor.headers
    alfa = await make_technician(engine, "Tecnico Alfa")
    t = await create(client, world)
    [offer] = await send(client, sup, t["id"], [alfa])
    await open_offer(client, alfa, offer["id"])
    async with engine.begin() as conn:
        await conn.execute(
            update(User)
            .where(User.id == alfa.user.id)
            .values(operational_status="blocked", operational_reason="Motivo Secreto")
        )
    r = await client.post(f"{API}/me/offers/{offer['id']}/accept", headers=alfa.headers)
    assert r.status_code == 409, r.text
    assert r.json() == {"detail": "Esta OS não está mais disponível.", "code": "OFFER_UNAVAILABLE"}
    assert (await client.get(f"{API}/tickets/{t['id']}", headers=sup)).json()["assignee"] is None


@requires_db
async def test_unavailable_leaves_suggestions_and_offers_but_not_assignment(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Indisponível nos dias da visita (sem horário: hoje): fora das sugestões, oferta recusada
    com o período; a atribuição manual passa (a web avisa). Colaborador e a ficha listam os
    períodos que não terminaram."""
    an, sup = world.analyst.headers, world.supervisor.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    for user_id in (tech, other):
        await client.patch(
            f"{API}/technicians/{user_id}",
            json={"home_city": "Cidade Exemplo", "home_state": "SP"},
            headers=an,
        )
    today = technician_status.today()
    away = (today + timedelta(days=10), today + timedelta(days=12))
    await set_periods(
        engine,
        world.tech.user.id,
        [(today - timedelta(days=9), today - timedelta(days=2)), (today, today + timedelta(days=1)), away],
    )

    # Sem horário: conta hoje.
    assert set(await suggested(client, world)) == {other}
    tz = ZoneInfo(settings.TIMEZONE)

    def at(day: date, hour: int) -> str:
        return datetime(day.year, day.month, day.day, hour, tzinfo=tz).isoformat()

    free_day = today + timedelta(days=5)
    timed = {"start": at(free_day, 9), "end": at(free_day, 10)}
    assert set(await suggested(client, world, **timed)) == {tech, other}
    # A visita que vira a noite e entra no período.
    crossing = {"start": at(away[0] - timedelta(days=1), 22), "end": at(away[0], 2)}
    assert set(await suggested(client, world, **crossing)) == {other}

    # Oferta: a OS sem agenda (hoje) é recusada com o período.
    t = await create(client, world)
    period = unavailability.period_short(
        {"start": today.isoformat(), "end": (today + timedelta(days=1)).isoformat()}, today
    )
    r = await client.post(
        f"{API}/tickets/{t['id']}/offers",
        json={"technician_ids": [tech], "amount": "80.00"},
        headers=sup,
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == f"Tecnico está indisponível {period}"
    # Com a visita num dia livre, a oferta sai.
    scheduled = await create(
        client,
        world,
        scheduled_start=at(free_day, 9),
        scheduled_end=at(free_day, 10),
    )
    await send(client, sup, scheduled["id"], [world.tech])

    # A atribuição manual passa (a web avisa).
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": tech, "expected_version": t["version"]},
        headers=sup,
    )
    assert r.status_code == 200, r.text

    # Colaborador e ficha: só os períodos que não terminaram, pelo início.
    expected = [
        {"start": today.isoformat(), "end": (today + timedelta(days=1)).isoformat()},
        {"start": away[0].isoformat(), "end": away[1].isoformat()},
    ]
    people = {p["id"]: p for p in (await client.get(f"{API}/users/assignable", headers=an)).json()}
    assert [{k: p[k] for k in ("start", "end")} for p in people[tech]["unavailability"]] == expected
    assert people[other]["unavailability"] == []
    one = (await client.get(f"{API}/technicians/{tech}", headers=an)).json()
    assert [{k: p[k] for k in ("start", "end")} for p in one["unavailability"]] == expected
    assert all(p["id"] for p in one["unavailability"])


@requires_db
async def test_assignable_shows_the_status_and_reason(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Colaborador: só quem tem acesso ao app; técnico Inativo ou Bloqueado vem com a situação e o
    motivo (a web mostra e não deixa escolher); os ativos sem motivo."""
    an = world.analyst.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    await set_status(client, an, tech, "inactive", "Férias coletivas")
    await set_status(client, an, other, "blocked", "Documentação vencida")
    await set_status(client, an, other, "active", "Documentação em dia")
    gama = await make_technician(engine, "Tecnico Gama")
    await set_status(client, an, gama.user.id, "blocked", "Sem seguro", cut_access=True)

    r = await client.get(f"{API}/users/assignable", headers=an)
    assert r.status_code == 200, r.text
    people = {p["id"]: p for p in r.json()}
    assert (people[tech]["operational_status"], people[tech]["operational_reason"]) == (
        "inactive",
        "Férias coletivas",
    )
    # Reativado: o motivo da reativação não aparece no Colaborador.
    assert (people[other]["operational_status"], people[other]["operational_reason"]) == (
        "active",
        None,
    )
    assert str(gama.user.id) not in people  # sem acesso ao app
    analyst = people[str(world.analyst.user.id)]
    assert (analyst["operational_status"], analyst["operational_reason"]) == ("active", None)
    assert analyst["unavailability"] == []
