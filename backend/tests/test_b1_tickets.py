"""Regras da OS: edição, agenda, prazos de campo, horários, anexos, busca e privacidade do
técnico."""

import base64
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def _dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


async def _store(client: AsyncClient, world: World, **body: object) -> str:
    r = await client.post(
        f"{API}/customers/{world.customer_id}/locations",
        json=body,
        headers=world.analyst.headers,
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _sql(engine: AsyncEngine, sql: str, **params: object) -> None:
    async with engine.begin() as conn:
        await conn.execute(text(sql), params)


async def _events(client: AsyncClient, world: World, ticket_id: str) -> list[dict]:
    r = await client.get(f"{API}/tickets/{ticket_id}/events", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------ edição


async def test_null_in_a_required_field_is_a_clear_422(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    t = await create(client, world)
    url = f"{API}/tickets/{t['id']}"
    r = await client.patch(url, json={"impact": None}, headers=an)
    assert r.status_code == 422 and "O impacto não pode ficar vazio" in r.text
    for body in ({"title": None}, {"priority": None}, {"type": None}, {"urgency": None}):
        assert (await client.patch(url, json=body, headers=an)).status_code == 422, body
    r = await client.patch(url, json={"description": None}, headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["description"] == ""


async def test_editor_saves_agenda_and_technician_together(
    client: AsyncClient, world: World
) -> None:
    """Agenda e técnico no mesmo salvamento: o conflito é conferido com o técnico novo (e não
    com o que está saindo)."""
    an = world.analyst.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    day = (datetime.now(UTC) + timedelta(days=3)).replace(
        hour=13, minute=0, second=0, microsecond=0
    )

    def at(hours: float) -> str:
        return (day + timedelta(hours=hours)).isoformat()

    await create(
        client,
        world,
        title="Ocupa o atual",
        assignee_id=tech,
        scheduled_start=at(0),
        scheduled_end=at(1),
    )
    x = await create(client, world, title="Troca de técnico", assignee_id=tech)
    r = await client.patch(
        f"{API}/tickets/{x['id']}",
        json={
            "scheduled_start": at(0),
            "scheduled_end": at(1),
            "assignee_id": other,
            "expected_version": x["version"],
        },
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert r.json()["assignee"]["id"] == other and _dt(r.json()["scheduled_start"]) == day
    assigned = [e for e in await _events(client, world, x["id"]) if e["event_type"] == "assigned"]
    assert len(assigned) == 2  # a da abertura e a troca

    # O técnico novo está ocupado: 409 com o nome dele.
    await create(
        client,
        world,
        title="Ocupa o novo",
        assignee_id=other,
        scheduled_start=at(3),
        scheduled_end=at(4),
    )
    y = await create(client, world, title="Outra troca", assignee_id=tech)
    r = await client.patch(
        f"{API}/tickets/{y['id']}",
        json={"scheduled_start": at(3.5), "assignee_id": other},
        headers=an,
    )
    assert r.status_code == 409 and r.json()["code"] == "SCHEDULE_CONFLICT"
    assert "Redes" in r.json()["detail"]
    # O técnico não troca o técnico da OS.
    denied = await client.patch(
        f"{API}/tickets/{y['id']}", json={"assignee_id": other}, headers=world.tech.headers
    )
    assert denied.status_code == 403


async def test_agenda_never_leaves_scheduled_without_a_date(
    client: AsyncClient, world: World
) -> None:
    an, tech = world.analyst.headers, str(world.tech.user.id)
    later = (datetime.now(UTC) + timedelta(days=2)).replace(
        hour=12, minute=0, second=0, microsecond=0
    )
    t = await create(client, world, title="Agendada", assignee_id=tech)
    t = await transition(client, an, t, "scheduled", scheduled_start=later.isoformat())
    r = await client.patch(
        f"{API}/tickets/{t['id']}",
        json={"scheduled_start": None, "expected_version": t["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    cleared = r.json()
    assert (cleared["status"], cleared["scheduled_start"], cleared["scheduled_end"]) == (
        "assigned",
        None,
        None,
    )

    # "Desmarcar" pela mudança de status também tira da agenda.
    t2 = await create(client, world, title="Desmarcada", assignee_id=tech)
    t2 = await transition(
        client, an, t2, "scheduled", scheduled_start=(later + timedelta(hours=3)).isoformat()
    )
    t2 = await transition(client, an, t2, "assigned")
    assert (t2["scheduled_start"], t2["scheduled_end"]) == (None, None)

    # Só o novo início (depois do fim antigo): o fim acompanha a estimativa.
    t3 = await create(
        client,
        world,
        title="Remarcada",
        assignee_id=tech,
        estimated_minutes=90,
        scheduled_start=(later + timedelta(hours=6)).isoformat(),
        scheduled_end=(later + timedelta(hours=7)).isoformat(),
    )
    moved = later + timedelta(hours=10)
    r = await client.patch(
        f"{API}/tickets/{t3['id']}", json={"scheduled_start": moved.isoformat()}, headers=an
    )
    assert r.status_code == 200, r.text
    assert _dt(r.json()["scheduled_end"]) == moved + timedelta(minutes=90)


# ------------------------------------------------------------------ relógios de campo


async def test_arrival_deadline_follows_the_agreed_visit(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    store = await _store(client, world, name="Loja Paulista", city="São Paulo", state="SP")
    later = (datetime.now(UTC) + timedelta(days=3)).replace(microsecond=0)
    # Preventiva combinada para daqui a 3 dias: sem "Chegada atrasada" falsa.
    p = await create(
        client,
        world,
        title="Preventiva",
        type="preventive",
        location_id=store,
        scheduled_start=later.isoformat(),
    )
    assert _dt(p["arrival_due_at"]) == later + timedelta(minutes=30)
    assert p["arrival_status"] == "pending"

    # Corretiva: 4 h da abertura; agendada para depois, o prazo acompanha; sem agenda, volta.
    c = await create(client, world, title="PDV parado", location_id=store)
    assert _dt(c["arrival_due_at"]) - _dt(c["created_at"]) == timedelta(hours=4)
    url = f"{API}/tickets/{c['id']}"
    r = await client.patch(url, json={"scheduled_start": later.isoformat()}, headers=an)
    assert _dt(r.json()["arrival_due_at"]) == later + timedelta(minutes=30)
    r = await client.patch(url, json={"scheduled_start": None}, headers=an)
    assert _dt(r.json()["arrival_due_at"]) - _dt(c["created_at"]) == timedelta(hours=4)


async def test_second_visit_counts_only_the_time_left(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Rack", assignee_id=str(world.tech.user.id))
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, an, t, "on_hold_vendor", note="Aguardando peça")
    # A 1ª visita foi há 2 dias e durou 1 h.
    await _sql(
        engine,
        "UPDATE tickets SET arrived_at = now() - interval '2 days', work_seconds = 3600 "
        "WHERE id = :i",
        i=uuid.UUID(t["id"]),
    )
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    t = await transition(client, th, t, "in_progress")
    assert t["onsite_status"] == "ok"
    left = _dt(t["onsite_due_at"]) - datetime.now(UTC)
    assert abs(left - timedelta(hours=3)) < timedelta(minutes=2)
    assert 59 <= t["onsite_used_minutes"] <= 61


async def test_check_in_far_from_the_store(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    store = await _store(
        client,
        world,
        name="Loja Paulista",
        city="São Paulo",
        state="SP",
        latitude=-23.5614,
        longitude=-46.6559,
    )
    t = await create(
        client,
        world,
        title="Câmera sem imagem",
        location_id=store,
        assignee_id=str(world.tech.user.id),
        owner_id=str(world.analyst.user.id),
    )
    t = await transition(client, th, t, "en_route", latitude=-23.5614, longitude=-46.6559)
    t = await transition(client, th, t, "in_progress", latitude=-23.5434, longitude=-46.6559)
    events = await _events(client, world, t["id"])
    start = next(e for e in events if e["to_value"] == "en_route")
    arrival = next(e for e in events if e["to_value"] == "in_progress")
    assert start["data"]["distance_m"] < 50
    assert 1900 < arrival["data"]["distance_m"] < 2100
    queue = (await client.get(f"{API}/my-queue", headers=an)).json()
    item = next(i for i in queue["items"] if i["id"] == t["id"])
    far = next(r for r in item["reasons"] if r["code"] == "checkin_far")
    assert (far["label"], far["tone"]) == ("Check-in a 2 km da loja", "warning")
    day = (await client.get(f"{API}/activities/day", headers=an)).json()
    row = next(a for a in day["activities"] if a["ticket"]["id"] == t["id"])
    assert row["start_distance_m"] < 50 and 1900 < row["arrival_distance_m"] < 2100


# ------------------------------------------------------------------ horários reais


async def test_times_correction_keeps_the_pause_between_visits(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(
        client, world, title="Rack em duas visitas", assignee_id=str(world.tech.user.id)
    )
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, an, t, "on_hold_vendor", note="Aguardando peça")
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Peça instalada")

    # Visita 1: dia 1, 1 h. Visita 2: dois dias depois, 1 h.
    first = (datetime.now(UTC) - timedelta(days=3)).replace(microsecond=0)
    second = first + timedelta(days=2, hours=4)
    moves: dict[str, list[datetime]] = {
        "in_progress": [first, second],
        "on_hold_vendor": [first + timedelta(hours=1)],
        "resolved": [second + timedelta(hours=1)],
    }
    status_events = sorted(
        (e for e in await _events(client, world, t["id"]) if e["event_type"] == "status_changed"),
        key=lambda e: e["created_at"],
    )
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE tickets SET created_at = :c, arrived_at = :a, resolved_at = :r, "
                "work_seconds = 7200 WHERE id = :i"
            ),
            {
                "c": first - timedelta(hours=1),
                "a": first,
                "r": second + timedelta(hours=1),
                "i": uuid.UUID(t["id"]),
            },
        )
        for event in status_events:
            targets = moves.get(event["to_value"])
            moment = targets.pop(0) if targets else first - timedelta(hours=1)
            await conn.execute(
                text("UPDATE ticket_events SET created_at = :at WHERE id = :id"),
                {"at": moment, "id": uuid.UUID(event["id"])},
            )
    current = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert current["actual_minutes"] == 120

    # A chegada foi 10 min antes: soma os dois trechos (70 + 60), não o intervalo de 2 dias.
    r = await client.put(
        f"{API}/tickets/{t['id']}/times",
        json={
            "arrived_at": (first - timedelta(minutes=10)).isoformat(),
            "reason": "Chegou antes de registrar",
            "expected_version": current["version"],
        },
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert r.json()["actual_minutes"] == 130
    assert r.json()["onsite_status"] == "ok"


async def test_time_without_timezone_is_brasilia(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Sem fuso", assignee_id=str(world.tech.user.id))
    await _sql(
        engine,
        "UPDATE tickets SET created_at = created_at - interval '2 hours' WHERE id = :i",
        i=uuid.UUID(t["id"]),
    )
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    t = await transition(client, th, t, "in_progress")
    tz = ZoneInfo(settings.TIMEZONE)
    local = (datetime.now(tz) - timedelta(minutes=40)).replace(microsecond=0, tzinfo=None)
    r = await client.put(
        f"{API}/tickets/{t['id']}/times",
        json={"arrived_at": local.isoformat(), "reason": "Integração sem fuso"},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert _dt(r.json()["arrived_at"]) == local.replace(tzinfo=tz)
    # O calendário também aceita o período sem fuso.
    r = await client.get(
        f"{API}/calendar",
        params={"start": "2030-01-01T00:00:00", "end": "2030-01-02T00:00:00"},
        headers=an,
    )
    assert r.status_code == 200, r.text


# ------------------------------------------------------------------ fluxo do técnico


async def test_technician_finishes_only_while_working(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Nobreak", assignee_id=str(world.tech.user.id))
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, an, t, "on_hold_vendor", note="Aguardando bateria")
    url = f"{API}/tickets/{t['id']}/transition"
    body = {"to_status": "resolved", "resolution_notes": "ok", "expected_version": t["version"]}
    assert (await client.post(url, json=body, headers=th)).status_code == 403
    seen = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    assert "resolved" not in seen["allowed_transitions"]
    assert "in_progress" in seen["allowed_transitions"]
    # Motivo de SLA também é da central.
    t = await transition(client, th, t, "in_progress")
    late = {**body, "expected_version": t["version"], "violation_note": "Trânsito"}
    assert (await client.post(url, json=late, headers=th)).status_code == 403
    # A central conclui de onde estiver.
    t = await transition(client, an, t, "on_hold_vendor", note="Aguardando bateria")
    done = await transition(client, an, t, "resolved", resolution_notes="Resolvido remoto")
    assert done["status"] == "resolved"


async def test_unproductive_after_reschedule_keeps_the_new_date(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Improdutiva feita offline às 10h; a central remarcou às 10h30 (avisada no grupo); o app
    sincroniza às 11h: a nova data fica."""
    an, th = world.analyst.headers, world.tech.headers
    reason = (
        await client.post(
            f"{API}/unproductive-reasons",
            json={"name": "Loja fechada", "responsibility": "customer"},
            headers=an,
        )
    ).json()
    t = await create(client, world, title="Rede lenta", assignee_id=str(world.tech.user.id))
    await _sql(
        engine,
        "UPDATE tickets SET created_at = created_at - interval '2 hours' WHERE id = :i",
        i=uuid.UUID(t["id"]),
    )
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    t = await transition(client, th, t, "en_route")
    tomorrow = (datetime.now(UTC) + timedelta(days=1)).replace(
        hour=17, minute=0, second=0, microsecond=0
    )
    current = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    r = await client.patch(
        f"{API}/tickets/{t['id']}",
        json={"scheduled_start": tomorrow.isoformat(), "expected_version": current["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    op = {
        "client_op_id": uuid.uuid4().hex,
        "type": "unproductive",
        "ticket_id": t["id"],
        "payload": {"reason_id": reason["id"]},
        "client_timestamp": (datetime.now(UTC) - timedelta(minutes=30)).isoformat(),
    }
    res = (await client.post(f"{API}/sync/push", json={"operations": [op]}, headers=th)).json()
    result = res["results"][0]
    assert result["status"] == "applied", result
    kept = result["ticket"]
    assert (kept["status"], _dt(kept["scheduled_start"]), kept["unproductive_count"]) == (
        "scheduled",
        tomorrow,
        1,
    )
    day = (await client.get(f"{API}/activities/day", headers=an)).json()
    row = next(a for a in day["activities"] if a["ticket"]["id"] == t["id"])
    assert row["unproductive_reason"] == "Loja fechada" and row["unproductive_at"]
    assert day["summary"]["unproductive"] == 1


# ------------------------------------------------------------------ anexos


async def test_photo_upload_checks_the_content(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    an = world.analyst.headers
    t = await create(client, world, assignee_id=str(world.tech.user.id))
    url = f"{API}/tickets/{t['id']}/attachments"

    async def upload(name: str, content: bytes, content_type: str, kind: str) -> dict:
        r = await client.post(
            url, files={"file": (name, content, content_type)}, data={"kind": kind}, headers=an
        )
        assert r.status_code == 201, r.text
        return r.json()

    pdf = await upload("orcamento.jpg", b"%PDF-1.4\n%teste\n", "image/jpeg", "photo")
    svg = await upload("desenho.svg", b"<svg onload='x'/>", "image/svg+xml", "photo")
    assert (pdf["kind"], svg["kind"]) == ("file", "file")
    png = await upload("rack.png", PNG, "application/octet-stream", "photo")
    assert (png["kind"], png["content_type"]) == ("photo", "image/png")
    r = await client.post(
        url,
        files={"file": ("assinatura.png", PNG, "image/png")},
        data={"kind": "signature"},
        headers=an,
    )
    assert r.status_code == 422 and "tela de assinatura" in r.json()["detail"]


async def test_deleting_a_form_photo_reopens_the_required_form(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    an, th = world.analyst.headers, world.tech.headers
    template = {
        "name": "Fachada da loja",
        "requires_signature": False,
        "fields": [
            {"id": "fachada", "type": "photo", "label": "Foto da fachada", "required": True}
        ],
    }
    tpl = (await client.post(f"{API}/form-templates", json=template, headers=an)).json()
    t = await create(client, world, title="Letreiro", assignee_id=str(world.tech.user.id))
    tid = t["id"]
    form = (
        await client.post(f"{API}/tickets/{tid}/forms", json={"template_id": tpl["id"]}, headers=an)
    ).json()
    photos = []
    for _ in range(2):
        r = await client.post(
            f"{API}/tickets/{tid}/forms/{form['id']}/photos",
            files={"file": ("fachada.png", PNG, "image/png")},
            data={"field_id": "fachada"},
            headers=th,
        )
        assert r.status_code == 201, r.text
        photos.append(r.json()["id"])
    r = await client.put(
        f"{API}/tickets/{tid}/forms/{form['id']}/answers",
        json={"answers": {}, "complete": True},
        headers=th,
    )
    assert r.status_code == 200 and r.json()["status"] == "completed", r.text

    # Ainda sobra uma foto (o mínimo é 1): o formulário segue concluído.
    assert (await client.delete(f"{API}/attachments/{photos[0]}", headers=an)).status_code == 204
    detail = (await client.get(f"{API}/tickets/{tid}", headers=an)).json()
    assert detail["forms"][0]["status"] == "completed"
    # Sem a última, volta para "em andamento" e trava a conclusão da OS de novo.
    assert (await client.delete(f"{API}/attachments/{photos[1]}", headers=an)).status_code == 204
    detail = (await client.get(f"{API}/tickets/{tid}", headers=an)).json()
    assert detail["forms"][0]["status"] == "in_progress"
    assert list(tmp_path.rglob("*fachada.png")) == []  # noqa: ASYNC240 (teste: o disco)
    t = await transition(client, th, detail, "in_progress")
    r = await client.post(
        f"{API}/tickets/{tid}/transition",
        json={"to_status": "resolved", "resolution_notes": "ok", "expected_version": t["version"]},
        headers=th,
    )
    assert r.status_code == 422 and "Fachada da loja" in r.json()["detail"]


# ------------------------------------------------------------------ privacidade do técnico


async def test_each_technician_sees_only_his_own_reimbursement(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    tech, helper = world.tech, world.tech_other
    t = await create(client, world, assignee_id=str(tech.user.id), helper_ids=[str(helper.user.id)])
    url = f"{API}/tickets/{t['id']}/expenses"
    mine = await client.post(
        url, json={"kind": "km", "description": "Ida e volta", "quantity": 10}, headers=an
    )
    theirs = await client.post(
        url,
        json={
            "kind": "toll",
            "description": "Pedágio",
            "quantity": 1,
            "unit_value": "12.50",
            "technician_id": str(helper.user.id),
        },
        headers=an,
    )
    assert mine.status_code == 201 and theirs.status_code == 201, theirs.text

    def ids(detail: dict) -> list[str]:
        return [e["id"] for e in detail["expenses"]]

    seen = (await client.get(f"{API}/tickets/{t['id']}", headers=tech.headers)).json()
    assert ids(seen) == [mine.json()["id"]]
    seen = (await client.get(f"{API}/tickets/{t['id']}", headers=helper.headers)).json()
    assert ids(seen) == [theirs.json()["id"]]
    office = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert len(office["expenses"]) == 2


# ------------------------------------------------------------------ listas e busca


async def test_search_finds_store_customer_and_technician(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    store = await _store(
        client,
        world,
        name="Le Biscuit - Shopping Iguatemi",
        code="LB-027",
        city="Fortaleza",
        state="CE",
    )
    t = await create(
        client,
        world,
        title="Manutenção preventiva do PDV",
        location_id=store,
        assignee_id=str(world.tech.user.id),
    )
    other = await create(client, world, title="Troca de toner")

    async def found(q: str) -> list[str]:
        r = await client.get(f"{API}/tickets", params={"q": q}, headers=an)
        assert r.status_code == 200, r.text
        return [i["id"] for i in r.json()["items"]]

    for q in ("biscuit iguatemi", "IGUATEMI", "fortaleza", "Tecnico", "manutencao", "lb-027"):
        assert t["id"] in await found(q), q
    assert other["id"] not in await found("iguatemi")
    assert set(await found("Cliente Teste")) == {t["id"], other["id"]}
    # Pelo número: "os 2", "OS-000002" e "#2" trazem a OS primeiro (a paleta mostra poucas).
    number = other["number"]
    for q in (f"os {number}", f"OS-{number:06d}", f"#{number}"):
        assert (await found(q))[0] == other["id"], q
    assert await found("9" * 40) == []  # número fora do intervalo: sem erro


async def test_recurrence_ignores_cancelled_tickets(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    dup = await create(client, world, title="Aberta em duplicidade")
    await transition(client, an, dup, "cancelled", note="Duplicada")
    t = await create(client, world, title="Original")
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert detail["recurrence"]["count_30d"] == 0
    listing = (await client.get(f"{API}/tickets", params={"q": "Original"}, headers=an)).json()
    assert listing["items"][0]["recurrence_30d"] == 0
    await create(client, world, title="Voltou o problema")
    detail = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert detail["recurrence"]["count_30d"] == 1


async def test_list_items_keep_their_fields(client: AsyncClient, world: World) -> None:
    t = await create(
        client,
        world,
        assignee_id=str(world.tech.user.id),
        helper_ids=[str(world.tech_other.user.id)],
    )
    items = (await client.get(f"{API}/tickets", headers=world.analyst.headers)).json()["items"]
    item = next(i for i in items if i["id"] == t["id"])
    assert item["assignee"]["id"] == str(world.tech.user.id)
    assert [h["id"] for h in item["helpers"]] == [str(world.tech_other.user.id)]
    assert (item["customer"]["name"], item["location"]["name"]) == ("Cliente Teste", "Matriz")
    assert item["owner"]["id"] == str(world.supervisor.user.id)
    assert item["sla_status"] and "forms" not in item and "expenses" not in item
