"""Assistência externa (cliente e loja vindos da OS, etapa errada que volta com motivo, foto que
sumiu do disco) e projetos (progresso sem as canceladas, margem com o valor dos técnicos)."""

import base64
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


async def test_repair_takes_the_customer_and_store_from_the_ticket(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Impressora com ruído")
    r = await client.post(
        f"{API}/repairs", json={"ticket_id": t["id"], "problem": "Fusor com ruído"}, headers=an
    )
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["customer"]["id"] == world.customer_id
    assert out["location"]["id"] == world.location_id
    assert out["ticket"]["name"] == t["code"]
    only_store = await client.post(
        f"{API}/repairs",
        json={"location_id": world.location_id, "problem": "Não liga"},
        headers=an,
    )
    assert only_store.json()["customer"]["id"] == world.customer_id
    other = (await client.post(f"{API}/customers", json={"name": "Outra"}, headers=an)).json()
    wrong = await client.post(
        f"{API}/repairs",
        json={"ticket_id": t["id"], "customer_id": other["id"], "problem": "Teste"},
        headers=an,
    )
    assert wrong.status_code == 422 and "outro cliente" in wrong.json()["detail"]
    # Busca pelo código do registro.
    found = (await client.get(f"{API}/repairs", params={"q": out["code"]}, headers=an)).json()
    assert [f["id"] for f in found] == [out["id"]]


async def test_wrong_step_goes_back_with_a_reason(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    created = await client.post(
        f"{API}/repairs", json={"customer_id": world.customer_id, "problem": "Atolando"}, headers=an
    )
    repair = created.json()
    url = f"{API}/repairs/{repair['id']}/status"
    moved = (await client.post(url, json={"to_status": "received"}, headers=an)).json()
    assert moved["previous_status"] == "withdrawn"
    no_reason = await client.post(url, json={"to_status": "withdrawn"}, headers=an)
    assert no_reason.status_code == 422
    assert no_reason.json()["detail"] == "Informe o motivo para voltar à etapa anterior"
    back = await client.post(
        url, json={"to_status": "withdrawn", "note": "Cliquei na etapa errada"}, headers=an
    )
    assert back.status_code == 200, back.text
    out = back.json()
    assert (out["status"], out["previous_status"]) == ("withdrawn", None)
    assert out["allowed_next"] == ["received", "cancelled"]
    last = out["events"][-1]
    assert (last["from_status"], last["to_status"], last["note"]) == (
        "received",
        "withdrawn",
        "Cliquei na etapa errada",
    )
    # Volta só uma etapa por vez (a anterior), e a lista não carrega a linha do tempo.
    for step in ("received", "sent_to_vendor"):
        assert (await client.post(url, json={"to_status": step}, headers=an)).status_code == 200
    skip = await client.post(url, json={"to_status": "withdrawn", "note": "Errado"}, headers=an)
    assert skip.status_code == 422
    listed = (await client.get(f"{API}/repairs", headers=an)).json()
    assert [(r["events"], r["photos"], r["previous_status"]) for r in listed] == [([], [], None)]


async def test_missing_repair_photo_is_404(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    an = world.analyst.headers
    body = {"customer_id": world.customer_id, "problem": "Sem toner"}
    repair = (await client.post(f"{API}/repairs", json=body, headers=an)).json()
    photo = await client.post(
        f"{API}/repairs/{repair['id']}/photos",
        files={"file": ("etiqueta.png", PNG, "image/png")},
        headers=an,
    )
    url = photo.json()["photos"][0]["url"]
    assert (await client.get(url)).status_code == 200
    for stored in (tmp_path / "repairs").iterdir():
        stored.unlink()
    missing = await client.get(url)
    assert missing.status_code == 404 and missing.json()["detail"] == "Arquivo não encontrado"


async def test_project_progress_and_margin(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tech = str(world.tech.user.id)
    body = {"name": "Lojas Zona Norte", "customer_id": world.customer_id, "contract_value": "1000"}
    p = (await client.post(f"{API}/projects", json=body, headers=an)).json()
    done = await create(client, world, title="Loja 1", project_id=p["id"], assignee_id=tech)
    r = await client.put(
        f"{API}/tickets/{done['id']}/payouts/{tech}", json={"amount": 300}, headers=an
    )
    assert r.status_code == 200, r.text
    done = (await client.get(f"{API}/tickets/{done['id']}", headers=th)).json()
    done = await transition(client, th, done, "in_progress")
    await transition(client, th, done, "resolved", resolution_notes="Rack montado")
    gone = await create(client, world, title="Loja 2", project_id=p["id"])
    await transition(client, world.supervisor.headers, gone, "cancelled", note="Loja fechou")

    out = (await client.get(f"{API}/projects/{p['id']}", headers=an)).json()
    s = out["stats"]
    # A cancelada não vai ser feita: o projeto está completo com a outra concluída.
    assert (s["tickets_total"], s["tickets_cancelled"], s["tickets_done"], s["progress"]) == (
        2,
        1,
        1,
        1.0,
    )
    # O valor do técnico parceiro é o principal custo: entra na margem.
    assert (s["payouts_total"], out["margin"]) == (300.0, 700.0)
