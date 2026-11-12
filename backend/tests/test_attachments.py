"""Anexos da OS pela web: enviar com descrição, editar a legenda e excluir (gestão)."""

from pathlib import Path

import pytest
from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX


async def upload(client: AsyncClient, headers: dict, ticket_id: str, **data: str) -> dict:
    r = await client.post(
        f"{API}/tickets/{ticket_id}/attachments",
        files={"file": ("rack.jpg", b"\xff\xd8fake-jpeg", "image/jpeg")},
        data={"kind": "photo", **data},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def test_upload_with_description_and_edit(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    t = await create(client, world, assignee_id=str(world.tech.user.id))

    att = await upload(
        client, world.analyst.headers, t["id"], description="  Rack antes da organização  "
    )
    assert att["description"] == "Rack antes da organização"
    assert att["external"] is False

    # O técnico edita a legenda só do que ele enviou.
    mine = await upload(client, world.tech.headers, t["id"])
    r = await client.patch(
        f"{API}/attachments/{mine['id']}",
        json={"description": "Patch panel"},
        headers=world.tech.headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["description"] == "Patch panel"
    r = await client.patch(
        f"{API}/attachments/{att['id']}", json={"description": "x"}, headers=world.tech.headers
    )
    assert r.status_code == 403

    # A gestão edita qualquer uma; vazio apaga a legenda.
    r = await client.patch(
        f"{API}/attachments/{mine['id']}",
        json={"description": "   "},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200
    assert r.json()["description"] is None

    r = await client.patch(
        f"{API}/attachments/{att['id']}",
        json={"description": "x" * 501},
        headers=world.analyst.headers,
    )
    assert r.status_code == 422


async def test_delete_attachment_rules(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    t = await create(client, world, assignee_id=str(world.tech.user.id))
    att = await upload(client, world.tech.headers, t["id"])
    stored = list(tmp_path.rglob("*rack.jpg"))  # noqa: ASYNC240 (teste: confere o arquivo no disco)
    assert len(stored) == 1

    # Técnico não exclui.
    r = await client.delete(f"{API}/attachments/{att['id']}", headers=world.tech.headers)
    assert r.status_code == 403

    r = await client.delete(f"{API}/attachments/{att['id']}", headers=world.analyst.headers)
    assert r.status_code == 204, r.text
    assert not stored[0].exists()  # noqa: ASYNC240
    r = await client.get(f"{API}/tickets/{t['id']}/attachments", headers=world.analyst.headers)
    assert r.json() == []
    r = await client.delete(f"{API}/attachments/{att['id']}", headers=world.analyst.headers)
    assert r.status_code == 404

    # O histórico registra a exclusão (interno: o solicitante não vê).
    r = await client.get(f"{API}/tickets/{t['id']}/events", headers=world.analyst.headers)
    assert any(e["event_type"] == "attachment_removed" for e in r.json())
