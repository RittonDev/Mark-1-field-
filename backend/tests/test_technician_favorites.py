"""Técnicos favoritos por cidade: a regra automática (quem mais atendeu nas lojas da cidade em
12 meses) e as decisões da central (fixar e tirar da lista).

Dados sintéticos: técnicos e lojas fictícios, em cidades públicas.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import Select, delete, func, or_, select, union_all, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import TicketStatus, UserRole
from app.db.base import utcnow
from app.main import validation_issue
from app.models import Location, TechnicianFavorite, Ticket, TicketWorklog, User
from app.models.technician_favorite import FavoriteKind
from app.models.ticket import ticket_helpers
from app.services import technician_favorites as favorites_svc
from app.services import technician_regions, validation_messages
from app.services.technician_favorites import Visit, rank_city
from tests.conftest import World, requires_db

API = settings.API_PREFIX
FAV = f"{API}/technicians/favorites"
SANTOS = {"state": "SP", "city": "Santos"}


def test_rank_city_orders_and_picks_the_automatic() -> None:
    now = datetime(2026, 11, 17, 12, tzinfo=UTC)

    def v(name: str, visits: int, days: float | None, active: bool = True) -> Visit:
        last = now - timedelta(days=days) if days is not None else None
        return Visit(uuid.uuid4(), name, active, visits, last)

    ana, bruno = v("Ana", 5, 1), v("Bruno", 3, 2)
    davi, alvaro, elisa = v("Davi", 2, 3), v("Álvaro", 2, 30), v("Elisa", 2, 30)
    carla = v("Carla", 2, 1, active=False)  # mais recente, mas sem acesso ao app
    sem_data = v("Gil", 2, None)
    fabio = v("Fábio", 1, 0)
    rows = [fabio, elisa, carla, ana, sem_data, alvaro, davi, bruno]

    ranked, auto = rank_city(rows)
    # Mais OS; empate: acesso ao app, visita mais recente, nome sem acento.
    assert [r.name for r in ranked] == [
        "Ana",
        "Bruno",
        "Davi",
        "Álvaro",
        "Elisa",
        "Gil",
        "Carla",
        "Fábio",
    ]
    assert auto == [ana.user_id, bruno.user_id, davi.user_id]

    # Tirado da lista sai do pool e o próximo sobe; o ranking completo não muda.
    ranked_hidden, auto = rank_city(rows, frozenset({bruno.user_id}))
    assert ranked_hidden == ranked
    assert auto == [ana.user_id, davi.user_id, alvaro.user_id]

    # Com 1 OS nunca é automático; o inativo entra na regra como qualquer um.
    assert rank_city([fabio])[1] == []
    assert rank_city([fabio, carla])[1] == [carla.user_id]


async def _seed(engine: AsyncEngine, world: World) -> dict[str, str]:
    """Santos-SP (A..I), Campinas-SP (inativos J e K, ativo L), Bom Jesus no PI e no RS, uma OS
    com dois técnicos no Guarujá e Bertioga só com loja."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    async with maker() as db:
        cust = uuid.UUID(world.customer_id)

        def store(name: str, city: str, state: str, active: bool = True) -> Location:
            item = Location(customer_id=cust, name=name, city=city, state=state, is_active=active)
            db.add(item)
            return item

        def tech(letter: str, active: bool = True) -> User:
            user = User(
                name=f"Técnico {letter}",
                email=f"tecnico.{letter.lower()}@exemplo.com",
                password_hash="x",
                role=UserRole.TECHNICIAN,
                is_active=active,
            )
            db.add(user)
            return user

        gonzaga = store("Loja Gonzaga", "Santos", "SP")
        praia = store("Loja Ponta da Praia", "Santos", "SP")
        centro = store("Loja Centro", "SANTOS", "sp")
        store("Loja Fechada", "Santos", "SP", active=False)
        bom_pi = store("Loja Bom Jesus", "Bom Jesus", "PI")
        bom_rs = store("Loja Bom Jesus", "Bom Jesus", "RS")
        cambui = store("Loja Cambuí", "Campinas", "SP")
        guaruja = store("Loja Pitangueiras", "Guarujá", "SP")
        store("Loja Riviera", "Bertioga", "SP")
        t = {letter: tech(letter) for letter in "ABCDEFGHILPR"}
        t["J"] = tech("J", active=False)
        t["K"] = tech("K", active=False)
        await db.flush()

        def visit(
            where: Location,
            who: User | None,
            days_ago: float,
            status: TicketStatus = TicketStatus.CLOSED,
        ) -> Ticket:
            at = now - timedelta(days=days_ago)
            item = Ticket(
                title="Visita",
                status=status,
                customer_id=cust,
                location_id=where.id,
                assignee_id=who.id if who else None,
                arrived_at=at,
                resolved_at=at if status == TicketStatus.CLOSED else None,
                created_at=at,
                updated_at=at,
            )
            db.add(item)
            return item

        stores_a = (gonzaga, praia, centro, gonzaga, centro)
        for days, where in zip((5, 15, 25, 35, 45), stores_a, strict=True):
            visit(where, t["A"], days)
        for days in (7, 17, 27):
            visit(gonzaga, t["B"], days)
        helped = [visit(praia, None, days) for days in (3, 4)]  # H só como ajudante
        for days in (10, 50):
            visit(centro, t["C"], days)
        for days in (100, 120):
            visit(gonzaga, t["D"], days)
        visit(praia, t["E"], 60)
        for days in (395, 396, 397, 398):  # 13 meses: fora da janela
            visit(gonzaga, t["F"], days)
        for days in (8, 9, 11):  # canceladas não contam
            visit(gonzaga, t["G"], days, TicketStatus.CANCELLED)
        with_log = visit(centro, t["I"], 20)  # responsável e apontamento na mesma OS
        for days in (2, 4, 6, 8, 10, 12):
            visit(cambui, t["J"], days)
        # Mesmo dia: o inativo K tem a visita mais recente, mas o ativo L vem antes.
        for who, days in ((t["L"], 30), (t["L"], 5), (t["K"], 30), (t["K"], 5 - 2 / 24)):
            visit(cambui, who, days)
        for days in (10, 20):
            visit(bom_pi, t["P"], days)
            visit(bom_rs, t["R"], days)
        shared = visit(guaruja, t["B"], 12)  # dois técnicos na mesma OS: conta 1
        await db.flush()
        for item in helped:
            await db.execute(ticket_helpers.insert().values(ticket_id=item.id, user_id=t["H"].id))
        await db.execute(ticket_helpers.insert().values(ticket_id=shared.id, user_id=t["C"].id))
        start = now - timedelta(days=20, hours=1)
        db.add(
            TicketWorklog(
                ticket_id=with_log.id,
                user_id=t["I"].id,
                description="Troca de fonte",
                started_at=start,
                ended_at=start + timedelta(minutes=40),
                minutes=40,
            )
        )
        await db.commit()
        ids = {letter: str(user.id) for letter, user in t.items()}
        ids.update(centro=str(centro.id), cambui=str(cambui.id))
        return ids


async def _new_technicians(engine: AsyncEngine, count: int) -> list[str]:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        users = [
            User(
                name=f"Fixo {n:02d}",
                email=f"fixo.{n:02d}@exemplo.com",
                password_hash="x",
                role=UserRole.TECHNICIAN,
                is_active=True,
            )
            for n in range(1, count + 1)
        ]
        db.add_all(users)
        await db.commit()
        return [str(u.id) for u in users]


async def _decisions(engine: AsyncEngine, user_id: str) -> list[TechnicianFavorite]:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        return list(
            await db.scalars(
                select(TechnicianFavorite).where(TechnicianFavorite.user_id == uuid.UUID(user_id))
            )
        )


def _ids(rows: list[dict]) -> list[str]:
    return [r["id"] for r in rows]


@requires_db
async def test_automatic_rule_by_store_city(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed(engine, world)
    an = world.analyst.headers

    r = await client.get(f"{FAV}/city", params={"state": " sp", "city": "SANTOS"}, headers=an)
    assert r.status_code == 200, r.text
    body = r.json()
    # "SANTOS" e "Santos" (e a UF em minúsculas) caem na mesma chave; só lojas ativas contam.
    assert (body["state"], body["city"], body["key"]) == ("SP", "Santos", "santos")
    assert body["stores"] == 3 and body["visits"] == 16

    favorites = body["favorites"]
    assert _ids(favorites) == [ids["A"], ids["B"], ids["H"]]
    assert [f["visits"] for f in favorites] == [5, 3, 2]
    assert [f["rank"] for f in favorites] == [1, 2, 3]
    assert all(f["automatic"] and not f["pinned"] and not f["hidden"] for f in favorites)
    assert all(f["set_by"] is None and f["set_at"] is None for f in favorites)
    helper = favorites[2]  # só como ajudante, há 3 dias
    last = datetime.fromisoformat(helper["last_visit_at"])
    assert abs(last - (utcnow() - timedelta(days=3))) < timedelta(minutes=5)
    assert (helper["name"], helper["email"], helper["is_active"]) == (
        "Técnico H",
        "tecnico.h@exemplo.com",
        True,
    )
    assert (helper["open_tickets"], helper["on_shift"]) == (0, False)

    # C e D têm 2 OS, mas as mais antigas: ficam em "outros", com E e I (1 OS cada).
    assert _ids(body["others"]) == [ids["C"], ids["D"], ids["I"], ids["E"]]
    assert body["others_count"] == 4 and body["hidden_count"] == 0 and body["hidden"] == []
    others = {o["id"]: o for o in body["others"]}
    assert [others[ids[x]]["rank"] for x in "CDIE"] == [4, 5, 6, 7]
    assert others[ids["I"]]["visits"] == 1  # responsável e apontamento: 1 OS
    # F (fora da janela) e G (só OS canceladas) não entram.
    assert ids["F"] not in others and ids["G"] not in others

    # Pela loja grafada "SANTOS": a mesma cidade.
    r = await client.get(f"{FAV}/city", params={"location_id": ids["centro"]}, headers=an)
    assert r.json()["key"] == "santos" and _ids(r.json()["favorites"]) == _ids(favorites)

    # A UF faz parte da chave: Bom Jesus-PI e Bom Jesus-RS são cidades diferentes.
    pi = await client.get(f"{FAV}/city", params={"state": "PI", "city": "Bom Jesus"}, headers=an)
    rs = await client.get(f"{FAV}/city", params={"state": "RS", "city": "bom jesus"}, headers=an)
    assert _ids(pi.json()["favorites"]) == [ids["P"]] and pi.json()["visits"] == 2
    assert _ids(rs.json()["favorites"]) == [ids["R"]] and rs.json()["visits"] == 2


@requires_db
async def test_inactive_favorite_stays_out_of_suggestions(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed(engine, world)
    an = world.analyst.headers

    r = await client.get(f"{FAV}/city", params={"location_id": ids["cambui"]}, headers=an)
    assert r.status_code == 200, r.text
    favorites = r.json()["favorites"]
    assert _ids(favorites) == [ids["J"], ids["L"], ids["K"]]
    assert favorites[0]["is_active"] is False and favorites[0]["visits"] == 6
    # Empate em OS: quem tem acesso ao app vem antes, mesmo com a visita mais antiga.
    assert [f["is_active"] for f in favorites[1:]] == [True, False]
    last_l, last_k = (datetime.fromisoformat(f["last_visit_at"]) for f in favorites[1:])
    assert last_l < last_k

    r = await client.get(
        f"{API}/technicians/suggest", params={"location_id": ids["cambui"]}, headers=an
    )
    assert r.status_code == 200, r.text
    rows = {row["id"]: row for row in r.json()}
    assert ids["J"] not in rows and ids["K"] not in rows
    assert rows[ids["L"]]["favorite"] == "auto"
    assert rows[ids["L"]]["reasons"][0] == "Favorito em Campinas-SP"


@requires_db
async def test_not_active_leaves_the_automatic_but_a_pinned_one_stays(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """Inativo e Bloqueado (situação na operação) ficam no ranking, mas fora do automático, e o
    próximo sobe; fixado pela central, continua, com a situação e o motivo (o selo da web e o
    title dele). O Ativo vem sem motivo, mesmo o reativado. Nas sugestões não entram."""
    ids = await _seed(engine, world)
    an = world.analyst.headers
    async with engine.begin() as conn:
        for letter, status in (("A", "inactive"), ("B", "blocked"), ("C", "active")):
            await conn.execute(
                update(User)
                .where(User.id == uuid.UUID(ids[letter]))
                .values(operational_status=status, operational_reason="Motivo de exemplo")
            )

    r = await client.get(f"{FAV}/city", params=SANTOS, headers=an)
    assert r.status_code == 200, r.text
    body = r.json()
    assert _ids(body["favorites"]) == [ids["H"], ids["C"], ids["D"]]
    assert all(f["operational_status"] == "active" for f in body["favorites"])
    assert all(f["operational_reason"] is None for f in body["favorites"])  # C: reativado
    others = {o["id"]: o for o in body["others"]}
    assert _ids(body["others"]) == [ids["A"], ids["B"], ids["I"], ids["E"]]
    assert (others[ids["A"]]["rank"], others[ids["A"]]["operational_status"]) == (1, "inactive")
    assert others[ids["B"]]["operational_status"] == "blocked"
    for letter in "AB":
        assert others[ids[letter]]["operational_reason"] == "Motivo de exemplo"

    r = await client.put(f"{FAV}/{ids['A']}", json=SANTOS, headers=an)
    assert r.status_code == 200, r.text
    favorites = r.json()["favorites"]
    assert _ids(favorites) == [ids["A"], ids["H"], ids["C"], ids["D"]]
    assert (favorites[0]["pinned"], favorites[0]["operational_status"]) == (True, "inactive")
    assert favorites[0]["operational_reason"] == "Motivo de exemplo"
    listed = (await client.get(FAV, params={"state": "SP"}, headers=an)).json()
    santos = next(c for c in listed["cities"] if c["key"] == "santos")
    assert santos["favorites"][0]["operational_status"] == "inactive"
    assert santos["favorites"][0]["operational_reason"] == "Motivo de exemplo"

    r = await client.get(
        f"{API}/technicians/suggest", params={"location_id": ids["centro"], "limit": 10}, headers=an
    )
    assert r.status_code == 200, r.text
    assert not {ids["A"], ids["B"]} & {row["id"] for row in r.json()}


@requires_db
async def test_pin_rules_and_errors(client: AsyncClient, engine: AsyncEngine, world: World) -> None:
    ids = await _seed(engine, world)
    an = world.analyst.headers
    other = str(world.tech_other.user.id)

    # Técnico sem OS na cidade: fixado vem primeiro e não muda os automáticos.
    body = {"state": " sp ", "city": " santos ", "note": "  Atende aos sábados  "}
    r = await client.put(f"{FAV}/{other}", json=body, headers=an)
    assert r.status_code == 200, r.text
    favorites = r.json()["favorites"]
    assert _ids(favorites) == [other, ids["A"], ids["B"], ids["H"]]
    pinned = favorites[0]
    assert (pinned["pinned"], pinned["automatic"], pinned["hidden"]) == (True, False, False)
    assert (pinned["visits"], pinned["rank"], pinned["last_visit_at"]) == (0, None, None)
    assert pinned["note"] == "Atende aos sábados"
    saved = (await _decisions(engine, other))[0]
    assert (saved.state, saved.city_key, saved.city) == ("SP", "santos", "Santos")

    # Nota vazia vira null; mais de 300 caracteres, 422.
    r = await client.put(f"{FAV}/{other}", json={**SANTOS, "note": "   "}, headers=an)
    assert r.json()["favorites"][0]["note"] is None
    r = await client.put(f"{FAV}/{other}", json={**SANTOS, "note": "x" * 301}, headers=an)
    assert r.status_code == 422

    # Até 10 fixados por cidade; quem já está fixado pode trocar a nota.
    extra = await _new_technicians(engine, 10)
    for user_id in extra[:9]:
        r = await client.put(f"{FAV}/{user_id}", json=SANTOS, headers=an)
        assert r.status_code == 200, r.text
    r = await client.put(f"{FAV}/{extra[9]}", json=SANTOS, headers=an)
    assert r.status_code == 422
    assert r.json()["detail"] == "Até 10 técnicos fixados por cidade"
    r = await client.put(f"{FAV}/{extra[0]}", json={**SANTOS, "note": "Chaves da loja"}, headers=an)
    assert r.status_code == 200, r.text
    # Em outra cidade a conta é outra.
    r = await client.put(f"{FAV}/{extra[9]}", json={"state": "SP", "city": "Guarujá"}, headers=an)
    assert r.status_code == 200, r.text

    r = await client.put(f"{FAV}/{other}", json={"state": "PE", "city": "Recife"}, headers=an)
    assert r.status_code == 404 and r.json()["detail"] == "Nenhuma loja em Recife-PE"
    r = await client.put(f"{FAV}/{other}", json={"state": "S1", "city": "Santos"}, headers=an)
    assert r.status_code == 422 and r.json()["detail"] == "UF inválida"
    r = await client.put(f"{FAV}/{world.analyst.user.id}", json=SANTOS, headers=an)
    assert r.status_code == 404 and r.json()["detail"] == "Técnico não encontrado"
    r = await client.put(f"{FAV}/{uuid.uuid4()}", json=SANTOS, headers=an)
    assert r.status_code == 404

    # Consulta da cidade: loja sem cidade, loja inexistente, cidade sem loja, sem parâmetros.
    r = await client.get(f"{FAV}/city", params={"location_id": world.location_id}, headers=an)
    assert r.status_code == 422 and r.json()["detail"] == "A loja não tem cidade e UF"
    r = await client.get(f"{FAV}/city", params={"location_id": str(uuid.uuid4())}, headers=an)
    assert r.status_code == 404 and r.json()["detail"] == "Loja não encontrada"
    r = await client.get(f"{FAV}/city", params={"state": "PE", "city": "Recife"}, headers=an)
    assert r.status_code == 404 and r.json()["detail"] == "Nenhuma loja em Recife-PE"
    r = await client.get(f"{FAV}/city", params={"city": "Santos"}, headers=an)
    assert r.status_code == 422 and r.json()["detail"] == "Informe a loja ou a cidade com a UF"


@requires_db
async def test_hide_and_back_to_the_rule(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed(engine, world)
    an = world.analyst.headers
    a = ids["A"]

    # Tirar um automático: o próximo (C) sobe.
    hide = {**SANTOS, "favorite": False, "note": "Mudou de região"}
    r = await client.put(f"{FAV}/{a}", json=hide, headers=an)
    assert r.status_code == 200, r.text
    body = r.json()
    assert _ids(body["favorites"]) == [ids["B"], ids["H"], ids["C"]]
    assert body["hidden_count"] == 1 and _ids(body["hidden"]) == [a]
    hidden = body["hidden"][0]
    assert (hidden["hidden"], hidden["automatic"], hidden["pinned"]) == (True, False, False)
    assert (hidden["rank"], hidden["visits"], hidden["note"]) == (1, 5, "Mudou de região")
    assert a not in _ids(body["others"])

    # Já tirado: false de novo só troca a nota.
    r = await client.put(f"{FAV}/{a}", json={**hide, "note": "Atende só a capital"}, headers=an)
    assert r.json()["hidden_count"] == 1
    assert r.json()["hidden"][0]["note"] == "Atende só a capital"

    # DELETE: volta a valer a regra (A volta, C sai). Sem registro, 200 do mesmo jeito.
    r = await client.delete(f"{FAV}/{a}", params=SANTOS, headers=an)
    assert r.status_code == 200, r.text
    assert _ids(r.json()["favorites"]) == [a, ids["B"], ids["H"]]
    assert r.json()["hidden_count"] == 0
    r = await client.delete(f"{FAV}/{a}", params=SANTOS, headers=an)
    assert r.status_code == 200 and _ids(r.json()["favorites"]) == [a, ids["B"], ids["H"]]
    assert await _decisions(engine, a) == []

    # Fixado sem OS + false: a decisão é apagada.
    other = str(world.tech_other.user.id)
    await client.put(f"{FAV}/{other}", json=SANTOS, headers=an)
    r = await client.put(f"{FAV}/{other}", json={**SANTOS, "favorite": False}, headers=an)
    assert other not in _ids(r.json()["favorites"]) and r.json()["hidden_count"] == 0
    assert await _decisions(engine, other) == []

    # Fixado que também é automático + false: vira tirado.
    r = await client.put(f"{FAV}/{a}", json=SANTOS, headers=an)
    first = r.json()["favorites"][0]
    assert first["id"] == a and first["pinned"] and first["automatic"]
    assert _ids(r.json()["favorites"]) == [a, ids["B"], ids["H"]]  # fixar não traz um 4º
    r = await client.put(f"{FAV}/{a}", json={**SANTOS, "favorite": False}, headers=an)
    assert _ids(r.json()["favorites"]) == [ids["B"], ids["H"], ids["C"]]
    assert _ids(r.json()["hidden"]) == [a]
    assert [d.kind.value for d in await _decisions(engine, a)] == ["hide"]

    # Tirar quem não é favorito nem tem decisão: nada muda.
    r = await client.put(f"{FAV}/{ids['E']}", json={**SANTOS, "favorite": False}, headers=an)
    assert r.status_code == 200 and await _decisions(engine, ids["E"]) == []

    # O Desfazer de um tirado (hide=true) grava tirado mesmo fora do top 3, com o motivo.
    undo = {**SANTOS, "favorite": False, "note": "Atende só a capital", "hide": True}
    r = await client.put(f"{FAV}/{ids['E']}", json=undo, headers=an)
    assert r.status_code == 200, r.text
    hidden_e = [h for h in r.json()["hidden"] if h["id"] == ids["E"]]
    assert [h["note"] for h in hidden_e] == ["Atende só a capital"]
    assert [d.kind.value for d in await _decisions(engine, ids["E"])] == ["hide"]


@requires_db
async def test_decisions_of_who_is_no_longer_a_technician_leave_the_counts(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed(engine, world)
    an = world.analyst.headers
    a, e = ids["A"], ids["E"]
    await client.put(f"{FAV}/{a}", json={**SANTOS, "favorite": False, "note": "Saiu"}, headers=an)
    await client.put(f"{FAV}/{e}", json=SANTOS, headers=an)

    # A gestão corrige o papel dos dois: as decisões ficam guardadas, mas não contam mais.
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        for user_id in (a, e):
            user = await db.get(User, uuid.UUID(user_id))
            assert user is not None
            user.role = UserRole.ANALYST
        await db.commit()
    r = await client.get(f"{FAV}/city", params=SANTOS, headers=an)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["hidden_count"], body["hidden"]) == (0, [])
    assert e not in _ids(body["favorites"])
    assert len(await _decisions(engine, a)) == 1 and len(await _decisions(engine, e)) == 1


@requires_db
async def test_audit_who_decided(client: AsyncClient, engine: AsyncEngine, world: World) -> None:
    await _seed(engine, world)
    other = str(world.tech_other.user.id)

    r = await client.put(
        f"{FAV}/{other}", json={**SANTOS, "note": "Primeira"}, headers=world.analyst.headers
    )
    pinned = r.json()["favorites"][0]
    assert pinned["set_by"] == {"id": str(world.analyst.user.id), "name": "Analista"}
    assert pinned["set_at"] is not None

    r = await client.put(
        f"{FAV}/{other}", json={**SANTOS, "note": "Editada"}, headers=world.supervisor.headers
    )
    pinned = r.json()["favorites"][0]
    assert pinned["set_by"]["id"] == str(world.supervisor.user.id)
    assert pinned["note"] == "Editada"
    saved = (await _decisions(engine, other))[0]
    assert saved.created_by_id == world.analyst.user.id
    assert saved.updated_by_id == world.supervisor.user.id


@requires_db
async def test_permissions(client: AsyncClient, engine: AsyncEngine, world: World) -> None:
    ids = await _seed(engine, world)
    calls = [
        ("GET", FAV, None, None),
        ("GET", f"{FAV}/city", SANTOS, None),
        ("PUT", f"{FAV}/{ids['B']}", None, SANTOS),
        ("DELETE", f"{FAV}/{ids['B']}", SANTOS, None),
    ]
    for actor, expected in (
        (world.tech, 403),
        (world.requester, 403),
        (world.analyst, 200),
        (world.supervisor, 200),
        (world.admin, 200),
    ):
        for method, url, params, body in calls:
            r = await client.request(method, url, params=params, json=body, headers=actor.headers)
            assert r.status_code == expected, (actor.user.name, method, url, r.text)


@requires_db
async def test_list_all_cities_and_filters(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    ids = await _seed(engine, world)
    an = world.analyst.headers

    r = await client.get(FAV, headers=an)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["window_days"], body["min_visits"], body["top"], body["max_pinned"]) == (
        365,
        2,
        3,
        10,
    )
    # Todas as cidades com loja (inclusive sem favorito): mais OS, depois UF, depois cidade.
    assert [(c["city"], c["state"]) for c in body["cities"]] == [
        ("Santos", "SP"),
        ("Campinas", "SP"),
        ("Bom Jesus", "PI"),
        ("Bom Jesus", "RS"),
        ("Guarujá", "SP"),
        ("Bertioga", "SP"),
    ]
    cities = {(c["state"], c["key"]): c for c in body["cities"]}
    santos = cities[("SP", "santos")]
    assert (santos["stores"], santos["visits"], santos["others_count"]) == (3, 16, 4)
    assert _ids(santos["favorites"]) == [ids["A"], ids["B"], ids["H"]]
    assert "hidden" not in santos and "others" not in santos
    # Uma OS com dois técnicos conta 1 para a cidade; 1 OS cada não faz favorito.
    guaruja = cities[("SP", "guaruja")]
    assert (guaruja["visits"], guaruja["favorites"], guaruja["others_count"]) == (1, [], 2)
    bertioga = cities[("SP", "bertioga")]
    assert (bertioga["stores"], bertioga["visits"], bertioga["favorites"]) == (1, 0, [])

    r = await client.get(FAV, params={"state": "sp"}, headers=an)
    assert [c["key"] for c in r.json()["cities"]] == ["santos", "campinas", "guaruja", "bertioga"]
    r = await client.get(FAV, params={"state": "PI"}, headers=an)
    assert [(c["key"], c["state"]) for c in r.json()["cities"]] == [("bom jesus", "PI")]

    # Por técnico: as cidades em que ele é favorito ou foi tirado da lista.
    r = await client.get(FAV, params={"technician_id": ids["J"]}, headers=an)
    assert [c["key"] for c in r.json()["cities"]] == ["campinas"]
    await client.put(f"{FAV}/{ids['A']}", json={**SANTOS, "favorite": False}, headers=an)
    r = await client.get(FAV, params={"technician_id": ids["A"]}, headers=an)
    assert [c["key"] for c in r.json()["cities"]] == ["santos"]
    assert r.json()["cities"][0]["hidden_count"] == 1
    r = await client.get(FAV, params={"technician_id": str(world.tech.user.id)}, headers=an)
    assert r.json()["cities"] == []


@requires_db
async def test_city_from_the_list_is_found_again(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """A chave sai do mesmo fold_text para as lojas e para os pedidos: a cidade que a lista
    devolve sempre volta pela consulta, pela loja e no PUT (até com apóstrofo tipográfico)."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        store = Location(
            customer_id=uuid.UUID(world.customer_id),
            name="Loja Herval",
            city="Herval d’Oeste",
            state="SC",
            is_active=True,
        )
        db.add(store)
        await db.commit()
    an = world.analyst.headers

    (city,) = (await client.get(FAV, params={"state": "SC"}, headers=an)).json()["cities"]
    assert (city["city"], city["key"], city["stores"]) == ("Herval d’Oeste", "herval doeste", 1)
    place = {"state": city["state"], "city": city["city"]}
    r = await client.get(f"{FAV}/city", params=place, headers=an)
    assert r.status_code == 200 and r.json()["key"] == "herval doeste"
    r = await client.get(f"{FAV}/city", params={"location_id": str(store.id)}, headers=an)
    assert r.status_code == 200 and r.json()["key"] == "herval doeste"
    r = await client.put(f"{FAV}/{world.tech.user.id}", json=place, headers=an)
    assert r.status_code == 200 and _ids(r.json()["favorites"]) == [str(world.tech.user.id)]


@requires_db
async def test_deleting_the_technician_deletes_the_decisions(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    await _seed(engine, world)
    (extra,) = await _new_technicians(engine, 1)
    r = await client.put(f"{FAV}/{extra}", json=SANTOS, headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    assert len(await _decisions(engine, extra)) == 1

    async with engine.begin() as conn:
        await conn.execute(delete(User).where(User.id == uuid.UUID(extra)))
        left = await conn.scalar(select(func.count()).select_from(TechnicianFavorite))
    assert left == 0


@requires_db
async def test_long_note_names_the_field_of_the_screen(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """Nota longa: o 422 de sempre, com o nome que a tela dá ao campo (a Nota do fixado, o Motivo
    do tirado). O "note" das outras telas segue "Motivo"."""
    await _seed(engine, world)
    an = world.analyst.headers
    other = str(world.tech_other.user.id)
    too_long = "x" * 301
    r = await client.put(f"{FAV}/{other}", json={**SANTOS, "note": too_long}, headers=an)
    assert r.status_code == 422
    assert r.json()["detail"] == [
        {
            "loc": ["body", "note"],
            "msg": "No máximo 300 caracteres",
            "type": "string_too_long",
            "ctx": {"max_length": 300},
            "label": "Nota",
        }
    ]
    hide = {**SANTOS, "favorite": False, "note": too_long}
    r = await client.put(f"{FAV}/{other}", json=hide, headers=an)
    assert r.status_code == 422 and r.json()["detail"][0]["label"] == "Motivo"
    # 300 cabem (os espaços das pontas saem antes de contar).
    r = await client.put(f"{FAV}/{other}", json={**SANTOS, "note": f"  {'x' * 300} "}, headers=an)
    assert r.status_code == 200, r.text

    # Sem rótulo do validador, vale o geral (o "note" da OS é o motivo da mudança).
    general = {"loc": ("body", "note"), "msg": "", "type": "string_too_long"}
    issue = validation_issue({**general, "ctx": {"max_length": 500}})
    assert (issue["label"], issue["msg"], issue["ctx"]) == (
        "Motivo",
        "No máximo 500 caracteres",
        {"max_length": 500},
    )
    labeled = {**general, "ctx": {"max_length": 300, "label": "Nota"}}
    assert validation_messages.readable([labeled]) == "Nota: no máximo 300 caracteres"
    assert validation_messages.readable([{**general, "ctx": {"max_length": 300}}]) == (
        "Motivo: no máximo 300 caracteres"
    )


@requires_db
async def test_pin_limit_holds_when_two_arrive_together(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """Dois "Fixar" ao mesmo tempo na cidade que já tem 9 fixados: a trava da cidade deixa um só
    passar (sem ela, os dois liam 9 antes de gravar e a cidade ficava com 11)."""
    await _seed(engine, world)
    an = world.analyst.headers
    extra = await _new_technicians(engine, 11)
    for user_id in extra[:9]:
        r = await client.put(f"{FAV}/{user_id}", json=SANTOS, headers=an)
        assert r.status_code == 200, r.text

    async def pin(user_id: str) -> int:
        return (await client.put(f"{FAV}/{user_id}", json=SANTOS, headers=an)).status_code

    assert sorted(await asyncio.gather(pin(extra[9]), pin(extra[10]))) == [200, 422]
    async with engine.connect() as conn:
        pinned = await conn.scalar(
            select(func.count())
            .select_from(TechnicianFavorite)
            .where(
                TechnicianFavorite.city_key == "santos",
                TechnicianFavorite.kind == FavoriteKind.INCLUDE,
            )
        )
    assert pinned == 10


@requires_db
async def test_one_city_reads_only_its_stores_with_the_same_result(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """A consulta de uma cidade (detalhe, sugestões da OS, decisões) monta as visitas só das lojas
    dela, em vez das de todas; o resultado é o mesmo da lista de todas as cidades."""
    ids = await _seed(engine, world)
    an = world.analyst.headers
    # Um tirado e um fixado, para a regra inteira entrar na comparação.
    await client.put(f"{FAV}/{ids['A']}", json={**SANTOS, "favorite": False}, headers=an)
    await client.put(f"{FAV}/{world.tech.user.id}", json=SANTOS, headers=an)

    now = utcnow()
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        everything = await favorites_svc._cities(db, now)
        assert len(everything) == 6
        for (uf, key), city in everything.items():
            (one,) = (await favorites_svc._cities(db, now, state=uf, key=key)).values()
            assert (one.city, one.stores, one.visits) == (city.city, city.stores, city.visits)
            assert sorted(one.rows, key=_by_user) == sorted(city.rows, key=_by_user), key
    listing = (await client.get(FAV, headers=an)).json()["cities"]
    async with maker() as db:
        for city in listing:
            place = {"state": city["state"], "city": city["city"]}
            detail = (await client.get(f"{FAV}/city", params=place, headers=an)).json()
            assert {k: detail[k] for k in city} == city
            marks = await favorites_svc.marks_for_place(db, city["state"], city["city"])
            assert set(map(str, marks)) == set(_ids(city["favorites"]))


def _by_user(visit: Visit) -> str:
    return str(visit.user_id)


def _footprint_before(since: datetime, until: datetime | None = None) -> Select:
    """O footprint de antes (o corte de `since` só depois de juntar): a referência do resultado."""
    visit_at = func.coalesce(
        Ticket.arrived_at, Ticket.resolved_at, Ticket.scheduled_start, Ticket.created_at
    )
    visited = (
        Ticket.location_id.is_not(None),
        Ticket.status != TicketStatus.CANCELLED,
        or_(
            Ticket.arrived_at.is_not(None),
            Ticket.status.in_((TicketStatus.RESOLVED, TicketStatus.CLOSED)),
        ),
    )
    assigned = select(
        Ticket.assignee_id.label("user_id"),
        Ticket.id.label("ticket_id"),
        Ticket.location_id.label("location_id"),
        visit_at.label("at"),
    ).where(Ticket.assignee_id.is_not(None), *visited)
    helped = (
        select(ticket_helpers.c.user_id, Ticket.id, Ticket.location_id, visit_at)
        .join(Ticket, Ticket.id == ticket_helpers.c.ticket_id)
        .where(*visited)
    )
    worked = (
        select(
            TicketWorklog.user_id,
            TicketWorklog.ticket_id,
            Ticket.location_id,
            TicketWorklog.started_at,
        )
        .join(Ticket, Ticket.id == TicketWorklog.ticket_id)
        .where(TicketWorklog.user_id.is_not(None), Ticket.location_id.is_not(None))
    )
    both = union_all(assigned, helped, worked).subquery()
    pairs = (
        select(
            both.c.user_id, both.c.ticket_id, both.c.location_id, func.max(both.c.at).label("at")
        )
        .group_by(both.c.user_id, both.c.ticket_id, both.c.location_id)
        .subquery()
    )
    conds = [pairs.c.at >= since]
    if until is not None:
        conds.append(pairs.c.at <= until)
    return select(pairs).where(*conds)


@requires_db
async def test_footprint_cuts_the_window_early_with_the_same_visits(
    engine: AsyncEngine, world: World
) -> None:
    """O footprint corta a janela em cada linha antes de juntar (e, para uma cidade, só as lojas
    dela): as mesmas visitas, com a mesma data, da conta de antes. Inclusive quando as linhas de um
    técnico na mesma OS ficam dos dois lados do começo da janela."""
    ids = await _seed(engine, world)
    now = utcnow()
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        centro = uuid.UUID(ids["centro"])
        tech = uuid.UUID(ids["E"])
        # Chegada há 400 dias e apontamento há 10; chegada há 10 dias e apontamento há 400.
        for arrived, logged in ((400, 10), (10, 400)):
            at = now - timedelta(days=arrived)
            item = Ticket(
                title="Visita",
                status=TicketStatus.CLOSED,
                customer_id=uuid.UUID(world.customer_id),
                location_id=centro,
                assignee_id=tech,
                arrived_at=at,
                resolved_at=at,
                created_at=at,
                updated_at=at,
            )
            db.add(item)
            await db.flush()
            start = now - timedelta(days=logged)
            db.add(
                TicketWorklog(
                    ticket_id=item.id,
                    user_id=tech,
                    description="Apontamento",
                    started_at=start,
                    ended_at=start + timedelta(minutes=30),
                    minutes=30,
                )
            )
        await db.commit()

    window = now - timedelta(days=365)
    santos = select(Location.id).where(Location.city.in_(("Santos", "SANTOS")))
    async with maker() as db:
        stores = set(await db.scalars(santos))
        for until in (None, now):
            before = set((await db.execute(_footprint_before(window, until))).all())
            fp = technician_regions.footprint(window, until=until)
            assert set((await db.execute(select(fp))).all()) == before
            only = technician_regions.footprint(window, until=until, location_ids=santos)
            in_santos = {row for row in before if row.location_id in stores}
            assert set((await db.execute(select(only))).all()) == in_santos
            # As duas OS novas entram, cada uma com a data de dentro da janela.
            mine = [r.at for r in before if r.user_id == tech and r.location_id == centro]
            assert mine == [now - timedelta(days=10)] * 2
