"""Formulários na OS: a gestão anexa, o técnico preenche (com fotos) e só então assina e conclui."""

import base64
import uuid

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

PREVENTIVA = {
    "name": "Preventiva de rack",
    "fields": [
        {"id": "s1", "type": "section", "label": "Antes"},
        {
            "id": "rack_antes",
            "type": "photo",
            "label": "Foto do rack antes",
            "min_photos": 2,
            "max_photos": 4,
        },
        {"id": "obs", "type": "textarea", "label": "Observações", "required": True},
        {"id": "s2", "type": "section", "label": "Depois"},
        {"id": "rack_depois", "type": "photo", "label": "Foto do rack depois", "required": True},
        {"id": "organizado", "type": "yes_no", "label": "Cabos organizados?", "required": True},
        {"id": "tipo", "type": "choice", "label": "Tipo de rack", "options": ["Parede", "Piso"]},
    ],
}


async def photo(client: AsyncClient, h: dict, ticket_id: str, form_id: str, field: str) -> int:
    r = await client.post(
        f"{API}/tickets/{ticket_id}/forms/{form_id}/photos",
        files={"file": ("foto.png", PNG, "image/png")},
        data={"field_id": field},
        headers=h,
    )
    return r.status_code


async def test_required_form_gates_signature_and_closing(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    bad = {
        **PREVENTIVA,
        "fields": [{"id": "x", "type": "choice", "label": "X", "options": ["Só uma"]}],
    }
    assert (await client.post(f"{API}/form-templates", json=bad, headers=an)).status_code == 422
    tpl = (await client.post(f"{API}/form-templates", json=PREVENTIVA, headers=an)).json()
    assert tpl["fields"][1]["min_photos"] == 2

    t = await create(client, world, title="Organizar rack", assignee_id=str(world.tech.user.id))
    tid = t["id"]
    # Só a gestão decide o formulário da OS.
    r = await client.post(f"{API}/tickets/{tid}/forms", json={"template_id": tpl["id"]}, headers=th)
    assert r.status_code == 403
    form = (
        await client.post(f"{API}/tickets/{tid}/forms", json={"template_id": tpl["id"]}, headers=an)
    ).json()
    fid = form["id"]
    dup = await client.post(
        f"{API}/tickets/{tid}/forms", json={"template_id": tpl["id"]}, headers=an
    )
    assert dup.status_code == 422
    detail = (await client.get(f"{API}/tickets/{tid}", headers=th)).json()
    assert detail["signature_required"] is True and detail["forms"][0]["status"] == "pending"

    t = await transition(client, th, detail, "en_route")
    t = await transition(client, th, t, "in_progress")
    blocked = await client.post(
        f"{API}/tickets/{tid}/transition",
        json={"to_status": "resolved", "resolution_notes": "ok", "expected_version": t["version"]},
        headers=th,
    )
    assert blocked.status_code == 422 and "Preventiva de rack" in blocked.json()["detail"]
    sig = {"file": ("assinatura.png", PNG, "image/png")}
    early = await client.post(
        f"{API}/tickets/{tid}/signature",
        files=sig,
        data={"signer_name": "Paulo Gerente"},
        headers=th,
    )
    assert early.status_code == 422  # sem o formulário, não colhe assinatura

    answers = f"{API}/tickets/{tid}/forms/{fid}/answers"
    r = await client.put(answers, json={"answers": {"obs": "Rack sem etiqueta"}}, headers=th)
    assert r.json()["status"] == "in_progress"
    assert (
        await client.put(answers, json={"answers": {"tipo": "Teto"}}, headers=th)
    ).status_code == 422
    r = await client.put(
        answers, json={"answers": {"organizado": True}, "complete": True}, headers=th
    )
    assert r.status_code == 422
    assert "Foto do rack antes (2 fotos)" in r.json()["detail"]

    assert await photo(client, th, tid, fid, "rack_antes") == 201
    assert await photo(client, th, tid, fid, "rack_antes") == 201
    assert await photo(client, th, tid, fid, "rack_depois") == 201
    assert await photo(client, th, tid, fid, "obs") == 422  # campo que não é de foto
    r = await client.put(
        answers, json={"answers": {"tipo": "Parede"}, "complete": True}, headers=th
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "completed"
    assert r.json()["answers"] == {"obs": "Rack sem etiqueta", "organizado": True, "tipo": "Parede"}

    t = (await client.get(f"{API}/tickets/{tid}", headers=th)).json()
    still = await client.post(
        f"{API}/tickets/{tid}/transition",
        json={"to_status": "resolved", "resolution_notes": "ok", "expected_version": t["version"]},
        headers=th,
    )
    assert still.status_code == 422 and "assinatura" in still.json()["detail"]

    r = await client.post(
        f"{API}/tickets/{tid}/signature",
        files=sig,
        data={"signer_name": "Paulo  Gerente", "signer_role": "Gerente da loja"},
        headers=th,
    )
    assert r.status_code == 200, r.text
    assert (r.json()["signer_name"], r.json()["signer_role"]) == (
        "Paulo Gerente",
        "Gerente da loja",
    )
    # Assinado: o técnico não muda mais o formulário.
    locked = await client.put(answers, json={"answers": {"obs": "mudou"}}, headers=th)
    assert locked.status_code == 422

    t = await transition(client, th, r.json(), "resolved", resolution_notes="Rack organizado")
    assert t["status"] == "resolved"
    kinds = sorted(
        (a["kind"], a["field_id"])
        for a in (await client.get(f"{API}/tickets/{tid}/attachments", headers=an)).json()
    )
    assert kinds == [
        ("photo", "rack_antes"),
        ("photo", "rack_antes"),
        ("photo", "rack_depois"),
        ("signature", None),
    ]


async def test_form_answers_offline_and_optional_forms(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tpl = (
        await client.post(
            f"{API}/form-templates",
            json={**PREVENTIVA, "name": "Checklist PDV", "requires_signature": False},
            headers=an,
        )
    ).json()
    t = await create(client, world, title="PDV", assignee_id=str(world.tech.user.id))
    form = (
        await client.post(
            f"{API}/tickets/{t['id']}/forms",
            json={"template_id": tpl["id"], "required": False},
            headers=an,
        )
    ).json()

    # Respostas feitas offline chegam pelo sync, como as outras ações do app.
    op = {
        "client_op_id": uuid.uuid4().hex,
        "type": "form_answers",
        "ticket_id": t["id"],
        "payload": {
            "form_id": form["id"],
            "answers": {"obs": "Feito offline", "organizado": False},
        },
    }
    r = await client.post(f"{API}/sync/push", json={"operations": [op]}, headers=th)
    assert r.json()["results"][0]["status"] == "applied", r.text
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    assert detail["forms"][0]["answers"]["obs"] == "Feito offline"
    assert detail["signature_required"] is False

    # Opcional e sem assinatura: a OS conclui mesmo sem terminar o formulário.
    t = await transition(client, th, detail, "en_route")
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="ok")
    assert t["status"] == "resolved"

    # A gestão remove formulário (e as fotos dele) e pode dispensar a assinatura.
    t2 = await create(client, world, title="Outra", assignee_id=str(world.tech.user.id))
    f2 = (
        await client.post(
            f"{API}/tickets/{t2['id']}/forms", json={"template_id": tpl["id"]}, headers=an
        )
    ).json()
    assert await photo(client, th, t2["id"], f2["id"], "rack_depois") == 201
    r = await client.delete(f"{API}/tickets/{t2['id']}/forms/{f2['id']}", headers=th)
    assert r.status_code == 403
    r = await client.delete(f"{API}/tickets/{t2['id']}/forms/{f2['id']}", headers=an)
    assert r.status_code == 204
    assert (await client.get(f"{API}/tickets/{t2['id']}/attachments", headers=an)).json() == []
