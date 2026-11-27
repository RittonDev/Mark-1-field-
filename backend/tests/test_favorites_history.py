"""Favoritos por cidade no histórico do cadastro: cada decisão da central (fixar, tirar da lista,
voltar para a regra, trocar a nota) vira uma linha do técnico (campo "favorites", via central, quem
fez e a nota do pedido em `note`), com a frase em "to" e a cidade na grafia das lojas; nada mudou,
nenhuma linha. O aviso vai só à central (favorito é da gestão: nada para o app). E a regra da E1:
Inativo e Bloqueado ficam fora do automático (o fixado continua).

Dados fictícios: Cidade Exemplo-SP, Loja Exemplo, técnicos Alfa a Delta.
"""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import TicketStatus, UserRole
from app.db.base import utcnow
from app.models import Location, Ticket, User
from app.services import realtime
from app.services import technician_favorites as favorites_svc
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX
FAV = f"{API}/technicians/favorites"
CITY = {"state": "SP", "city": "Cidade Exemplo"}
PLACE = "Cidade Exemplo-SP"


async def _seed(engine: AsyncEngine, world: World) -> dict[str, str]:
    """Cidade Exemplo-SP com duas lojas (uma grafada "CIDADE EXEMPLO"): Alfa com 3 OS, Bravo e
    Charlie com 2 recentes (os três automáticos) e Delta com 2 antigas (o 4º)."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    now = utcnow()
    async with maker() as db:
        customer = uuid.UUID(world.customer_id)
        stores = [
            Location(customer_id=customer, name="Loja Exemplo", city=city, state="SP")
            for city in ("Cidade Exemplo", "CIDADE EXEMPLO", "Cidade Exemplo")
        ]
        db.add_all(stores)
        techs = {
            name: User(
                name=f"Tecnico {name}",
                email=f"tecnico.{name.lower()}@exemplo.com",
                password_hash="x",
                role=UserRole.TECHNICIAN,
                is_active=True,
            )
            for name in ("Alfa", "Bravo", "Charlie", "Delta")
        }
        db.add_all(techs.values())
        await db.flush()
        visits = {"Alfa": (3, 4, 5), "Bravo": (6, 7), "Charlie": (8, 9), "Delta": (50, 60)}
        for name, days in visits.items():
            for n, days_ago in enumerate(days):
                at = now - timedelta(days=days_ago)
                db.add(
                    Ticket(
                        title="Visita de exemplo",
                        status=TicketStatus.CLOSED,
                        customer_id=customer,
                        location_id=stores[n % len(stores)].id,
                        assignee_id=techs[name].id,
                        arrived_at=at,
                        resolved_at=at,
                        created_at=at,
                        updated_at=at,
                    )
                )
        await db.commit()
        return {name: str(user.id) for name, user in techs.items()}


async def _lines(
    client: AsyncClient, world: World, user_id: str
) -> list[tuple[str, str, str | None, list[dict[str, Any]]]]:
    """O histórico do técnico (o mais novo primeiro): (via, quem, nota, mudanças)."""
    r = await client.get(f"{API}/technicians/{user_id}/changes", headers=world.supervisor.headers)
    assert r.status_code == 200, r.text
    return [(row["via"], row["actor"]["name"], row["note"], row["changes"]) for row in r.json()]


def _line(text: str, note: str | None = None) -> tuple[str, str, str | None, list[dict[str, Any]]]:
    return ("central", "Analista", note, [{"field": "favorites", "from": None, "to": text}])


async def test_favorite_decisions_go_to_the_history(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """Cada transição com a frase e a nota do pedido; repetir a mesma decisão não grava linha."""
    ids = await _seed(engine, world)
    an = world.analyst.headers
    tech, alfa = str(world.tech.user.id), ids["Alfa"]

    async def put(user_id: str, **body: Any) -> None:
        r = await client.put(f"{FAV}/{user_id}", json={**CITY, **body}, headers=an)
        assert r.status_code == 200, r.text

    async def delete(user_id: str) -> None:
        r = await client.delete(f"{FAV}/{user_id}", params=CITY, headers=an)
        assert r.status_code == 200, r.text

    # Sem OS na cidade: fixado; a mesma decisão de novo, nada; a nota trocada, "nota alterada".
    await put(tech, note="Atende aos sábados")
    pinned = _line(f"fixado em {PLACE}", "Atende aos sábados")
    assert await _lines(client, world, tech) == [pinned]
    await put(tech, note=" Atende aos sábados ")
    assert await _lines(client, world, tech) == [pinned]
    await put(tech, note="Chaves na Loja Exemplo")
    noted = _line(f"nota alterada em {PLACE}", "Chaves na Loja Exemplo")
    assert await _lines(client, world, tech) == [noted, pinned]
    # Tirar o fixado que não é automático: volta para a regra (a decisão sai); de novo, nada.
    await put(tech, favorite=False, note="Não atende mais a região")
    back = _line(f"voltou para a regra em {PLACE}", "Não atende mais a região")
    assert await _lines(client, world, tech) == [back, noted, pinned]
    await put(tech, favorite=False)
    await delete(tech)
    assert len(await _lines(client, world, tech)) == 3

    # O automático tirado da lista; a mesma nota de novo, nada; outra, "nota alterada".
    await put(alfa, favorite=False, note="Mudou de região")
    hidden = _line(f"tirado da lista de {PLACE}", "Mudou de região")
    assert await _lines(client, world, alfa) == [hidden]
    await put(alfa, favorite=False, note="Mudou de região")
    assert await _lines(client, world, alfa) == [hidden]
    await put(alfa, favorite=False, note="Atende só a capital")
    assert (await _lines(client, world, alfa))[0] == _line(
        f"nota alterada em {PLACE}", "Atende só a capital"
    )
    # Tirado → fixado; fixado → DELETE: volta para a regra (sem nota); DELETE de novo, nada.
    await put(alfa)
    assert (await _lines(client, world, alfa))[0] == _line(f"fixado em {PLACE}")
    await delete(alfa)
    assert (await _lines(client, world, alfa))[0] == _line(f"voltou para a regra em {PLACE}")
    await delete(alfa)
    assert len(await _lines(client, world, alfa)) == 4

    # Tirar quem não é favorito (Delta, o 4º) nem tem decisão: nada; o Desfazer (hide) grava
    # tirado.
    delta = ids["Delta"]
    await put(delta, favorite=False)
    assert await _lines(client, world, delta) == []
    await put(delta, favorite=False, hide=True, note="Desfeito")
    assert await _lines(client, world, delta) == [_line(f"tirado da lista de {PLACE}", "Desfeito")]

    # Fixado que também é automático + "tirar": vira tirado.
    bravo = ids["Bravo"]
    await put(bravo)
    await put(bravo, favorite=False, note="Pedido da Loja Exemplo")
    assert await _lines(client, world, bravo) == [
        _line(f"tirado da lista de {PLACE}", "Pedido da Loja Exemplo"),
        _line(f"fixado em {PLACE}"),
    ]


def test_history_change_phrases() -> None:
    """As frases sem banco (a tabela do contrato §6.6)."""
    include, hide = favorites_svc.FavoriteKind.INCLUDE, favorites_svc.FavoriteKind.HIDE
    now = utcnow()

    def decision(kind: Any, note: str | None = None) -> Any:
        return favorites_svc._Decision(kind, note, None, now)

    def to(before: Any, kind: Any, note: str | None = None) -> str | None:
        changes = favorites_svc.history_change(before, kind, note, PLACE)
        assert all(c["field"] == "favorites" and c["from"] is None for c in changes)
        return changes[0]["to"] if changes else None

    assert to(None, include) == f"fixado em {PLACE}"
    assert to(None, hide) == f"tirado da lista de {PLACE}"
    assert to(decision(include), hide) == f"tirado da lista de {PLACE}"
    assert to(decision(hide), include) == f"fixado em {PLACE}"
    assert to(decision(include, "Nota"), None) == f"voltou para a regra em {PLACE}"
    assert to(decision(hide), None) == f"voltou para a regra em {PLACE}"
    assert to(decision(include, "Nota"), include, "Outra nota") == f"nota alterada em {PLACE}"
    assert to(decision(include, "Nota"), include, None) == f"nota alterada em {PLACE}"
    assert to(decision(include, "Nota"), include, "Nota") is None
    assert to(decision(hide), hide) is None
    assert to(None, None) is None


async def test_favorite_change_reaches_only_the_central(
    client: AsyncClient, engine: AsyncEngine, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O aviso profile.changed vai à central com "favorites" (via central, quem fez); nada para o
    app do técnico; sem mudança, nenhum aviso."""
    await _seed(engine, world)
    published: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", capture)
    tech = str(world.tech.user.id)
    r = await client.put(f"{FAV}/{tech}", json=CITY, headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    [event] = published
    assert (event["type"], event["user_id"], event["actor_id"]) == (
        "profile.changed",
        tech,
        str(world.analyst.user.id),
    )
    assert (event["data"], event["audience"]) == (
        {"fields": ["favorites"], "via": "central"},
        {"managers_only": True},
    )
    published.clear()
    r = await client.put(f"{FAV}/{tech}", json=CITY, headers=world.analyst.headers)
    assert r.status_code == 200 and published == []
    r = await client.delete(f"{FAV}/{tech}", params=CITY, headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    assert [e["type"] for e in published] == ["profile.changed"]
    published.clear()
    r = await client.delete(f"{FAV}/{tech}", params=CITY, headers=world.analyst.headers)
    assert r.status_code == 200 and published == []


async def test_inactive_and_blocked_stay_out_of_the_automatic(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """Regressão da E1: Inativo e Bloqueado (situação na operação) saem do automático e o próximo
    sobe; fixado pela central, continua, com a situação; nas sugestões não entram."""
    ids = await _seed(engine, world)
    an = world.analyst.headers
    async with engine.begin() as conn:
        for name, status in (("Alfa", "inactive"), ("Bravo", "blocked")):
            await conn.execute(
                update(User)
                .where(User.id == uuid.UUID(ids[name]))
                .values(operational_status=status, operational_reason="Motivo de exemplo")
            )
    r = await client.get(f"{FAV}/city", params=CITY, headers=an)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [f["id"] for f in body["favorites"]] == [ids["Charlie"], ids["Delta"]]
    assert {o["id"] for o in body["others"]} >= {ids["Alfa"], ids["Bravo"]}

    r = await client.put(f"{FAV}/{ids['Alfa']}", json=CITY, headers=an)
    assert r.status_code == 200, r.text
    first = r.json()["favorites"][0]
    assert (first["id"], first["pinned"], first["operational_status"]) == (
        ids["Alfa"],
        True,
        "inactive",
    )
    store = r.json()
    assert store["key"] == "cidade exemplo"
    r = await client.get(
        f"{API}/technicians/suggest",
        params={"city": "Cidade Exemplo", "state": "SP", "limit": 10},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert not {ids["Alfa"], ids["Bravo"]} & {row["id"] for row in r.json()}
