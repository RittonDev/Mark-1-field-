"""Histórico do cadastro na central em páginas (GET /technicians/{id}/changes com `before`).

`before` = "{created_at}|{id}" da última linha recebida traz as linhas mais antigas que ela, na
mesma ordem (do mais novo para o mais antigo) e com o mesmo `limit`: a troca de PIX ou de e-mail
antiga continua alcançável depois das 200 mais novas, sem repetir nem pular linha (também com
várias linhas no mesmo instante). Sem `before`, igual a antes. Dados fictícios.
"""

import uuid
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.models import UserChange
from app.models.user_change import VIA_APP, VIA_CENTRAL
from tests.conftest import World, requires_db
from tests.test_access import restrict_analyst

pytestmark = requires_db

API = settings.API_PREFIX
PAGE_ERROR = {"detail": "Página do histórico inválida. Recarregue a ficha."}
START = datetime(2026, 9, 1, 12, 0, 0, 250000, tzinfo=UTC)
BRASILIA = timezone(timedelta(hours=-3))
PIX_CHANGES = [
    {"field": "pix", "from": None, "to": "CPF ***.456.789-**"},
    {"field": "pix_holder", "from": None, "to": "Tecnico Alfa"},
]
TOTAL = 230


def _before(row: dict[str, Any]) -> str:
    """O cursor como a ficha monta: o created_at e o id da última linha recebida."""
    return f"{row['created_at']}|{row['id']}"


async def _seed(engine: AsyncEngine, world: World) -> tuple[list[str], str]:
    """TOTAL linhas do técnico, de três em três no mesmo instante; a mais antiga é a troca de PIX.
    O colega ganha linhas nos mesmos instantes (não podem aparecer). Devolve os ids na ordem da
    lista (do mais novo para o mais antigo) e o id da linha de PIX."""
    tech, other = world.tech.user.id, world.tech_other.user.id
    rows: list[UserChange] = []
    for i in range(TOTAL):
        at = START + timedelta(minutes=i // 3, microseconds=(i // 3) * 1001)
        changes = PIX_CHANGES if i == 0 else [{"field": "tools", "from": None, "to": f"Item {i}"}]
        rows.append(
            UserChange(
                id=uuid.uuid4(),
                user_id=tech,
                actor_id=tech,
                via=VIA_APP,
                changes=changes,
                created_at=at,
            )
        )
        if i % 20 == 0:
            rows.append(
                UserChange(
                    id=uuid.uuid4(),
                    user_id=other,
                    actor_id=world.analyst.user.id,
                    via=VIA_CENTRAL,
                    changes=[{"field": "phone", "from": None, "to": "(11) 98888-7777"}],
                    created_at=at,
                )
            )
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add_all(rows)
        await db.commit()
    mine = [row for row in rows if row.user_id == tech]
    ordered = sorted(mine, key=lambda row: (row.created_at, row.id), reverse=True)
    return [str(row.id) for row in ordered], str(mine[0].id)


async def _page(
    client: AsyncClient, url: str, headers: dict[str, str], **params: Any
) -> list[dict[str, Any]]:
    r = await client.get(url, params=params, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def test_changes_pages_reach_the_old_pix_line(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    expected, pix_id = await _seed(engine, world)
    url = f"{API}/technicians/{world.tech.user.id}/changes"
    sup = world.supervisor.headers

    # Sem `before` (ou vazio): como antes, as 50 mais novas; no máximo 200.
    first = await _page(client, url, sup)
    assert [row["id"] for row in first] == expected[:50]
    assert await _page(client, url, sup, before="") == first
    top = await _page(client, url, sup, limit=200)
    assert [row["id"] for row in top] == expected[:200] and pix_id not in str(top)

    # A página seguinte às 200: as 30 mais antigas, com a troca de PIX inteira.
    rest = await _page(client, url, sup, limit=200, before=_before(top[-1]))
    assert [row["id"] for row in rest] == expected[200:]
    pix_row = next(row for row in rest if row["id"] == pix_id)
    assert pix_row["changes"] == PIX_CHANGES and pix_row["via"] == "app"
    assert await _page(client, url, sup, before=_before(rest[-1])) == []

    # De 50 em 50 até o fim: tudo, na ordem, sem repetir nem pular (a última página é menor).
    seen: list[str] = []
    page = first
    while page and len(seen) <= TOTAL:
        seen += [row["id"] for row in page]
        page = await _page(client, url, sup, before=_before(page[-1]))
    assert seen == expected and len(set(seen)) == TOTAL

    # O mesmo instante escrito com outro fuso dá a mesma página.
    last = first[-1]
    at = datetime.fromisoformat(last["created_at"])
    for written in (at.isoformat(), at.astimezone(BRASILIA).isoformat()):
        again = await _page(client, url, sup, before=f"{written}|{last['id']}")
        assert [row["id"] for row in again] == expected[50:100], written

    # Quem tem Técnicos sem Pagamentos: as mesmas páginas, com a chave como "***" e sem o titular.
    await restrict_analyst(
        client, world, **{"base.technicians": "view", "commercial.payouts": "none"}
    )
    an = world.analyst.headers
    hidden = await _page(client, url, an, limit=200)
    assert [row["id"] for row in hidden] == expected[:200]
    hidden_rest = await _page(client, url, an, limit=200, before=_before(hidden[-1]))
    assert [row["id"] for row in hidden_rest] == expected[200:]
    hidden_pix = next(row for row in hidden_rest if row["id"] == pix_id)
    assert hidden_pix["changes"] == [{"field": "pix", "from": None, "to": "***"}]
    assert "Tecnico Alfa" not in str(hidden_rest) and "456.789" not in str(hidden_rest)


async def test_changes_page_errors(client: AsyncClient, world: World) -> None:
    url = f"{API}/technicians/{world.tech.user.id}/changes"
    an = world.analyst.headers
    row_id = uuid.uuid4()
    for wrong in (
        "sem separador",
        f"2026-11-18T19:40:00|{row_id}",  # sem fuso
        "2026-11-18T19:40:00+00:00|nao-e-id",
        f"ontem|{row_id}",
        f"2026-11-18T19:40:00+00:00|{row_id}|extra",
        # Fora da faixa em UTC (antes do ano 1 e depois do 9999).
        f"0001-01-01T00:00:00+14:00|{row_id}",
        f"9999-12-31T23:59:59-14:00|{row_id}",
        # Longo demais, mesmo que o id ainda fosse lido ("{{id}}").
        "2026-11-18T19:40:00+00:00|" + "{" * 40 + str(row_id) + "}" * 40,
    ):
        r = await client.get(url, params={"before": wrong}, headers=an)
        assert (r.status_code, r.json()) == (422, PAGE_ERROR), wrong
    # Cursor certo sem linhas mais antigas: lista vazia; técnico que não existe continua 404.
    fine = {"before": f"2026-11-18T19:40:00Z|{row_id}"}
    r = await client.get(url, params=fine, headers=an)
    assert (r.status_code, r.json()) == (200, [])
    r = await client.get(f"{API}/technicians/{uuid.uuid4()}/changes", params=fine, headers=an)
    assert r.status_code == 404
    # O técnico não lê o histórico da central.
    assert (await client.get(url, params=fine, headers=world.tech.headers)).status_code == 403
