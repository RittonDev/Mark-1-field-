"""Gestão dos técnicos (Entrega 2)

- Catálogos de Configurações › Técnicos: area_catalog (com o código das 10 áreas fixas de antes em
  `code`: uq_area_catalog_code) e skill_catalog, os dois com name_key (o nome sem acento e sem
  maiúsculas, único: uq_*_name_key) e used_at (o 1º uso). tool_catalog ganha name_key
  (uq_tool_catalog_name_key; uq_tool_catalog_name fica) e used_at.
- technician_documents: certificações (com validade), documentos pessoais, currículo e anexos
  internos, com as versões do arquivo (version_of_id); checks _owner, _expiry, _internal e _version;
  índices parciais uq_technician_documents_user_resume e ix_technician_documents_expiry.
- technician_ratings: a avaliação do cliente por OS e técnico
  (uq_technician_ratings_ticket_technician, ck_technician_ratings_score).

Dados (laço simples; funções puras testadas em tests/test_gestao_migration.py; nada de app.*):
1. as 10 áreas fixas entram no catálogo (código, nome);
2. as aptidões: as 16 sugestões de antes e depois os nomes gravados pelos técnicos e pelas fichas
   (por created_at), sem repetir pelo nome sem acento e sem maiúsculas;
3. o name_key do ferramental (as repetidas por ele fundem na mais antiga, que fica ativa se alguma
   estava; users.tool_ids troca o id);
4. as áreas dos técnicos e das fichas passam de códigos a ids (o código desconhecido vira uma área
   nova, ativa);
5. as aptidões dos técnicos passam a {skill_id, level, since} (sem "desde": o dia local do
   cadastro) e as das fichas a {skill_id, level}; nível desconhecido vira "basico";
6. o 1º uso (used_at) do que está nos técnicos e nas fichas, e das ferramentas e aptidões citadas
   no histórico do cadastro;
7. o carimbo "areas" (via "ficha", na data da ficha aprovada ou do cadastro) de quem tem áreas.
Rodar de novo não muda nada. Só então name_key do ferramental vira NOT NULL e único.

O downgrade apaga os eventos de OS rating_set e rating_removed (o enum de antes não lê esses
valores e quebraria a OS); tira do histórico do cadastro os itens internal_attachments (o código de
antes os mostraria a quem só tem Visualizar; a linha que fica vazia sai); volta as aptidões a
{name, level[, since]} e as áreas a códigos; tira o carimbo "areas" e troca o "central" dos carimbos
por "app" (o código de antes só conhece app e ficha); e apaga as tabelas novas e as colunas
name_key e used_at do ferramental. Perdas: documentos e avaliações (os arquivos ficam em
MEDIA_ROOT/documents/: limpeza manual), as áreas sem código (criadas depois da migração: saem dos
técnicos e das fichas), as aptidões que não estão mais no catálogo, as ferramentas fundidas (a mais
nova não volta) e o 1º uso.

Revision ID: c8f2a4e6b0d3
Revises: b7e2d4f6a8c1
Create Date: 2026-11-26
"""

import json
import re
import unicodedata
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c8f2a4e6b0d3"
down_revision: str | None = "b7e2d4f6a8c1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = postgresql.JSONB(astext_type=sa.Text())
UUID = postgresql.UUID(as_uuid=True)
TIMEZONE = "America/Sao_Paulo"  # o mesmo de settings.TIMEZONE: o "desde" é o dia local

# Cópias (não importar app.* numa migração): services/technician_catalogs (DEFAULT_AREAS,
# DEFAULT_SKILLS, NAME_MAX), os níveis de schemas/onboarding.SKILL_LEVELS e core/text (visible,
# fold, clean). tests/test_gestao_migration.py confere.
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
SKILL_LEVELS: tuple[str, ...] = ("basico", "intermediario", "avancado")
DEFAULT_LEVEL = "basico"
NAME_MAX = 80  # o nome nos catálogos
KEY_MAX = 160  # a coluna name_key
CODE_MAX = 32  # a coluna area_catalog.code
SPACE_CONTROLS = frozenset("\t\n\v\f\r")  # os únicos controles que viram espaço
# O histórico do cadastro (services/user_history): as listas de ferramentas e de aptidões, o fim
# " e mais N" das listas longas e o " (Nível)" de cada aptidão.
HISTORY_FIELDS = ("tools", "skills")
_MORE = re.compile(r"\s+e mais \d+$")
_LEVEL_SUFFIX = re.compile(r"\s+\((?:Básico|Intermediário|Avançado)\)$")
# Downgrade: o que o código de antes não lê.
INTERNAL_FIELD = "internal_attachments"
RATING_EVENTS = ("rating_set", "rating_removed")


# ------------------------------------------------------------------ texto (core/text.py)


def visible(text: str) -> str:
    """Sem controles (Cc) nem formatação (Cf); tab, LF, VT, FF e CR viram espaço."""
    return "".join(
        " " if ch in SPACE_CONTROLS else ch
        for ch in text
        if ch in SPACE_CONTROLS or unicodedata.category(ch) not in ("Cc", "Cf")
    )


def fold(text: str | None) -> str:
    """Sem controles nem formatação, NFKD sem marcas, casefold, espaços colapsados."""
    decomposed = unicodedata.normalize("NFKD", visible(text or ""))
    plain = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(plain.casefold().split())


def clean(text: str | None) -> str:
    """Sem controles nem formatação, NFC e espaços colapsados."""
    return " ".join(unicodedata.normalize("NFC", visible(text or "")).split())


def key_of(name: str | None) -> str:
    """O name_key de um nome (o fold; cortado no tamanho da coluna, para a migração não parar)."""
    return fold(name)[:KEY_MAX]


# ------------------------------------------------------------------ funções puras


def _loaded(value: Any) -> Any:
    """O JSONB lido como texto (::text): o asyncpg entrega o texto do JSON."""
    return json.loads(value) if isinstance(value, str) else value


def _utc(at: datetime) -> datetime:
    return at.astimezone(UTC) if at.tzinfo is not None else at.replace(tzinfo=UTC)


def _local_day(at: datetime) -> str:
    return _utc(at).astimezone(ZoneInfo(TIMEZONE)).date().isoformat()


def _as_id(value: Any) -> str | None:
    """O id em texto (str(UUID)); None quando não é um id."""
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value.strip()))
    except ValueError:
        return None


def catalog_name(raw: Any) -> str | None:
    """O nome como entra num catálogo: texto limpo, até NAME_MAX; vazio (ou só marcas): None."""
    if not isinstance(raw, str):
        return None
    name = clean(clean(raw)[:NAME_MAX])
    return name if key_of(name) else None


def seed_skill_names(defaults: Sequence[str], recorded: Iterable[Any]) -> list[str]:
    """As padrão primeiro, depois os nomes gravados (texto; limpos; vazio sai; mais de 80 corta),
    sem repetir pelo nome sem acento e sem maiúsculas (fica a grafia do primeiro)."""
    seen: set[str] = set()
    out: list[str] = []
    for raw in (*defaults, *recorded):
        name = catalog_name(raw)
        if name is None or key_of(name) in seen:
            continue
        seen.add(key_of(name))
        out.append(name)
    return out


def area_ids(
    values: Any, by_code: Mapping[str, str], known: set[str]
) -> tuple[list[str], list[str]] | None:
    """(ids na ordem, sem repetir; códigos desconhecidos, sem repetir). Os ids conhecidos ficam
    (rodar de novo não muda nada); o código vira o id da área dele (também em maiúsculas); um id
    fora do catálogo e o que não é texto saem. None quando não é lista (a coluna fica)."""
    if not isinstance(values, list):
        return None
    ids: list[str] = []
    unknown: list[str] = []
    for raw in values:
        if not isinstance(raw, str) or not raw.strip():
            continue
        value = raw.strip()
        found = _as_id(value)
        if found is not None:
            if found not in known:
                continue
        else:
            found = by_code.get(value) or by_code.get(value.lower())
            if found is None:
                if value not in unknown:
                    unknown.append(value)
                continue
        if found not in ids:
            ids.append(found)
    return ids, unknown


def skill_items(
    raw: Any, by_key: Mapping[str, str], *, since: str | None
) -> list[dict[str, Any]] | None:
    """{name, level[, since]} -> {skill_id, level[, since]} pelo nome sem acento e sem maiúsculas;
    o item que já tem skill_id fica; nível fora de SKILL_LEVELS vira "basico" (nada se perde); o
    mesmo id duas vezes: fica o primeiro; o "desde" do item ou `since`; com `since` None (a ficha),
    sem a chave. None quando não é lista."""
    if not isinstance(raw, list):
        return None
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        skill_id = item.get("skill_id")
        if isinstance(skill_id, str) and skill_id:
            key: str | None = skill_id
        else:
            name = catalog_name(item.get("name"))
            key = by_key.get(key_of(name)) if name is not None else None
        if key is None or key in seen:
            continue
        seen.add(key)
        level = item.get("level")
        new: dict[str, Any] = {
            "skill_id": key,
            "level": level if level in SKILL_LEVELS else DEFAULT_LEVEL,
        }
        if since is not None:
            own = item.get("since")
            new["since"] = own if isinstance(own, str) and own else since
        out.append(new)
    return out


def history_names(changes: Any, field: str) -> list[str]:
    """Os nomes nos itens "from"/"to" de `field` ("tools" ou "skills") de uma linha do histórico:
    separa por ", ", tira o " e mais N" e, em skills, o " (Nível)" do fim. Sem repetir."""
    out: list[str] = []
    for item in changes if isinstance(changes, list) else []:
        if not isinstance(item, Mapping) or item.get("field") != field:
            continue
        for side in ("from", "to"):
            value = item.get(side)
            if not isinstance(value, str) or not value:
                continue
            for part in _MORE.sub("", value.strip()).split(", "):
                name = part.strip()
                if field == "skills":
                    name = _LEVEL_SUFFIX.sub("", name)
                if name and name not in out:
                    out.append(name)
    return out


def merge_duplicates(rows: Sequence[tuple[str, str, datetime]]) -> dict[str, str]:
    """(id, name, created_at) do tool_catalog com o mesmo name_key: {id repetido: id mantido} (o
    mais antigo; empate: o menor id)."""
    groups: dict[str, list[tuple[datetime, str]]] = {}
    for tool_id, name, created_at in rows:
        groups.setdefault(key_of(name), []).append((_utc(created_at), str(tool_id)))
    out: dict[str, str] = {}
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort()
        kept = members[0][1]
        for _, other in members[1:]:
            out[other] = kept
    return out


def replace_ids(values: Any, merge: Mapping[str, str]) -> list[Any] | None:
    """users.tool_ids com os ids fundidos trocados pelo mantido, sem repetir. None quando não é
    lista."""
    if not isinstance(values, list):
        return None
    out: list[Any] = []
    for raw in values:
        value = merge.get(raw, raw) if isinstance(raw, str) else raw
        if value not in out:
            out.append(value)
    return out


def stamp_areas(stamps: Any, at: datetime) -> dict[str, Any] | None:
    """O carimbo "areas" (via "ficha") nos carimbos de quem tem áreas; None quando já tem ou quando
    o valor não é objeto (fica)."""
    if not isinstance(stamps, Mapping) or "areas" in stamps:
        return None
    return {**stamps, "areas": {"at": _utc(at).isoformat(), "via": "ficha"}}


# Downgrade.


def skills_back(
    raw: Any, names: Mapping[str, str], *, with_since: bool
) -> list[dict[str, Any]] | None:
    """{skill_id, level[, since]} -> {name, level[, since]} pelo nome do catálogo (o "desde" só
    com `with_since`: os técnicos); o item que já tem só o nome fica; a aptidão fora do catálogo
    sai; o mesmo nome duas vezes: fica o primeiro. None quando não é lista."""
    if not isinstance(raw, list):
        return None
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        if "skill_id" in item:
            name = names.get(str(item.get("skill_id")))
        else:
            name = item.get("name") if isinstance(item.get("name"), str) else None
        if not name or key_of(name) in seen:
            continue
        seen.add(key_of(name))
        back: dict[str, Any] = {"name": name, "level": item.get("level")}
        if with_since and isinstance(item.get("since"), str):
            back["since"] = item["since"]
        out.append(back)
    return out


def areas_back(raw: Any, codes: Mapping[str, str]) -> list[str] | None:
    """ids -> códigos antigos; a área sem código (criada depois) sai; o que já é código fica. None
    quando não é lista."""
    if not isinstance(raw, list):
        return None
    known = set(codes.values())
    out: list[str] = []
    for value in raw:
        if not isinstance(value, str):
            continue
        code = codes.get(_as_id(value) or "") or (value if value in known else None)
        if code is not None and code not in out:
            out.append(code)
    return out


def stamps_back(stamps: Any) -> Any:
    """Os carimbos sem "areas" e com o via "central" trocado por "app"; o valor que não é objeto
    fica."""
    if not isinstance(stamps, Mapping):
        return stamps
    out: dict[str, Any] = {}
    for part, stamp in stamps.items():
        if part == "areas":
            continue
        if isinstance(stamp, Mapping) and stamp.get("via") == "central":
            stamp = {**stamp, "via": "app"}
        out[part] = stamp
    return out


def strip_internal(changes: Any) -> Any:
    """As mudanças de uma linha do histórico sem os itens internal_attachments; o valor que não é
    lista fica."""
    if not isinstance(changes, list):
        return changes
    return [
        item
        for item in changes
        if not (isinstance(item, Mapping) and item.get("field") == INTERNAL_FIELD)
    ]


# ------------------------------------------------------------------ passos de dados

INSERT_AREA = sa.text(
    "INSERT INTO area_catalog (id, name, name_key, code, is_active)"
    " VALUES (:id, :name, :name_key, :code, true) ON CONFLICT DO NOTHING RETURNING id::text"
)
FIND_AREA = sa.text("SELECT id::text FROM area_catalog WHERE name_key = :name_key")
INSERT_SKILL = sa.text(
    "INSERT INTO skill_catalog (id, name, name_key, is_active)"
    " VALUES (:id, :name, :name_key, true) ON CONFLICT (name_key) DO NOTHING"
)
# Os nomes gravados, na ordem do cadastro (o JSONB como texto: _loaded).
RECORDED_SKILLS = (
    sa.text("SELECT skills::text AS skills FROM users ORDER BY created_at, id"),
    sa.text("SELECT skills::text AS skills FROM technician_applications ORDER BY created_at, id"),
)
TOOLS = sa.text(
    "SELECT id::text AS id, name, name_key, is_active, created_at FROM tool_catalog"
    " ORDER BY created_at, id"
)
SET_TOOL_KEY = sa.text("UPDATE tool_catalog SET name_key = :key WHERE id = CAST(:id AS uuid)")
ACTIVATE_TOOL = sa.text(
    "UPDATE tool_catalog SET is_active = true WHERE id = CAST(:id AS uuid) AND NOT is_active"
)
DELETE_TOOL = sa.text("DELETE FROM tool_catalog WHERE id = CAST(:id AS uuid)")
TOOL_USERS = sa.text("SELECT id, tool_ids::text AS tool_ids FROM users")
SET_TOOL_IDS = sa.text("UPDATE users SET tool_ids = CAST(:ids AS jsonb) WHERE id = :id")
AREAS = sa.text("SELECT id::text AS id, code, name_key FROM area_catalog")
SKILLS = sa.text("SELECT id::text AS id, name, name_key FROM skill_catalog")
# (consulta, gravação) das áreas e das aptidões de técnicos e fichas.
USER_AREAS = (
    sa.text("SELECT id, service_areas::text AS value FROM users"),
    sa.text("UPDATE users SET service_areas = CAST(:value AS jsonb) WHERE id = :id"),
)
FICHA_AREAS = (
    sa.text("SELECT id, service_areas::text AS value FROM technician_applications"),
    sa.text(
        "UPDATE technician_applications SET service_areas = CAST(:value AS jsonb) WHERE id = :id"
    ),
)
USER_SKILLS = (
    sa.text("SELECT id, created_at, skills::text AS value FROM users"),
    sa.text("UPDATE users SET skills = CAST(:value AS jsonb) WHERE id = :id"),
)
FICHA_SKILLS = (
    sa.text("SELECT id, skills::text AS value FROM technician_applications"),
    sa.text("UPDATE technician_applications SET skills = CAST(:value AS jsonb) WHERE id = :id"),
)
USED_BY_USERS = sa.text(
    "SELECT tool_ids::text AS tools, service_areas::text AS areas, skills::text AS skills"
    " FROM users"
)
USED_BY_FICHAS = sa.text(
    "SELECT NULL AS tools, service_areas::text AS areas, skills::text AS skills"
    " FROM technician_applications"
)
HISTORY_ROWS = sa.text(
    "SELECT changes::text AS changes FROM user_changes"
    " WHERE changes @> CAST(:tools AS jsonb) OR changes @> CAST(:skills AS jsonb)"
)
# A ficha aprovada que trouxe as áreas (a mesma ordem da cópia da b7e2d4f6a8c1).
AREA_STAMPS = sa.text(
    """
    SELECT u.id, u.created_at, u.tech_profile_stamps::text AS stamps,
           (SELECT a.created_at FROM technician_applications a
             WHERE a.user_id = u.id AND CAST(a.status AS text) = 'approved'
             ORDER BY a.reviewed_at NULLS LAST, a.created_at, a.id LIMIT 1) AS ficha_at
      FROM users u
     WHERE jsonb_typeof(u.service_areas) = 'array' AND u.service_areas <> '[]'::jsonb
    """
)
SET_STAMPS = sa.text("UPDATE users SET tech_profile_stamps = CAST(:stamps AS jsonb) WHERE id = :id")


def _seed_areas() -> int:
    """1. As 10 áreas fixas (código, nome) que ainda não estão no catálogo."""
    conn = op.get_bind()
    count = 0
    for code, name in DEFAULT_AREAS:
        params = {"id": uuid.uuid4(), "name": name, "name_key": key_of(name), "code": code}
        count += len(conn.execute(INSERT_AREA, params).all())
    return count


def _seed_skills() -> int:
    """2. As aptidões padrão e depois os nomes gravados (técnicos e fichas)."""
    conn = op.get_bind()
    recorded: list[Any] = []
    for query in RECORDED_SKILLS:
        for row in conn.execute(query).mappings().all():
            items = _loaded(row["skills"])
            if isinstance(items, list):
                recorded.extend(item.get("name") for item in items if isinstance(item, Mapping))
    count = 0
    for name in seed_skill_names(DEFAULT_SKILLS, recorded):
        params = {"id": uuid.uuid4(), "name": name, "name_key": key_of(name)}
        count += conn.execute(INSERT_SKILL, params).rowcount or 0
    return count


def _tool_keys() -> int:
    """3. O name_key do ferramental; as repetidas por ele fundem na mais antiga."""
    conn = op.get_bind()
    rows = conn.execute(TOOLS).mappings().all()
    merge = merge_duplicates([(row["id"], row["name"], row["created_at"]) for row in rows])
    count = 0
    if merge:
        active = {row["id"] for row in rows if row["is_active"]}
        for kept in sorted(set(merge.values())):
            if any(merged in active for merged, into in merge.items() if into == kept):
                count += conn.execute(ACTIVATE_TOOL, {"id": kept}).rowcount or 0
        for row in conn.execute(TOOL_USERS).mappings().all():
            ids = _loaded(row["tool_ids"])
            new = replace_ids(ids, merge)
            if new is not None and new != ids:
                conn.execute(SET_TOOL_IDS, {"id": row["id"], "ids": json.dumps(new)})
                count += 1
        for merged in sorted(merge):
            count += conn.execute(DELETE_TOOL, {"id": merged}).rowcount or 0
    for row in rows:
        key = key_of(row["name"])
        if row["id"] not in merge and row["name_key"] != key:
            conn.execute(SET_TOOL_KEY, {"id": row["id"], "key": key})
            count += 1
    return count


def _new_area(conn: Any, code: str, by_code: dict[str, str], by_key: dict[str, str]) -> str | None:
    """A área de um código desconhecido: a de mesmo nome que já existe ou uma nova, ativa, com o
    código (se ele couber e for de ninguém)."""
    name = catalog_name(code)
    if name is None:
        return None
    key = key_of(name)
    if key in by_key:
        return by_key[key]
    cut = code[:CODE_MAX]
    own_code = None if cut in by_code else cut
    params = {"id": uuid.uuid4(), "name": name, "name_key": key, "code": own_code}
    created = conn.execute(INSERT_AREA, params).scalar()
    area_id = created or conn.execute(FIND_AREA, {"name_key": key}).scalar()
    if area_id is None:
        return None
    by_key[key] = str(area_id)
    if created and own_code is not None:
        by_code[own_code] = str(area_id)
    return str(area_id)


def _convert_areas() -> int:
    """4. As áreas de técnicos e fichas viram ids (o código desconhecido vira área antes)."""
    conn = op.get_bind()
    areas = conn.execute(AREAS).mappings().all()
    by_code = {row["code"]: row["id"] for row in areas if row["code"]}
    by_key = {row["name_key"]: row["id"] for row in areas}
    known = {row["id"] for row in areas}
    rows = [
        (write, row["id"], _loaded(row["value"]))
        for query, write in (USER_AREAS, FICHA_AREAS)
        for row in conn.execute(query).mappings().all()
    ]
    for _, _, values in rows:
        converted = area_ids(values, by_code, known)
        for code in converted[1] if converted is not None else []:
            if code in by_code:
                continue
            area_id = _new_area(conn, code, by_code, by_key)
            if area_id is not None:
                by_code[code] = area_id
                known.add(area_id)
    count = 0
    for write, row_id, values in rows:
        converted = area_ids(values, by_code, known)
        if converted is None or converted[0] == values:
            continue
        conn.execute(write, {"id": row_id, "value": json.dumps(converted[0])})
        count += 1
    return count


def _convert_skills() -> int:
    """5. As aptidões de técnicos ({skill_id, level, since}) e fichas ({skill_id, level})."""
    conn = op.get_bind()
    by_key = {row["name_key"]: row["id"] for row in conn.execute(SKILLS).mappings().all()}
    count = 0
    for (query, write), with_since in ((USER_SKILLS, True), (FICHA_SKILLS, False)):
        for row in conn.execute(query).mappings().all():
            items = _loaded(row["value"])
            since = _local_day(row["created_at"]) if with_since else None
            new = skill_items(items, by_key, since=since)
            if new is None or new == items:
                continue
            conn.execute(write, {"id": row["id"], "value": json.dumps(new)})
            count += 1
    return count


def _ids(values: Any) -> set[str]:
    return (
        {found for raw in values if (found := _as_id(raw))} if isinstance(values, list) else set()
    )


def _skill_ids(items: Any) -> set[str]:
    if not isinstance(items, list):
        return set()
    return _ids([item.get("skill_id") for item in items if isinstance(item, Mapping)])


def _mark_used() -> int:
    """6. O 1º uso do que está em técnicos e fichas e do que o histórico cita."""
    conn = op.get_bind()
    used: dict[str, set[str]] = {
        "tool_catalog": set(),
        "area_catalog": set(),
        "skill_catalog": set(),
    }
    for query in (USED_BY_USERS, USED_BY_FICHAS):
        for row in conn.execute(query).mappings().all():
            used["tool_catalog"] |= _ids(_loaded(row["tools"]))
            used["area_catalog"] |= _ids(_loaded(row["areas"]))
            used["skill_catalog"] |= _skill_ids(_loaded(row["skills"]))
    by_key = {
        "tool_catalog": {
            key_of(row["name"]): row["id"] for row in conn.execute(TOOLS).mappings().all()
        },
        "skill_catalog": {
            row["name_key"]: row["id"] for row in conn.execute(SKILLS).mappings().all()
        },
    }
    params = {
        "tools": json.dumps([{"field": "tools"}]),
        "skills": json.dumps([{"field": "skills"}]),
    }
    for row in conn.execute(HISTORY_ROWS, params).mappings().all():
        changes = _loaded(row["changes"])
        for field, table in zip(HISTORY_FIELDS, ("tool_catalog", "skill_catalog"), strict=True):
            for name in history_names(changes, field):
                found = by_key[table].get(key_of(name))
                if found is not None:
                    used[table].add(found)
    count = 0
    for table, ids in used.items():
        mark = sa.text(
            f"UPDATE {table} SET used_at = now() WHERE id = CAST(:id AS uuid) AND used_at IS NULL"
        )
        for item_id in sorted(ids):
            count += conn.execute(mark, {"id": item_id}).rowcount or 0
    return count


def _stamp_areas() -> int:
    """7. O carimbo "areas" de quem tem áreas (até aqui elas só vinham da ficha)."""
    conn = op.get_bind()
    count = 0
    for row in conn.execute(AREA_STAMPS).mappings().all():
        stamps = stamp_areas(_loaded(row["stamps"]), row["ficha_at"] or row["created_at"])
        if stamps is None:
            continue
        conn.execute(SET_STAMPS, {"id": row["id"], "stamps": json.dumps(stamps)})
        count += 1
    return count


DATA_STEPS: tuple[Callable[[], int], ...] = (
    _seed_areas,
    _seed_skills,
    _tool_keys,
    _convert_areas,
    _convert_skills,
    _mark_used,
    _stamp_areas,
)


# ------------------------------------------------------------------ passos do downgrade

DELETE_RATING_EVENTS = sa.text(
    "DELETE FROM ticket_events WHERE event_type IN ('rating_set', 'rating_removed')"
)
INTERNAL_ROWS = sa.text(
    "SELECT id, changes::text AS changes FROM user_changes WHERE changes @> CAST(:probe AS jsonb)"
)
SET_CHANGES = sa.text("UPDATE user_changes SET changes = CAST(:changes AS jsonb) WHERE id = :id")
DELETE_CHANGE = sa.text("DELETE FROM user_changes WHERE id = :id")
AREA_CODES = sa.text("SELECT id::text AS id, code FROM area_catalog WHERE code IS NOT NULL")
STAMP_ROWS = sa.text(
    "SELECT id, tech_profile_stamps::text AS stamps FROM users"
    " WHERE tech_profile_stamps <> '{}'::jsonb"
)


def _drop_rating_events() -> int:
    """(1) Os eventos de OS da avaliação: o enum de antes não lê esses valores."""
    return op.get_bind().execute(DELETE_RATING_EVENTS).rowcount or 0


def _strip_internal_history() -> int:
    """(2) Os itens internal_attachments do histórico (a linha que fica vazia sai)."""
    conn = op.get_bind()
    count = 0
    probe = json.dumps([{"field": INTERNAL_FIELD}])
    for row in conn.execute(INTERNAL_ROWS, {"probe": probe}).mappings().all():
        changes = _loaded(row["changes"])
        stripped = strip_internal(changes)
        if stripped == changes:
            continue
        if stripped:
            conn.execute(SET_CHANGES, {"id": row["id"], "changes": json.dumps(stripped)})
        else:
            conn.execute(DELETE_CHANGE, {"id": row["id"]})
        count += 1
    return count


def _skills_back() -> int:
    """(3) As aptidões voltam a {name, level, since} (técnicos) e {name, level} (fichas)."""
    conn = op.get_bind()
    names = {row["id"]: row["name"] for row in conn.execute(SKILLS).mappings().all()}
    count = 0
    for (query, write), with_since in ((USER_SKILLS, True), (FICHA_SKILLS, False)):
        for row in conn.execute(query).mappings().all():
            items = _loaded(row["value"])
            back = skills_back(items, names, with_since=with_since)
            if back is None or back == items:
                continue
            conn.execute(write, {"id": row["id"], "value": json.dumps(back)})
            count += 1
    return count


def _areas_back() -> int:
    """(3) As áreas voltam aos códigos (a área sem código sai)."""
    conn = op.get_bind()
    codes = {row["id"]: row["code"] for row in conn.execute(AREA_CODES).mappings().all()}
    count = 0
    for query, write in (USER_AREAS, FICHA_AREAS):
        for row in conn.execute(query).mappings().all():
            values = _loaded(row["value"])
            back = areas_back(values, codes)
            if back is None or back == values:
                continue
            conn.execute(write, {"id": row["id"], "value": json.dumps(back)})
            count += 1
    return count


def _stamps_back() -> int:
    """(3) Os carimbos sem "areas" e sem "central"."""
    conn = op.get_bind()
    count = 0
    for row in conn.execute(STAMP_ROWS).mappings().all():
        stamps = _loaded(row["stamps"])
        back = stamps_back(stamps)
        if back == stamps:
            continue
        conn.execute(SET_STAMPS, {"id": row["id"], "stamps": json.dumps(back)})
        count += 1
    return count


DOWNGRADE_STEPS: tuple[Callable[[], int], ...] = (
    _drop_rating_events,
    _strip_internal_history,
    _skills_back,
    _areas_back,
    _stamps_back,
)


# ------------------------------------------------------------------ upgrade / downgrade


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def upgrade() -> None:
    op.create_table(
        "area_catalog",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("name_key", sa.String(length=160), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.UniqueConstraint("name_key", name=op.f("uq_area_catalog_name_key")),
        sa.UniqueConstraint("code", name=op.f("uq_area_catalog_code")),
    )
    op.create_table(
        "skill_catalog",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("name_key", sa.String(length=160), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.UniqueConstraint("name_key", name=op.f("uq_skill_catalog_name_key")),
    )
    op.add_column("tool_catalog", sa.Column("name_key", sa.String(length=160), nullable=True))
    op.add_column("tool_catalog", sa.Column("used_at", sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        "technician_documents",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column(
            "application_id",
            UUID,
            sa.ForeignKey("technician_applications.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "version_of_id",
            UUID,
            sa.ForeignKey("technician_documents.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=80), nullable=False),
        sa.Column("expires_on", sa.Date(), nullable=True),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=120), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("storage_key", sa.String(length=500), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "uploaded_by_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("uploaded_via", sa.String(length=10), nullable=False),
        sa.Column("replaced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("client_upload_id", UUID, nullable=True),
        *_timestamps(),
        sa.UniqueConstraint(
            "client_upload_id", name=op.f("uq_technician_documents_client_upload_id")
        ),
        sa.CheckConstraint(
            "user_id IS NOT NULL OR application_id IS NOT NULL",
            name=op.f("ck_technician_documents_owner"),
        ),
        sa.CheckConstraint(
            "expires_on IS NULL OR kind = 'certification'",
            name=op.f("ck_technician_documents_expiry"),
        ),
        sa.CheckConstraint(
            "kind <> 'internal' OR application_id IS NULL",
            name=op.f("ck_technician_documents_internal"),
        ),
        sa.CheckConstraint(
            "(version_of_id IS NULL) = (replaced_at IS NULL)",
            name=op.f("ck_technician_documents_version"),
        ),
    )
    op.create_index("ix_technician_documents_user_id", "technician_documents", ["user_id"])
    op.create_index(
        "ix_technician_documents_application_id", "technician_documents", ["application_id"]
    )
    op.create_index(
        "ix_technician_documents_version_of_id", "technician_documents", ["version_of_id"]
    )
    op.create_index(
        "uq_technician_documents_user_resume",
        "technician_documents",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text(
            "kind = 'resume' AND version_of_id IS NULL AND user_id IS NOT NULL"
        ),
    )
    op.create_index(
        "ix_technician_documents_expiry",
        "technician_documents",
        ["expires_on"],
        postgresql_where=sa.text(
            "kind = 'certification' AND version_of_id IS NULL AND expires_on IS NOT NULL"
        ),
    )

    op.create_table(
        "technician_ratings",
        sa.Column("id", UUID, primary_key=True),
        sa.Column(
            "ticket_id", UUID, sa.ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "technician_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("score", sa.SmallInteger(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("rater_name", sa.String(length=120), nullable=True),
        sa.Column("source", sa.String(length=32), server_default="central", nullable=False),
        sa.Column(
            "created_by_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "updated_by_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        *_timestamps(),
        sa.UniqueConstraint(
            "ticket_id", "technician_id", name=op.f("uq_technician_ratings_ticket_technician")
        ),
        sa.CheckConstraint("score BETWEEN 1 AND 5", name=op.f("ck_technician_ratings_score")),
    )
    op.create_index("ix_technician_ratings_technician_id", "technician_ratings", ["technician_id"])

    for step in DATA_STEPS:
        step()

    op.alter_column("tool_catalog", "name_key", existing_type=sa.String(length=160), nullable=False)
    op.create_unique_constraint(op.f("uq_tool_catalog_name_key"), "tool_catalog", ["name_key"])


def downgrade() -> None:
    for step in DOWNGRADE_STEPS:
        step()

    op.drop_index("ix_technician_ratings_technician_id", table_name="technician_ratings")
    op.drop_table("technician_ratings")
    op.drop_index("ix_technician_documents_expiry", table_name="technician_documents")
    op.drop_index("uq_technician_documents_user_resume", table_name="technician_documents")
    op.drop_index("ix_technician_documents_version_of_id", table_name="technician_documents")
    op.drop_index("ix_technician_documents_application_id", table_name="technician_documents")
    op.drop_index("ix_technician_documents_user_id", table_name="technician_documents")
    op.drop_table("technician_documents")

    op.drop_constraint(op.f("uq_tool_catalog_name_key"), "tool_catalog", type_="unique")
    op.drop_column("tool_catalog", "used_at")
    op.drop_column("tool_catalog", "name_key")
    op.drop_table("skill_catalog")
    op.drop_table("area_catalog")
