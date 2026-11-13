"""O técnico é terceiro: o app recebe só o básico da OS (cliente, local, agenda e escopo)."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from app.services.realtime import field_event
from tests.conftest import World, requires_db
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX

# Campos que são da gestão e não vão para o app do técnico.
OFFICE_ONLY = (
    "owner",
    "team",
    "project",
    "category",
    "client_reference",
    "requester_name",
    "requester",
    "requester_contact",
    "created_by",
    "response_due_at",
    "resolution_due_at",
    "first_response_at",
    "legacy",
    "recurrence",
    "authorized_by_name",
    "authorization_ref",
)


async def _upload(
    client: AsyncClient,
    headers: dict,
    ticket_id: str,
    kind: str,
    name: str = "rack.jpg",
    content: bytes = b"\xff\xd8fake-jpeg",
    content_type: str = "image/jpeg",
) -> dict:
    r = await client.post(
        f"{API}/tickets/{ticket_id}/attachments",
        files={"file": (name, content, content_type)},
        data={"kind": kind},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def test_technician_gets_only_the_basics(
    client: AsyncClient,
    world: World,
    engine: AsyncEngine,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE locations SET document = '11222333000181', contact_name = 'Paula',"
                " contact_phone = '(11) 98888-7777' WHERE id = :id"
            ),
            {"id": world.location_id},
        )
    tech, helper = world.tech.headers, world.tech_other.headers
    t = await create(
        client,
        world,
        assignee_id=str(world.tech.user.id),
        helper_ids=[str(world.tech_other.user.id)],
        requester_name="Fulano do cliente",
        client_reference="INC-2041",
        visit_note="Falar com a Paula",
        team_id=world.team_field_id,
    )
    office = (await client.get(f"{API}/tickets/{t['id']}", headers=world.analyst.headers)).json()
    assert office["owner"] and office["resolution_due_at"] and office["requester_name"]
    assert office["location"]["document"] == "11222333000181"

    seen = (await client.get(f"{API}/tickets/{t['id']}", headers=tech)).json()
    # Fica o básico: cliente, local (endereço e contato da loja), agenda e escopo.
    assert (seen["title"], seen["description"]) == ("Impressora atolando", "Bandeja 2")
    assert seen["customer"]["name"] == office["customer"]["name"]
    assert seen["location"]["name"] == "Matriz"
    assert seen["location"]["contact_phone"] == "(11) 98888-7777"
    assert seen["visit_note"] == "Falar com a Paula"
    # Sai o que é da gestão.
    for key in OFFICE_ONLY:
        assert seen[key] is None, key
    assert seen["tags"] == [] and seen["recurrence_30d"] == 0
    assert seen["location"]["document"] is None
    assert seen["assignee"]["email"] == ""
    assert {h["email"] for h in seen["helpers"]} == {""}
    # O sync do app recebe a mesma visão.
    pulled = (await client.get(f"{API}/sync/pull", headers=tech)).json()
    synced = next(x for x in pulled["tickets"] if x["id"] == t["id"])
    assert synced["owner"] is None and synced["resolution_due_at"] is None
    assert synced["location"]["document"] is None

    # Anexos: as fotos e o que ele mesmo enviou; documento do escritório fica de fora.
    doc = await _upload(
        client,
        world.analyst.headers,
        t["id"],
        "file",
        name="orcamento.pdf",
        content=b"%PDF-1.4\n%teste\n",
        content_type="application/pdf",
    )
    office_photo = await _upload(client, world.analyst.headers, t["id"], "photo")
    own = await _upload(client, tech, t["id"], "photo")
    url = f"{API}/tickets/{t['id']}/attachments"
    listed = (await client.get(url, headers=tech)).json()
    assert {a["id"] for a in listed} == {office_photo["id"], own["id"]}
    assert all(a["uploaded_by"]["email"] == "" for a in listed)
    assert doc["id"] in {a["id"] for a in (await client.get(url, headers=world.analyst.headers)).json()}

    # Horas: cada técnico da visita vê só as dele.
    for headers, desc in ((tech, "Cabeamento"), (helper, "Ajudante")):
        r = await client.post(
            f"{API}/tickets/{t['id']}/worklogs",
            json={"description": desc, "started_at": datetime.now(UTC).isoformat(), "minutes": 30},
            headers=headers,
        )
        assert r.status_code == 201, r.text
    logs = (await client.get(f"{API}/tickets/{t['id']}/worklogs", headers=tech)).json()
    assert [w["description"] for w in logs] == ["Cabeamento"]
    pulled = (await client.get(f"{API}/sync/pull", headers=helper)).json()
    assert [w["description"] for w in pulled["worklogs"]] == ["Ajudante"]
    assert pulled["comments"] == []


def test_realtime_event_for_technician_has_no_internal_data() -> None:
    event = {
        "type": "ticket.updated",
        "ticket_id": "t1",
        "ticket_code": "OS-000001",
        "status": "assigned",
        "priority": "p1",
        "assignee_id": "u1",
        "team_id": "team",
        "actor_id": "a1",
        "actor_name": "Analista",
        "version": 3,
        "occurred_at": "2026-11-12T10:00:00+00:00",
        "data": {"fields": ["owner_id"], "owner": "Fulana"},
    }
    out = field_event(event)
    assert not {"priority", "actor_name", "team_id"} & set(out)
    assert out["data"] == {} and out["ticket_id"] == "t1" and out["version"] == 3
    # Mudança na equipe da visita: o app só precisa dos ids que entraram.
    helpers = field_event(
        {**event, "type": "ticket.helpers_changed", "data": {"added_ids": ["u2"], "names": ["X"]}}
    )
    assert helpers["data"] == {"added_ids": ["u2"]}
