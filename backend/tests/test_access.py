"""Permissões por tela (perfis de acesso e ajustes por usuário) contra PostgreSQL.

Os padrões dos perfis reproduzem o acesso de antes dos perfis; o administrador é sempre total; a
guarda vale na API (403 com código que a tela reconhece), não só no menu.
"""

import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.api.deps import require_access
from app.core import permissions
from app.core.config import settings
from app.core.enums import TicketEventType
from app.services.location_import import NEW_CUSTOMER_FORBIDDEN
from tests.conftest import World, requires_db
from tests.test_api import create
from tests.test_b2_quotes import APPROVAL
from tests.test_forms import PNG

pytestmark = requires_db

API = settings.API_PREFIX
ALL_NONE = dict.fromkeys(permissions.ITEM_KEYS, "none")


async def profiles(client: AsyncClient, world: World) -> dict[str, dict]:
    """Perfis por nome (a listagem cria os padrões que faltarem)."""
    r = await client.get(f"{API}/access/profiles", headers=world.admin.headers)
    assert r.status_code == 200, r.text
    return {p["name"]: p for p in r.json()}


async def new_profile(client: AsyncClient, world: World, name: str, **body: object) -> dict:
    r = await client.post(
        f"{API}/access/profiles", json={"name": name, **body}, headers=world.admin.headers
    )
    assert r.status_code == 201, r.text
    return r.json()


async def set_access(
    client: AsyncClient,
    headers: dict,
    user_id: object,
    *,
    profile_id: str | None = None,
    items: dict | None = None,
    scope: str | None = None,
    unowned: bool | None = None,
    expect: int = 200,
) -> dict:
    overrides = {"items": items, "queue_scope": scope, "queue_unowned": unowned}
    r = await client.patch(
        f"{API}/users/{user_id}",
        json={"access": {"profile_id": profile_id, "overrides": overrides}},
        headers=headers,
    )
    assert r.status_code == expect, r.text
    return r.json()


async def restrict_analyst(client: AsyncClient, world: World, **items: str) -> dict:
    """O analista num perfil próprio com as telas dadas (o resto igual ao Analista)."""
    profile = await new_profile(
        client, world, f"Restrito {uuid.uuid4().hex[:6]}", items=dict(items)
    )
    await set_access(client, world.admin.headers, world.analyst.user.id, profile_id=profile["id"])
    return profile


# ---------------------------------------------------------------- padrões = acesso de antes

DEFAULT_CASES = [
    # (papel, método, caminho, corpo, status de antes dos perfis)
    ("analyst", "PUT", "/settings/company", {"name": "Empresa Teste"}, 403),
    ("supervisor", "PUT", "/settings/company", {"name": "Empresa Teste"}, 200),
    ("analyst", "PUT", "/settings/expenses", {"km_rate": "1.50"}, 403),
    ("supervisor", "PUT", "/settings/expenses", {"km_rate": "1.50"}, 200),
    ("analyst", "POST", "/teams", {"name": "Grupo Novo"}, 403),
    ("supervisor", "POST", "/teams", {"name": "Grupo Novo"}, 201),
    ("analyst", "POST", "/categories", {"name": "Categoria Nova"}, 403),
    (
        "analyst",
        "POST",
        "/unproductive-reasons",
        {"name": "Motivo de teste", "responsibility": "internal"},
        201,
    ),
    ("analyst", "POST", "/service-types", {"name": "Tipo de teste", "estimated_minutes": 60}, 201),
    ("analyst", "GET", "/access/profiles", None, 200),
    ("supervisor", "GET", "/access/profiles", None, 200),
    ("analyst", "GET", "/payouts", None, 200),
    ("analyst", "GET", "/quotes", None, 200),
    ("analyst", "GET", "/repairs", None, 200),
    ("analyst", "GET", "/technicians", None, 200),
    ("analyst", "GET", "/dashboard/summary", None, 200),
    ("analyst", "GET", "/reports/monthly", None, 200),
    ("analyst", "GET", "/tracking/live", None, 200),
    ("analyst", "GET", "/onboarding/applications", None, 200),
    ("analyst", "GET", "/message-templates", None, 200),
    ("tech", "GET", "/payouts", None, 403),
    ("tech", "GET", "/quotes", None, 403),
    ("tech", "GET", "/repairs", None, 403),
    ("tech", "GET", "/technicians", None, 403),
    ("tech", "GET", "/dashboard/summary", None, 403),
    ("tech", "GET", "/access/profiles", None, 403),
    ("tech", "GET", "/tracking/live", None, 403),
    ("requester", "GET", "/payouts", None, 403),
    ("requester", "GET", "/onboarding/applications", None, 403),
    ("admin", "GET", "/access/profiles", None, 200),
    ("admin", "PUT", "/settings/company", {"name": "Empresa Teste"}, 200),
]


@pytest.mark.parametrize(("role", "method", "path", "body", "status"), DEFAULT_CASES)
async def test_defaults_keep_todays_access(
    client: AsyncClient,
    world: World,
    role: str,
    method: str,
    path: str,
    body: dict | None,
    status: int,
) -> None:
    actor = getattr(world, role)
    r = await client.request(method, f"{API}{path}", json=body, headers=actor.headers)
    assert r.status_code == status, r.text
    if role in ("tech", "requester"):
        # Técnico e cliente: o 403 de sempre (sem a tela de "sem acesso").
        assert r.json() == {"detail": "Sem permissão para esta ação"}


async def test_analyst_settings_by_url_is_module_forbidden(
    client: AsyncClient, world: World
) -> None:
    """A única mudança visível: Configurações pela URL agora diz qual tela falta."""
    r = await client.put(
        f"{API}/settings/company", json={"name": "Empresa Teste"}, headers=world.analyst.headers
    )
    assert r.status_code == 403
    assert r.json() == {
        "detail": "Sem acesso a Configurações.",
        "code": "MODULE_FORBIDDEN",
        "item": "setup.settings",
        "module": "setup",
        "required": "edit",
    }


async def test_admin_is_always_full(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE users SET access_overrides = CAST(:j AS jsonb) WHERE id = :i"),
            {"j": json.dumps({"items": ALL_NONE, "queue_scope": "own"}), "i": world.admin.user.id},
        )
    adm = world.admin.headers
    assert (await client.get(f"{API}/payouts", headers=adm)).status_code == 200
    assert (await client.get(f"{API}/access/profiles", headers=adm)).status_code == 200
    me = (await client.get(f"{API}/auth/me", headers=adm)).json()
    assert me["access"]["full"] is True
    assert me["access"]["items"]["commercial.payouts"] == "edit"
    assert me["access"]["items"]["analysis.dashboard"] == "view"
    assert me["access"]["queues"] == {"scope": "all", "unowned": True}
    # O administrador não usa perfil.
    await set_access(client, adm, world.admin.user.id, items={"base.customers": "none"}, expect=422)


# ---------------------------------------------------------------- telas comerciais


async def test_payouts_none_blocks_screen_and_ticket_values(
    client: AsyncClient, world: World
) -> None:
    sup, an = world.supervisor.headers, world.analyst.headers
    ticket = await create(client, world, assignee_id=str(world.tech.user.id))
    url = f"{API}/tickets/{ticket['id']}/payouts/{world.tech.user.id}"
    assert (await client.put(url, json={"amount": "120.00"}, headers=sup)).status_code == 200
    await restrict_analyst(client, world, **{"commercial.payouts": "none"})

    r = await client.get(f"{API}/payouts", headers=an)
    assert r.status_code == 403
    assert r.json() == {
        "detail": "Sem acesso a Pagamentos.",
        "code": "MODULE_FORBIDDEN",
        "item": "commercial.payouts",
        "module": "commercial",
        "required": "view",
    }
    r = await client.put(url, json={"amount": "150.00"}, headers=an)
    assert r.status_code == 403 and r.json()["code"] == "MODULE_FORBIDDEN"
    # A OS continua abrindo, sem o valor do técnico (o supervisor vê).
    detail = await client.get(f"{API}/tickets/{ticket['id']}", headers=an)
    assert detail.status_code == 200, detail.text
    assert detail.json()["payouts"] == []
    full = (await client.get(f"{API}/tickets/{ticket['id']}", headers=sup)).json()
    assert len(full["payouts"]) == 1


async def test_quotes_view_only(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    an = world.analyst.headers
    ticket = await create(client, world)
    legacy = {
        "source": "fieldcontrol",
        "values": {"products": 10.0, "services": 20.0, "expenses": 0.0, "total": 30.0},
        "items": [
            {"type": "service", "name": "Visita", "quantity": 1.0, "value": 20.0, "total": 20.0}
        ],
    }
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE tickets SET legacy = CAST(:j AS jsonb) WHERE id = :i"),
            {"j": json.dumps(legacy), "i": ticket["id"]},
        )
    profile = await restrict_analyst(client, world, **{"commercial.quotes": "view"})

    assert (await client.get(f"{API}/quotes", headers=an)).status_code == 200
    assert (await client.get(f"{API}/tickets/{ticket['id']}/quotes", headers=an)).status_code == 200
    body = {
        "title": "Troca de peça",
        "items": [{"description": "Peça", "quantity": 1, "unit_price": 10}],
    }
    r = await client.post(f"{API}/tickets/{ticket['id']}/quotes", json=body, headers=an)
    assert r.status_code == 403
    assert r.json() == {
        "detail": "Seu acesso a Orçamentos é só de visualização.",
        "code": "MODULE_FORBIDDEN",
        "item": "commercial.quotes",
        "module": "commercial",
        "required": "edit",
    }
    # Com Visualizar, os preços do pedido migrado aparecem.
    seen = (await client.get(f"{API}/tickets/{ticket['id']}", headers=an)).json()["legacy"]
    assert seen["values"]["total"] == 30.0

    # Sem Orçamentos, saem os preços do pedido do Field Control (o resto do legado fica).
    r = await client.patch(
        f"{API}/access/profiles/{profile['id']}",
        json={"items": {"commercial.quotes": "none"}},
        headers=world.admin.headers,
    )
    assert r.status_code == 200, r.text
    hidden = (await client.get(f"{API}/tickets/{ticket['id']}", headers=an)).json()["legacy"]
    assert hidden["values"] is None
    assert hidden["items"] == [
        {"type": "service", "name": "Visita", "quantity": 1.0, "value": None, "total": None}
    ]
    assert hidden["source"] == "fieldcontrol"
    assert (await client.get(f"{API}/quotes", headers=an)).status_code == 403


# ------------------------------------------- valores comerciais fora das telas de cada item

QUOTE = {
    "title": "Troca de peça",
    "items": [{"description": "Peça", "quantity": 1, "unit_price": 50}],
}
COST = {"kind": "material", "description": "Conector", "quantity": 1, "unit_value": "7.00"}
NO_MONEY = dict.fromkeys(("commercial.payouts", "commercial.expenses", "commercial.quotes"), "none")


async def money_trail(client: AsyncClient, world: World, ticket: dict) -> None:
    """Valor do técnico (R$ 80), um custo extra (R$ 7) e um orçamento de R$ 50 enviado e
    aprovado pelo cliente, lançados pelo supervisor na OS."""
    sup, tid = world.supervisor.headers, ticket["id"]
    r = await client.put(
        f"{API}/tickets/{tid}/payouts/{world.tech.user.id}", json={"amount": "80.00"}, headers=sup
    )
    assert r.status_code == 200, r.text
    r = await client.post(f"{API}/tickets/{tid}/expenses", json=COST, headers=sup)
    assert r.status_code == 201, r.text
    r = await client.post(f"{API}/tickets/{tid}/quotes", json=QUOTE, headers=sup)
    assert r.status_code == 201, r.text
    r = await client.post(f"{API}/quotes/{r.json()['id']}/send", headers=sup)
    assert r.status_code == 200, r.text
    r = await client.post(f"{API}/public/quotes/{r.json()['token']}/approve", json=APPROVAL)
    assert r.status_code == 200, r.text


async def test_history_hides_values_of_screens_without_access(
    client: AsyncClient, world: World
) -> None:
    """O Histórico da OS (rota do núcleo) não mostra o que o detalhe esconde: o evento com valor
    de Pagamentos, Custos extras ou Orçamentos sai inteiro para quem não tem a tela."""
    assert set(permissions.HISTORY_ITEMS) <= {t.value for t in TicketEventType}
    ticket = await create(client, world, assignee_id=str(world.tech.user.id))
    await money_trail(client, world, ticket)
    an, url = world.analyst.headers, f"{API}/tickets/{ticket['id']}/events"

    async def kinds(headers: dict) -> set[str]:
        r = await client.get(url, headers=headers)
        assert r.status_code == 200, r.text
        return {e["event_type"] for e in r.json()}

    everything = await kinds(an)
    assert {"payout_set", "expense_added", "quote_sent", "quote_approved"} <= everything
    # O caso do pedido: Orçamentos liberado e Pagamentos bloqueado.
    await restrict_analyst(client, world, **{"commercial.payouts": "none"})
    seen = await kinds(an)
    assert "payout_set" not in seen
    assert {"expense_added", "quote_sent", "quote_approved"} <= seen
    # Sem as três telas, nenhum evento com valor; o resto do histórico continua.
    await restrict_analyst(client, world, **NO_MONEY)
    seen = await kinds(an)
    assert not seen & set(permissions.HISTORY_ITEMS)
    assert "created" in seen
    # Quem tem as telas (o supervisor, no padrão) vê tudo.
    assert everything <= await kinds(world.supervisor.headers)


async def test_projects_list_hides_values_without_the_screens(
    client: AsyncClient, world: World
) -> None:
    """A lista de projetos é de toda a gestão (o seletor da Nova OS usa), mas o valor do contrato
    só sai com Projetos, e cada total também pede a tela dele (a margem, Custos e Pagamentos)."""
    sup, an = world.supervisor.headers, world.analyst.headers
    body = {"name": "Projeto Teste", "contract_value": "1000.00", "pricing_notes": "Tabela X"}
    r = await client.post(f"{API}/projects", json=body, headers=sup)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    ticket = await create(client, world, assignee_id=str(world.tech.user.id), project_id=pid)
    await money_trail(client, world, ticket)
    totals = ("payouts_total", "expenses_total", "quotes_approved_total")

    async def row() -> dict:
        r = await client.get(f"{API}/projects", headers=an)
        assert r.status_code == 200, r.text
        return next(p for p in r.json() if p["id"] == pid)

    seen = await row()
    assert (seen["contract_value"], seen["margin"]) == (1000.0, 913.0)
    assert tuple(seen["stats"][k] for k in totals) == (80.0, 7.0, 50.0)

    await restrict_analyst(client, world, **ALL_NONE)
    assert (await client.get(f"{API}/projects/{pid}", headers=an)).status_code == 403
    seen = await row()
    assert (seen["contract_value"], seen["pricing_notes"], seen["margin"]) == (None, None, None)
    assert tuple(seen["stats"][k] for k in totals) == (0, 0, 0)
    assert seen["stats"]["tickets_total"] == 1  # as contagens de OS continuam

    # Projetos sim, as três telas comerciais não: o contrato aparece, os totais e a margem não.
    await restrict_analyst(client, world, **NO_MONEY)
    one = (await client.get(f"{API}/projects/{pid}", headers=an)).json()
    assert (one["contract_value"], one["pricing_notes"], one["margin"]) == (
        1000.0,
        "Tabela X",
        None,
    )
    assert tuple(one["stats"][k] for k in totals) == (0, 0, 0)
    # Só sem Pagamentos, a margem também não sai (seria o contrato menos só os custos).
    await restrict_analyst(client, world, **{"commercial.payouts": "none"})
    one = (await client.get(f"{API}/projects/{pid}", headers=an)).json()
    assert (one["margin"], one["stats"]["expenses_total"], one["stats"]["payouts_total"]) == (
        None,
        7.0,
        0,
    )


async def test_monthly_report_and_home_money_follow_the_screens(
    client: AsyncClient, world: World
) -> None:
    sup, an = world.supervisor.headers, world.analyst.headers
    ticket = await create(client, world, assignee_id=str(world.tech.user.id))
    await money_trail(client, world, ticket)
    # Mais um orçamento, este aguardando o cliente.
    other = await create(client, world)
    r = await client.post(f"{API}/tickets/{other['id']}/quotes", json=QUOTE, headers=sup)
    assert r.status_code == 201, r.text
    r = await client.post(f"{API}/quotes/{r.json()['id']}/send", headers=sup)
    assert r.status_code == 200, r.text

    monthly = (await client.get(f"{API}/reports/monthly", headers=an)).json()
    assert (monthly["expenses_total"], monthly["quotes_approved_total"]) == (7.0, 50.0)
    finance = (await client.get(f"{API}/home/overview", headers=an)).json()["pulse"]["finance"]
    assert (finance["quotes_waiting"], finance["quotes_approved_month"]) == (1, 1)

    # Relatórios sim, Custos extras e Orçamentos não: os dois totais do mês saem null.
    await restrict_analyst(
        client, world, **{"commercial.expenses": "none", "commercial.quotes": "none"}
    )
    r = await client.get(f"{API}/reports/monthly", headers=an)
    assert r.status_code == 200, r.text
    assert (r.json()["expenses_total"], r.json()["quotes_approved_total"]) == (None, None)

    # Início sem Orçamentos: pulse.quotes já sai null, e o financeiro sai sem os números de
    # orçamento; custos e pagamentos continuam.
    await restrict_analyst(client, world, **{"commercial.quotes": "none"})
    pulse = (await client.get(f"{API}/home/overview", headers=an)).json()["pulse"]
    finance = pulse["finance"]
    assert pulse["quotes"] is None
    assert (finance["quotes_waiting"], finance["quotes_waiting_total"]) == (0, 0)
    assert (finance["quotes_approved_month"], finance["quotes_approved_month_total"]) == (0, 0)
    assert finance["costs_pending_total"] == 7.0


async def test_ticket_expenses_route_follows_the_detail(client: AsyncClient, world: World) -> None:
    """GET /tickets/{id}/expenses segue as regras do detalhe: o técnico vê o reembolso dele e o
    material da OS, não o do colega, e não vê quem lançou."""
    sup = world.supervisor.headers
    ticket = await create(
        client,
        world,
        assignee_id=str(world.tech.user.id),
        helper_ids=[str(world.tech_other.user.id)],
    )
    url = f"{API}/tickets/{ticket['id']}/expenses"
    parking = {
        "kind": "parking",
        "description": "Estacionamento do colega",
        "quantity": 1,
        "unit_value": "33.00",
        "technician_id": str(world.tech_other.user.id),
    }
    for body in (COST, parking):
        r = await client.post(url, json=body, headers=sup)
        assert r.status_code == 201, r.text
    for actor in (world.tech, world.tech_other, world.analyst):
        route = (await client.get(url, headers=actor.headers)).json()
        detail = (await client.get(f"{API}/tickets/{ticket['id']}", headers=actor.headers)).json()
        assert route == detail["expenses"], actor.user.name
    mine = (await client.get(url, headers=world.tech.headers)).json()
    assert [(e["description"], e["created_by"]) for e in mine] == [("Conector", None)]
    helper = (await client.get(url, headers=world.tech_other.headers)).json()
    assert [e["description"] for e in helper] == ["Estacionamento do colega"]
    office = (await client.get(url, headers=world.analyst.headers)).json()
    assert len(office) == 2 and all(e["created_by"] is not None for e in office)


async def test_cost_receipt_stays_with_extra_costs(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O comprovante de custo é custo: sem Custos extras, a gestão não o vê entre os anexos nem
    mexe nele. Excluído por quem tem a tela, o custo fica sem comprovante; o reembolsado não troca
    de comprovante."""
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    sup, an = world.supervisor.headers, world.analyst.headers
    t = await create(client, world, title="Troca de fonte")

    async def photo(name: str) -> str:
        r = await client.post(
            f"{API}/tickets/{t['id']}/attachments",
            files={"file": (name, PNG, "image/png")},
            data={"kind": "photo"},
            headers=sup,
        )
        assert r.status_code == 201, r.text
        return r.json()["id"]

    visit, receipt = await photo("rack.png"), await photo("recibo-pedagio.png")
    toll = {"kind": "toll", "description": "Pedágio", "quantity": 1, "unit_value": "12.00"}
    r = await client.post(
        f"{API}/tickets/{t['id']}/expenses",
        json={**toll, "receipt_attachment_id": receipt},
        headers=sup,
    )
    assert r.status_code == 201, r.text
    expense = f"{API}/expenses/{r.json()['id']}"

    async def listed(headers: dict) -> list[str]:
        r = await client.get(f"{API}/tickets/{t['id']}/attachments", headers=headers)
        assert r.status_code == 200, r.text
        return [a["id"] for a in r.json()]

    assert await listed(an) == [visit, receipt]  # no padrão, com Custos extras
    await restrict_analyst(client, world, **{"commercial.expenses": "none"})
    assert await listed(an) == [visit]
    assert await listed(sup) == [visit, receipt]
    # Nem pelo id: para ele o comprovante não existe.
    r = await client.patch(f"{API}/attachments/{receipt}", json={"description": "x"}, headers=an)
    assert r.status_code == 404
    assert (await client.delete(f"{API}/attachments/{receipt}", headers=an)).status_code == 404
    assert (await client.delete(f"{API}/attachments/{visit}", headers=an)).status_code == 204

    # Reembolsado: o comprovante fica (volte o custo para Aprovado antes).
    for status in ("approved", "paid"):
        r = await client.patch(expense, json={"status": status}, headers=sup)
        assert r.status_code == 200, r.text
    r = await client.delete(f"{API}/attachments/{receipt}", headers=sup)
    assert r.status_code == 422 and "reembolsado" in r.json()["detail"]
    assert (
        await client.patch(expense, json={"status": "approved"}, headers=sup)
    ).status_code == 200
    assert (await client.delete(f"{API}/attachments/{receipt}", headers=sup)).status_code == 204
    rows = (await client.get(f"{API}/tickets/{t['id']}/expenses", headers=sup)).json()
    assert [e["receipt_attachment_id"] for e in rows] == [None]  # sem apontar para o apagado


async def test_location_import_creates_customers_only_with_customers_edit(
    client: AsyncClient, world: World
) -> None:
    """Locais: Editar importa lojas; cliente novo pelas colunas da planilha pede Clientes: Editar,
    como o POST /customers (a linha dá erro na prévia e na gravação)."""
    an = world.analyst.headers
    csv = (
        "Cliente;Código;Local;Cidade;UF\n"
        "Cliente Teste;L01;Loja Centro;São Paulo;SP\n"
        "Rede X;R01;Rede X Centro;Campinas;SP\n"
        "Rede X;R02;Rede X Norte;Campinas;SP\n"
    )
    files = {"file": ("locais.csv", csv.encode("cp1252"), "text/csv")}
    await restrict_analyst(client, world, **{"base.customers": "view", "base.locations": "edit"})
    r = await client.post(f"{API}/customers", json={"name": "Rede X"}, headers=an)
    assert r.status_code == 403 and r.json()["code"] == "MODULE_FORBIDDEN"
    for dry_run in (True, False):
        r = await client.post(
            f"{API}/locations/import", params={"dry_run": dry_run}, files=files, headers=an
        )
        assert r.status_code == 200, r.text
        out = r.json()
        assert (out["created"], out["errors"], out["customers_created"]) == (1, 2, 0)
        errors = {row["line"]: row["errors"] for row in out["rows"] if row["errors"]}
        assert errors == {3: [NEW_CUSTOMER_FORBIDDEN], 4: [NEW_CUSTOMER_FORBIDDEN]}
    names = {c["name"] for c in (await client.get(f"{API}/customers", headers=an)).json()}
    assert "Rede X" not in names
    # Com Clientes: Editar (o padrão do analista), o mesmo arquivo cria o cliente.
    await restrict_analyst(client, world)
    r = await client.post(f"{API}/locations/import", files=files, headers=an)
    assert (r.json()["customers_created"], r.json()["errors"]) == (1, 0)


async def test_project_margin_needs_every_queue(client: AsyncClient, world: World) -> None:
    """Com "Somente a própria fila", os totais do projeto são só das OS da fila e o contrato é do
    projeto inteiro: a margem não sai (sairia maior que a real)."""
    sup, an = world.supervisor.headers, world.analyst.headers
    body = {"name": "Projeto Filas", "contract_value": "1000.00"}
    r = await client.post(f"{API}/projects", json=body, headers=sup)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    # Uma OS na fila do supervisor (R$ 300 de técnico) e outra na do analista.
    other = await create(client, world, project_id=pid, assignee_id=str(world.tech.user.id))
    r = await client.put(
        f"{API}/tickets/{other['id']}/payouts/{world.tech.user.id}",
        json={"amount": "300.00"},
        headers=sup,
    )
    assert r.status_code == 200, r.text
    mine = {"title": "Do analista", "customer_id": world.customer_id, "project_id": pid}
    assert (await client.post(f"{API}/tickets", json=mine, headers=an)).status_code == 201

    full = (await client.get(f"{API}/projects/{pid}", headers=sup)).json()
    assert (full["margin"], full["stats"]["payouts_total"], full["stats"]["tickets_total"]) == (
        700.0,
        300.0,
        2,
    )
    await set_access(client, world.admin.headers, world.analyst.user.id, scope="own", unowned=False)
    own = (await client.get(f"{API}/projects/{pid}", headers=an)).json()
    assert (own["contract_value"], own["margin"]) == (1000.0, None)
    assert (own["stats"]["payouts_total"], own["stats"]["tickets_total"]) == (0, 1)
    rows = (await client.get(f"{API}/projects", headers=an)).json()
    assert next(p for p in rows if p["id"] == pid)["margin"] is None


async def test_users_screen_shows_the_saved_role_default(client: AsyncClient, world: World) -> None:
    """Analista sem perfil (login Microsoft, importação) cai no perfil padrão gravado: Usuários
    mostra o mesmo acesso do /auth/me (e das guardas), e o "Usado por N" do padrão conta ele."""
    adm, an = world.admin.headers, world.analyst.headers
    analyst_profile = (await profiles(client, world))["Analista"]
    r = await client.patch(
        f"{API}/access/profiles/{analyst_profile['id']}",
        json={"items": {"commercial.payouts": "none"}},
        headers=adm,
    )
    assert r.status_code == 200, r.text
    uid = str(world.analyst.user.id)
    me = (await client.get(f"{API}/auth/me", headers=an)).json()
    assert me["access"]["items"]["commercial.payouts"] == "none"
    assert (await client.get(f"{API}/payouts", headers=an)).status_code == 403

    listed = next(
        u for u in (await client.get(f"{API}/users", headers=adm)).json() if u["id"] == uid
    )
    one = (await client.get(f"{API}/users/{uid}", headers=adm)).json()
    for seen in (listed, one):
        assert (seen["access_profile_id"], seen["access"]) == (None, me["access"])
    r = await client.patch(f"{API}/users/{uid}", json={"job_title": "Analista N1"}, headers=adm)
    assert r.status_code == 200, r.text
    assert r.json()["access"] == me["access"]

    # "Usado por N" e a lista que ele abre contam quem está sem perfil.
    count = {p["id"]: p["users_count"] for p in (await profiles(client, world)).values()}
    assert count[analyst_profile["id"]] == 1
    r = await client.get(
        f"{API}/users", params={"access_profile_id": analyst_profile["id"]}, headers=adm
    )
    assert [u["id"] for u in r.json()] == [uid]


async def test_shared_reads_stay_open_with_everything_none(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    await restrict_analyst(client, world, **ALL_NONE)
    me = (await client.get(f"{API}/auth/me", headers=an)).json()
    assert set(me["access"]["items"].values()) == {"none"}
    start = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    for path in (
        "/customers",
        f"/customers/{world.customer_id}/locations",
        "/locations",
        f"/locations/{world.location_id}",
        f"/intake/context?location_id={world.location_id}",
        "/service-types",
        "/categories",
        "/sla-policies",
        "/violation-reasons",
        "/unproductive-reasons",
        "/ticket-tags",
        "/ticket-tag-rules",
        "/form-templates",
        "/users",
        "/users/assignable",
        "/teams",
        "/queues",
        "/my-queue",
        "/projects",
        f"/calendar/conflicts?start={start.replace('+', '%2B')}",
        "/technicians/suggest?city=Campinas&state=SP",
        "/settings/company",
        "/settings/expenses",
        "/settings/field",
        "/portal/inbox-count",
        "/home/overview",
        "/search/smart?q=impressora",
        "/access/catalog",
        "/tickets",
    ):
        r = await client.get(f"{API}{path}", headers=an)
        assert r.status_code == 200, (path, r.text)
    body = {"title": "Aberta sem telas", "customer_id": world.customer_id}
    assert (await client.post(f"{API}/tickets", json=body, headers=an)).status_code == 201
    # E as telas, não.
    for path in ("/payouts", "/quotes", "/technicians", "/dashboard/summary", "/access/profiles"):
        r = await client.get(f"{API}{path}", headers=an)
        assert r.status_code == 403 and r.json()["code"] == "MODULE_FORBIDDEN", path


# ---------------------------------------------------------------- validação e resolução


async def test_invalid_items_are_422(client: AsyncClient, world: World) -> None:
    adm = world.admin.headers
    r = await client.post(
        f"{API}/access/profiles",
        json={"name": "Errado", "items": {"modulo.x": "view"}},
        headers=adm,
    )
    assert r.status_code == 422 and r.json()["detail"] == "Tela desconhecida: modulo.x"
    r = await client.post(
        f"{API}/access/profiles",
        json={"name": "Errado", "items": {"analysis.dashboard": "edit"}},
        headers=adm,
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "Dashboard só tem Sem acesso ou Visualizar"
    await set_access(client, adm, world.analyst.user.id, items={"setup.nada": "view"}, expect=422)


async def test_override_wins_and_null_follows_profile(client: AsyncClient, world: World) -> None:
    an, adm = world.analyst.headers, world.admin.headers
    profile = await restrict_analyst(client, world, **{"commercial.payouts": "none"})
    assert (await client.get(f"{API}/payouts", headers=an)).status_code == 403

    out = await set_access(
        client,
        adm,
        world.analyst.user.id,
        profile_id=profile["id"],
        items={"commercial.payouts": "edit"},
    )
    assert out["access"]["customized"] is True
    assert out["access_overrides"] == {"items": {"commercial.payouts": "edit"}}
    assert (await client.get(f"{API}/payouts", headers=an)).status_code == 200

    # Ajuste nulo: segue o perfil (e o ajuste igual ao perfil nem é gravado).
    out = await set_access(
        client,
        adm,
        world.analyst.user.id,
        profile_id=profile["id"],
        items={"commercial.payouts": None, "commercial.quotes": "edit"},
    )
    assert out["access_overrides"] is None
    assert out["access"]["customized"] is False
    assert (await client.get(f"{API}/payouts", headers=an)).status_code == 403

    # Fila: "todas" já inclui a sem analista.
    await client.patch(
        f"{API}/access/profiles/{profile['id']}",
        json={"queue_scope": "own", "queue_unowned": False},
        headers=adm,
    )
    me = (await client.get(f"{API}/auth/me", headers=an)).json()
    assert me["access"]["queues"] == {"scope": "own", "unowned": False}
    out = await set_access(
        client, adm, world.analyst.user.id, profile_id=profile["id"], scope="all", unowned=False
    )
    assert out["access"]["queues"] == {"scope": "all", "unowned": True}
    assert out["access_overrides"] == {"queue_scope": "all"}


def test_resolve_rules() -> None:
    """O cálculo puro: clamp das telas só de leitura, padrão do papel e chave desconhecida."""

    class P:
        id = uuid.uuid4()
        name = "Perfil"
        system_key = None
        items = {"analysis.reports": "edit", "nada.disso": "edit", "commercial.payouts": "none"}
        queue_scope = "own"
        queue_unowned = False

    class U:
        role = "analyst"
        access_overrides = {"items": {"commercial.payouts": "view"}, "queue_unowned": True}

    acc = permissions.resolve(U(), P())
    assert len(acc.items) == len(permissions.ITEM_KEYS) == 19
    assert acc.level("analysis.reports") == "view"  # Editar numa tela só de leitura vira Ver
    assert acc.level("setup.settings") == "none"  # padrão do analista
    assert acc.level("commercial.payouts") == "view"
    assert (acc.queue_scope, acc.queue_unowned, acc.customized) == ("own", True, True)
    assert permissions.allows_link(acc, "/chamados?no_owner=1")  # núcleo
    assert not permissions.allows_link(acc, "/configuracoes")
    assert permissions.item_for_link("/orcamentos?cobrar=1") == "commercial.quotes"
    assert permissions.item_for_link("/dia") == "operation.day"
    with pytest.raises(ValueError):
        require_access("modulo.inexistente")


# ---------------------------------------------------------------- sessão


async def test_me_and_login_bring_effective_access(client: AsyncClient, world: World) -> None:
    r = await client.post(
        f"{API}/auth/login", json={"email": "analista@teste.com.br", "password": "senha-teste-123"}
    )
    assert r.status_code == 200, r.text
    access = r.json()["user"]["access"]
    assert len(access["items"]) == 19
    assert access["full"] is False
    assert access["items"]["setup.users"] == "view"
    assert access["items"]["setup.settings"] == "none"
    assert access["queues"] == {"scope": "all", "unowned": True}
    me = (await client.get(f"{API}/auth/me", headers=world.supervisor.headers)).json()
    assert len(me["access"]["items"]) == 19 and me["access"]["items"]["setup.settings"] == "edit"
    tech = (await client.get(f"{API}/auth/me", headers=world.tech.headers)).json()
    assert tech["access"] is None


async def test_change_applies_on_the_next_request(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    assert (await client.get(f"{API}/technicians", headers=an)).status_code == 200
    await set_access(
        client, world.admin.headers, world.analyst.user.id, items={"base.technicians": "none"}
    )
    # O mesmo token, sem novo login.
    r = await client.get(f"{API}/technicians", headers=an)
    assert r.status_code == 403 and r.json()["item"] == "base.technicians"


# ---------------------------------------------------------------- gestão dos perfis


async def test_profile_crud(client: AsyncClient, world: World) -> None:
    adm, sup = world.admin.headers, world.supervisor.headers
    found = await profiles(client, world)
    assert list(found)[:2] == ["Supervisor", "Analista"]
    analyst_profile = found["Analista"]
    assert analyst_profile["system_key"] == "analyst" and analyst_profile["items"] == {}
    assert analyst_profile["effective_items"]["setup.settings"] == "none"

    body = {"name": "Comercial"}
    assert (await client.post(f"{API}/access/profiles", json=body, headers=sup)).status_code == 403
    created = await new_profile(client, world, "Comercial", items={"analysis.dashboard": "none"})
    # Sem "começar igual a": o Analista, com as telas enviadas por cima (dicionário completo).
    assert len(created["items"]) == 19
    assert created["items"]["setup.settings"] == "none"
    assert created["items"]["analysis.dashboard"] == "none"
    r = await client.post(f"{API}/access/profiles", json={"name": "comercial"}, headers=adm)
    assert r.status_code == 409 and r.json()["detail"] == "Já existe um perfil com este nome"

    copy = await new_profile(client, world, "Coordenação", copy_from_id=found["Supervisor"]["id"])
    assert copy["items"] == found["Supervisor"]["effective_items"]
    assert copy["items"]["setup.settings"] == "edit"

    # Em uso não sai; perfil padrão nunca sai.
    await set_access(client, adm, world.analyst.user.id, profile_id=created["id"])
    r = await client.delete(f"{API}/access/profiles/{created['id']}", headers=adm)
    assert r.status_code == 409
    assert r.json()["detail"] == "Perfil em uso por 1 usuário. Troque o perfil deles antes."
    r = await client.delete(f"{API}/access/profiles/{analyst_profile['id']}", headers=adm)
    assert r.status_code == 409 and r.json()["detail"] == "Perfis padrão não são excluídos."
    users = await client.get(f"{API}/users?access_profile_id={created['id']}", headers=adm)
    assert [u["id"] for u in users.json()] == [str(world.analyst.user.id)]
    await set_access(client, adm, world.analyst.user.id)  # volta ao padrão do papel
    assert (
        await client.delete(f"{API}/access/profiles/{created['id']}", headers=adm)
    ).status_code == 204

    # Perfil padrão: o nome não muda; restaurar limpa as telas e a fila.
    url = f"{API}/access/profiles/{analyst_profile['id']}"
    r = await client.patch(url, json={"name": "Outro nome"}, headers=adm)
    assert r.status_code == 422 and r.json()["detail"] == "O nome dos perfis padrão não muda"
    r = await client.patch(
        url, json={"items": {"commercial.payouts": "none"}, "queue_scope": "own"}, headers=adm
    )
    assert r.json()["items"] == {"commercial.payouts": "none"}
    assert r.json()["users_count"] == 1
    reset = await client.post(f"{url}/reset", headers=adm)
    assert reset.status_code == 200, reset.text
    assert reset.json()["items"] == {}
    assert reset.json()["queue_scope"] == "all"
    assert reset.json()["effective_items"]["commercial.payouts"] == "edit"
    r = await client.post(f"{API}/access/profiles/{copy['id']}/reset", headers=adm)
    assert r.status_code == 422

    catalog = (await client.get(f"{API}/access/catalog", headers=world.analyst.headers)).json()
    assert [m["key"] for m in catalog["modules"]] == [
        "operation",
        "commercial",
        "base",
        "analysis",
        "setup",
    ]
    assert sum(len(m["items"]) for m in catalog["modules"]) == 19
    assert catalog["defaults"]["analyst"]["setup.users"] == "view"


async def test_supervisor_cap_and_hierarchy(client: AsyncClient, world: World) -> None:
    adm, sup = world.admin.headers, world.supervisor.headers
    found = await profiles(client, world)
    # O supervisor fica com Pagamentos só para ver e só a própria fila.
    capped = await new_profile(
        client,
        world,
        "Supervisor com teto",
        copy_from_id=found["Supervisor"]["id"],
        items={"commercial.payouts": "view"},
        queue_scope="own",
        queue_unowned=False,
    )
    await set_access(client, adm, world.supervisor.user.id, profile_id=capped["id"])
    # O analista começa sem Pagamentos e só com a própria fila.
    restricted = await restrict_analyst(client, world, **{"commercial.payouts": "none"})
    analyst_profile = restricted["id"]
    await set_access(
        client, adm, world.analyst.user.id, profile_id=analyst_profile, scope="own", unowned=False
    )

    # Dentro do teto: dar Visualizar em Pagamentos.
    out = await set_access(
        client,
        sup,
        world.analyst.user.id,
        profile_id=analyst_profile,
        items={"commercial.payouts": "view"},
        scope="own",
        unowned=False,
    )
    assert out["access"]["items"]["commercial.payouts"] == "view"
    # Acima do teto: Editar em Pagamentos, ou todas as filas.
    for extra in ({"items": {"commercial.payouts": "edit"}}, {"scope": "all"}):
        r = await client.patch(
            f"{API}/users/{world.analyst.user.id}",
            json={
                "access": {
                    "profile_id": analyst_profile,
                    "overrides": {
                        "items": extra.get("items"),
                        "queue_scope": extra.get("scope", "own"),
                        "queue_unowned": False,
                    },
                }
            },
            headers=sup,
        )
        assert r.status_code == 403, r.text
        assert r.json() == {
            "detail": "Você não pode dar mais acesso do que tem.",
            "code": "ACCESS_CAP",
        }

    # Hierarquia: supervisor não mexe em supervisor, em admin nem em si mesmo.
    for target in (world.admin.user.id, world.supervisor.user.id):
        await set_access(client, sup, target, items={"base.customers": "none"}, expect=403)
    # Nem cria analista com mais acesso do que ele tem (o padrão do Analista edita Pagamentos).
    body = {
        "name": "Analista Novo",
        "email": "analista.novo@teste.com.br",
        "password": "senha-teste-123",
        "role": "analyst",
    }
    r = await client.post(f"{API}/users", json=body, headers=sup)
    assert r.status_code == 403 and r.json()["code"] == "ACCESS_CAP"


async def test_supervisor_cap_covers_password_and_email(client: AsyncClient, world: World) -> None:
    """Entrar como a pessoa daria ao supervisor o acesso que o teto não deixa dar: restrito, ele
    não troca a senha nem o e-mail de quem tem mais acesso (isso fica com o administrador)."""
    adm, sup = world.admin.headers, world.supervisor.headers
    analyst = f"{API}/users/{world.analyst.user.id}"
    # Nos padrões, como sempre.
    r = await client.patch(analyst, json={"password": "senha-nova-111"}, headers=sup)
    assert r.status_code == 200, r.text
    await set_access(
        client,
        adm,
        world.supervisor.user.id,
        items={"commercial.payouts": "none"},
        scope="own",
        unowned=False,
    )
    for body in ({"password": "senha-nova-456"}, {"email": "analista.outro@teste.com.br"}):
        r = await client.patch(analyst, json=body, headers=sup)
        assert r.status_code == 403, r.text
        assert r.json() == {
            "detail": "Só o administrador troca a senha ou o e-mail de quem tem mais acesso "
            "que você.",
            "code": "ACCESS_CAP",
        }
    # O resto do cadastro continua, e o e-mail igual ao atual não conta como troca.
    for body in ({"job_title": "Analista de suporte"}, {"email": "Analista@teste.com.br"}):
        r = await client.patch(analyst, json=body, headers=sup)
        assert r.status_code == 200, r.text
    # Com o analista no mesmo nível, o supervisor volta a trocar a senha.
    await set_access(
        client,
        adm,
        world.analyst.user.id,
        items={"commercial.payouts": "none"},
        scope="own",
        unowned=False,
    )
    r = await client.patch(analyst, json={"password": "senha-nova-789"}, headers=sup)
    assert r.status_code == 200, r.text
    # O administrador não tem teto.
    r = await client.patch(analyst, json={"password": "senha-nova-000"}, headers=adm)
    assert r.status_code == 200, r.text


async def test_role_change_follows_profile(client: AsyncClient, world: World) -> None:
    adm = world.admin.headers
    found = await profiles(client, world)
    uid = world.analyst.user.id
    await set_access(client, adm, uid)  # padrão do Analista
    r = await client.patch(f"{API}/users/{uid}", json={"role": "supervisor"}, headers=adm)
    assert r.status_code == 200, r.text
    assert r.json()["access_profile_id"] == found["Supervisor"]["id"]
    assert r.json()["access"]["items"]["setup.settings"] == "edit"
    await set_access(client, adm, uid, items={"commercial.quotes": "none"})
    r = await client.patch(f"{API}/users/{uid}", json={"role": "technician"}, headers=adm)
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["access_profile_id"], out["access_overrides"], out["access"]) == (None, None, None)


async def test_create_user_gets_role_profile(client: AsyncClient, world: World) -> None:
    adm = world.admin.headers
    body = {
        "name": "Analista Criado",
        "email": "analista.criado@teste.com.br",
        "password": "senha-teste-123",
        "role": "analyst",
    }
    r = await client.post(f"{API}/users", json=body, headers=adm)
    assert r.status_code == 201, r.text
    assert r.json()["access_profile"]["name"] == "Analista"
    assert r.json()["access"]["items"]["setup.users"] == "view"
    tech = {
        **body,
        "email": "tecnico.criado@teste.com.br",
        "role": "technician",
        "access": {"profile_id": None},
    }
    r = await client.post(f"{API}/users", json=tech, headers=adm)
    assert r.status_code == 422 and r.json()["detail"] == "Este papel não usa perfil de acesso"


# ---------------------------------------------------------------- regras duras de papel


async def test_sla_policies_stay_admin_only(client: AsyncClient, world: World) -> None:
    body = {"response_minutes": 60, "resolution_minutes": 480}
    url = f"{API}/sla-policies/high"
    sup = await client.put(url, json=body, headers=world.supervisor.headers)
    assert sup.status_code == 403
    assert (await client.put(url, json=body, headers=world.admin.headers)).status_code == 200


async def test_lgpd_deletion_stays_with_admin_and_supervisor(
    client: AsyncClient, world: World
) -> None:
    url = f"{API}/onboarding/applications/{uuid.uuid4()}"
    # O analista edita a Homologação, mas não apaga ficha (403 de papel, como antes).
    r = await client.delete(url, headers=world.analyst.headers)
    assert r.status_code == 403 and r.json() == {"detail": "Sem permissão para esta ação"}
    # O supervisor passa pela guarda (a ficha não existe).
    assert (await client.delete(url, headers=world.supervisor.headers)).status_code == 404
