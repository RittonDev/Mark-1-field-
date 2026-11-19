"""Perfil técnico, catálogo de ferramentas e escopo lido na oferta

- Tabela tool_catalog: o ferramental dos técnicos (a central inclui, renomeia e desativa; sem excluir), com 20
  ferramentas iniciais de TI de campo.
- users ganha o perfil técnico, que o técnico mantém no app: tool_ids, availability ("dia:turno"), transport_modes,
  has_driver_license, skills ([{name, level, since}]), education ([{id, course, level, institution, start, end}]) e
  tech_profile_stamps ({parte: {at, via}}). Todas NOT NULL com default: a importação do Field Control e os INSERT em
  lote não passam por elas.
- Técnicos com ficha de homologação aprovada recebem a disponibilidade, o transporte e as aptidões da ficha (via
  "ficha"), com o mesmo mapa de services/tech_profile.py, copiado aqui (tests/test_tech_profile.py confere a cópia).
  Rodar de novo não muda nada: só preenche quem ainda tem tech_profile_stamps vazio.
- ticket_offers.scope_read_at: quando o técnico abriu o escopo no app (gravado no aceite).

O downgrade apaga o perfil técnico informado e o catálogo.

Revision ID: f5a7c9e1b3d6
Revises: e4b6d8f0a2c3
Create Date: 2026-11-19
"""

import json
import unicodedata
import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f5a7c9e1b3d6"
down_revision: str | None = "e4b6d8f0a2c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = postgresql.JSONB(astext_type=sa.Text())
TIMEZONE = "America/Sao_Paulo"  # o mesmo de settings.TIMEZONE: o "desde" é o dia local da ficha

# Cópias de services/tech_profile.py (não importar app.services numa migração).
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
PERIODS = ("morning", "afternoon", "evening", "night")
ALL_SLOTS = tuple(f"{d}:{p}" for d in WEEKDAYS for p in PERIODS)
DEFAULT_TOOLS = (
    "Alicate de corte",
    "Alicate de crimpar",
    "Alicate de inserção (punch down)",
    "Caneta óptica (VFL)",
    "Escada",
    "Etiquetadora",
    "Ferro de solda",
    "Furadeira",
    "HD externo",
    "Jogo de chaves Phillips e fenda",
    "Kit de limpeza",
    "Lanterna",
    "Localizador de cabos",
    "Máquina de fusão de fibra óptica",
    "Multímetro",
    "Notebook com cabo console",
    "Parafusadeira",
    "Pendrive de instalação",
    "Testador de cabo de rede",
    "Trena",
)
FICHA_AVAILABILITY = {
    "dias_uteis_manha": tuple(f"{d}:morning" for d in WEEKDAYS[:5]),
    "dias_uteis_tarde": tuple(f"{d}:afternoon" for d in WEEKDAYS[:5]),
    "dias_uteis_noite": tuple(f"{d}:evening" for d in WEEKDAYS[:5]),
    "sabado": ("sat:morning", "sat:afternoon", "sat:evening"),
    "domingo_feriado": ("sun:morning", "sun:afternoon", "sun:evening"),
    "plantao": ALL_SLOTS,
}
FICHA_VEHICLE = {"carro": "car", "moto": "motorcycle"}
SKILL_LEVELS = ("basico", "intermediario", "avancado")
MAX_SKILLS = 30
TEXT_MIN, SKILL_NAME_MAX = 2, 80

APPROVED = sa.text(
    """
    SELECT a.user_id, a.availability, a.has_vehicle, a.vehicle_type, a.has_driver_license, a.skills, a.created_at
      FROM technician_applications a
      JOIN users u ON u.id = a.user_id
     WHERE CAST(a.status AS text) = 'approved'
    """
)
FILL = sa.text(
    """
    UPDATE users
       SET availability = CAST(:availability AS jsonb),
           transport_modes = CAST(:modes AS jsonb),
           has_driver_license = :license,
           skills = CAST(:skills AS jsonb),
           tech_profile_stamps = CAST(:stamps AS jsonb)
     WHERE id = :id AND tech_profile_stamps = '{}'::jsonb
    """
)


def _fold(text: str) -> str:
    """NFKD sem marcas, casefold, espaços colapsados (como tech_profile.fold)."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    plain = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(plain.casefold().split())


def _clean(text: str) -> str:
    """NFC e espaços colapsados (como tech_profile.clean)."""
    return " ".join(unicodedata.normalize("NFC", text or "").split())


def _loaded(value: Any) -> Any:
    """JSONB de uma consulta em texto puro: o asyncpg entrega o texto do JSON."""
    return json.loads(value) if isinstance(value, str) else value


def _utc(at: datetime) -> datetime:
    return at.astimezone(UTC) if at.tzinfo is not None else at.replace(tzinfo=UTC)


def _skills(raw: Any, since: str) -> list[dict[str, Any]]:
    """Nível válido, nome limpo (2 a 80), sem repetir o nome (fica a primeira), até MAX_SKILLS, pelo
    nome sem acento e sem maiúsculas (tech_profile._ficha_skills)."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, Mapping):
            continue
        name, level = item.get("name"), item.get("level")
        if not isinstance(name, str) or not isinstance(level, str) or level not in SKILL_LEVELS:
            continue
        name = _clean(name)
        key = _fold(name)
        if not TEXT_MIN <= len(name) <= SKILL_NAME_MAX or key in seen:
            continue
        seen.add(key)
        out.append({"name": name, "level": level, "since": since})
    return sorted(out[:MAX_SKILLS], key=lambda item: (_fold(item["name"]), item["name"]))


def _ficha_profile(row: Mapping[str, Any]) -> dict[str, Any]:
    """O perfil técnico de uma ficha aprovada (uma linha de APPROVED): o mesmo de
    tech_profile.from_ficha, com as mesmas chaves."""
    at = _utc(row["created_at"])
    codes = _loaded(row["availability"])
    wanted = {
        slot
        for code in (codes if isinstance(codes, list) else [])
        for slot in FICHA_AVAILABILITY.get(str(code), ())
    }
    availability = [slot for slot in ALL_SLOTS if slot in wanted]
    vehicle = FICHA_VEHICLE.get(str(row["vehicle_type"] or ""))
    modes = [vehicle] if row["has_vehicle"] and vehicle else []
    driver_license = bool(row["has_driver_license"])
    skills = _skills(_loaded(row["skills"]), at.astimezone(ZoneInfo(TIMEZONE)).date().isoformat())
    filled = {
        "availability": bool(availability),
        "transport": bool(modes) or driver_license,
        "skills": bool(skills),
    }
    stamp = {"at": at.isoformat(), "via": "ficha"}
    return {
        "availability": availability,
        "transport_modes": modes,
        "has_driver_license": driver_license,
        "skills": skills,
        "tech_profile_stamps": {part: dict(stamp) for part, ok in filled.items() if ok},
    }


def _backfill() -> None:
    conn = op.get_bind()
    for row in conn.execute(APPROVED).mappings().all():
        profile = _ficha_profile(row)
        if not profile["tech_profile_stamps"]:
            continue  # a ficha não informou nada disso
        conn.execute(
            FILL,
            {
                "id": row["user_id"],
                "availability": json.dumps(profile["availability"]),
                "modes": json.dumps(profile["transport_modes"]),
                "license": profile["has_driver_license"],
                "skills": json.dumps(profile["skills"]),
                "stamps": json.dumps(profile["tech_profile_stamps"]),
            },
        )


def upgrade() -> None:
    tools = op.create_table(
        "tool_catalog",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("name", name="uq_tool_catalog_name"),
    )
    op.bulk_insert(tools, [{"id": uuid.uuid4(), "name": name, "is_active": True} for name in DEFAULT_TOOLS])
    for name, default in (
        ("tool_ids", "[]"),
        ("availability", "[]"),
        ("transport_modes", "[]"),
        ("skills", "[]"),
        ("education", "[]"),
        ("tech_profile_stamps", "{}"),
    ):
        op.add_column("users", sa.Column(name, JSONB, server_default=default, nullable=False))
    op.add_column(
        "users", sa.Column("has_driver_license", sa.Boolean(), server_default=sa.false(), nullable=False)
    )
    op.add_column("ticket_offers", sa.Column("scope_read_at", sa.DateTime(timezone=True), nullable=True))
    _backfill()


def downgrade() -> None:
    op.drop_column("ticket_offers", "scope_read_at")
    for name in (
        "has_driver_license",
        "tech_profile_stamps",
        "education",
        "skills",
        "transport_modes",
        "availability",
        "tool_ids",
    ):
        op.drop_column("users", name)
    op.drop_table("tool_catalog")
