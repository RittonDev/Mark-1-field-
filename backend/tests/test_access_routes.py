"""Inventário das rotas: toda rota da API tem uma guarda conhecida.

- GUARDED: rota de uma tela do menu (guarda `access_user`, app/api/deps.py): as telas e o nível.
- SHARED: consultas que a Nova OS, o editor, a OS, os filtros, a Minha fila e o Início usam. Ficam
  abertas a toda a gestão (nunca bloquear por tela); a visibilidade de filas vale dentro delas.
- CORE: o núcleo da gestão (Início, Minha fila, Chamados e tudo dentro da OS), sem tela.
- OTHER: rotas de outro papel (técnico, cliente, administrador), de qualquer pessoa logada ou
  públicas.

Rota nova sem classificação faz este teste falhar: decida se ela é de uma tela do menu, uma
consulta compartilhada, do núcleo ou de outro papel, e acrescente aqui.
"""

from collections.abc import Iterator
from typing import Any

from fastapi.routing import APIRoute, APIWebSocketRoute

from app.api import deps
from app.core import permissions
from app.core.config import settings
from app.core.enums import UserRole
from app.main import app
from app.models.user import STAFF_ROLES, TICKET_MANAGER_ROLES

P = settings.API_PREFIX
V, E = "view", "edit"
ANY = "ANY"  # rota que o técnico também usa: só a gestão é conferida na matriz
MANAGER = "MANAGER"  # regra dura: só admin e supervisor, além da tela

GUARDED: dict[tuple[str, str], tuple[tuple[str, ...], str] | tuple[tuple[str, ...], str, str]] = {
    # Operação
    ("GET", "/activities/day"): (("operation.day", "operation.map"), V),
    ("GET", "/calendar"): (("operation.calendar",), V),
    ("GET", "/tracking/live"): (("operation.map",), V),
    ("GET", "/tracking/distances"): (("operation.map",), V),
    ("GET", "/tracking/history"): (("operation.map",), V),
    ("GET", "/repairs"): (("operation.repairs",), V),
    ("GET", "/repairs/summary"): (("operation.repairs",), V),
    ("GET", "/repairs/{repair_id}"): (("operation.repairs",), V),
    ("POST", "/repairs"): (("operation.repairs",), E),
    ("PUT", "/repairs/{repair_id}"): (("operation.repairs",), E),
    ("POST", "/repairs/{repair_id}/status"): (("operation.repairs",), E),
    ("POST", "/repairs/{repair_id}/photos"): (("operation.repairs",), E),
    # Comercial
    ("GET", "/quote-items"): (("commercial.quotes",), V),
    ("GET", "/quote-items/last-prices"): (("commercial.quotes",), V),
    ("GET", "/tickets/{ticket_id}/quotes"): (("commercial.quotes",), V),
    ("GET", "/quotes"): (("commercial.quotes",), V),
    ("GET", "/quotes/summary"): (("commercial.quotes",), V),
    ("POST", "/quote-items"): (("commercial.quotes",), E),
    ("PUT", "/quote-items/{item_id}"): (("commercial.quotes",), E),
    ("POST", "/tickets/{ticket_id}/quotes"): (("commercial.quotes",), E),
    ("PUT", "/quotes/{quote_id}"): (("commercial.quotes",), E),
    ("POST", "/quotes/{quote_id}/send"): (("commercial.quotes",), E),
    ("POST", "/quotes/{quote_id}/remind"): (("commercial.quotes",), E),
    ("POST", "/quotes/{quote_id}/link/rotate"): (("commercial.quotes",), E),
    ("POST", "/quotes/{quote_id}/cancel"): (("commercial.quotes",), E),
    ("GET", "/projects/{project_id}"): (("commercial.projects",), V),
    ("POST", "/projects"): (("commercial.projects",), E),
    ("PUT", "/projects/{project_id}"): (("commercial.projects",), E),
    ("GET", "/tickets/{ticket_id}/expenses"): (("commercial.expenses",), V, ANY),
    ("POST", "/tickets/{ticket_id}/expenses"): (("commercial.expenses",), E),
    ("PATCH", "/expenses/{expense_id}"): (("commercial.expenses",), E),
    ("DELETE", "/expenses/{expense_id}"): (("commercial.expenses",), E),
    ("GET", "/expenses"): (("commercial.expenses", "commercial.payouts"), V),
    ("POST", "/expenses/mark-paid"): (("commercial.expenses",), E),
    ("GET", "/payouts"): (("commercial.payouts",), V),
    ("PUT", "/tickets/{ticket_id}/payouts/{technician_id}"): (("commercial.payouts",), E),
    ("DELETE", "/tickets/{ticket_id}/payouts/{technician_id}"): (("commercial.payouts",), E),
    ("POST", "/payouts/pay"): (("commercial.payouts",), E),
    ("POST", "/payouts/unpay"): (("commercial.payouts",), E),
    # Ofertas de OS: o valor oferecido ao técnico é de Pagamentos.
    ("GET", "/tickets/{ticket_id}/offers"): (("commercial.payouts",), V),
    ("POST", "/tickets/{ticket_id}/offers"): (("commercial.payouts",), E),
    ("POST", "/tickets/{ticket_id}/offers/{offer_id}/cancel"): (("commercial.payouts",), E),
    # Chave PIX do técnico: a central só remove (quem cadastra é ele, no app).
    ("DELETE", "/technicians/{user_id}/pix"): (("commercial.payouts",), E),
    # Base
    ("GET", "/customers/{customer_id}"): (("base.customers",), V),
    ("POST", "/customers"): (("base.customers",), E),
    ("PATCH", "/customers/{customer_id}"): (("base.customers",), E),
    ("GET", "/assets"): (("base.customers",), V),
    ("GET", "/assets/{asset_id}"): (("base.customers",), V),
    ("POST", "/assets"): (("base.customers",), E),
    ("PATCH", "/assets/{asset_id}"): (("base.customers",), E),
    ("POST", "/customers/{customer_id}/locations"): (("base.locations",), E),
    ("PATCH", "/locations/{location_id}"): (("base.locations",), E),
    ("POST", "/locations/import"): (("base.locations",), E),
    ("GET", "/technicians"): (("base.technicians",), V),
    ("GET", "/technicians/regions"): (("base.technicians", "base.onboarding"), V),
    ("GET", "/technicians/nearby"): (("base.technicians", "base.locations"), V),
    ("GET", "/technicians/favorites"): (("base.technicians",), V),
    ("GET", "/technicians/{user_id}"): (("base.technicians",), V),
    ("GET", "/technicians/{user_id}/changes"): (("base.technicians",), V),
    ("POST", "/technicians/regions/refresh"): (("base.technicians",), E),
    ("POST", "/technicians"): (("base.technicians",), E),
    ("PATCH", "/technicians/{user_id}"): (("base.technicians",), E),
    ("POST", "/technicians/{user_id}/reset-password"): (("base.technicians",), E),
    ("POST", "/technicians/{user_id}/photo"): (("base.technicians",), E),
    ("DELETE", "/technicians/{user_id}/photo"): (("base.technicians",), E),
    ("POST", "/technicians/import"): (("base.technicians",), E),
    ("PUT", "/technicians/favorites/{technician_id}"): (("base.technicians",), E),
    ("DELETE", "/technicians/favorites/{technician_id}"): (("base.technicians",), E),
    ("GET", "/onboarding/invites"): (("base.onboarding",), V),
    ("GET", "/onboarding/applications"): (("base.onboarding",), V),
    ("GET", "/onboarding/applications/pending-count"): (("base.onboarding",), V),
    ("GET", "/onboarding/applications/{application_id}"): (("base.onboarding",), V),
    ("POST", "/onboarding/invites"): (("base.onboarding",), E),
    ("DELETE", "/onboarding/invites/{invite_id}"): (("base.onboarding",), E),
    ("POST", "/onboarding/applications/{application_id}/approve"): (("base.onboarding",), E),
    ("POST", "/onboarding/applications/{application_id}/reject"): (("base.onboarding",), E),
    ("DELETE", "/onboarding/applications/{application_id}"): (("base.onboarding",), E, MANAGER),
    # Análise
    ("GET", "/dashboard/summary"): (("analysis.dashboard",), V),
    ("GET", "/reports/sla-violations"): (("analysis.dashboard", "analysis.reports"), V),
    ("GET", "/reports/daily"): (("analysis.reports", "analysis.dashboard"), V),
    ("GET", "/reports/monthly"): (("analysis.reports",), V),
    # Configuração
    ("GET", "/form-templates/catalog"): (("setup.forms",), V),
    ("GET", "/form-templates/{template_id}"): (("setup.forms",), V),
    ("GET", "/form-templates/{template_id}/usage"): (("setup.forms",), V),
    ("POST", "/form-templates"): (("setup.forms",), E),
    ("PUT", "/form-templates/{template_id}"): (("setup.forms",), E),
    ("GET", "/message-templates"): (("setup.messages",), V),
    ("PUT", "/message-templates"): (("setup.messages",), E),
    ("POST", "/message-templates/reset"): (("setup.messages",), E),
    ("POST", "/service-types"): (("setup.service_types",), E),
    ("PATCH", "/service-types/{service_type_id}"): (("setup.service_types",), E),
    ("POST", "/service-types/{service_type_id}/apply-observed"): (("setup.service_types",), E),
    ("GET", "/access/profiles"): (("setup.users",), V),
    ("POST", "/users"): (("setup.users",), E, MANAGER),
    ("PATCH", "/users/{user_id}"): (("setup.users",), E, MANAGER),
    ("POST", "/teams"): (("setup.users",), E),
    ("PATCH", "/teams/{team_id}"): (("setup.users",), E),
    ("POST", "/categories"): (("setup.settings",), E),
    ("PATCH", "/categories/{category_id}"): (("setup.settings",), E),
    ("POST", "/violation-reasons"): (("setup.settings",), E),
    ("PATCH", "/violation-reasons/{reason_id}"): (("setup.settings",), E),
    ("PUT", "/settings/company"): (("setup.settings",), E),
    ("PUT", "/settings/expenses"): (("setup.settings",), E),
    ("PUT", "/settings/field"): (("setup.settings",), E),
    ("PUT", "/ticket-tag-rules"): (("setup.settings",), E),
}

# Consultas compartilhadas: toda a gestão (nunca por tela).
SHARED = {
    ("GET", "/customers"),
    ("GET", "/customers/{customer_id}/locations"),
    ("GET", "/locations"),
    ("GET", "/locations/{location_id}"),
    ("GET", "/intake/context"),
    ("GET", "/service-types"),
    ("GET", "/categories"),
    ("GET", "/sla-policies"),
    ("GET", "/violation-reasons"),
    ("GET", "/ticket-tags"),
    ("GET", "/ticket-tag-rules"),
    ("GET", "/form-templates"),
    ("GET", "/users"),
    ("GET", "/users/assignable"),
    ("GET", "/teams"),
    ("GET", "/technicians/suggest"),
    ("GET", "/technicians/favorites/city"),
    ("GET", "/tickets/{ticket_id}/technician-suggestions"),
    ("GET", "/calendar/conflicts"),
    ("GET", "/projects"),
    ("GET", "/queues"),
    ("GET", "/settings/company"),
    ("GET", "/settings/expenses"),
    ("GET", "/portal/inbox-count"),
    ("GET", "/access/catalog"),
}

# Núcleo da gestão (sem tela): o gate da gestão mais a visibilidade de filas.
CORE = {
    ("GET", "/home/overview"),
    ("GET", "/search/smart"),
    ("GET", "/my-queue"),
    ("GET", "/tickets"),
    ("POST", "/tickets"),
    ("GET", "/tickets/export"),
    ("POST", "/tickets/bulk-tags"),
    ("POST", "/tickets/{ticket_id}/claim"),
    ("PUT", "/tickets/{ticket_id}/times"),
    ("GET", "/tickets/{ticket_id}/comments"),
    ("POST", "/tickets/{ticket_id}/comments"),
    ("GET", "/tickets/{ticket_id}/events"),
    ("DELETE", "/attachments/{attachment_id}"),
    ("GET", "/tickets/{ticket_id}/forms/suggestions"),
    ("POST", "/tickets/{ticket_id}/forms"),
    ("PATCH", "/tickets/{ticket_id}/forms/{form_id}"),
    ("DELETE", "/tickets/{ticket_id}/forms/{form_id}"),
    ("GET", "/tickets/{ticket_id}/messages"),
    ("PATCH", "/part-requests/{request_id}"),
    ("POST", "/tickets/{ticket_id}/report-link/rotate"),
    ("DELETE", "/tickets/{ticket_id}/report-link"),
    # Cadastro operacional que o analista mantém pela API desde antes (fora da matriz).
    ("POST", "/unproductive-reasons"),
    ("PATCH", "/unproductive-reasons/{reason_id}"),
}

# Outros papéis, qualquer pessoa logada ou sem login.
OTHER: dict[tuple[str, str], str] = {
    # Qualquer pessoa logada (a regra de cada um fica no serviço: técnico só a dele, etc.)
    ("GET", "/auth/me"): "CU",
    ("POST", "/auth/change-password"): "CU",
    ("DELETE", "/devices/{token}"): "CU",
    ("GET", "/me/earnings"): "CU",
    ("GET", "/tickets/lookup"): "CU",
    ("GET", "/tickets/{ticket_id}"): "CU",
    ("PATCH", "/tickets/{ticket_id}"): "CU",
    ("POST", "/tickets/{ticket_id}/assign"): "CU",
    ("PATCH", "/tickets/{ticket_id}/violation"): "CU",
    ("POST", "/tickets/{ticket_id}/transition"): "CU",
    ("POST", "/tickets/{ticket_id}/unproductive"): "CU",
    ("GET", "/tickets/{ticket_id}/attachments"): "CU",
    ("POST", "/tickets/{ticket_id}/attachments"): "CU",
    ("PUT", "/tickets/{ticket_id}/forms/{form_id}/answers"): "CU",
    ("POST", "/tickets/{ticket_id}/forms/{form_id}/photos"): "CU",
    ("DELETE", "/tickets/{ticket_id}/forms/{form_id}/photos/{attachment_id}"): "CU",
    ("POST", "/tickets/{ticket_id}/signature"): "CU",
    ("POST", "/tickets/{ticket_id}/report-link"): "CU",
    ("GET", "/portal/me"): "CU",
    ("GET", "/portal/locations"): "CU",
    ("GET", "/portal/requests"): "CU",
    ("POST", "/portal/requests"): "CU",
    ("GET", "/portal/requests/{request_id}"): "CU",
    ("POST", "/portal/requests/{request_id}/attachments"): "CU",
    ("POST", "/portal/requests/{request_id}/cancel"): "CU",
    # Equipe (gestão e técnico)
    ("GET", "/settings/field"): "SU",
    ("GET", "/unproductive-reasons"): "SU",
    ("POST", "/tickets/{ticket_id}/take"): "SU",
    ("GET", "/tickets/{ticket_id}/worklogs"): "SU",
    ("POST", "/tickets/{ticket_id}/worklogs"): "SU",
    ("PATCH", "/attachments/{attachment_id}"): "SU",
    ("GET", "/tickets/{ticket_id}/part-requests"): "SU",
    ("POST", "/tickets/{ticket_id}/part-requests"): "SU",
    ("GET", "/sync/pull"): "SU",
    ("POST", "/sync/push"): "SU",
    ("POST", "/devices"): "SU",
    ("GET", "/users/{user_id}"): "NT",
    # Só o administrador (regras duras)
    ("PUT", "/sla-policies/{priority}"): "ADMIN",
    ("POST", "/access/profiles"): "ADMIN",
    ("PATCH", "/access/profiles/{profile_id}"): "ADMIN",
    ("POST", "/access/profiles/{profile_id}/reset"): "ADMIN",
    ("DELETE", "/access/profiles/{profile_id}"): "ADMIN",
    # App do técnico
    ("POST", "/tracking/consent"): "TECHNICIAN",
    ("DELETE", "/tracking/consent"): "TECHNICIAN",
    ("GET", "/tracking/shift"): "TECHNICIAN",
    ("POST", "/tracking/shift/start"): "TECHNICIAN",
    ("POST", "/tracking/shift/end"): "TECHNICIAN",
    ("POST", "/tracking/pings"): "TECHNICIAN",
    ("GET", "/me/offers"): "TECHNICIAN",
    ("GET", "/me/offers/{offer_id}"): "TECHNICIAN",
    ("POST", "/me/offers/{offer_id}/accept"): "TECHNICIAN",
    ("POST", "/me/offers/{offer_id}/decline"): "TECHNICIAN",
    # Meu cadastro (o próprio técnico)
    ("GET", "/me/profile"): "TECHNICIAN",
    ("PATCH", "/me/profile"): "TECHNICIAN",
    ("POST", "/me/profile/photo"): "TECHNICIAN",
    ("DELETE", "/me/profile/photo"): "TECHNICIAN",
    # Sem login (ou link assinado)
    ("POST", "/auth/login"): "PUB",
    ("POST", "/auth/refresh"): "PUB",
    ("POST", "/auth/logout"): "PUB",
    ("GET", "/auth/providers"): "PUB",
    ("GET", "/auth/microsoft/start"): "PUB",
    ("GET", "/auth/microsoft/callback"): "PUB",
    ("POST", "/auth/microsoft/exchange"): "PUB",
    ("GET", "/meta"): "PUB",
    ("GET", "/attachments/{attachment_id}/download"): "PUB",
    ("GET", "/public/reports/{token}"): "PUB",
    ("GET", "/public/onboarding/catalog"): "PUB",
    ("GET", "/public/onboarding/{token}"): "PUB",
    ("POST", "/public/onboarding/{token}"): "PUB",
    ("GET", "/onboarding/applications/{application_id}/photo"): "PUB",
    ("GET", "/public/quotes/{token}"): "PUB",
    ("POST", "/public/quotes/{token}/approve"): "PUB",
    ("POST", "/public/quotes/{token}/reject"): "PUB",
    ("GET", "/quotes/{quote_id}/signature"): "PUB",
    ("GET", "/repair-photos/{photo_id}"): "PUB",
    ("GET", "/users/{user_id}/avatar"): "PUB",
    ("WS", "/ws"): "WS",
}


def _routes() -> Iterator[tuple[str, set[str], Any]]:
    """(caminho completo, métodos, rota) de todas as rotas, inclusive as dos routers incluídos."""
    try:
        from fastapi.routing import iter_route_contexts
    except ImportError:  # FastAPI antigo: app.routes já vem achatado
        for route in app.routes:
            yield getattr(route, "path", ""), set(getattr(route, "methods", None) or ()), route
        return
    for ctx in iter_route_contexts(app.routes):
        yield ctx.path, set(ctx.methods or ()), ctx.route


def _calls(dependant: Any) -> Iterator[Any]:
    for dep in dependant.dependencies:
        yield dep.call
        yield from _calls(dep)


def _guard(route: Any) -> tuple[str, Any]:
    """O tipo de guarda da rota: ("RULE", (itens, nível, papéis)) ou um dos tipos de OTHER, ou
    "TMU" para a gestão sem tela."""
    roles: Any = None
    current = False
    for call in _calls(route.dependant):
        rule = getattr(call, "access_rule", None)
        if rule is not None:
            items, level = rule
            who = call.roles
            kind = ANY if who is None else (MANAGER if who == deps.MANAGER_ROLES else None)
            assert who is None or who in (TICKET_MANAGER_ROLES, deps.MANAGER_ROLES), who
            return "RULE", (tuple(items), level, kind)
        if call is deps._not_technician:
            return "NT", None
        if hasattr(call, "roles") and roles is None:
            roles = call.roles
        if call is deps.get_current_user:
            current = True
    if roles is not None:
        if roles == TICKET_MANAGER_ROLES:
            return "TMU", None
        if roles == STAFF_ROLES:
            return "SU", None
        if roles == frozenset({UserRole.ADMIN}):
            return "ADMIN", None
        if roles == frozenset({UserRole.TECHNICIAN}):
            return "TECHNICIAN", None
        return "ROLES " + ",".join(sorted(r.value for r in roles)), None
    return ("CU" if current else "PUB"), None


def _inventory() -> dict[tuple[str, str], tuple[str, Any]]:
    found: dict[tuple[str, str], tuple[str, Any]] = {}
    for path, methods, route in _routes():
        if not path.startswith(P):
            continue
        short = path[len(P) :]
        if isinstance(route, APIWebSocketRoute):
            found[("WS", short)] = ("WS", None)
        elif isinstance(route, APIRoute):
            for method in methods - {"HEAD", "OPTIONS"}:
                found[(method, short)] = _guard(route)
    return found


def test_every_route_is_classified() -> None:
    found = _inventory()
    known = set(GUARDED) | SHARED | CORE | set(OTHER)
    assert not (SHARED & CORE), "rota em duas listas"
    assert not (set(GUARDED) & (SHARED | CORE | set(OTHER))), "rota em duas listas"
    new = sorted(set(found) - known)
    gone = sorted(known - set(found))
    assert not new, f"Rota sem classificação (tela, compartilhada, núcleo ou outro papel): {new}"
    assert not gone, f"Rota do inventário que não existe mais: {gone}"


def test_guarded_routes_have_the_expected_rule() -> None:
    found = _inventory()
    for key, expected in GUARDED.items():
        items, level, *who = expected
        kind, rule = found[key]
        assert kind == "RULE", (key, kind)
        assert rule == (items, level, who[0] if who else None), (key, rule)
        for item in items:
            assert item in permissions.ITEM_BY_KEY, (key, item)
            assert level in permissions.ITEM_BY_KEY[item].levels, (key, item, level)


def test_shared_and_core_routes_stay_with_the_whole_management() -> None:
    found = _inventory()
    for key in SHARED | CORE:
        assert found[key] == ("TMU", None), (key, found[key])


def test_other_routes_keep_their_role_rules() -> None:
    found = _inventory()
    for key, kind in OTHER.items():
        assert found[key][0] == kind, (key, found[key])


def test_every_screen_has_a_route() -> None:
    """Cada tela do catálogo protege ao menos uma rota (as só de leitura não têm "Editar")."""
    used = {item for spec in GUARDED.values() for item in spec[0]}
    assert used == set(permissions.ITEM_KEYS)
    for (_method, _path), (items, level, *_) in GUARDED.items():
        if level == E:
            assert all(permissions.ITEM_BY_KEY[i].levels[-1] == E for i in items)
