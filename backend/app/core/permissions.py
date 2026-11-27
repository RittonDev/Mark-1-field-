"""Permissões por tela (os módulos do menu) e visibilidade das filas.

O papel (users.role) continua decidindo o canal (core/access.py), a hierarquia de cadastro
(routes/users.py _can_manage) e as regras duras (ex.: SLA só com o administrador). Por cima dele:

- Administrador: acesso total sempre. Ignora perfil e ajustes, e não dá para restringir.
- Supervisor e analista: um perfil de acesso (models/access.py) define, por tela, o nível
  none | view | edit e a fila que a pessoa vê; os ajustes do usuário (users.access_overrides)
  sobrepõem o perfil item por item.
- Técnico e cliente: fora da matriz (o papel decide tudo).

O núcleo (Início, Minha fila, Solicitações, Chamados, Nova OS e tudo dentro da OS) não tem módulo:
continua com o gate da gestão (TicketManagerUser) mais o escopo de fila. A proteção do módulo
cobre a TELA e as GRAVAÇÕES dele; as consultas que o núcleo usa (clientes, locais, catálogos...)
continuam abertas a toda a gestão.

Puro: sem I/O e sem importar os modelos (lê usuário e perfil pelos atributos). A resolução por
request fica em services/access.py (attach), que guarda o resultado em `user._access`.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.exc import NoInspectionAvailable

from app.core.enums import UserRole
from app.services.errors import AccessDenied

Level = Literal["none", "view", "edit"]
QueueScope = Literal["own", "all"]

RANK: dict[str, int] = {"none": 0, "view": 1, "edit": 2}
FULL: tuple[Level, ...] = ("none", "view", "edit")
VIEW_ONLY: tuple[Level, ...] = ("none", "view")
# Ação sem tela de leitura (confirmar ou não): Sem acesso ou Editar.
CONFIRM: tuple[Level, ...] = ("none", "edit")
QUEUE_SCOPES: tuple[QueueScope, ...] = ("own", "all")

LEVEL_LABELS: dict[str, str] = {"none": "Sem acesso", "view": "Visualizar", "edit": "Editar"}

# Papéis com perfil de acesso; com o administrador, os papéis que aparecem na matriz.
PROFILE_ROLES = frozenset({UserRole.SUPERVISOR, UserRole.ANALYST})
MATRIX_ROLES = PROFILE_ROLES | {UserRole.ADMIN}


@dataclass(frozen=True)
class Module:
    key: str
    label: str


@dataclass(frozen=True)
class Item:
    key: str
    label: str
    href: str
    levels: tuple[Level, ...]
    hint: str | None = None

    @property
    def module(self) -> str:
        return self.key.split(".", 1)[0]

    @property
    def top(self) -> Level:
        """Maior nível que a tela aceita (Editar, ou Visualizar nas telas só de leitura)."""
        return self.levels[-1]


MODULES: tuple[Module, ...] = (
    Module("operation", "Operação"),
    Module("commercial", "Comercial"),
    Module("base", "Base"),
    Module("analysis", "Análise"),
    Module("setup", "Configuração"),
)
MODULE_BY_KEY: dict[str, Module] = {m.key: m for m in MODULES}

# Na ordem do menu (frontend/src/components/nav.ts).
ITEMS: tuple[Item, ...] = (
    Item("operation.calendar", "Calendário", "/agenda", FULL, "Editar: remarcar arrastando"),
    Item("operation.day", "Atividades do dia", "/dia", VIEW_ONLY),
    Item("operation.map", "Mapa ao vivo", "/mapa", VIEW_ONLY),
    Item("operation.repairs", "Assistência externa", "/assistencia", FULL),
    Item("commercial.quotes", "Orçamentos", "/orcamentos", FULL, "Inclui a aba Orçamentos da OS"),
    Item("commercial.projects", "Projetos", "/projetos", FULL),
    Item("commercial.expenses", "Custos extras", "/custos", FULL, "Inclui os custos da OS"),
    Item(
        "commercial.payouts", "Pagamentos", "/pagamentos", FULL, "Inclui o valor do técnico na OS"
    ),
    Item("base.customers", "Clientes", "/clientes", FULL),
    Item("base.locations", "Locais", "/locais", FULL),
    Item("base.technicians", "Técnicos", "/tecnicos", FULL, "Editar inclui Liberar acesso"),
    # Elo por pontos: quem confirma abandono e retorno (as rotas e a fila /pendencias-elo vêm nas
    # Etapas 3 e 4; Configurações › Elo mostra quem tem o item em Editar).
    Item(
        "base.level_confirm",
        "Elo: confirmar ocorrências",
        "/pendencias-elo",
        CONFIRM,
        "Confirmar ou dispensar abandono e retorno",
    ),
    Item("base.onboarding", "Homologação", "/homologacao", FULL),
    Item("analysis.dashboard", "Dashboard", "/dashboard", VIEW_ONLY),
    Item("analysis.reports", "Relatórios", "/relatorios", VIEW_ONLY),
    Item("setup.forms", "Formulários", "/formularios", FULL),
    Item("setup.messages", "Textos do WhatsApp", "/textos", FULL),
    Item("setup.service_types", "Tipos de serviço", "/tipos-servico", FULL),
    Item(
        "setup.users",
        "Usuários",
        "/usuarios",
        FULL,
        "Editar: grupos técnicos e os usuários do papel que você cuida",
    ),
    Item(
        "setup.settings",
        "Configurações",
        "/configuracoes",
        FULL,
        "O SLA continua só com o administrador",
    ),
)
ITEM_BY_KEY: dict[str, Item] = {i.key: i for i in ITEMS}
ITEM_KEYS: tuple[str, ...] = tuple(ITEM_BY_KEY)


def _defaults(overrides: Mapping[str, Level] | None = None) -> dict[str, Level]:
    levels: dict[str, Level] = {i.key: i.top for i in ITEMS}
    levels.update(overrides or {})
    return levels


# Reproduzem o acesso de antes dos perfis. O analista via Usuários só para ler e não tinha
# Configurações no menu (as leituras que a OS usa continuam abertas a ele). "Elo: confirmar
# ocorrências" nasce com o supervisor (e o administrador, sempre); o analista e o perfil criado na
# tela começam sem ele.
ROLE_DEFAULTS: dict[str, dict[str, Level]] = {
    UserRole.SUPERVISOR.value: _defaults(),
    UserRole.ANALYST.value: _defaults(
        {"setup.users": "view", "setup.settings": "none", "base.level_confirm": "none"}
    ),
}
# Perfil criado na tela começa (e completa as chaves ausentes) pelo padrão do analista.
CUSTOM_BASE = UserRole.ANALYST.value
DEFAULT_QUEUE: tuple[QueueScope, bool] = ("all", True)

# Eventos de tempo real que pertencem a telas: só vão para quem tem pelo menos uma delas.
EVENT_ITEMS: dict[str, tuple[str, ...]] = {
    "quote.decided": ("commercial.quotes",),
    "onboarding.submitted": ("base.onboarding",),
    # Ficha da homologação mudou (e-mail validado, reaberta, aprovada, reprovada).
    "onboarding.updated": ("base.onboarding",),
    # Posição e jornada dos técnicos: só o Mapa ao vivo usa (e /tracking/* já pede o item).
    "technician.location": ("operation.map",),
    "technician.shift": ("operation.map",),
    # Cadastro do técnico mudou (Meu cadastro no app ou a central): a lista de Técnicos e a chave
    # PIX em Pagamentos. Nunca "technician.*": a web manda esses para o mapa.
    "profile.changed": ("base.technicians", "commercial.payouts"),
}

# Eventos do histórico da OS que levam valores de uma tela comercial: só vão para quem tem o
# item, como os blocos do detalhe (o evento sai inteiro: from_value/to_value também têm o valor).
HISTORY_ITEMS: dict[str, str] = {
    "payout_set": "commercial.payouts",
    "payout_removed": "commercial.payouts",
    # Ofertas de OS: levam o valor oferecido ao técnico.
    "offer_sent": "commercial.payouts",
    "offer_accepted": "commercial.payouts",
    "offer_declined": "commercial.payouts",
    "offer_cancelled": "commercial.payouts",
    "expense_added": "commercial.expenses",
    "expense_updated": "commercial.expenses",
    "expense_removed": "commercial.expenses",
    "quote_sent": "commercial.quotes",
    "quote_approved": "commercial.quotes",
    "quote_rejected": "commercial.quotes",
    "quote_reminded": "commercial.quotes",
}


def clamp(item: str, level: str) -> Level:
    """Maior nível que a tela aceita sem passar do pedido (Editar numa tela só de leitura vira
    Visualizar)."""
    want = RANK.get(level, 0)
    allowed = [lv for lv in ITEM_BY_KEY[item].levels if RANK[lv] <= want]
    return allowed[-1] if allowed else "none"


@dataclass(frozen=True)
class Access:
    """Acesso efetivo de uma pessoa: nível de cada tela (dicionário completo) e a fila."""

    full: bool
    items: Mapping[str, Level]
    queue_scope: QueueScope = "all"
    queue_unowned: bool = True
    profile_id: uuid.UUID | None = None
    profile_name: str | None = None
    customized: bool = False

    def level(self, item: str) -> Level:
        return self.items.get(item, "none")

    def can(self, item: str, level: Level = "view") -> bool:
        return RANK[self.level(item)] >= RANK[level]

    @property
    def all_queues(self) -> bool:
        return self.queue_scope == "all"

    def sees(self, user_id: object, audience: Mapping[str, Any] | None) -> bool:
        """Evento de OS (tempo real): a OS está na fila que a pessoa vê? Com "own", vale ser o
        analista responsável ou o executor (atual ou o anterior, para a tela tirar a OS da
        lista) e, com a opção, as OS sem analista."""
        if self.all_queues:
            return True
        aud = audience or {}
        me = str(user_id)
        mine = (
            aud.get("owner_id"),
            aud.get("previous_owner_id"),
            aud.get("assignee_id"),
            aud.get("previous_assignee_id"),
        )
        if me in {str(v) for v in mine if v}:
            return True
        return self.queue_unowned and bool(aud.get("unowned"))

    @property
    def fingerprint(self) -> str:
        """Muda quando o acesso muda (a conexão de tempo real fecha e reconecta)."""
        raw = json.dumps(
            {
                "items": dict(sorted(self.items.items())),
                "scope": self.queue_scope,
                "unowned": self.queue_unowned,
                "full": self.full,
            },
            sort_keys=True,
        )
        return hashlib.sha1(raw.encode(), usedforsecurity=False).hexdigest()[:16]


FULL_ACCESS = Access(full=True, items={i.key: i.top for i in ITEMS})
NO_ACCESS = Access(
    full=False, items=dict.fromkeys(ITEM_KEYS, "none"), queue_scope="own", queue_unowned=False
)


def _role(user: Any) -> UserRole | None:
    role = getattr(user, "role", None)
    if role is None:
        return None
    try:
        return UserRole(role)
    except ValueError:
        return None


def base_key(profile: Any, role: UserRole | str | None) -> str:
    """De onde vêm os padrões: o papel do perfil padrão; perfil criado na tela = analista; sem
    perfil nenhum, o papel da pessoa."""
    if profile is not None:
        key = getattr(profile, "system_key", None)
        return key if key in ROLE_DEFAULTS else CUSTOM_BASE
    value = role.value if isinstance(role, UserRole) else role
    return value if value in ROLE_DEFAULTS else CUSTOM_BASE


def profile_items(profile: Any, role: UserRole | str | None = None) -> dict[str, Level]:
    """Nível efetivo de cada tela no perfil (padrões do código + o que foi gravado)."""
    defaults = ROLE_DEFAULTS[base_key(profile, role)]
    stored = (getattr(profile, "items", None) or {}) if profile is not None else {}
    out: dict[str, Level] = {}
    for key in ITEM_KEYS:
        value = stored.get(key)
        out[key] = clamp(key, value) if value in RANK else defaults[key]
    return out


def profile_queue(profile: Any) -> tuple[QueueScope, bool]:
    if profile is None:
        return DEFAULT_QUEUE
    scope = getattr(profile, "queue_scope", None)
    scope = scope if scope in QUEUE_SCOPES else "all"
    unowned = getattr(profile, "queue_unowned", True)
    return scope, (True if scope == "all" else bool(unowned))


def apply_overrides(
    items: Mapping[str, Level],
    scope: QueueScope,
    unowned: bool,
    overrides: Mapping[str, Any] | None,
) -> tuple[dict[str, Level], QueueScope, bool]:
    """Ajustes do usuário por cima do perfil: só chaves do catálogo e valores válidos."""
    out = dict(items)
    ov = overrides or {}
    for key, value in (ov.get("items") or {}).items():
        if key in ITEM_BY_KEY and value in RANK:
            out[key] = clamp(key, value)
    if ov.get("queue_scope") in QUEUE_SCOPES:
        scope = ov["queue_scope"]
    if isinstance(ov.get("queue_unowned"), bool):
        unowned = ov["queue_unowned"]
    # "Todas as filas" já inclui a "Sem analista".
    if scope == "all":
        unowned = True
    return out, scope, unowned


def resolve(user: Any, profile: Any) -> Access:
    """Acesso efetivo do usuário com o perfil dado (None = padrão do papel)."""
    role = _role(user)
    if role == UserRole.ADMIN:
        return FULL_ACCESS
    if role not in PROFILE_ROLES:
        return NO_ACCESS
    items = profile_items(profile, role)
    scope, unowned = profile_queue(profile)
    final_items, final_scope, final_unowned = apply_overrides(
        items, scope, unowned, getattr(user, "access_overrides", None)
    )
    customized = (final_items, final_scope, final_unowned) != (items, scope, unowned)
    return Access(
        full=False,
        items=final_items,
        queue_scope=final_scope,
        queue_unowned=final_unowned,
        profile_id=getattr(profile, "id", None) if profile is not None else None,
        profile_name=getattr(profile, "name", None) if profile is not None else None,
        customized=customized,
    )


def _loaded_profile(user: Any) -> Any:
    """O perfil já carregado com o usuário (selectin), sem ir ao banco: num objeto recém-criado
    na sessão, ler a relação não carregada faria I/O síncrono."""
    try:
        state = sa_inspect(user)
    except NoInspectionAvailable:
        return getattr(user, "access_profile", None)
    if "access_profile" in state.unloaded:
        return None
    return state.dict.get("access_profile")


def of(user: Any) -> Access:
    """Acesso efetivo: o que o attach do request deixou pronto ou, sem ele (serviços chamados
    direto), o perfil carregado com o usuário ou os padrões do papel (= comportamento de antes)."""
    attached = getattr(user, "_access", None)
    if isinstance(attached, Access):
        return attached
    return resolve(user, _loaded_profile(user))


def _denied(item: str, level: Level, current: Level) -> AccessDenied:
    spec = ITEM_BY_KEY[item]
    if level == "edit" and current == "view":
        message = f"Seu acesso a {spec.label} é só de visualização."
    else:
        message = f"Sem acesso a {spec.label}."
    return AccessDenied(
        message, code="MODULE_FORBIDDEN", item=item, module=spec.module, required=level
    )


def require(user: Any, item: str, level: Level = "view") -> None:
    require_any(user, (item,), level)


def require_any(user: Any, items: Iterable[str], level: Level = "view") -> None:
    """Basta um dos itens no nível pedido. O erro cita o primeiro (a tela principal da rota)."""
    keys = tuple(items)
    acc = of(user)
    if any(acc.can(k, level) for k in keys):
        return
    raise _denied(keys[0], level, acc.level(keys[0]))


def summary(user: Any) -> dict[str, Any] | None:
    """O acesso efetivo para a tela (EffectiveAccessOut). Técnico e cliente: None."""
    if _role(user) not in MATRIX_ROLES:
        return None
    acc = of(user)
    profile = (
        {"id": acc.profile_id, "name": acc.profile_name} if acc.profile_id is not None else None
    )
    return {
        "full": acc.full,
        "profile": profile,
        "customized": acc.customized,
        "items": dict(acc.items),
        "queues": {"scope": acc.queue_scope, "unowned": acc.queue_unowned},
    }


def item_for_link(link: str | None) -> str | None:
    """Tela do link pelo maior prefixo do href do catálogo (None = núcleo)."""
    if not link:
        return None
    path = link.split("?", 1)[0].split("#", 1)[0].rstrip("/") or "/"
    best: Item | None = None
    for spec in ITEMS:
        matches = path == spec.href or path.startswith(spec.href + "/")
        if matches and (best is None or len(spec.href) > len(best.href)):
            best = spec
    return best.key if best else None


def allows_link(access: Access, link: str | None) -> bool:
    """O link leva a uma tela que a pessoa vê? Link do núcleo (sem item) sempre."""
    item = item_for_link(link)
    return item is None or access.can(item)


def catalog() -> dict[str, Any]:
    """O catálogo para a tela da matriz (GET /access/catalog)."""
    return {
        "modules": [
            {
                "key": m.key,
                "label": m.label,
                "items": [
                    {
                        "key": i.key,
                        "label": i.label,
                        "href": i.href,
                        "levels": list(i.levels),
                        "hint": i.hint,
                    }
                    for i in ITEMS
                    if i.module == m.key
                ],
            }
            for m in MODULES
        ],
        "defaults": {role: dict(levels) for role, levels in ROLE_DEFAULTS.items()},
    }
