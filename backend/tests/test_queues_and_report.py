"""Analista responsável (fila), "Minha fila", filas da equipe e o relatório da OS para o cliente."""

import base64
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def _ids(page: dict) -> set[str]:
    return {i["id"] for i in page["items"]}


async def test_owner_claim_and_filters(client: AsyncClient, world: World) -> None:
    an, sup, th, req = (
        world.analyst.headers,
        world.supervisor.headers,
        world.tech.headers,
        world.requester.headers,
    )
    analyst_id, sup_id = str(world.analyst.user.id), str(world.supervisor.user.id)

    # Quem abre pela gestão fica responsável; pode escolher outro analista/gestor.
    t1 = await create(client, world, title="Impressora parada")
    assert t1["owner"]["id"] == sup_id
    body = {"title": "Switch sem link", "customer_id": world.customer_id}
    t2 = (
        await client.post(
            f"{API}/tickets", json={**body, "owner_id": str(world.admin.user.id)}, headers=an
        )
    ).json()
    assert t2["owner"]["name"] == "Admin"
    bad = await client.post(
        f"{API}/tickets", json={**body, "owner_id": str(world.tech.user.id)}, headers=an
    )
    assert bad.status_code == 422 and bad.json()["detail"] == "Escolha um analista ou gestor"
    # Aberta pelo solicitante: fica sem analista até alguém puxar.
    r1 = await client.post(f"{API}/tickets", json={"title": "Sem acesso ao ERP"}, headers=req)
    assert r1.status_code == 201 and r1.json()["owner"] is None
    r1 = r1.json()

    # Puxar para a minha fila: o técnico não muda, só o analista responsável.
    t3 = await create(client, world, title="Câmera offline", assignee_id=str(world.tech.user.id))
    claimed = await client.post(f"{API}/tickets/{t3['id']}/claim", headers=an)
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["owner"]["id"] == analyst_id
    assert claimed.json()["assignee"]["id"] == str(world.tech.user.id)
    again = await client.post(f"{API}/tickets/{t3['id']}/claim", headers=an)
    assert again.status_code == 422 and "já está na sua fila" in again.json()["detail"]
    assert (await client.post(f"{API}/tickets/{t3['id']}/claim", headers=th)).status_code == 403
    events = (await client.get(f"{API}/tickets/{t3['id']}/events", headers=an)).json()
    moved = next(e for e in events if e["event_type"] == "owner_changed")
    assert moved["note"] == "Analista puxou a OS de Super"
    assert moved["data"] == {"from_name": "Super", "to_name": "Analista"}

    # Transferir pela edição (só gestão; só para analista/gestor) e tirar da fila.
    url = f"{API}/tickets/{t1['id']}"
    tech_owner = await client.patch(url, json={"owner_id": str(world.tech.user.id)}, headers=an)
    assert tech_owner.status_code == 422
    moved = await client.patch(url, json={"owner_id": analyst_id}, headers=sup)
    assert moved.status_code == 200 and moved.json()["owner"]["id"] == analyst_id
    cleared = await client.patch(url, json={"owner_id": None}, headers=an)
    assert cleared.json()["owner"] is None
    denied = await client.patch(f"{API}/tickets/{t3['id']}", json={"owner_id": None}, headers=th)
    assert denied.status_code == 403

    # Assumir (técnico = eu) também coloca na minha fila quando a OS não tem analista.
    took = (await client.post(f"{API}/tickets/{r1['id']}/take", headers=an)).json()
    assert took["assignee"]["id"] == analyst_id and took["owner"]["id"] == analyst_id
    # O solicitante não vê a troca de fila no histórico.
    seen = (await client.get(f"{API}/tickets/{r1['id']}/events", headers=req)).json()
    assert all(e["event_type"] != "owner_changed" for e in seen)

    listing = f"{API}/tickets"
    owned = (await client.get(listing, params={"owner_id": analyst_id}, headers=an)).json()
    assert _ids(owned) == {t3["id"], r1["id"]}
    unowned = (await client.get(listing, params={"no_owner": "true"}, headers=an)).json()
    assert _ids(unowned) == {t1["id"]}
    mine = (await client.get(listing, params={"mine": "true"}, headers=an)).json()
    assert _ids(mine) == {t3["id"], r1["id"]}  # executa (r1) ou é o responsável (t3, r1)
    tech_mine = (await client.get(listing, params={"mine": "true"}, headers=th)).json()
    assert _ids(tech_mine) == {t3["id"]}


async def test_my_queue_sections_and_team_queues(client: AsyncClient, world: World) -> None:
    an, th, sup = world.analyst.headers, world.tech.headers, world.supervisor.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    mine = {"owner_id": str(world.analyst.user.id)}
    tz = ZoneInfo(settings.TIMEZONE)
    local_now = datetime.now(tz)
    in_two = (local_now + timedelta(days=2)).date()
    in_five = (local_now + timedelta(days=5)).date()
    now = datetime.now(UTC)

    field = await create(client, world, title="Em campo", assignee_id=tech, **mine)
    await transition(client, th, field, "en_route", latitude=-23.5, longitude=-46.6)
    late = await create(
        client,
        world,
        title="Atrasada",
        assignee_id=other,
        scheduled_start=(now - timedelta(minutes=5)).isoformat(),
        **mine,
    )
    today = await create(
        client,
        world,
        title="Daqui a dois dias",
        assignee_id=tech,
        scheduled_start=datetime.combine(in_two, time(12, 0), tzinfo=tz).isoformat(),
        **mine,
    )
    upcoming = await create(
        client,
        world,
        title="Daqui a cinco dias",
        assignee_id=tech,
        scheduled_start=datetime.combine(in_five, time(12, 0), tzinfo=tz).isoformat(),
        **mine,
    )
    waiting = await create(client, world, title="Aguardando", assignee_id=other, **mine)
    await transition(client, sup, waiting, "on_hold_customer")
    loose = await create(client, world, title="Sem agenda", assignee_id=tech, **mine)
    no_tech = await create(client, world, title="Sem técnico", **mine)

    reason = (
        await client.post(
            f"{API}/unproductive-reasons",
            json={"name": "Loja fechada", "responsibility": "customer"},
            headers=an,
        )
    ).json()
    bounced = await create(client, world, title="Improdutiva", assignee_id=other, **mine)
    bounced = await transition(client, world.tech_other.headers, bounced, "en_route")
    r = await client.post(
        f"{API}/tickets/{bounced['id']}/unproductive",
        json={"reason_id": reason["id"]},
        headers=world.tech_other.headers,
    )
    assert r.status_code == 200, r.text

    done = await create(client, world, title="Concluída hoje", assignee_id=other, **mine)
    done = await transition(client, world.tech_other.headers, done, "in_progress")
    await transition(client, world.tech_other.headers, done, "resolved", resolution_notes="ok")
    # Do supervisor e sem analista: não entram na fila do analista.
    await create(client, world, title="Do supervisor")
    await client.post(
        f"{API}/tickets", json={"title": "Do solicitante"}, headers=world.requester.headers
    )

    q = (await client.get(f"{API}/my-queue", headers=an)).json()
    assert q["user"]["id"] == str(world.analyst.user.id)
    by_id = {i["id"]: i for i in q["items"]}
    sections = {
        by_id[t["id"]]["title"]: by_id[t["id"]]["section"]
        for t in (field, late, today, upcoming, waiting, loose, no_tech, bounced, done)
    }
    assert sections == {
        "Em campo": "in_field",
        "Atrasada": "attention",
        "Daqui a dois dias": "upcoming",
        "Daqui a cinco dias": "upcoming",
        "Aguardando": "waiting",
        "Sem agenda": "unscheduled",
        "Sem técnico": "attention",
        "Improdutiva": "attention",
        "Concluída hoje": "done",
    }
    assert len(q["items"]) == 9
    codes = {i["title"]: [r["code"] for r in i["reasons"]] for i in q["items"]}
    assert codes["Atrasada"] == ["late_start"]
    assert codes["Sem técnico"] == ["no_technician"]
    assert codes["Improdutiva"] == ["unproductive"]
    assert codes["Sem agenda"] == [] and codes["Aguardando"] == []
    assert q["counts"] == {
        "open": 8,
        "attention": 3,
        "in_field": 1,
        "today": 0,
        "waiting": 1,
        "upcoming": 2,
        "unscheduled": 1,
        "done": 1,
    }
    # Seções na ordem da tela: atenção (pior primeiro), em campo, ... concluídas.
    order = [i["section"] for i in q["items"]]
    assert order == sorted(
        order,
        key=["attention", "in_field", "today", "waiting", "upcoming", "unscheduled", "done"].index,
    )
    assert q["items"][0]["reasons"][0]["tone"] == "danger"

    # Outro dia: a agendada para ele vira "hoje"; a concluída hoje sai.
    q2 = (
        await client.get(f"{API}/my-queue", params={"date": in_two.isoformat()}, headers=an)
    ).json()
    by_title = {i["title"]: i["section"] for i in q2["items"]}
    assert by_title["Daqui a dois dias"] == "today"
    assert by_title["Daqui a cinco dias"] == "upcoming"
    assert "Concluída hoje" not in by_title

    # Fila de um colega (qualquer gestor vê); técnico não tem fila.
    other_view = await client.get(
        f"{API}/my-queue", params={"user_id": str(world.analyst.user.id)}, headers=sup
    )
    assert {i["id"] for i in other_view.json()["items"]} == {i["id"] for i in q["items"]}
    assert (await client.get(f"{API}/my-queue", headers=th)).status_code == 403

    teams = (await client.get(f"{API}/queues", headers=sup)).json()
    by_name = {x["user"]["name"]: x for x in teams["queues"]}
    assert set(by_name) == {"Admin", "Analista", "Super"}  # só analistas e gestores
    assert by_name["Analista"]["role"] == "analyst"
    assert (by_name["Analista"]["open"], by_name["Analista"]["in_field"]) == (8, 1)
    assert by_name["Analista"]["attention"] == 3
    assert by_name["Super"]["open"] == 1
    assert teams["unowned"]["open"] == 1
    assert (await client.get(f"{API}/queues", headers=th)).status_code == 403


PREVENTIVA = {
    "name": "Preventiva de rack",
    "fields": [
        {"id": "s1", "type": "section", "label": "Antes"},
        {"id": "foto", "type": "photo", "label": "Foto do rack", "required": True},
        {"id": "ok", "type": "yes_no", "label": "Cabos organizados?", "required": True},
        {"id": "dia", "type": "date", "label": "Data da última preventiva"},
        {"id": "metros", "type": "number", "label": "Metros de velcro"},
        {"id": "tipo", "type": "choice", "label": "Tipo de rack", "options": ["Parede", "Piso"]},
    ],
}


async def test_client_report_link(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tpl = (await client.post(f"{API}/form-templates", json=PREVENTIVA, headers=an)).json()
    t = await create(client, world, title="Organizar rack", assignee_id=str(world.tech.user.id))
    tid = t["id"]
    form = (
        await client.post(f"{API}/tickets/{tid}/forms", json={"template_id": tpl["id"]}, headers=an)
    ).json()
    t = (await client.get(f"{API}/tickets/{tid}", headers=th)).json()
    t = await transition(client, th, t, "en_route", latitude=-23.5, longitude=-46.6)
    t = await transition(client, th, t, "in_progress", latitude=-23.51, longitude=-46.61)
    png = {"file": ("rack.png", PNG, "image/png")}
    r = await client.post(
        f"{API}/tickets/{tid}/forms/{form['id']}/photos",
        files=png,
        data={"field_id": "foto"},
        headers=th,
    )
    assert r.status_code == 201, r.text
    answers = {"ok": True, "dia": "2026-11-12", "metros": "2,5", "tipo": "Parede"}
    r = await client.put(
        f"{API}/tickets/{tid}/forms/{form['id']}/answers",
        json={"answers": answers, "complete": True},
        headers=th,
    )
    assert r.status_code == 200, r.text
    r = await client.post(
        f"{API}/tickets/{tid}/attachments",
        files={"file": ("depois.png", PNG, "image/png")},
        data={"kind": "photo"},
        headers=th,
    )
    assert r.status_code == 201
    # Coisas internas que nunca podem aparecer para o cliente.
    await client.post(
        f"{API}/tickets/{tid}/comments",
        json={"body": "nota interna secreta", "is_internal": True},
        headers=an,
    )
    await client.post(
        f"{API}/tickets/{tid}/expenses",
        json={"kind": "material", "description": "Velcro 3m", "quantity": 1, "unit_value": "15.90"},
        headers=an,
    )
    r = await client.post(
        f"{API}/tickets/{tid}/signature",
        files={"file": ("assinatura.png", PNG, "image/png")},
        data={"signer_name": "Paula Gerente", "signer_role": "Gerente da loja"},
        headers=th,
    )
    assert r.status_code == 200, r.text
    detail = (await client.get(f"{API}/tickets/{tid}", headers=an)).json()
    assert detail["report_link"] is None  # ainda em atendimento

    # Concluída: o link nasce sozinho; só a gestão recebe.
    msgs = (await client.get(f"{API}/tickets/{tid}/messages", headers=an)).json()
    closing = next(m["text"] for m in msgs if m["key"] == "fechamento")
    assert "Relatório: (disponível quando a OS for concluída)" in closing
    await transition(client, th, detail, "resolved", resolution_notes="Rack organizado")
    detail = (await client.get(f"{API}/tickets/{tid}", headers=an)).json()
    link = detail["report_link"]
    assert link["path"] == f"/relatorio/{link['token']}"
    assert link["url"] == f"{settings.WEB_URL}{link['path']}" and link["views"] == 0
    assert (await client.get(f"{API}/tickets/{tid}", headers=th)).json()["report_link"] is None
    version = detail["version"]

    public = f"{API}/public/reports"
    r = await client.get(f"{public}/{link['token']}")
    assert r.status_code == 200, r.text
    rep = r.json()
    assert (rep["code"], rep["status"], rep["company_name"]) == (
        t["code"],
        "resolved",
        "Maxx Field",
    )
    assert rep["technician"] == {"name": "Tecnico"}
    assert rep["customer"]["name"] == "Cliente Teste" and rep["location"]["name"] == "Matriz"
    assert rep["resolution_notes"] == "Rack organizado" and rep["check_in_gps"] is True
    assert [m["label"] for m in rep["timeline"]] == [
        "Aberta",
        "Técnico a caminho",
        "Chegada ao local",
        "Concluída",
    ]
    items = {i["label"]: i for i in rep["forms"][0]["items"]}
    assert items["Antes"]["type"] == "section"
    assert items["Cabos organizados?"]["value"] == "Sim"
    assert items["Data da última preventiva"]["value"] == "12/11/2026"
    assert items["Metros de velcro"]["value"] == "2,5"
    assert items["Tipo de rack"]["value"] == "Parede"
    assert len(items["Foto do rack"]["photos"]) == 1
    assert [p["filename"] for p in rep["photos"]] == ["depois.png"]
    assert rep["signature"]["name"] == "Paula Gerente"
    assert rep["signature"]["image_url"].startswith("http://test/api/v1/attachments/")
    photo_url = rep["photos"][0]["url"]
    assert photo_url.startswith("http://test/api/v1/attachments/")
    img = await client.get(photo_url.removeprefix("http://test"))
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    for secret in ("nota interna secreta", "Velcro"):
        assert secret not in r.text

    # A visita do cliente conta, mas não muda a versão da OS (não atrapalha quem está editando).
    detail = (await client.get(f"{API}/tickets/{tid}", headers=an)).json()
    assert detail["report_link"]["views"] == 1 and detail["report_link"]["last_viewed_at"]
    assert detail["version"] == version

    token = link["token"]
    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
    assert (await client.get(f"{public}/{tampered}")).status_code == 404
    assert (await client.get(f"{public}/qualquer-coisa")).status_code == 404

    # Novo link: o anterior para de funcionar e as visualizações recomeçam.
    new = (await client.post(f"{API}/tickets/{tid}/report-link/rotate", headers=an)).json()
    assert new["token"] != token and new["views"] == 0
    assert (await client.get(f"{public}/{token}")).status_code == 404
    assert (await client.get(f"{public}/{new['token']}")).status_code == 200
    same = (await client.post(f"{API}/tickets/{tid}/report-link", headers=an)).json()
    assert same["token"] == new["token"] and same["views"] == 1
    assert (await client.post(f"{API}/tickets/{tid}/report-link", headers=th)).status_code == 403

    # O texto de fechamento leva o link; {analista} é o responsável pela OS.
    custom = {"templates": [{"name": "Teste", "body": "{analista} | {link_relatorio}"}]}
    await client.put(f"{API}/message-templates", json=custom, headers=an)
    msgs = (await client.get(f"{API}/tickets/{tid}/messages", headers=an)).json()
    assert msgs[0]["text"] == f"Super | {new['url']}"
    await client.post(f"{API}/message-templates/reset", headers=an)

    # Reaberta: o link continua, mas a página avisa até concluir de novo.
    detail = (await client.get(f"{API}/tickets/{tid}", headers=an)).json()
    detail = await transition(client, an, detail, "reopened", note="Voltou a falhar")
    r = await client.get(f"{public}/{new['token']}")
    assert r.status_code == 409 and "reaberta" in r.json()["detail"]
    assert detail["report_link"]["token"] == new["token"]
    blocked = await client.post(f"{API}/tickets/{tid}/report-link", headers=an)
    assert blocked.status_code == 422
    assert blocked.json()["detail"] == "Disponível quando a OS for concluída"

    # Revogado e concluída de novo: nasce outro link.
    assert (await client.delete(f"{API}/tickets/{tid}/report-link", headers=an)).status_code == 204
    detail = (await client.get(f"{API}/tickets/{tid}", headers=an)).json()
    assert detail["report_link"] is None
    detail = await transition(client, th, detail, "in_progress")
    detail = await transition(client, th, detail, "resolved", resolution_notes="Trocado o patch")
    again = detail["report_link"]
    assert again is None  # o técnico concluiu: a resposta dele não traz o link
    again = (await client.get(f"{API}/tickets/{tid}", headers=an)).json()["report_link"]
    assert again["token"] not in (token, new["token"])
    assert (await client.get(f"{public}/{again['token']}")).status_code == 200

    # OS concluída sem link (ex.: antiga): o texto de fechamento cria na hora.
    await client.delete(f"{API}/tickets/{tid}/report-link", headers=an)
    msgs = (await client.get(f"{API}/tickets/{tid}/messages", headers=an)).json()
    closing = next(m["text"] for m in msgs if m["key"] == "fechamento")
    assert "/relatorio/" in closing
    detail = (await client.get(f"{API}/tickets/{tid}", headers=an)).json()
    assert detail["report_link"]["url"] in closing
