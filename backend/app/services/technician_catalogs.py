"""Catálogos de Configurações › Técnicos: Ferramental (tool_catalog), Áreas de atuação
(area_catalog) e Aptidões (skill_catalog), com uma regra só (contrato da Entrega 2 §5 e §6.1).

- Gestão (as rotas de api/routes/catalog.py, que fazem o commit): `list_items`, `create`, `update`
  e `delete`. Nome limpo (core.text.clean) de 2 a 80; repetido sem acento e sem maiúsculas
  (`name_key`, também entre os desativados) → 409 CATALOG_NAME_TAKEN, conferido sob a trava da
  tabela (o índice único fica de reserva); o limite conta ativos e desativados; o PATCH muda só o
  que vem (null ignorado); renomear mantém o id (vale para todos); desativar tira das escolhas
  (app, ficha, filtros) e o item fica guardado com quem tinha; reativar devolve; excluir só o que
  nunca foi usado (`in_use` falso), senão 409 CATALOG_IN_USE ("desative").
- `in_use` = `used_at` gravado (o 1º uso: o item entrou no perfil de alguém pelo app, pela central
  ou pela ficha; `mark_used`) ou algum técnico (papel técnico, com ou sem acesso) ou ficha com ele
  agora (`usage`; o Ferramental não tem ficha: a ficha tem o ferramental em texto livre).
- O técnico lê só os ativos, com as contagens e `in_use` null.
- Leitura para quem grava e mostra o perfil (services/tech_profile.py, my_profile, technicians,
  user_history, onboarding, suggestions): `catalog` (inteiro), `picked` (só os ids pedidos),
  `active_ids`, `refs`, `skills_out`, `area_codes`, `public_lists`.
- Gravação do perfil (app, central e ficha): `resolve_areas` e `resolve_skills` devolvem a lista
  final, com as regras e as mensagens do contrato §6.2; quem compara com o gravado (o que mudou) é
  tech_profile.wanted; depois de gravar, `mark_used`.

Os ids ficam em texto nas colunas JSONB do técnico e da ficha (users.tool_ids, users.service_areas,
users.skills[].skill_id, technician_applications.service_areas e .skills[].skill_id).
"""

import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, get_args

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import UserRole
from app.core.text import clean, fold
from app.models import ServiceArea, Skill, TechnicianTool, User
from app.schemas.common import Ref
from app.schemas.tech_profile import (
    SkillLevel,
    TechCatalogItemOut,
    TechCatalogItemUpdate,
    TechnicianSkillIn,
    TechnicianSkillOut,
)
from app.services.errors import CodedError, NotFound, WorkflowError

if TYPE_CHECKING:
    # Importado na hora (public_lists): schemas/onboarding pode importar daqui.
    from app.schemas.onboarding import CatalogItem

Kind = Literal["tool", "area", "skill"]


@dataclass(frozen=True)
class CatalogInfo:
    name: str
    is_active: bool
    # Só nas áreas: o código das 10 áreas fixas de antes ("redes"); as novas, None.
    code: str | None = None


# As 10 áreas fixas de antes da Entrega 2 (código, nome), na ordem de então: o catálogo inicial (a
# migração c8f2a4e6b0d3 tem a cópia; tests/test_gestao_migration.py confere).
DEFAULT_AREAS: tuple[tuple[str, str], ...] = (
    ("impressoras", "Impressoras e multifuncionais"),
    ("computadores", "Computadores e notebooks"),
    ("redes", "Redes e cabeamento estruturado"),
    ("wifi", "Wi-Fi e access points"),
    ("cftv", "CFTV e câmeras IP"),
    ("seguranca", "Alarmes e controle de acesso"),
    ("telefonia", "Telefonia e PABX"),
    ("servidores", "Servidores e storage"),
    ("energia", "Nobreaks e energia"),
    ("automacao", "Automação comercial (PDV)"),
)
# As 16 sugestões de aptidão de antes da Entrega 2: as primeiras do catálogo (a migração junta os
# nomes já gravados pelos técnicos e pelas fichas).
DEFAULT_SKILLS: tuple[str, ...] = (
    "Windows 10/11",
    "Linux",
    "Active Directory",
    "Impressoras HP",
    "Impressoras Brother",
    "Impressoras Ricoh / Kyocera",
    "Switches gerenciáveis",
    "Roteadores e firewall",
    "Fibra óptica (fusão)",
    "Certificação de cabeamento",
    "DVR/NVR Intelbras",
    "Câmeras Hikvision",
    "Controle de acesso",
    "PABX IP",
    "Nobreaks",
    "Montagem de rack",
)

# Itens por catálogo (ativos e desativados), o nome (= CATALOG_LIMITS em lib/constants.ts) e as
# áreas por técnico ou ficha (= TECH_PROFILE_LIMITS.areas).
MAX_ITEMS: dict[str, int] = {"tool": 200, "area": 100, "skill": 300}
NAME_MIN, NAME_MAX = 2, 80
MAX_AREAS = 20

# Mensagens (contrato §6.1 e §6.2). {noun}: "ferramenta", "área" ou "aptidão".
NAME_REQUIRED = "Informe o nome da {noun}"
NAME_TOO_LONG = f"No máximo {NAME_MAX} caracteres"
NAME_TAKEN = "Já existe uma {noun} com este nome"
CATALOG_FULL = "O catálogo aceita até {limit} {plural}"
IN_USE = "Esta {noun} já foi usada: desative para tirar das escolhas"
AREA_NOT_FOUND = "Área não encontrada. Atualize a lista"
AREAS_LIMIT = f"Até {MAX_AREAS} áreas de atuação"
AREA_REQUIRED = "Escolha pelo menos uma área de atuação"
SKILL_NOT_FOUND = "Aptidão não encontrada. Atualize a lista"
SKILL_UNKNOWN_NAME = "Atualize o app: as aptidões agora são escolhidas numa lista"
SKILL_REPEATED = "Aptidão repetida: {name}"

SKILL_LEVELS: tuple[str, ...] = get_args(SkillLevel)


@dataclass(frozen=True)
class _Spec:
    model: Any  # TechnicianTool | ServiceArea | Skill
    table: str  # o nome da tabela: também a chave da trava
    noun: str
    plural: str
    missing: str
    # As colunas JSONB do técnico e da ficha com os ids (None: a ficha não tem).
    user_column: str
    application_column: str | None
    # Os itens são objetos {skill_id, ...} (aptidões) ou os ids direto.
    item_key: str | None = None


_SPECS: dict[str, _Spec] = {
    "tool": _Spec(
        TechnicianTool,
        "tool_catalog",
        "ferramenta",
        "ferramentas",
        "Ferramenta não encontrada",
        "tool_ids",
        None,
    ),
    "area": _Spec(
        ServiceArea,
        "area_catalog",
        "área",
        "áreas",
        "Área não encontrada",
        "service_areas",
        "service_areas",
    ),
    "skill": _Spec(
        Skill,
        "skill_catalog",
        "aptidão",
        "aptidões",
        "Aptidão não encontrada",
        "skills",
        "skills",
        item_key="skill_id",
    ),
}


def _spec(kind: str) -> _Spec:
    try:
        return _SPECS[kind]
    except KeyError:
        raise ValueError(f"catálogo desconhecido: {kind}") from None


# ------------------------------------------------------------------------- ids


def _canonical(raw: Any) -> str | None:
    """O id em texto como se grava (str(UUID), minúsculo); None quando não é um id."""
    if raw is None:
        return None
    try:
        return str(raw if isinstance(raw, uuid.UUID) else uuid.UUID(str(raw).strip()))
    except ValueError:
        return None


def _uuids(ids: Iterable[Any]) -> list[uuid.UUID]:
    """Os ids válidos, sem repetir, na ordem."""
    out: dict[str, uuid.UUID] = {}
    for raw in ids:
        key = _canonical(raw)
        if key is not None and key not in out:
            out[key] = uuid.UUID(key)
    return list(out.values())


def _order(name: str) -> tuple[str, str]:
    """Ordem alfabética (sem acento e sem maiúsculas; empate pela grafia)."""
    return fold(name), name


def _field(item: Any, name: str) -> Any:
    """Campo do item enviado: o schema (TechnicianSkillIn) ou um dicionário."""
    return item.get(name) if isinstance(item, Mapping) else getattr(item, name, None)


# --------------------------------------------------------------------- leitura


def _info_rows(rows: Iterable[Any], with_code: bool) -> dict[str, CatalogInfo]:
    return {
        str(row[0]): CatalogInfo(row[1], bool(row[2]), row[3] if with_code else None)
        for row in rows
    }


def _columns(spec: _Spec) -> list[Any]:
    model = spec.model
    columns = [model.id, model.name, model.is_active]
    if model is ServiceArea:
        columns.append(ServiceArea.code)
    return columns


async def catalog(db: AsyncSession, kind: Kind) -> dict[str, CatalogInfo]:
    """O catálogo inteiro (ativos e desativados), pela chave str(id): 1 consulta (≤ 300 linhas)."""
    spec = _spec(kind)
    rows = await db.execute(select(*_columns(spec)))
    return _info_rows(rows.all(), spec.model is ServiceArea)


async def picked(db: AsyncSession, kind: Kind, ids: Iterable[Any]) -> dict[str, CatalogInfo]:
    """Só os itens destes ids (ativos ou não), pela chave str(id); nenhuma consulta sem id válido
    (GET /me/profile, o histórico do cadastro)."""
    spec = _spec(kind)
    keys = _uuids(ids)
    if not keys:
        return {}
    rows = await db.execute(select(*_columns(spec)).where(spec.model.id.in_(keys)))
    return _info_rows(rows.all(), spec.model is ServiceArea)


def _elements_sql(table: str, column: str, item_key: str | None, where: str) -> str:
    """Contagem por item de uma coluna JSONB em lista (o valor que não é lista conta como vazio)."""
    source = (
        f"CASE WHEN jsonb_typeof(t.{column}) = 'array' THEN t.{column} ELSE '[]'::jsonb END"
    )
    if item_key is None:
        element = "lower(e.value)"
        lateral = f"jsonb_array_elements_text({source}) AS e(value)"
        filters = where
    else:
        element = f"lower(e.value ->> '{item_key}')"
        lateral = f"jsonb_array_elements({source}) AS e(value)"
        filters = f"{where} AND jsonb_typeof(e.value) = 'object'"
    return (
        f"SELECT {element} AS item, count(DISTINCT t.id) AS total FROM {table} t"
        f" CROSS JOIN LATERAL {lateral} WHERE {filters} GROUP BY 1"
    )


async def usage(db: AsyncSession, kind: Kind) -> dict[str, tuple[int, int]]:
    """Por str(id): (técnicos, fichas) com o item guardado agora, ativo ou não. Técnicos: papel
    técnico, com ou sem acesso (a mesma regra dos filtros da lista). Fichas: todas, de qualquer
    situação (o Ferramental: 0). Item sem uso não aparece."""
    spec = _spec(kind)
    out: dict[str, list[int]] = {}
    sql = _elements_sql("users", spec.user_column, spec.item_key, "t.role = :role")
    for item, total in await db.execute(text(sql), {"role": UserRole.TECHNICIAN.value}):
        if item:
            out.setdefault(str(item), [0, 0])[0] = int(total)
    if spec.application_column is not None:
        sql = _elements_sql(
            "technician_applications", spec.application_column, spec.item_key, "true"
        )
        for item, total in await db.execute(text(sql)):
            if item:
                out.setdefault(str(item), [0, 0])[1] = int(total)
    return {key: (counts[0], counts[1]) for key, counts in out.items()}


async def area_codes(db: AsyncSession) -> dict[str, str]:
    """str(id) -> código, das áreas ativas que têm o código antigo (a sugestão de técnicos)."""
    rows = await db.execute(
        select(ServiceArea.id, ServiceArea.code).where(
            ServiceArea.is_active.is_(True), ServiceArea.code.is_not(None)
        )
    )
    return {str(area_id): str(code) for area_id, code in rows.all()}


async def public_lists(db: AsyncSession) -> "tuple[list[CatalogItem], list[CatalogItem]]":
    """(áreas, aptidões) ativas da ficha pública, em ordem alfabética, {key: id, label: nome}."""
    from app.schemas.onboarding import CatalogItem

    out: list[list[CatalogItem]] = []
    for model in (ServiceArea, Skill):
        rows = await db.execute(select(model.id, model.name).where(model.is_active.is_(True)))
        items = sorted(rows.all(), key=lambda row: (*_order(row[1]), str(row[0])))
        out.append([CatalogItem(key=str(item_id), label=name) for item_id, name in items])
    return out[0], out[1]


def _stored(stored: Iterable[Any] | None, info: Mapping[str, CatalogInfo], *, inactive: bool):
    """Os itens guardados (ids) que estão no catálogo, sem repetir, em ordem alfabética; os
    desativados só com `inactive`."""
    seen: set[str] = set()
    out: list[tuple[str, CatalogInfo]] = []
    for raw in stored or []:
        key = _canonical(raw)
        if key is None or key in seen:
            continue
        found = info.get(key)
        if found is None or not (found.is_active or inactive):
            continue
        seen.add(key)
        out.append((key, found))
    out.sort(key=lambda item: (*_order(item[1].name), item[0]))
    return out


def active_ids(stored: Iterable[Any] | None, info: Mapping[str, CatalogInfo]) -> list[uuid.UUID]:
    """Os ids guardados que estão ativos, sem repetir, pela ordem do nome (os desativados ficam
    guardados e não saem)."""
    return [uuid.UUID(key) for key, _ in _stored(stored, info, inactive=False)]


def refs(
    stored: Iterable[Any] | None, info: Mapping[str, CatalogInfo], *, inactive: bool = False
) -> list[Ref]:
    """O mesmo de `active_ids` como {id, name}; com `inactive`, também os desativados (a ficha da
    homologação mostra todas as áreas gravadas)."""
    return [Ref(id=uuid.UUID(key), name=found.name) for key, found in _stored(stored, info, inactive=inactive)]


def _sorted_skills(items: list[dict[str, Any]], names: Mapping[str, str]) -> list[dict[str, Any]]:
    """O "desde" mais novo primeiro, depois o nome (sem acento e sem maiúsculas); sem "desde" (a
    ficha), só o nome."""
    ordered = sorted(items, key=lambda item: (*_order(names.get(item["skill_id"], "")), item["skill_id"]))
    return sorted(ordered, key=lambda item: str(item.get("since") or ""), reverse=True)


def skills_out(
    stored: Iterable[Any] | None, info: Mapping[str, CatalogInfo]
) -> list[TechnicianSkillOut]:
    """As aptidões guardadas do técnico ({skill_id, level, since}) que estão ativas, com o nome do
    catálogo, sem repetir (fica a primeira), o "desde" mais novo primeiro e depois o nome. Item
    estragado (sem id, nível ou "desde") não sai."""
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for item in stored or []:
        if not isinstance(item, Mapping):
            continue
        key = _canonical(item.get("skill_id"))
        found = info.get(key) if key is not None else None
        level, since = item.get("level"), item.get("since")
        if (
            key is None
            or found is None
            or not found.is_active
            or key in seen
            or level not in SKILL_LEVELS
            or not isinstance(since, str)
            or not since
        ):
            continue
        seen.add(key)
        items.append({"skill_id": key, "level": level, "since": since})
    names = {key: found.name for key, found in info.items()}
    return [
        TechnicianSkillOut(
            skill_id=uuid.UUID(item["skill_id"]),
            name=names[item["skill_id"]],
            level=item["level"],
            since=item["since"],
        )
        for item in _sorted_skills(items, names)
    ]


# --------------------------------------------------------------- uso e dados iniciais


async def mark_used(db: AsyncSession, kind: Kind, ids: Iterable[Any]) -> None:
    """Grava o 1º uso (`used_at`) dos itens que ainda não têm: depois de gravar Ferramental,
    Aptidões ou Áreas (app, central, ficha). Nenhuma consulta sem id. Não mexe em `updated_at`
    (não é edição do catálogo)."""
    keys = _uuids(ids)
    if not keys:
        return
    model = _spec(kind).model
    await db.execute(
        update(model)
        .where(model.id.in_(keys), model.used_at.is_(None))
        .values(used_at=func.now(), updated_at=model.updated_at)
        .execution_options(synchronize_session=False)
    )


async def seed_defaults(db: AsyncSession) -> None:
    """As 10 áreas (com o código antigo) e as 16 aptidões iniciais, as que faltarem (pelo nome sem
    acento e sem maiúsculas ou pelo código). Para os testes: o banco deles nasce dos modelos; em
    produção, a migração c8f2a4e6b0d3 fez o mesmo. Quem chama faz o commit."""
    await db.execute(
        pg_insert(ServiceArea)
        .values(
            [
                {"id": uuid.uuid4(), "name": name, "name_key": fold(name), "code": code}
                for code, name in DEFAULT_AREAS
            ]
        )
        .on_conflict_do_nothing()
    )
    await db.execute(
        pg_insert(Skill)
        .values([{"id": uuid.uuid4(), "name": name, "name_key": fold(name)} for name in DEFAULT_SKILLS])
        .on_conflict_do_nothing()
    )


# ------------------------------------------------------------------- gestão


def _out(item: Any, counts: Mapping[str, tuple[int, int]] | None) -> TechCatalogItemOut:
    """`counts` None: quem pediu é o técnico (sem contagens nem `in_use`)."""
    if counts is None:
        return TechCatalogItemOut(id=item.id, name=item.name, is_active=item.is_active)
    technicians, applications = counts.get(str(item.id), (0, 0))
    return TechCatalogItemOut(
        id=item.id,
        name=item.name,
        is_active=item.is_active,
        technicians=technicians,
        applications=applications,
        in_use=item.used_at is not None or technicians > 0 or applications > 0,
    )


async def _lock(db: AsyncSession, spec: _Spec) -> None:
    """Um cadastro ou renomeação por vez no catálogo, até o fim da transação: o nome repetido sem
    acento e sem maiúsculas e o limite são conferidos lendo o catálogo antes de gravar, e dois
    pedidos juntos ("Multímetro" e "multimetro") passariam os dois. Em READ COMMITTED, a leitura
    feita depois da trava já vê o que o outro pedido gravou."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": spec.table}
    )


def _checked_name(spec: _Spec, raw: str) -> str:
    name = clean(raw)
    if len(name) < NAME_MIN:
        raise WorkflowError(NAME_REQUIRED.format(noun=spec.noun))
    if len(name) > NAME_MAX:
        raise WorkflowError(NAME_TOO_LONG)
    return name


async def _check_name(db: AsyncSession, spec: _Spec, name: str, self_id: uuid.UUID | None) -> None:
    """O nome repetido sem acento e sem maiúsculas, entre ativos e desativados (com a trava)."""
    model = spec.model
    other = await db.scalar(select(model.id).where(model.name_key == fold(name)))
    if other is not None and other != self_id:
        raise CodedError(NAME_TAKEN.format(noun=spec.noun), "CATALOG_NAME_TAKEN", 409)


async def list_items(
    db: AsyncSession, kind: Kind, viewer: User, active: bool | None = None
) -> list[TechCatalogItemOut]:
    """O catálogo em ordem alfabética. O técnico (o app) recebe só os ativos, com as contagens e
    `in_use` null, e o `active` é ignorado; a gestão filtra por `active` e vê as contagens."""
    model = _spec(kind).model
    technician = viewer.role == UserRole.TECHNICIAN
    stmt = select(model)
    if technician:
        stmt = stmt.where(model.is_active.is_(True))
    elif active is not None:
        stmt = stmt.where(model.is_active.is_(active))
    items = sorted(
        await db.scalars(stmt),
        key=lambda item: (item.name_key or fold(item.name), item.name, str(item.id)),
    )
    counts = None if technician else await usage(db, kind)
    return [_out(item, counts) for item in items]


async def create(db: AsyncSession, kind: Kind, name: str) -> TechCatalogItemOut:
    """Item novo, já ativo (sem uso). 422 sem nome ou com o catálogo cheio (ativos e desativados);
    409 CATALOG_NAME_TAKEN com o nome repetido."""
    spec = _spec(kind)
    name = _checked_name(spec, name)
    await _lock(db, spec)
    await _check_name(db, spec, name, None)
    total = await db.scalar(select(func.count()).select_from(spec.model)) or 0
    if total >= MAX_ITEMS[kind]:
        raise WorkflowError(
            CATALOG_FULL.format(limit=MAX_ITEMS[kind], plural=spec.plural)
        )
    item = spec.model(name=name, is_active=True)
    db.add(item)
    await db.flush()
    return _out(item, {})


async def _get(db: AsyncSession, spec: _Spec, item_id: uuid.UUID, *, lock: bool = False) -> Any:
    stmt = select(spec.model).where(spec.model.id == item_id)
    if lock:
        stmt = stmt.with_for_update()
    item = await db.scalar(stmt.execution_options(populate_existing=True))
    if item is None:
        raise NotFound(spec.missing)
    return item


async def update_item(
    db: AsyncSession, kind: Kind, item_id: uuid.UUID, data: TechCatalogItemUpdate
) -> TechCatalogItemOut:
    """Só o que vier muda (null é ignorado). Renomear muda para todos (o técnico e a ficha guardam
    o id); desativar não mexe em quem tem: o item some das escolhas e volta quando reativado."""
    spec = _spec(kind)
    item = await _get(db, spec, item_id)
    fields = data.model_dump(exclude_none=True)
    if "name" in fields:
        name = _checked_name(spec, fields["name"])
        if name != item.name:  # só desativar ou reativar não precisa da trava
            await _lock(db, spec)
            await _check_name(db, spec, name, item.id)
            item.name = name
    if "is_active" in fields:
        item.is_active = bool(fields["is_active"])
    await db.flush()
    return _out(item, await usage(db, kind))


# O nome do desenho (D-B2 §4): `update` é também o de sqlalchemy, importado acima.
update_ = update_item


async def delete(db: AsyncSession, kind: Kind, item_id: uuid.UUID) -> None:
    """Exclui o item nunca usado; com uso (o 1º uso gravado, ou algum técnico ou ficha com ele),
    409 CATALOG_IN_USE: desative. A linha fica travada até o fim: quem gravar o item ao mesmo tempo
    espera e, se gravar antes, o `used_at` dele já conta aqui."""
    spec = _spec(kind)
    item = await _get(db, spec, item_id, lock=True)
    technicians, applications = (await usage(db, kind)).get(str(item.id), (0, 0))
    if item.used_at is not None or technicians or applications:
        raise CodedError(IN_USE.format(noun=spec.noun), "CATALOG_IN_USE", 409)
    await db.delete(item)
    await db.flush()


# ------------------------------------------------------------ gravação do perfil


def _area_key(raw: Any, info: Mapping[str, CatalogInfo], by_code: Mapping[str, str]) -> str | None:
    """O id (texto) de uma área enviada ou guardada: o id do catálogo ou o código antigo (sem
    maiúsculas); None quando não é nenhum dos dois."""
    key = _canonical(raw)
    if key is not None:
        return key if key in info else None
    return by_code.get(fold(str(raw))) if isinstance(raw, str) else None


async def resolve_areas(
    db: AsyncSession, sent: Iterable[Any], stored: Iterable[Any], *, ficha: bool = False
) -> list[str]:
    """As áreas a gravar (ids em texto, ordenados): as enviadas que estão ativas e as guardadas que
    não estão (ficam guardadas e voltam se a central reativar). Cada valor é o id do catálogo ou o
    código antigo. Desconhecida → 422 AREA_NOT_FOUND; desativada enviada: ignorada (na ficha,
    AREA_NOT_FOUND: a lista dela está velha); mais de MAX_AREAS → 422 AREAS_LIMIT; na ficha, com
    alguma área ativa no catálogo e nenhuma escolhida → 422 AREA_REQUIRED. Quem compara com o
    gravado (o que mudou: o conjunto) é tech_profile.wanted."""
    info = await catalog(db, "area")
    by_code = {fold(found.code): key for key, found in info.items() if found.code}
    chosen: set[str] = set()
    for raw in sent:
        key = _area_key(raw, info, by_code)
        if key is None:
            raise CodedError(AREA_NOT_FOUND, "AREA_NOT_FOUND")
        if info[key].is_active:
            chosen.add(key)
        elif ficha:
            raise CodedError(AREA_NOT_FOUND, "AREA_NOT_FOUND")
    kept: set[str] = set()
    for raw in stored or []:
        key = _area_key(raw, info, by_code)
        if key is None:
            # Fora do catálogo (não acontece: excluir pede o item sem uso): fica como está.
            value = _canonical(raw) or (str(raw) if isinstance(raw, str) and raw else None)
            if value is not None:
                kept.add(value)
        elif not info[key].is_active:
            kept.add(key)
    final = chosen | kept
    if len(final) > MAX_AREAS:
        raise CodedError(AREAS_LIMIT, "AREAS_LIMIT")
    if ficha and not final and any(found.is_active for found in info.values()):
        raise CodedError(AREA_REQUIRED, "AREA_REQUIRED")
    return sorted(final)


async def resolve_skills(
    db: AsyncSession,
    sent: Iterable[TechnicianSkillIn],
    stored: Iterable[Any],
    *,
    today: str | None,
) -> list[dict[str, Any]]:
    """As aptidões a gravar: [{skill_id, level, since}] (app e central) ou, com `today` None (a
    ficha), [{skill_id, level}]; em ordem ("desde" mais novo primeiro, depois o nome).

    Enviada por `skill_id`: desconhecida → 422 SKILL_NOT_FOUND. Por `name` (o app e a ficha de antes
    da Entrega 2): casa com o catálogo pelo nome sem acento e sem maiúsculas; fora dele → 422
    SKILL_UNKNOWN_NAME. Desativada enviada: ignorada. A mesma aptidão duas vezes (pelo id ou pelo
    nome) → 422 SKILL_REPEATED com o nome do catálogo. As guardadas desativadas ficam (voltam se a
    central reativar). O "desde" da guardada de mesmo id fica; a nova ganha `today`. Quem compara
    com o gravado (o conjunto de (skill_id, level)) é tech_profile.wanted."""
    info = await catalog(db, "skill")
    by_key = {fold(found.name): key for key, found in info.items()}
    names = {key: found.name for key, found in info.items()}
    since_of: dict[str, str] = {}
    kept: list[dict[str, Any]] = []
    kept_ids: set[str] = set()
    for item in stored or []:
        if not isinstance(item, Mapping):
            continue
        key = _canonical(item.get("skill_id"))
        if key is None and isinstance(item.get("name"), str):
            key = by_key.get(fold(item["name"]))  # o formato de antes (só o nome)
        if key is None:
            continue
        since = item.get("since")
        if isinstance(since, str) and since:
            since_of.setdefault(key, since)
        found = info.get(key)
        if (found is None or not found.is_active) and key not in kept_ids:
            kept_ids.add(key)
            kept.append({"skill_id": key, "level": item.get("level"), "since": since})
    chosen: dict[str, str] = {}
    for item in sent:
        skill_id, name, level = _field(item, "skill_id"), _field(item, "name"), _field(item, "level")
        if skill_id is not None:
            key = _canonical(skill_id)
            if key is None or key not in info:
                raise CodedError(SKILL_NOT_FOUND, "SKILL_NOT_FOUND")
        else:
            key = by_key.get(fold(name))
            if key is None:
                raise CodedError(SKILL_UNKNOWN_NAME, "SKILL_UNKNOWN_NAME")
        if not info[key].is_active:
            continue
        if key in chosen:
            raise CodedError(SKILL_REPEATED.format(name=info[key].name), "SKILL_REPEATED")
        chosen[key] = str(level)
    out: list[dict[str, Any]] = []
    for key, level in chosen.items():
        item = {"skill_id": key, "level": level}
        if today is not None:
            item["since"] = since_of.get(key, today)
        out.append(item)
    for item in kept:
        if today is None:
            out.append({"skill_id": item["skill_id"], "level": item["level"]})
        else:
            out.append({**item, "since": item["since"] or since_of.get(item["skill_id"], today)})
    return _sorted_skills(out, names)
