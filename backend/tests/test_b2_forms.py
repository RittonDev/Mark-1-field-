"""Formulários: a assinatura acompanha o formulário obrigatório, a correção da central não desfaz
o "concluído", a OS concluída ainda recebe checklist (opcional), número do jeito brasileiro, foto
de verdade e o modelo corrigido chegando às OS em que o formulário nem começou."""

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition
from tests.test_forms import PNG, PREVENTIVA, photo

pytestmark = requires_db

API = settings.API_PREFIX
CHECKLIST = {
    "name": "Checklist PDV",
    "requires_signature": False,
    "fields": [
        {"id": "obs", "type": "textarea", "label": "Observações", "required": True},
        {"id": "metros", "type": "number", "label": "Metros de cabo"},
    ],
}
HEIC = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic"


async def template(client: AsyncClient, world: World, **extra: object) -> dict:
    r = await client.post(
        f"{API}/form-templates", json={**CHECKLIST, **extra}, headers=world.analyst.headers
    )
    assert r.status_code == 201, r.text
    return r.json()


async def attach(
    client: AsyncClient, world: World, ticket_id: str, template_id: str, required: bool
) -> dict:
    r = await client.post(
        f"{API}/tickets/{ticket_id}/forms",
        json={"template_id": template_id, "required": required},
        headers=world.analyst.headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def test_signature_follows_the_required_form(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tpl = await template(client, world, requires_signature=True)
    t = await create(client, world, title="PDV", assignee_id=str(world.tech.user.id))
    form = await attach(client, world, t["id"], tpl["id"], required=False)
    ticket_url = f"{API}/tickets/{t['id']}"

    async def signature_required() -> bool:
        return (await client.get(ticket_url, headers=an)).json()["signature_required"]

    assert await signature_required() is False
    url = f"{ticket_url}/forms/{form['id']}"
    r = await client.patch(url, json={"required": True}, headers=an)
    assert r.status_code == 200 and r.json()["required"] is True
    assert await signature_required() is True
    # Tornar opcional libera o fechamento: fica no histórico, e a assinatura deixa de ser exigida.
    assert (await client.patch(url, json={"required": False}, headers=an)).status_code == 200
    assert await signature_required() is False
    events = (await client.get(f"{ticket_url}/events", headers=an)).json()
    changes = [
        e["data"]["required"]
        for e in events
        if e["event_type"] == "updated" and (e["data"] or {}).get("form_id") == form["id"]
    ]
    assert sorted(changes) == [False, True]

    # Removendo o obrigatório que pedia assinatura, o técnico conclui sem assinatura.
    assert (await client.patch(url, json={"required": True}, headers=an)).status_code == 200
    assert (await client.delete(url, headers=an)).status_code == 204
    assert await signature_required() is False
    t = (await client.get(ticket_url, headers=th)).json()
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="PDV liberado")
    assert t["status"] == "resolved"


async def test_office_correction_keeps_the_form_completed(
    client: AsyncClient, world: World
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tpl = await template(client, world)
    t = await create(client, world, title="PDV", assignee_id=str(world.tech.user.id))
    form = await attach(client, world, t["id"], tpl["id"], required=True)
    answers = f"{API}/tickets/{t['id']}/forms/{form['id']}/answers"
    r = await client.put(
        answers,
        json={"answers": {"obs": "Tudo certo", "metros": "1.234,5"}, "complete": True},
        headers=th,
    )
    assert r.status_code == 200, r.text
    done = r.json()
    assert (done["status"], done["answers"]["metros"]) == ("completed", 1234.5)

    # A central corrige uma resposta e nada obrigatório falta: continua concluído, mesma data.
    r = await client.put(answers, json={"answers": {"obs": "Cabo trocado"}}, headers=an)
    assert (r.json()["status"], r.json()["completed_at"]) == ("completed", done["completed_at"])
    # O técnico mudando depois de concluído: precisa concluir de novo.
    r = await client.put(answers, json={"answers": {"obs": "Mudei"}}, headers=th)
    assert r.json()["status"] == "in_progress"
    for bad in ("NaN", "1e999", "abc"):
        r = await client.put(answers, json={"answers": {"metros": bad}}, headers=th)
        assert r.status_code == 422, bad


async def test_concluded_ticket_still_gets_an_optional_checklist(
    client: AsyncClient, world: World
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tpl = await template(client, world)
    t = await create(client, world, title="Rack", assignee_id=str(world.tech.user.id))
    t = await transition(client, th, t, "in_progress")
    await transition(client, th, t, "resolved", resolution_notes="Rack organizado")
    # O checklist chegou depois pelo WhatsApp: a central registra, sem travar o que já fechou.
    late = await attach(client, world, t["id"], tpl["id"], required=True)
    assert late["required"] is False

    gone = await create(client, world, title="Cancelada")
    await transition(client, world.supervisor.headers, gone, "cancelled", note="Duplicada")
    r = await client.post(
        f"{API}/tickets/{gone['id']}/forms", json={"template_id": tpl["id"]}, headers=an
    )
    assert r.status_code == 422


async def test_form_photos_and_signature_must_be_real_images(
    client: AsyncClient, world: World
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tpl = (await client.post(f"{API}/form-templates", json=PREVENTIVA, headers=an)).json()
    t = await create(client, world, title="Rack", assignee_id=str(world.tech.user.id))
    form = await attach(client, world, t["id"], tpl["id"], required=False)
    url = f"{API}/tickets/{t['id']}/forms/{form['id']}/photos"

    async def send(content: bytes, name: str) -> int:
        r = await client.post(
            url,
            files={"file": (name, content, "image/png")},
            data={"field_id": "rack_antes"},
            headers=th,
        )
        return r.status_code

    assert await send(b"<svg xmlns='http://www.w3.org/2000/svg'/>", "foto.png") == 422
    assert await send(HEIC, "IMG_0001.HEIC") == 201  # foto do iPhone não se perde
    assert await photo(client, th, t["id"], form["id"], "rack_antes") == 201

    plain = await create(client, world, title="Assinatura", assignee_id=str(world.tech.user.id))
    sign = f"{API}/tickets/{plain['id']}/signature"
    fake = await client.post(
        sign,
        files={"file": ("assinatura.png", b"nao e imagem", "image/png")},
        data={"signer_name": "Paula Gerente"},
        headers=th,
    )
    assert fake.status_code == 422
    real = await client.post(
        sign,
        files={"file": ("assinatura.png", PNG, "image/png")},
        data={"signer_name": "Paula Gerente"},
        headers=th,
    )
    assert real.status_code == 200, real.text


async def test_fixed_template_reaches_tickets_that_did_not_start(
    client: AsyncClient, world: World
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    tpl = await template(client, world)
    untouched = await create(client, world, title="Loja 1", assignee_id=str(world.tech.user.id))
    started = await create(client, world, title="Loja 2", assignee_id=str(world.tech.user.id))
    await attach(client, world, untouched["id"], tpl["id"], required=True)
    begun = await attach(client, world, started["id"], tpl["id"], required=True)
    r = await client.put(
        f"{API}/tickets/{started['id']}/forms/{begun['id']}/answers",
        json={"answers": {"obs": "Começado"}},
        headers=th,
    )
    assert r.status_code == 200, r.text

    photo_field = {"id": "foto", "type": "photo", "label": "Foto da loja", "required": True}
    fixed = {**CHECKLIST, "fields": [*CHECKLIST["fields"], photo_field]}
    r = await client.put(
        f"{API}/form-templates/{tpl['id']}",
        params={"apply_to_pending": True},
        json=fixed,
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert (r.json()["version"], r.json()["applied_to"]) == (2, 1)

    def form_of(ticket: dict) -> dict:
        return ticket["forms"][0]

    fresh = form_of((await client.get(f"{API}/tickets/{untouched['id']}", headers=an)).json())
    assert (fresh["template_version"], len(fresh["fields"])) == (2, 3)
    kept = form_of((await client.get(f"{API}/tickets/{started['id']}", headers=an)).json())
    assert (kept["template_version"], len(kept["fields"])) == (1, 2)
    # Sem a opção, o modelo muda e as OS ficam com a versão que já têm.
    r = await client.put(f"{API}/form-templates/{tpl['id']}", json=CHECKLIST, headers=an)
    assert (r.json()["version"], r.json()["applied_to"]) == (3, None)
