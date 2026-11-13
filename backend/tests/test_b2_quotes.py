"""Orçamentos: aprovação pública com o IP da conexão e uma resposta só, lista filtrada no banco
(antes do limite) com os totais do topo, OS cancelada e assinatura cujo arquivo sumiu."""

import asyncio
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition
from tests.test_quotes import SIGNATURE

pytestmark = requires_db

API = settings.API_PREFIX
APPROVAL = {"name": "Paula Compras", "signature": SIGNATURE, "accept": True}


def quote_body(title: str, price: str = "100") -> dict:
    return {
        "title": title,
        "items": [
            {
                "description": "Mão de obra",
                "quantity": 1,
                "unit": "serviço",
                "unit_price": price,
                "kind": "service",
            }
        ],
    }


async def new_quote(
    client: AsyncClient, world: World, ticket_id: str, title: str, price: str = "100"
) -> dict:
    r = await client.post(
        f"{API}/tickets/{ticket_id}/quotes",
        json=quote_body(title, price),
        headers=world.analyst.headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def send(client: AsyncClient, world: World, quote: dict) -> str:
    r = await client.post(f"{API}/quotes/{quote['id']}/send", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def test_public_approval_uses_the_connection_ip_and_answers_once(
    client: AsyncClient,
    world: World,
    engine: AsyncEngine,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    t = await create(client, world, title="Rack")
    q = await new_quote(client, world, t["id"], "Organização do rack")
    token = await send(client, world, q)
    # Cabeçalho escrito pelo próprio cliente (e maior que a coluna): não vale como IP.
    forged = {"X-Forwarded-For": "1" * 200}

    async def approve() -> int:
        r = await client.post(
            f"{API}/public/quotes/{token}/approve", json=APPROVAL, headers=forged
        )
        return r.status_code

    # Dois cliques ao mesmo tempo: um aprova, o outro vê "já respondido".
    assert sorted(await asyncio.gather(approve(), approve())) == [200, 409]
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                text("SELECT status, decision_ip FROM quotes WHERE id = :i"), {"i": q["id"]}
            )
        ).one()
    assert (row.status, row.decision_ip) == ("approved", "127.0.0.1")
    events = (
        await client.get(f"{API}/tickets/{t['id']}/events", headers=world.analyst.headers)
    ).json()
    assert [e["event_type"] for e in events].count("quote_approved") == 1


async def test_list_filters_in_the_database_and_the_summary_counts_everything(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Loja")
    oldest = await new_quote(client, world, t["id"], "Recusado antigo", "100")
    token = await send(client, world, oldest)
    r = await client.post(
        f"{API}/public/quotes/{token}/reject", json={"reason": "Fora do orçamento"}
    )
    assert r.status_code == 200, r.text
    overdue = await new_quote(client, world, t["id"], "Vencido", "50")
    await send(client, world, overdue)
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE quotes SET valid_until = current_date - 2 WHERE id = :i"),
            {"i": overdue["id"]},
        )
    newest = await new_quote(client, world, t["id"], "Rascunho novo", "30")

    r = await client.get(f"{API}/quotes", params={"limit": 1}, headers=an)
    assert [q["id"] for q in r.json()] == [newest["id"]]
    assert r.headers["x-total-count"] == "3"
    # A situação é filtrada no banco, antes do limite: o mais antigo aparece.
    r = await client.get(f"{API}/quotes", params={"status": "rejected", "limit": 1}, headers=an)
    assert [q["id"] for q in r.json()] == [oldest["id"]]
    assert r.headers["x-total-count"] == "1"
    # Enviado com a validade vencida já conta como vencido (mesmo antes da rotina gravar).
    r = await client.get(f"{API}/quotes", params={"status": "expired"}, headers=an)
    assert [(q["id"], q["status"], q["location"]) for q in r.json()] == [
        (overdue["id"], "expired", "Matriz")
    ]
    assert (await client.get(f"{API}/quotes", params={"status": "sent"}, headers=an)).json() == []

    # Busca pelo código do orçamento (só ele) ou da OS (todos os dela).
    r = await client.get(f"{API}/quotes", params={"q": oldest["code"]}, headers=an)
    assert [q["id"] for q in r.json()] == [oldest["id"]]
    r = await client.get(f"{API}/quotes", params={"q": t["code"]}, headers=an)
    assert {q["id"] for q in r.json()} == {oldest["id"], overdue["id"], newest["id"]}
    r = await client.get(f"{API}/quotes", params={"q": "vencido"}, headers=an)
    assert [q["id"] for q in r.json()] == [overdue["id"]]

    summary = (await client.get(f"{API}/quotes/summary", headers=an)).json()["by_status"]
    assert summary["rejected"] == {"count": 1, "total": 100.0}
    assert summary["expired"] == {"count": 1, "total": 50.0}
    assert summary["draft"] == {"count": 1, "total": 30.0}
    assert summary["sent"] == {"count": 0, "total": 0.0}
    assert summary["approved"] == {"count": 0, "total": 0.0}


async def test_cancelled_ticket_freezes_its_quotes(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    an = world.analyst.headers
    t = await create(client, world, title="Duplicada")
    sent = await new_quote(client, world, t["id"], "Enviado antes")
    token = await send(client, world, sent)
    draft = await new_quote(client, world, t["id"], "Rascunho")
    await transition(client, world.supervisor.headers, t, "cancelled", note="OS duplicada")

    r = await client.post(f"{API}/tickets/{t['id']}/quotes", json=quote_body("Novo"), headers=an)
    assert r.status_code == 422 and "cancelada" in r.json()["detail"]
    r = await client.post(f"{API}/quotes/{draft['id']}/send", headers=an)
    assert r.status_code == 422
    # O cliente ainda abre o link para consulta, mas não aprova uma OS que não existe mais.
    assert (await client.get(f"{API}/public/quotes/{token}")).status_code == 200
    r = await client.post(f"{API}/public/quotes/{token}/approve", json=APPROVAL)
    assert r.status_code == 409 and "cancelada" in r.json()["detail"]


async def test_missing_signature_file_is_404(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    an = world.analyst.headers
    t = await create(client, world, title="Rack")
    q = await new_quote(client, world, t["id"], "Velcro")
    token = await send(client, world, q)
    r = await client.post(f"{API}/public/quotes/{token}/approve", json=APPROVAL)
    assert r.status_code == 200, r.text
    listed = (await client.get(f"{API}/tickets/{t['id']}/quotes", headers=an)).json()
    url = next(x["signature_url"] for x in listed if x["id"] == q["id"])
    assert (await client.get(url)).status_code == 200
    for stored in (tmp_path / "quotes").iterdir():
        stored.unlink()  # volume trocado ou backup restaurado sem a pasta de mídia
    missing = await client.get(url)
    assert missing.status_code == 404
    assert missing.json()["detail"] == "Arquivo não encontrado"
