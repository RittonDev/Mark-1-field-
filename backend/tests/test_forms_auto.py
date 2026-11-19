"""Formulários que entram sozinhos na OS pelo tipo de OS e pela categoria (valendo as de baixo),
a lista explícita da Nova OS (com os desmarcados), a reconciliação antes da visita (troca de tipo
ou de categoria e "Levar também às OS que ainda não começaram"), o modelo desativado, o histórico
de uso do modelo e a resposta automática, ao vivo até a conclusão do formulário."""

import uuid
from datetime import UTC, date, datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from app.core.enums import TicketStatus
from app.services.form_prefill import prefill_for
from tests.conftest import World, requires_db
from tests.test_api import create, transition
from tests.test_queue_visibility import access_a

pytestmark = requires_db

API = settings.API_PREFIX
FIELDS = [{"id": "obs", "type": "textarea", "label": "Observações"}]


async def category(
    client: AsyncClient, world: World, name: str, parent: dict | None = None
) -> dict:
    body: dict = {"name": name}
    if parent is not None:
        body["parent_id"] = parent["id"]
    r = await client.post(f"{API}/categories", json=body, headers=world.supervisor.headers)
    assert r.status_code == 201, r.text
    return r.json()


async def service_type(
    client: AsyncClient, world: World, name: str, default: dict | None = None
) -> dict:
    body: dict = {"name": name, "estimated_minutes": 60}
    if default is not None:
        body["category_id"] = default["id"]
    r = await client.post(f"{API}/service-types", json=body, headers=world.supervisor.headers)
    assert r.status_code == 201, r.text
    return r.json()


async def template(client: AsyncClient, world: World, name: str, **extra: object) -> dict:
    body = {"name": name, "fields": FIELDS, "requires_signature": False, **extra}
    r = await client.post(f"{API}/form-templates", json=body, headers=world.analyst.headers)
    assert r.status_code == 201, r.text
    return r.json()


async def detail(client: AsyncClient, world: World, ticket_id: str) -> dict:
    r = await client.get(f"{API}/tickets/{ticket_id}", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    return r.json()


async def patch(client: AsyncClient, world: World, ticket_id: str, **body: object) -> dict:
    r = await client.patch(f"{API}/tickets/{ticket_id}", json=body, headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    return r.json()


async def events(client: AsyncClient, world: World, ticket_id: str, kind: str) -> list[dict]:
    r = await client.get(f"{API}/tickets/{ticket_id}/events", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    return [e for e in r.json() if e["event_type"] == kind]


def names(ticket: dict) -> list[str]:
    return [f["name"] for f in ticket["forms"]]


async def printers_scene(client: AsyncClient, world: World) -> tuple[dict, dict, dict, dict, dict]:
    """A ligado ao tipo T (obrigatório, pede assinatura); B à categoria-mãe "Impressoras"
    (opcional); C a "Redes"; D inativo, ligado a T."""
    printers = await category(client, world, "Impressoras")
    jam = await category(client, world, "Atolamento", printers)
    network = await category(client, world, "Redes")
    kind = await service_type(client, world, "Instalação de impressora")
    a = await template(
        client, world, "Checklist A", service_type_ids=[kind["id"]], requires_signature=True
    )
    b = await template(
        client, world, "Checklist B", category_ids=[printers["id"]], default_required=False
    )
    c = await template(client, world, "Checklist C", category_ids=[network["id"]])
    d = await template(client, world, "Checklist D", service_type_ids=[kind["id"]], is_active=False)
    return {"printers": printers, "jam": jam, "network": network, "type": kind}, a, b, c, d


async def test_new_ticket_gets_the_forms_of_its_type_and_category(
    client: AsyncClient, world: World
) -> None:
    scene, a, b, _, _ = await printers_scene(client, world)
    assert (b["category_ids"], b["default_required"]) == ([scene["printers"]["id"]], False)
    assert (a["category_ids"], a["default_required"]) == ([], True)

    t = await create(
        client, world, service_type_id=scene["type"]["id"], category_id=scene["jam"]["id"]
    )
    got = [(f["name"], f["required"], f["auto_attached"]) for f in t["forms"]]
    assert got == [("Checklist A", True, True), ("Checklist B", False, True)]
    assert t["signature_required"] is True
    added = await events(client, world, t["id"], "form_added")
    assert sorted((e["to_value"], e["actor"], e["note"]) for e in added) == [
        ("Checklist A", None, "Pelo tipo de OS “Instalação de impressora”"),
        ("Checklist B", None, "Pela categoria “Impressoras”"),
    ]
    assert all(e["data"]["auto"] is True for e in added)
    assert {e["data"]["template_id"] for e in added} == {a["id"], b["id"]}

    # Tipo com a categoria padrão "Impressoras > Atolamento", aberto sem categoria: B entra.
    jam_type = await service_type(client, world, "Atolamento de papel", scene["jam"])
    t = await create(client, world, service_type_id=jam_type["id"])
    assert t["category"]["id"] == scene["jam"]["id"]
    assert names(t) == ["Checklist B"]
    assert t["signature_required"] is False


async def test_explicit_forms_list_is_what_goes_in(client: AsyncClient, world: World) -> None:
    scene, a, b, c, d = await printers_scene(client, world)
    base = {"service_type_id": scene["type"]["id"], "category_id": scene["jam"]["id"]}

    # Lista vazia: nenhum formulário, e os ligados que ficaram de fora vão para o histórico.
    t = await create(client, world, forms=[], **base)
    assert t["forms"] == [] and t["signature_required"] is False
    created = await events(client, world, t["id"], "created")
    assert set(created[0]["data"]["forms_left_out"]) == {a["id"], b["id"]}

    # Exatamente a lista, na ordem: A é ligado (automático), C foi escolhido à mão.
    chosen = [
        {"template_id": c["id"], "required": True},
        {"template_id": a["id"], "required": False},
    ]
    t = await create(client, world, forms=chosen, **base)
    got = [(f["name"], f["required"], f["auto_attached"]) for f in t["forms"]]
    assert got == [("Checklist C", True, False), ("Checklist A", False, True)]
    assert t["signature_required"] is False
    number = t["number"]

    # Repetido, inexistente ou inativo: 422 e nenhuma OS (o número não é gasto).
    bad_lists = [
        ([{"template_id": a["id"]}, {"template_id": a["id"]}], "Formulário repetido na lista"),
        ([{"template_id": str(uuid.uuid4())}], "Modelo de formulário não encontrado"),
        ([{"template_id": d["id"]}], "Modelo de formulário inativo: Checklist D"),
    ]
    for forms, message in bad_lists:
        body = {
            "title": "Impressora parada",
            "customer_id": world.customer_id,
            "location_id": world.location_id,
            "forms": forms,
            **base,
        }
        r = await client.post(f"{API}/tickets", json=body, headers=world.supervisor.headers)
        assert (r.status_code, r.json()["detail"]) == (422, message)
    t = await create(client, world, **base)
    assert t["number"] == number + 1

    # Quem só vê a própria fila abre "Sem analista" já com os formulários (sem passos depois).
    await access_a(client, world, unowned=False)
    body = {
        "title": "OS sem analista",
        "customer_id": world.customer_id,
        "location_id": world.location_id,
        "owner_id": None,
        "forms": [{"template_id": c["id"], "required": True}],
    }
    r = await client.post(f"{API}/tickets", json=body, headers=world.analyst.headers)
    assert r.status_code == 201, r.text
    assert r.json()["owner"] is None and names(r.json()) == ["Checklist C"]


async def test_explicit_list_with_the_unchecked_forms(client: AsyncClient, world: World) -> None:
    scene, a, b, c, d = await printers_scene(client, world)
    base = {"service_type_id": scene["type"]["id"], "category_id": scene["jam"]["id"]}

    # A Nova OS mostrou B e o analista desmarcou; A ela não conhecia (o vínculo veio depois de a
    # tela carregar os modelos): A entra sozinho, pelo padrão do modelo, depois da lista. Só o
    # desmarcado que é ligado vai para o histórico (D está inativo; o outro id não é ligado).
    unchecked = [b["id"], d["id"], str(uuid.uuid4())]
    listed = [{"template_id": c["id"], "required": False}]
    t = await create(client, world, forms=listed, forms_left_out=unchecked, **base)
    got = [(f["name"], f["required"], f["auto_attached"]) for f in t["forms"]]
    assert got == [("Checklist C", False, False), ("Checklist A", True, True)]
    assert t["signature_required"] is True  # A pede assinatura e entrou obrigatório
    created = await events(client, world, t["id"], "created")
    assert created[0]["data"]["forms_left_out"] == [b["id"]]
    added = await events(client, world, t["id"], "form_added")
    assert sorted((e["to_value"], e["actor"] is None, e["note"]) for e in added) == [
        ("Checklist A", True, "Pelo tipo de OS “Instalação de impressora”"),
        ("Checklist C", False, None),
    ]
    # O desmarcado não volta sozinho com a troca de categoria antes da visita.
    t = await patch(client, world, t["id"], category_id=scene["printers"]["id"])
    assert names(t) == ["Checklist C", "Checklist A"]

    # Desmarcado e também na lista: vale a lista (nada fica de fora).
    t = await create(
        client, world, forms=[{"template_id": a["id"]}], forms_left_out=[a["id"]], **base
    )
    assert [(f["name"], f["auto_attached"]) for f in t["forms"]] == [
        ("Checklist A", True),
        ("Checklist B", True),
    ]
    created = await events(client, world, t["id"], "created")
    assert "forms_left_out" not in created[0]["data"]

    # Sem lista, os desmarcados não valem: entram os ligados, como sempre.
    t = await create(client, world, forms_left_out=[a["id"], b["id"]], **base)
    assert names(t) == ["Checklist A", "Checklist B"]
    created = await events(client, world, t["id"], "created")
    assert "forms_left_out" not in created[0]["data"]

    r = await client.post(
        f"{API}/tickets",
        json={
            "title": "Impressora parada",
            "customer_id": world.customer_id,
            "forms": [],
            "forms_left_out": [str(uuid.uuid4()) for _ in range(21)],
        },
        headers=world.supervisor.headers,
    )
    assert r.status_code == 422


async def test_inactive_template_stays_when_type_or_category_change(
    client: AsyncClient, world: World
) -> None:
    kind = await service_type(client, world, "Preventiva")
    other = await service_type(client, world, "Corretiva")
    a = await template(
        client, world, "Checklist A", service_type_ids=[kind["id"]], requires_signature=True
    )
    t = await create(client, world, service_type_id=kind["id"])
    assert names(t) == ["Checklist A"] and t["signature_required"] is True

    # Desativado pela lista de Formulários (que manda os vínculos e o padrão de obrigatório).
    keys = ("name", "fields", "service_type_ids", "category_ids", "default_required")
    body = {**{k: a[k] for k in keys}, "requires_signature": True, "is_active": False}
    r = await client.put(
        f"{API}/form-templates/{a['id']}", json=body, headers=world.analyst.headers
    )
    assert r.status_code == 200, r.text

    # As OS que já têm o formulário continuam com ele: só uma pessoa tira.
    printers = await category(client, world, "Impressoras")
    t = await patch(client, world, t["id"], category_id=printers["id"])
    assert names(t) == ["Checklist A"] and t["signature_required"] is True
    t = await patch(client, world, t["id"], service_type_id=other["id"])
    assert names(t) == ["Checklist A"] and t["signature_required"] is True
    assert await events(client, world, t["id"], "form_removed") == []


async def test_type_change_before_the_visit_reconciles_forms(
    client: AsyncClient, world: World
) -> None:
    kind = await service_type(client, world, "Preventiva")
    other = await service_type(client, world, "Corretiva")
    a = await template(
        client, world, "Checklist A", service_type_ids=[kind["id"]], requires_signature=True
    )
    g = await template(client, world, "Checklist G", service_type_ids=[other["id"]])
    e = await template(client, world, "Checklist E")

    t = await create(client, world, service_type_id=kind["id"])
    assert names(t) == ["Checklist A"] and t["signature_required"] is True
    r = await client.post(
        f"{API}/tickets/{t['id']}/forms",
        json={"template_id": e["id"], "required": False},
        headers=world.analyst.headers,
    )
    assert r.status_code == 201, r.text
    assert r.json()["auto_attached"] is False

    t = await patch(client, world, t["id"], service_type_id=other["id"])
    assert names(t) == ["Checklist E", "Checklist G"]
    assert [f["auto_attached"] for f in t["forms"]] == [False, True]
    # A exigência de assinatura vinha só do A, que saiu.
    assert t["signature_required"] is False
    removed = await events(client, world, t["id"], "form_removed")
    assert [(x["from_value"], x["actor"], x["note"]) for x in removed] == [
        ("Checklist A", None, "Saiu com a troca do tipo de OS")
    ]
    assert removed[0]["data"]["template_id"] == a["id"]
    updated = await events(client, world, t["id"], "updated")
    assert updated[0]["data"]["changes"]["signature_required"] == [True, False]

    # Com resposta, o automático não sai.
    started = await create(client, world, service_type_id=kind["id"])
    form_id = started["forms"][0]["id"]
    r = await client.put(
        f"{API}/tickets/{started['id']}/forms/{form_id}/answers",
        json={"answers": {"obs": "Começou"}},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    started = await patch(client, world, started["id"], service_type_id=other["id"])
    assert names(started) == ["Checklist A", "Checklist G"]

    # Tirado à mão não volta sozinho (nem com a troca da categoria).
    g_form = next(f for f in t["forms"] if f["template_id"] == g["id"])
    r = await client.delete(
        f"{API}/tickets/{t['id']}/forms/{g_form['id']}", headers=world.analyst.headers
    )
    assert r.status_code == 204
    printers = await category(client, world, "Impressoras")
    t = await patch(client, world, t["id"], category_id=printers["id"])
    assert names(t) == ["Checklist E"]

    # Em atendimento ou cancelada, a troca não mexe nos formulários.
    tech = str(world.tech.user.id)
    visit = await create(client, world, service_type_id=kind["id"], assignee_id=tech)
    visit = await transition(client, world.tech.headers, visit, "en_route")
    visit = await transition(client, world.tech.headers, visit, "in_progress")
    visit = await patch(client, world, visit["id"], service_type_id=other["id"])
    assert names(visit) == ["Checklist A"]
    gone = await create(client, world, service_type_id=kind["id"])
    await transition(client, world.supervisor.headers, gone, "cancelled", note="Duplicada")
    gone = await patch(client, world, gone["id"], service_type_id=other["id"])
    assert names(gone) == ["Checklist A"]


async def test_category_follows_the_type(client: AsyncClient, world: World) -> None:
    printers = await category(client, world, "Impressoras")
    network = await category(client, world, "Redes")
    chosen = await category(client, world, "Outra")
    kind = await service_type(client, world, "Instalação", printers)
    other = await service_type(client, world, "Cabeamento", network)

    # A categoria que veio do tipo acompanha a troca.
    t = await create(client, world, service_type_id=kind["id"])
    assert t["category"]["id"] == printers["id"]
    t = await patch(client, world, t["id"], service_type_id=other["id"])
    assert t["category"]["id"] == network["id"]
    # Tirar o tipo não mexe na categoria.
    t = await patch(client, world, t["id"], service_type_id=None)
    assert t["category"]["id"] == network["id"]
    # Sem categoria, o tipo traz a dele.
    empty = await create(client, world)
    empty = await patch(client, world, empty["id"], service_type_id=other["id"])
    assert empty["category"]["id"] == network["id"]

    # A escolhida à mão fica.
    manual = await create(client, world, service_type_id=kind["id"], category_id=chosen["id"])
    manual = await patch(client, world, manual["id"], service_type_id=other["id"])
    assert manual["category"]["id"] == chosen["id"]

    # A informada no corpo vence.
    sent = await create(client, world, service_type_id=kind["id"])
    sent = await patch(
        client, world, sent["id"], service_type_id=other["id"], category_id=chosen["id"]
    )
    assert sent["category"]["id"] == chosen["id"]


async def test_portal_request_gets_forms_when_the_central_sets_the_type(
    client: AsyncClient, world: World
) -> None:
    kind = await service_type(client, world, "Visita técnica")
    a = await template(client, world, "Checklist A", service_type_ids=[kind["id"]])
    r = await client.post(
        f"{API}/portal/requests",
        json={"location_id": world.location_id, "title": "Impressora sem toner"},
        headers=world.requester.headers,
    )
    assert r.status_code == 201, r.text
    ticket_id = r.json()["id"]
    assert (await detail(client, world, ticket_id))["forms"] == []

    t = await patch(client, world, ticket_id, service_type_id=kind["id"])
    assert t["status"] == "new"
    assert [(f["template_id"], f["auto_attached"]) for f in t["forms"]] == [(a["id"], True)]


async def test_apply_to_pending_reconciles_tickets_not_started(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    kind = await service_type(client, world, "Preventiva")
    elsewhere = await category(client, world, "Sem OS")
    f = await template(
        client, world, "Checklist F", category_ids=[elsewhere["id"]], default_required=False
    )
    url = f"{API}/form-templates/{f['id']}"
    base = {"name": "Checklist F", "fields": FIELDS, "requires_signature": False}

    tech = str(world.tech.user.id)
    os1 = await create(client, world, title="Loja 1", service_type_id=kind["id"])
    os2 = await create(client, world, title="Loja 2", service_type_id=kind["id"], assignee_id=tech)
    os2 = await transition(client, world.tech.headers, os2, "in_progress")
    os3 = await create(client, world, title="Loja 3", service_type_id=kind["id"])
    by_hand = {"template_id": f["id"]}
    r = await client.post(f"{API}/tickets/{os3['id']}/forms", json=by_hand, headers=an)
    assert r.status_code == 201, r.text
    r = await client.delete(f"{API}/tickets/{os3['id']}/forms/{r.json()['id']}", headers=an)
    assert r.status_code == 204

    # Sem a opção, o vínculo vale só para as próximas OS.
    r = await client.put(url, json={**base, "service_type_ids": [kind["id"]]}, headers=an)
    assert r.status_code == 200, r.text
    assert (r.json()["attached_to"], r.json()["detached_from"]) == (None, None)
    assert (await detail(client, world, os1["id"]))["forms"] == []

    # Com a opção: só a OS que não começou e de onde ninguém tirou o formulário.
    linked = {**base, "service_type_ids": [kind["id"]]}
    r = await client.put(url, params={"apply_to_pending": True}, json=linked, headers=an)
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["attached_to"], out["detached_from"], out["applied_to"]) == (1, 0, 0)
    # Sem category_ids nem default_required no corpo, o modelo mantém os dois; e só os vínculos
    # mudaram: a versão não sobe.
    assert (out["category_ids"], out["default_required"], out["version"]) == (
        [elsewhere["id"]],
        False,
        1,
    )
    form = (await detail(client, world, os1["id"]))["forms"]
    assert [(x["template_id"], x["required"], x["auto_attached"]) for x in form] == [
        (f["id"], False, True)
    ]
    assert (await detail(client, world, os2["id"]))["forms"] == []
    assert (await detail(client, world, os3["id"]))["forms"] == []

    # Tirando o tipo: sai de onde entrou sozinho e ninguém começou.
    r = await client.put(url, params={"apply_to_pending": True}, json=base, headers=an)
    assert (r.json()["attached_to"], r.json()["detached_from"]) == (0, 1)
    assert (await detail(client, world, os1["id"]))["forms"] == []
    removed = await events(client, world, os1["id"], "form_removed")
    assert [(x["actor"], x["note"]) for x in removed] == [
        (None, "O modelo não está mais ligado ao tipo nem à categoria desta OS")
    ]
    # Saiu sozinho (sem autor): ligando de novo, volta. Respondido, não sai mais.
    r = await client.put(url, params={"apply_to_pending": True}, json=linked, headers=an)
    assert r.json()["attached_to"] == 1
    form_id = (await detail(client, world, os1["id"]))["forms"][0]["id"]
    r = await client.put(
        f"{API}/tickets/{os1['id']}/forms/{form_id}/answers",
        json={"answers": {"obs": "Respondido"}},
        headers=an,
    )
    assert r.status_code == 200, r.text
    r = await client.put(url, params={"apply_to_pending": True}, json=base, headers=an)
    assert (r.json()["attached_to"], r.json()["detached_from"]) == (0, 0)
    assert len((await detail(client, world, os1["id"]))["forms"]) == 1

    # O modelo novo já entra nas OS que não começaram.
    r = await client.post(
        f"{API}/form-templates",
        params={"apply_to_pending": True},
        json={**base, "name": "Checklist F2", "service_type_ids": [kind["id"]]},
        headers=an,
    )
    assert r.status_code == 201, r.text
    assert r.json()["attached_to"] == 2
    assert "Checklist F2" in names(await detail(client, world, os3["id"]))
    assert "Checklist F2" not in names(await detail(client, world, os2["id"]))


async def test_category_link_covers_subcategories(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    printers = await category(client, world, "Impressoras")
    laser = await category(client, world, "Laser", printers)
    toner = await category(client, world, "Toner", laser)
    f = await template(client, world, "Checklist F")
    t = await create(client, world, category_id=toner["id"])
    assert t["forms"] == []

    # Ligar à categoria-mãe leva às OS das netas que não começaram.
    body = {
        "name": "Checklist F",
        "fields": FIELDS,
        "requires_signature": False,
        "category_ids": [printers["id"]],
    }
    url = f"{API}/form-templates/{f['id']}"
    r = await client.put(url, params={"apply_to_pending": True}, json=body, headers=an)
    assert (r.json()["attached_to"], r.json()["detached_from"]) == (1, 0)
    added = await events(client, world, t["id"], "form_added")
    assert [(x["actor"], x["note"]) for x in added] == [(None, "Pela categoria “Impressoras”")]

    # A troca de categoria antes da visita também traz o formulário.
    other = await create(client, world)
    other = await patch(client, world, other["id"], category_id=laser["id"])
    assert [(x["name"], x["auto_attached"]) for x in other["forms"]] == [("Checklist F", True)]
    # E tirar a categoria tira o automático que ninguém começou.
    other = await patch(client, world, other["id"], category_id=None)
    assert other["forms"] == []
    removed = await events(client, world, other["id"], "form_removed")
    assert [x["note"] for x in removed] == ["Saiu com a troca da categoria"]

    r = await client.put(
        url, params={"apply_to_pending": True}, json={**body, "category_ids": []}, headers=an
    )
    assert (r.json()["attached_to"], r.json()["detached_from"]) == (0, 1)
    assert (await detail(client, world, t["id"]))["forms"] == []


async def test_prefill_until_the_form_is_completed(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    catalog = (await client.get(f"{API}/form-templates/catalog", headers=an)).json()
    sources = {s["key"]: s for s in catalog["prefill_sources"]}
    assert sources["visit_date"]["types"] == ["text", "textarea", "date"]
    assert sources["location_name"]["label"] == "Nome da loja"

    fields = [
        {
            "id": "loja",
            "type": "text",
            "label": "Loja",
            "required": True,
            "prefill": "location_name",
        },
        {"id": "tecnico", "type": "text", "label": "Técnico", "prefill": "technician"},
        {"id": "data", "type": "date", "label": "Data", "required": True, "prefill": "visit_date"},
        {"id": "qtd", "type": "number", "label": "Quantidade", "prefill": "location_name"},
        {"id": "obs", "type": "textarea", "label": "Observações"},
    ]
    tpl = await template(client, world, "Relatório da visita", fields=fields)
    by_id = {x["id"]: x for x in tpl["fields"]}
    assert by_id["qtd"]["prefill"] is None and by_id["obs"]["prefill"] is None
    assert by_id["data"]["prefill"] == "visit_date"

    start = datetime(2026, 12, 3, 13, 0, tzinfo=UTC)  # 10h em Brasília
    t = await create(
        client, world, assignee_id=str(world.tech.user.id), scheduled_start=start.isoformat()
    )
    r = await client.post(
        f"{API}/tickets/{t['id']}/forms", json={"template_id": tpl["id"]}, headers=an
    )
    assert r.status_code == 201, r.text
    expected = {"loja": "Matriz", "tecnico": "Tecnico", "data": "2026-12-03"}
    assert r.json()["prefill"] == expected
    form = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()["forms"][0]
    assert (form["prefill"], form["answers"]) == (expected, {})

    # Concluir sem responder nada: a resposta automática conta e fica gravada.
    r = await client.put(
        f"{API}/tickets/{t['id']}/forms/{form['id']}/answers",
        json={"answers": {}, "complete": True},
        headers=th,
    )
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["answers"], r.json()["prefill"]) == (
        "completed",
        expected,
        {},
    )

    # Depois de concluído, trocar o técnico não muda as respostas.
    t = await patch(client, world, t["id"], assignee_id=str(world.tech_other.user.id))
    assert t["forms"][0]["answers"] == expected and t["forms"][0]["prefill"] == {}


async def test_template_put_without_the_prefill_key_keeps_it(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    fields = [
        {"id": "loja", "type": "text", "label": "Loja", "prefill": "location_name"},
        {"id": "data", "type": "date", "label": "Data", "prefill": "visit_date"},
        {"id": "obs", "type": "textarea", "label": "Obs"},
    ]
    tpl = await template(client, world, "Relatório da visita", fields=fields)
    url = f"{API}/form-templates/{tpl['id']}"
    body = {"name": tpl["name"], "service_type_ids": [], "requires_signature": False}
    # O editor aberto antes da resposta automática existir manda cada pergunta com estas chaves.
    keys = ("id", "type", "label", "help", "required", "options", "min_photos", "max_photos")

    def old_tab(current: list[dict]) -> list[dict]:
        return [{k: f[k] for k in keys} for f in current]

    def sources(out: dict) -> dict[str, str | None]:
        return {f["id"]: f["prefill"] for f in out["fields"]}

    # Sem a chave, a resposta automática fica; sem outra mudança, a versão não sobe.
    r = await client.put(url, json={**body, "fields": old_tab(tpl["fields"])}, headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 1
    assert sources(r.json()) == {"loja": "location_name", "data": "visit_date", "obs": None}

    # Corrigir um texto sobe a versão e mantém a fonte; a pergunta que virou número perde a dela
    # (o tipo não aceita).
    changed = old_tab(r.json()["fields"])
    changed[0]["type"], changed[2]["label"] = "number", "Observações"
    r = await client.put(url, json={**body, "fields": changed}, headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2
    assert sources(r.json()) == {"loja": None, "data": "visit_date", "obs": None}

    # null explícito limpa.
    cleared = [{**f, "prefill": None} for f in r.json()["fields"]]
    r = await client.put(url, json={**body, "fields": cleared}, headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 3
    assert sources(r.json()) == {"loja": None, "data": None, "obs": None}


def test_prefill_values_of_each_source() -> None:
    store = SimpleNamespace(
        name="Loja Exemplo",
        code="L-41",
        address_line="Rua Exemplo, 100",
        district="Centro",
        city="Cidade Exemplo",
        state="sp",
    )
    ticket = SimpleNamespace(
        location=store,
        customer=SimpleNamespace(name="Cliente Exemplo"),
        service_address=None,
        number=123,
        assignee=None,
        service_type=SimpleNamespace(name="Preventiva"),
        status=TicketStatus.IN_PROGRESS,
        # Em atendimento vale o dia local do início do trecho atual (23h30 de 03/12 em Brasília),
        # e não o da primeira chegada nem o da agenda.
        work_started_at=datetime(2026, 12, 4, 2, 30, tzinfo=UTC),
        arrived_at=datetime(2026, 11, 24, 13, 0, tzinfo=UTC),
        scheduled_start=datetime(2026, 12, 1, 13, 0, tzinfo=UTC),
        resolved_at=None,
        closed_at=None,
    )
    sources = [
        "location_name",
        "location_code",
        "customer",
        "address",
        "city",
        "ticket_code",
        "technician",
        "service_type",
        "visit_date",
    ]
    fields = [{"id": s, "type": "text", "prefill": s} for s in sources] + [
        {"id": "dia", "type": "date", "prefill": "visit_date"},
        {"id": "qtd", "type": "number", "prefill": "customer"},
        {"id": "obs", "type": "textarea"},
    ]
    # Sem técnico, o campo fica sem valor; a pergunta já respondida não recebe nada.
    assert prefill_for(ticket, fields, {"customer": "Respondido"}) == {  # type: ignore[arg-type]
        "location_name": "Loja Exemplo",
        "location_code": "L-41",
        "address": "Rua Exemplo, 100, Centro, Cidade Exemplo-SP",
        "city": "Cidade Exemplo-SP",
        "ticket_code": "OS-000123",
        "service_type": "Preventiva",
        "visit_date": "03/12/2026",
        "dia": "2026-12-03",
    }

    def visit(**changes: object) -> tuple[str | None, str | None]:
        """A data da visita nas perguntas de data e de texto (a mesma ao vivo e na conclusão)."""
        for key, value in changes.items():
            setattr(ticket, key, value)
        got = prefill_for(ticket, fields, {})  # type: ignore[arg-type]
        return got.get("dia"), got.get("visit_date")

    # A OS migrada do Field Control em atendimento não tem o início do trecho: vale a chegada.
    assert visit(work_started_at=None) == ("2026-11-24", "24/11/2026")
    # Resolvida ou fechada: o dia local da conclusão (23h50 de 05/12 em Brasília); sem ela, o do
    # fechamento.
    finished = datetime(2026, 12, 6, 2, 50, tzinfo=UTC)
    assert visit(status=TicketStatus.RESOLVED, resolved_at=finished) == ("2026-12-05", "05/12/2026")
    assert visit(status=TicketStatus.CLOSED) == ("2026-12-05", "05/12/2026")
    closed = datetime(2026, 12, 8, 12, 0, tzinfo=UTC)
    assert visit(resolved_at=None, closed_at=closed) == ("2026-12-08", "08/12/2026")
    # Fora disso, depois de uma chegada (pausada, a caminho de novo, reaberta, de volta à agenda
    # depois de uma improdutiva), a data seria a de uma ida anterior: não vem.
    for status in (
        TicketStatus.ON_HOLD_CUSTOMER,
        TicketStatus.ON_HOLD_VENDOR,
        TicketStatus.EN_ROUTE,
        TicketStatus.REOPENED,
        TicketStatus.SCHEDULED,
        TicketStatus.ASSIGNED,
    ):
        assert visit(status=status) == (None, None), status
    # Antes da primeira chegada, a da agenda; sem agenda, nada.
    assert visit(status=TicketStatus.SCHEDULED, arrived_at=None) == ("2026-12-01", "01/12/2026")
    assert visit(status=TicketStatus.NEW, scheduled_start=None) == (None, None)

    # O endereço do atendimento vence o da loja.
    ticket.service_address = "Av. Exemplo, 200"
    assert prefill_for(ticket, fields, {})["address"] == "Av. Exemplo, 200"  # type: ignore[arg-type]


async def _shift(engine: AsyncEngine, ticket_id: str, days: int, *columns: str) -> None:
    """Recua as datas da OS em `days` dias: a visita que aconteceu em outro dia."""
    moved = ", ".join(f"{c} = {c} - make_interval(days => :days)" for c in columns)
    async with engine.begin() as conn:
        await conn.execute(
            text(f"UPDATE tickets SET {moved} WHERE id = :id"), {"id": ticket_id, "days": days}
        )


async def _local_day(engine: AsyncEngine, ticket_id: str, column: str) -> date:
    async with engine.connect() as conn:
        moment = await conn.scalar(
            text(f"SELECT {column} FROM tickets WHERE id = :id"), {"id": ticket_id}
        )
    return moment.astimezone(ZoneInfo(settings.TIMEZONE)).date()


def _shown(day: date) -> dict[str, str]:
    """A data da visita nas perguntas de data e de texto."""
    return {"data": day.isoformat(), "dia": day.strftime("%d/%m/%Y")}


async def test_visit_date_follows_the_current_visit(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Uma regra só para o valor ao vivo e para a conclusão: a resposta gravada é a que a pergunta
    mostrava, também quando a central conclui."""
    an, th, sup = world.analyst.headers, world.tech.headers, world.supervisor.headers
    asked = [
        {"id": "data", "type": "date", "label": "Data", "required": True, "prefill": "visit_date"},
        {"id": "dia", "type": "text", "label": "Dia", "prefill": "visit_date"},
    ]
    optional = [{**asked[0], "required": False}, asked[1]]
    report = await template(client, world, "Relatório da visita", fields=asked)
    paused = await template(client, world, "Checklist da pausa", fields=optional)
    typed = await template(client, world, "Checklist digitado", fields=asked)
    finished = await template(client, world, "Checklist da conclusão", fields=asked)
    reopened = await template(client, world, "Checklist da reabertura", fields=optional)
    returned = await template(client, world, "Checklist do retorno", fields=asked)
    agenda = datetime(2026, 12, 3, 13, 0, tzinfo=UTC)  # 10h em Brasília
    t = await create(
        client,
        world,
        assignee_id=str(world.tech.user.id),
        scheduled_start=agenda.isoformat(),
        forms=[
            {"template_id": report["id"], "required": True},
            *(
                {"template_id": x["id"], "required": False}
                for x in (paused, typed, finished, reopened, returned)
            ),
        ],
    )

    async def form_of(tpl: dict) -> dict:
        d = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
        return next(f for f in d["forms"] if f["template_id"] == tpl["id"])

    async def prefill(tpl: dict) -> dict:
        return (await form_of(tpl))["prefill"]

    async def complete(tpl: dict, headers: dict, answers: dict | None = None) -> Response:
        return await client.put(
            f"{API}/tickets/{t['id']}/forms/{(await form_of(tpl))['id']}/answers",
            json={"answers": answers or {}, "complete": True},
            headers=headers,
        )

    # Antes da chegada: o dia da agenda.
    assert await prefill(report) == _shown(date(2026, 12, 3))

    # A primeira ida foi há 10 dias: em atendimento, o dia do início do trecho.
    t = await transition(client, th, t, "en_route")
    t = await transition(client, th, t, "in_progress")
    await _shift(engine, t["id"], 10, "arrived_at", "work_started_at")
    first_day = await _local_day(engine, t["id"], "arrived_at")
    assert await prefill(report) == _shown(first_day)

    # Pausada pela central (aguardando peça): a data seria a da ida anterior e não vem, nem na
    # conclusão. A pergunta opcional fica sem resposta; a obrigatória precisa ser digitada.
    t = await transition(client, sup, t, "on_hold_vendor", note="Peça")
    assert await prefill(report) == {}
    r = await complete(paused, th)
    assert r.status_code == 200, r.text
    assert r.json()["answers"] == {}
    r = await complete(typed, th)
    assert (r.status_code, r.json()["detail"]) == (422, "Falta preencher: Data")
    r = await complete(typed, th, {"data": "2026-11-10"})
    assert r.status_code == 200, r.text
    assert r.json()["answers"] == {"data": "2026-11-10"}

    # O técnico voltou há 6 dias e retomou: vale o dia da volta, não o da primeira ida.
    t = await transition(client, th, t, "in_progress")
    await _shift(engine, t["id"], 6, "work_started_at")
    back = await _local_day(engine, t["id"], "work_started_at")
    assert back != first_day
    assert await prefill(report) == _shown(back)
    r = await complete(report, th)
    assert r.status_code == 200, r.text
    assert r.json()["answers"] == _shown(back)

    # Resolvida (há 5 dias): ao vivo e na conclusão, o dia da conclusão, também quando a central
    # conclui depois.
    t = await transition(client, th, t, "resolved", resolution_notes="Peça trocada")
    await _shift(engine, t["id"], 5, "resolved_at")
    resolved = await _local_day(engine, t["id"], "resolved_at")
    assert resolved not in (first_day, back)
    assert await prefill(finished) == _shown(resolved)
    r = await complete(finished, an)
    assert r.status_code == 200, r.text
    assert r.json()["answers"] == _shown(resolved)

    # Reaberta, ainda sem a nova ida (e a caminho de novo): nada, nem na conclusão.
    t = await transition(client, an, t, "reopened", note="Voltou a falhar")
    assert await prefill(reopened) == {}
    r = await complete(reopened, th)
    assert r.status_code == 200, r.text
    assert r.json()["answers"] == {}
    t = await transition(client, th, t, "en_route")
    assert await prefill(returned) == {}

    # Voltou em outro dia (ontem): o dia da volta.
    t = await transition(client, th, t, "in_progress")
    await _shift(engine, t["id"], 1, "work_started_at")
    again = await _local_day(engine, t["id"], "work_started_at")
    assert again not in (first_day, back, resolved)
    assert await prefill(returned) == _shown(again)
    r = await complete(returned, th)
    assert r.status_code == 200, r.text
    assert r.json()["answers"] == _shown(again)


async def test_usage_lists_types_from_history(client: AsyncClient, world: World) -> None:
    kind = await service_type(client, world, "Preventiva")
    rare = await service_type(client, world, "Corretiva")
    f = await template(client, world, "Checklist F")
    with_f = [{"template_id": f["id"], "required": True}]
    for _ in range(3):
        await create(client, world, service_type_id=kind["id"], forms=with_f)
    await create(client, world, service_type_id=kind["id"], forms=[])
    for _ in range(2):
        await create(client, world, service_type_id=rare["id"], forms=with_f)

    r = await client.get(f"{API}/form-templates/{f['id']}/usage", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "service_types": [
            {"id": kind["id"], "name": "Preventiva", "customer": None, "used": 3, "total": 4}
        ]
    }


async def test_suggestions_follow_type_and_category(client: AsyncClient, world: World) -> None:
    printers = await category(client, world, "Impressoras")
    jam = await category(client, world, "Atolamento", printers)
    kind = await service_type(client, world, "Instalação")
    by_category = await template(
        client, world, "Checklist da categoria", category_ids=[printers["id"]]
    )
    by_type = await template(client, world, "Checklist do tipo", service_type_ids=[kind["id"]])
    await template(client, world, "Checklist solto")

    t = await create(
        client,
        world,
        service_type_id=kind["id"],
        category_id=jam["id"],
        forms=[{"template_id": by_type["id"], "required": True}],
    )
    r = await client.get(
        f"{API}/tickets/{t['id']}/forms/suggestions", headers=world.analyst.headers
    )
    assert r.status_code == 200, r.text
    assert [x["id"] for x in r.json()] == [by_category["id"]]
