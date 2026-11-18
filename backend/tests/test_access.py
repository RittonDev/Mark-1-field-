"""Permissões por tela (perfis de acesso e ajustes por usuário) contra PostgreSQL.

Os padrões dos perfis reproduzem o acesso de antes dos perfis; o administrador é sempre total; a
guarda vale na API (403 com código que a tela reconhece), não só no menu.
"""

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.api.deps import require_access
from app.core import permissions
from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create

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
