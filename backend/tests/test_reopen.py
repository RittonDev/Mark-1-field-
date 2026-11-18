"""Reabrir OS fechada ou cancelada: só a central, com motivo, a qualquer momento."""

from pathlib import Path

import pytest
from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition
from tests.test_b2_forms import attach, template
from tests.test_forms import PNG

pytestmark = requires_db

API = settings.API_PREFIX


async def test_office_reopens_a_closed_os(client: AsyncClient, world: World) -> None:
    an, th, sup = world.analyst.headers, world.tech.headers, world.supervisor.headers
    t = await create(client, world, title="Nobreak apitando", assignee_id=str(world.tech.user.id))
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Bateria trocada")
    t = await transition(client, sup, t, "closed")
    assert t["closed_at"] and t["resolved_at"]

    office = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert office["allowed_transitions"] == ["reopened"]

    # O técnico e o solicitante não reabrem; sem motivo, nem a central.
    url = f"{API}/tickets/{t['id']}/transition"
    body = {"to_status": "reopened", "note": "Voltou a apitar", "expected_version": t["version"]}
    assert (await client.post(url, json=body, headers=th)).status_code == 403
    by_requester = await client.post(url, json=body, headers=world.requester.headers)
    assert by_requester.status_code in (403, 404)
    assert (await client.post(url, json={**body, "note": " "}, headers=an)).status_code == 422

    t = await transition(client, an, office, "reopened", note="Voltou a apitar")
    assert t["status"] == "reopened"
    assert t["closed_at"] is None and t["resolved_at"] is None
    assert t["reopen_count"] == 1
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    reopen = next(
        e for e in events if e["event_type"] == "status_changed" and e["to_value"] == "reopened"
    )
    assert (reopen["from_value"], reopen["note"]) == ("closed", "Voltou a apitar")
    assert reopen["actor"]["id"] == str(world.analyst.user.id)

    # Volta ao fluxo normal: o técnico atende de novo e a central fecha outra vez.
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Nobreak trocado")
    t = await transition(client, sup, t, "closed")
    assert t["status"] == "closed" and t["closed_at"] and t["reopen_count"] == 1
    assert t["resolution_notes"] == "Nobreak trocado"


async def test_office_reopens_a_cancelled_os(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Cancelada por engano")
    t = await transition(client, an, t, "cancelled", note="Achei que era duplicada")
    assert t["cancelled_at"]
    assert t["allowed_transitions"] == ["reopened"]

    t = await transition(client, an, t, "reopened", note="Não era duplicada")
    assert t["status"] == "reopened" and t["cancelled_at"] is None
    assert t["reopen_count"] == 1

    # Segue como qualquer OS na fila: ao receber o técnico, fica atribuída.
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": str(world.tech.user.id), "expected_version": t["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "assigned"


async def test_reopening_asks_for_a_new_signature(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A assinatura era do atendimento que terminou: reaberta, a OS fica sem ela, o técnico volta
    a mexer no formulário e a nova conclusão pede outra. O anexo antigo fica, protegido."""
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    an, th, sup = world.analyst.headers, world.tech.headers, world.supervisor.headers
    tpl = await template(client, world, requires_signature=True)
    t = await create(client, world, title="PDV", assignee_id=str(world.tech.user.id))
    form = await attach(client, world, t["id"], tpl["id"], required=True)
    answers = f"{API}/tickets/{t['id']}/forms/{form['id']}/answers"
    r = await client.put(answers, json={"answers": {"obs": "ok"}, "complete": True}, headers=th)
    assert r.status_code == 200, r.text
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    t = await transition(client, th, t, "in_progress")

    async def sign(name: str) -> dict:
        r = await client.post(
            f"{API}/tickets/{t['id']}/signature",
            files={"file": ("assinatura.png", PNG, "image/png")},
            data={"signer_name": name},
            headers=th,
        )
        assert r.status_code == 200, r.text
        return r.json()

    first = await sign("Gerente da Loja")
    old_signature = first["signature_attachment_id"]
    t = await transition(client, th, first, "resolved", resolution_notes="Rolo trocado")
    t = await transition(client, sup, t, "closed")
    t = await transition(client, an, t, "reopened", note="Voltou a falhar")
    assert (t["signed_at"], t["signer_name"], t["signer_role"], t["signature_attachment_id"]) == (
        None,
        None,
        None,
        None,
    )
    assert t["signature_required"] is True

    t = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    t = await transition(client, th, t, "in_progress")
    r = await client.put(
        answers, json={"answers": {"obs": "nova visita"}, "complete": True}, headers=th
    )
    assert r.status_code == 200, r.text  # destravado para o técnico
    blocked = await client.post(
        f"{API}/tickets/{t['id']}/transition",
        json={"to_status": "resolved", "resolution_notes": "ok", "expected_version": t["version"]},
        headers=th,
    )
    assert blocked.status_code == 422 and "assinatura" in blocked.json()["detail"]
    # A assinatura antiga continua nos anexos e no histórico, e não sai.
    r = await client.delete(f"{API}/attachments/{old_signature}", headers=an)
    assert r.status_code == 422
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    assert sum(e["event_type"] == "signature_collected" for e in events) == 1

    second = await sign("Gerente Novo")
    assert second["signature_attachment_id"] not in (None, old_signature)
    t = await transition(client, th, second, "resolved", resolution_notes="Fonte trocada")
    assert (t["status"], t["signer_name"]) == ("resolved", "Gerente Novo")
