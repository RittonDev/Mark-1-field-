"""Relatório público do cliente: o comprovante de custo não aparece, a OS reaberta mostra o
atendimento atual e só a visita do cliente conta como visualização."""

import base64
from datetime import datetime
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


async def upload_photo(client: AsyncClient, headers: dict, ticket_id: str, name: str) -> dict:
    r = await client.post(
        f"{API}/tickets/{ticket_id}/attachments",
        files={"file": (name, PNG, "image/png")},
        data={"kind": "photo"},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def report_url(client: AsyncClient, world: World, ticket_id: str) -> str:
    r = await client.post(
        f"{API}/tickets/{ticket_id}/report-link", headers=world.analyst.headers
    )
    assert r.status_code == 200, r.text
    return f"{API}/public/reports/{r.json()['token']}"


async def test_cost_receipt_photo_never_reaches_the_client(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    an = world.analyst.headers
    t = await create(client, world, title="Troca de fonte")
    await upload_photo(client, an, t["id"], "servico.png")
    receipt = await upload_photo(client, an, t["id"], "recibo-pedagio.png")
    expense = await client.post(
        f"{API}/tickets/{t['id']}/expenses",
        json={
            "kind": "toll",
            "description": "Pedágio",
            "quantity": 1,
            "unit_value": 12,
            "receipt_attachment_id": receipt["id"],
        },
        headers=an,
    )
    assert expense.status_code == 201, expense.text
    public = await report_url(client, world, t["id"])
    photos = [p["filename"] for p in (await client.get(public)).json()["photos"]]
    assert photos == ["servico.png"]

    # Sem o vínculo com o custo, volta a ser uma foto comum da OS.
    r = await client.patch(
        f"{API}/expenses/{expense.json()['id']}", json={"receipt_attachment_id": None}, headers=an
    )
    assert r.status_code == 200, r.text
    photos = [p["filename"] for p in (await client.get(public)).json()["photos"]]
    assert photos == ["servico.png", "recibo-pedagio.png"]


async def test_reopened_ticket_shows_the_current_visit(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Impressora", assignee_id=str(world.tech.user.id))
    t = await transition(client, th, t, "en_route")
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Rolo trocado")
    public = await report_url(client, world, t["id"])
    done = (await client.get(public)).json()
    assert done["finished_at"] is not None
    assert "Concluída" in [m["label"] for m in done["timeline"]]

    t = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    t = await transition(client, an, t, "reopened", note="Voltou a falhar")
    await transition(client, th, t, "in_progress")
    current = (await client.get(public)).json()
    assert current["status"] == "in_progress"
    # A conclusão antiga não é mais o resultado; a chegada que vale é a nova.
    assert current["finished_at"] is None
    assert "Concluída" not in [m["label"] for m in current["timeline"]]
    assert datetime.fromisoformat(current["arrived_at"]) > datetime.fromisoformat(
        done["arrived_at"]
    )


async def test_only_the_client_visit_counts_as_a_view(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Rede lenta", assignee_id=str(world.tech.user.id))
    public = await report_url(client, world, t["id"])
    link_url = f"{API}/tickets/{t['id']}/report-link"

    # A gestão conferindo (ou baixando o PDF) e o técnico da OS não contam.
    assert (await client.get(public, headers=an)).status_code == 200
    assert (await client.get(public, headers=th)).status_code == 200
    assert (await client.post(link_url, headers=an)).json()["views"] == 0

    # O cliente abre; recarregar logo em seguida não conta de novo.
    assert (await client.get(public)).status_code == 200
    assert (await client.get(public)).status_code == 200
    link = (await client.post(link_url, headers=an)).json()
    assert link["views"] == 1 and link["last_viewed_at"] is not None
