"""Orçamento da OS: a gestão monta, envia o link e o cliente aprova (assinando) ou recusa."""

import hashlib
from datetime import date, timedelta

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX
SIGNATURE = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


async def test_quote_approval_flow(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    an, th = world.analyst.headers, world.tech.headers
    velcro = (
        await client.post(
            f"{API}/quote-items",
            json={"name": "Velcro 3 m", "unit": "rolo", "price": "15.90"},
            headers=an,
        )
    ).json()
    assert velcro["kind"] == "product"
    t = await create(client, world, title="Organizar rack")
    body = {
        "title": "Organização do rack principal",
        "items": [
            {
                "description": "Velcro 3 m",
                "quantity": 2,
                "unit": "rolo",
                "unit_price": "15.90",
                "catalog_item_id": velcro["id"],
            },
            {
                "description": "Mão de obra",
                "quantity": 1,
                "unit": "serviço",
                "unit_price": "150",
                "kind": "service",
            },
        ],
        "discount": "10",
        "valid_until": (date.today() + timedelta(days=7)).isoformat(),
        "notes": "Pagamento em 30 dias.",
    }
    url = f"{API}/tickets/{t['id']}/quotes"
    assert (await client.post(url, json=body, headers=th)).status_code == 403
    assert (await client.post(url, json={**body, "discount": "999"}, headers=an)).status_code == 422
    q = (await client.post(url, json=body, headers=an)).json()
    assert (q["code"][:4], q["status"], q["subtotal"], q["total"]) == (
        "ORC-",
        "draft",
        181.8,
        171.8,
    )
    assert q["items"][0]["total"] == 31.8
    assert [i["kind"] for i in q["items"]] == ["product", "service"]
    assert q["totals_by_kind"] == {"product": 31.8, "service": 150.0, "expense": 0.0}
    assert q["link"] is None  # rascunho nunca enviado: ainda sem link

    sent = (await client.post(f"{API}/quotes/{q['id']}/send", headers=an)).json()
    token = sent["token"]
    assert sent["link"]["token"] == token and sent["link"]["path"] == f"/orcamento/{token}"
    assert sent["link"]["url"] == f"{settings.WEB_URL}/orcamento/{token}"
    # O link fica disponível para copiar a qualquer momento (lista da OS e geral).
    listed = (await client.get(url, headers=an)).json()
    assert listed[0]["link"]["token"] == token
    view = (await client.get(f"{API}/public/quotes/{token}")).json()
    assert (view["status"], view["total"], view["customer"]) == ("sent", 171.8, "Cliente Teste")
    assert view["customer_info"]["name"] == "Cliente Teste"
    assert view["company"]["name"] == settings.COMPANY_NAME
    assert (view["ticket_number"], view["ticket_code"]) == (t["number"], t["code"])
    assert view["issued_at"] is not None and view["signature_url"] is None
    assert view["totals_by_kind"] == {"product": 31.8, "service": 150.0, "expense": 0.0}
    assert [(i["unit"], i["kind"]) for i in view["items"]] == [
        ("rolo", "product"),
        ("serviço", "service"),
    ]
    assert "token" not in view and "decision_ip" not in view and "link" not in view

    # Editou: volta a rascunho, mas o link continua o mesmo; o cliente vê o conteúdo atual
    # "em revisão" e só responde depois do novo envio.
    r = await client.put(f"{API}/quotes/{q['id']}", json={**body, "discount": "0"}, headers=an)
    assert (r.json()["status"], r.json()["total"], r.json()["link"]["token"]) == (
        "draft",
        181.8,
        token,
    )
    review = await client.get(f"{API}/public/quotes/{token}")
    assert review.status_code == 200
    assert (review.json()["status"], review.json()["total"]) == ("draft", 181.8)
    approve = {
        "name": "Paula Gerente",
        "registration": "MAT-4471",
        "comment": "Pode agendar na quinta pela manhã.",
        "signature": SIGNATURE,
        "accept": False,
    }
    early = await client.post(
        f"{API}/public/quotes/{token}/approve", json={**approve, "accept": True}
    )
    assert early.status_code == 409 and "revisão" in early.json()["detail"]
    again = (await client.post(f"{API}/quotes/{q['id']}/send", headers=an)).json()
    assert again["token"] == token  # reenviar mantém o mesmo link

    assert (
        await client.post(f"{API}/public/quotes/{token}/approve", json=approve)
    ).status_code == 422
    bad = {**approve, "accept": True, "signature": "data:image/png;base64,PHNjcmlwdD4="}
    assert (await client.post(f"{API}/public/quotes/{token}/approve", json=bad)).status_code == 422
    r = await client.post(f"{API}/public/quotes/{token}/approve", json={**approve, "accept": True})
    assert r.status_code == 200, r.text
    approved = r.json()
    assert (approved["status"], approved["approver_name"]) == ("approved", "Paula Gerente")
    assert (approved["approver_registration"], approved["client_comment"]) == (
        "MAT-4471",
        "Pode agendar na quinta pela manhã.",
    )
    assert approved["signature_url"].startswith("http")
    public_sig = await client.get(approved["signature_url"])
    assert public_sig.status_code == 200 and public_sig.content.startswith(b"\x89PNG")
    again = await client.post(
        f"{API}/public/quotes/{token}/approve", json={**approve, "accept": True}
    )
    assert again.status_code == 409
    # O cliente continua vendo o orçamento aprovado pelo link.
    assert (await client.get(f"{API}/public/quotes/{token}")).json()["status"] == "approved"

    quotes = (await client.get(url, headers=an)).json()
    assert quotes[0]["status"] == "approved"
    assert (quotes[0]["approver_registration"], quotes[0]["client_comment"]) == (
        "MAT-4471",
        "Pode agendar na quinta pela manhã.",
    )
    sig = await client.get(quotes[0]["signature_url"])
    assert sig.status_code == 200 and sig.content.startswith(b"\x89PNG")
    events = [
        e["event_type"]
        for e in (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    ]
    assert "quote_approved" in events and "quote_sent" in events

    # Recusa com motivo e comentário; e o vencido não aceita resposta.
    q2 = (await client.post(url, json=body, headers=an)).json()
    tok2 = (await client.post(f"{API}/quotes/{q2['id']}/send", headers=an)).json()["token"]
    r = await client.post(
        f"{API}/public/quotes/{tok2}/reject",
        json={"reason": "Vamos fazer internamente", "comment": "Obrigado pelo retorno rápido."},
    )
    assert (r.json()["status"], r.json()["rejection_reason"], r.json()["client_comment"]) == (
        "rejected",
        "Vamos fazer internamente",
        "Obrigado pelo retorno rápido.",
    )

    q3 = (await client.post(url, json=body, headers=an)).json()
    tok3 = (await client.post(f"{API}/quotes/{q3['id']}/send", headers=an)).json()["token"]
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE quotes SET valid_until = current_date - 1 WHERE id = :i"), {"i": q3["id"]}
        )
    assert (await client.get(f"{API}/public/quotes/{tok3}")).json()["status"] == "expired"
    late = await client.post(
        f"{API}/public/quotes/{tok3}/approve", json={**approve, "accept": True}
    )
    assert late.status_code == 409
    listed = {r["id"]: r["status"] for r in (await client.get(f"{API}/quotes", headers=an)).json()}
    assert listed == {q["id"]: "approved", q2["id"]: "rejected", q3["id"]: "expired"}


async def test_quote_link_rotate_legacy_and_cancel(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    t = await create(client, world, title="Trocar HD do DVR")
    body = {
        "title": "HD 500 GB",
        "items": [
            {"description": "HD 500 GB Purple", "quantity": 1, "unit": "un", "unit_price": "280"},
            {
                "description": "Deslocamento",
                "quantity": 30,
                "unit": "km",
                "unit_price": "1.50",
                "kind": "expense",
            },
        ],
    }
    url = f"{API}/tickets/{t['id']}/quotes"
    q = (await client.post(url, json=body, headers=an)).json()
    assert q["totals_by_kind"] == {"product": 280.0, "service": 0.0, "expense": 45.0}
    rotate = f"{API}/quotes/{q['id']}/link/rotate"
    assert (await client.post(rotate, headers=an)).status_code == 422  # rascunho sem link
    token = (await client.post(f"{API}/quotes/{q['id']}/send", headers=an)).json()["token"]
    assert (await client.post(rotate, headers=world.tech.headers)).status_code == 403

    # Trocar o link: o anterior para de abrir (inclusive um antigo, só com hash).
    legacy = "link-antigo-so-com-hash"
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE quotes SET token_hash = :h WHERE id = :i"),
            {"h": hashlib.sha256(legacy.encode()).hexdigest(), "i": q["id"]},
        )
    assert (await client.get(f"{API}/public/quotes/{legacy}")).json()["title"] == "HD 500 GB"
    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
    assert (await client.get(f"{API}/public/quotes/{tampered}")).status_code == 410
    new = (await client.post(rotate, headers=an)).json()
    assert new["token"] != token and new["path"] == f"/orcamento/{new['token']}"
    assert (await client.get(f"{API}/public/quotes/{token}")).status_code == 410
    assert (await client.get(f"{API}/public/quotes/{legacy}")).status_code == 410
    assert (await client.get(f"{API}/public/quotes/{new['token']}")).status_code == 200
    detail = (await client.get(url, headers=an)).json()[0]
    assert detail["link"]["token"] == new["token"]

    # Cancelar tira o link do ar.
    cancelled = (await client.post(f"{API}/quotes/{q['id']}/cancel", headers=an)).json()
    assert (cancelled["status"], cancelled["link"]) == ("cancelled", None)
    assert (await client.get(f"{API}/public/quotes/{new['token']}")).status_code == 410
    assert (await client.post(rotate, headers=an)).status_code == 422


async def test_company_profile_and_public_address(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an, sup = world.analyst.headers, world.supervisor.headers
    default = (await client.get(f"{API}/settings/company", headers=an)).json()
    assert default["name"] == settings.COMPANY_NAME and default["email"] is None
    profile = {
        "name": "  Maxx Field   Serviços ",
        "document": "12.345.678/0001-90",
        "email": "atendimento@exemplo.com.br",
        "phone": "(11) 4000-0000",
        "address": "Rua Exemplo, 100 - São Paulo - SP",
        "website": "",
    }
    assert (
        await client.put(f"{API}/settings/company", json=profile, headers=an)
    ).status_code == 403
    bad = await client.put(
        f"{API}/settings/company", json={**profile, "email": "sem-arroba"}, headers=sup
    )
    assert bad.status_code == 422
    saved = (await client.put(f"{API}/settings/company", json=profile, headers=sup)).json()
    assert (saved["name"], saved["website"]) == ("Maxx Field Serviços", None)
    assert (await client.get(f"{API}/settings/company", headers=an)).json() == saved

    # Endereço do local completo (rua, bairro, cidade, UF e CEP) no cartão do orçamento.
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE locations SET address_line = 'Avenida Kennedy, 700', "
                "district = 'Jardim do Mar', city = 'São Bernardo do Campo', state = 'SP', "
                "zip_code = '09726-252' WHERE id = :i"
            ),
            {"i": world.location_id},
        )
    t = await create(client, world, title="Rack da loja")
    body = {
        "title": "Velcro",
        "items": [{"description": "Velcro", "quantity": 1, "unit": "un", "unit_price": "10"}],
    }
    q = (await client.post(f"{API}/tickets/{t['id']}/quotes", json=body, headers=an)).json()
    token = (await client.post(f"{API}/quotes/{q['id']}/send", headers=an)).json()["token"]
    view = (await client.get(f"{API}/public/quotes/{token}")).json()
    assert view["company"]["name"] == "Maxx Field Serviços"
    assert view["company"]["phone"] == "(11) 4000-0000"
    assert view["address"]["full"] == (
        "Avenida Kennedy, 700 - Jardim do Mar, São Bernardo do Campo - SP, 09726-252"
    )
    assert (view["address"]["city"], view["address"]["zip_code"]) == (
        "São Bernardo do Campo",
        "09726-252",
    )

    # Endereço do atendimento informado na OS tem prioridade sobre o do local.
    t2 = await create(client, world, title="Doca", service_address="Doca 3, entrada pelos fundos")
    q2 = (await client.post(f"{API}/tickets/{t2['id']}/quotes", json=body, headers=an)).json()
    tok2 = (await client.post(f"{API}/quotes/{q2['id']}/send", headers=an)).json()["token"]
    addr = (await client.get(f"{API}/public/quotes/{tok2}")).json()["address"]
    assert addr["full"] == "Doca 3, entrada pelos fundos, São Bernardo do Campo - SP"
