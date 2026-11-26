"""Cadastro V2 dos técnicos

- users: endereço em partes (address_line passa a ser o logradouro; address_number e
  address_complement), CPF (único: uq_users_cpf), RG (número, órgão emissor, UF), nascimento,
  telefone secundário, mini biografia, veículo (modelo e placa), empresa (company_document,
  company_name, company_trade_name), áreas de atuação (service_areas), e-mail validado e o e-mail
  novo pedido no app (email_verified_at, email_pending, email_pending_at), situação na operação
  (operational_status NOT NULL, todos "active"; motivo, quando e quem, com a FK
  fk_users_operational_changed_by_id_users SET NULL) e a indisponibilidade
  ([{"id", "start", "end"}]).
- technician_applications: os campos novos da ficha, e-mail validado, reabertura (reopened_at,
  reopened_by_id SET NULL) e as análises (reviews). `address` passa a ser o logradouro.
- user_changes.note: o motivo da linha do histórico.
- Tabelas novas: technician_payout_methods (formas de recebimento, uma preferencial por técnico:
  índices únicos parciais _preferred, _pix e _bank; checks _pix_fields e _bank_fields),
  account_tokens (links por e-mail, só o hash; ck_account_tokens_one_target) e email_outbox (fila e
  registro dos e-mails; ix_email_outbox_status_next).

Dados (laço simples; funções puras testadas em tests/test_cadastro_v2_migration.py; nada de app.*):
1. as linhas de endereço "rua, número - complemento" viram as partes (o que não casar com segurança
   fica inteiro no logradouro);
2. a chave PIX de cada técnico vira a 1ª forma de recebimento, preferencial;
3. das fichas aprovadas, só no que está vazio no técnico: CPF (se não for de outro), nascimento,
   CNPJ e áreas de atuação;
4. cada ficha analisada ganha a entrada da análise (aprovada, reprovada ou expirada);
5. no histórico, o acesso ao app "Bloqueado" passa a "Sem acesso".
Só então saem ck_users_pix_pair e as colunas pix_* de users.

O downgrade volta a preferencial que é PIX para as colunas pix_* (o "desde" é o mais novo de
changed_at e preferred_since), junta o endereço ("rua, número - complemento"; na ficha, também o
bairro), devolve "Bloqueado" ao histórico e as linhas "ficha"/"link" a "central"/"app" (o código de
antes só conhece esses dois), troca no histórico as formas de recebimento (payout_methods e
payout_preferred, com a chave ou a conta mascarada e o titular) por um item "pix" com "***" (o
código de antes só esconde "pix" de quem não tem Pagamentos), e apaga o resto: contas e chaves não
preferenciais, situação, indisponibilidade, dados pessoais novos, análises, links e a fila de
e-mails.

Revision ID: b7e2d4f6a8c1
Revises: f5a7c9e1b3d6
Create Date: 2026-11-25
"""

import json
import re
import uuid
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b7e2d4f6a8c1"
down_revision: str | None = "f5a7c9e1b3d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = postgresql.JSONB(astext_type=sa.Text())
UUID = postgresql.UUID(as_uuid=True)

# Cópias (não importar app.* numa migração): services/onboarding.EXPIRED_NOTE e os textos do acesso
# ao app no histórico (services/user_history).
EXPIRED_NOTE = "Expirada sem análise"
ACCESS_OFF_BEFORE = "Bloqueado"
ACCESS_OFF = "Sem acesso"
COMPLEMENT_MAX = 60
# O histórico das formas de recebimento no código de antes (services/user_history.PIX_HIDDEN e os
# campos que o código novo grava).
PIX_HIDDEN = "***"
PAYOUT_ITEMS = frozenset({"payout_methods", "payout_preferred"})

# Colunas novas, todas nulas (as NOT NULL com default vêm à parte).
USER_COLUMNS: tuple[tuple[str, Any], ...] = (
    ("address_number", sa.String(length=10)),
    ("address_complement", sa.String(length=60)),
    ("cpf", sa.String(length=11)),
    ("rg_number", sa.String(length=20)),
    ("rg_issuer", sa.String(length=20)),
    ("rg_state", sa.String(length=2)),
    ("birth_date", sa.Date()),
    ("phone_secondary", sa.String(length=40)),
    ("bio", sa.Text()),
    ("vehicle_model", sa.String(length=60)),
    ("vehicle_plate", sa.String(length=7)),
    ("company_document", sa.String(length=14)),
    ("company_name", sa.String(length=160)),
    ("company_trade_name", sa.String(length=160)),
    ("email_verified_at", sa.DateTime(timezone=True)),
    ("email_pending", sa.String(length=255)),
    ("email_pending_at", sa.DateTime(timezone=True)),
    ("operational_reason", sa.Text()),
    ("operational_changed_at", sa.DateTime(timezone=True)),
    ("operational_changed_by_id", UUID),
)
APPLICATION_COLUMNS: tuple[tuple[str, Any], ...] = (
    ("address_number", sa.String(length=10)),
    ("address_complement", sa.String(length=60)),
    ("address_district", sa.String(length=120)),
    ("rg_number", sa.String(length=20)),
    ("rg_issuer", sa.String(length=20)),
    ("rg_state", sa.String(length=2)),
    ("phone_secondary", sa.String(length=40)),
    ("bio", sa.Text()),
    ("company_name", sa.String(length=160)),
    ("company_trade_name", sa.String(length=160)),
    ("vehicle_model", sa.String(length=60)),
    ("vehicle_plate", sa.String(length=7)),
    ("email_verified_at", sa.DateTime(timezone=True)),
    ("reopened_at", sa.DateTime(timezone=True)),
    ("reopened_by_id", UUID),
)
PIX_COLUMNS: tuple[tuple[str, Any], ...] = (
    ("pix_key_type", sa.String(length=32)),
    ("pix_key", sa.String(length=80)),
    ("pix_holder_name", sa.String(length=160)),
    ("pix_updated_at", sa.DateTime(timezone=True)),
)


# ------------------------------------------------------------------ funções puras

_NUMBER = r"(?:\d{1,6}[A-Za-z]?|[Ss]\s*/\s*[Nn]|[Ss][Nn])"
_LINE = re.compile(
    rf"^(?P<street>[^,]+?)\s*,\s*(?:n[º°o]?\.?\s*)?(?P<number>{_NUMBER})\s*(?:[-–,]\s*(?P<complement>.*?))?\s*$",
    re.IGNORECASE,
)


def split_address_line(line: str | None) -> tuple[str, str, str | None] | None:
    """(logradouro, número, complemento) de "Rua Exemplo, 123 - Apto 4"; None quando não dá com segurança."""
    m = _LINE.match((line or "").strip())
    if not m or len(m["street"].strip()) < 2:
        return None
    number = re.sub(r"\s", "", m["number"]).upper()
    number = "S/N" if number in ("S/N", "SN") else number
    complement = " ".join((m["complement"] or "").split()) or None
    if complement and len(complement) > COMPLEMENT_MAX:
        return None
    return " ".join(m["street"].split())[:255], number, complement


def _utc(at: datetime) -> datetime:
    return at.astimezone(UTC) if at.tzinfo is not None else at.replace(tzinfo=UTC)


def _loaded(value: Any) -> Any:
    """O JSONB lido como texto (::text): o asyncpg entrega o texto do JSON."""
    return json.loads(value) if isinstance(value, str) else value


def _pix_method_row(row: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    """A chave PIX de users (uma linha de PIX_USERS) como a 1ª forma de recebimento, preferencial.
    O titular é o da chave ou, sem ele, o nome do técnico; o documento do titular é a própria chave
    quando ela é CPF ou CNPJ. Todas as datas são a da chave (ou agora, sem ela)."""
    key_type = str(row["pix_key_type"])
    at = row["pix_updated_at"] or now
    holder = " ".join(str(row["pix_holder_name"] or "").split()) or " ".join(
        str(row["name"] or "").split()
    )
    return {
        "id": uuid.uuid4(),
        "user_id": row["id"],
        "kind": "pix",
        "pix_key_type": key_type,
        "pix_key": row["pix_key"],
        "holder_name": holder[:160],
        "holder_document": row["pix_key"] if key_type in ("cpf", "cnpj") else None,
        "preferred": True,
        "preferred_since": at,
        "changed_at": at,
        "created_at": at,
        "updated_at": at,
    }


def _ficha_fill(
    ficha: Mapping[str, Any], user: Mapping[str, Any], used_cpfs: set[str]
) -> dict[str, Any]:
    """O que a ficha aprovada traz para o técnico, só no que está vazio nele: CPF (11 números e de
    ninguém mais: `used_cpfs` guarda os já gravados), nascimento, CNPJ (14) e áreas de atuação
    (quando não tem nenhuma). Vazio: nada a gravar."""
    fill: dict[str, Any] = {}
    document = re.sub(r"\D", "", str(ficha["document"] or ""))
    if user["cpf"] is None and len(document) == 11 and document not in used_cpfs:
        fill["cpf"] = document
    if user["birth_date"] is None and ficha["birth_date"] is not None:
        fill["birth_date"] = ficha["birth_date"]
    company = str(ficha["company_document"] or "").strip().upper()
    if user["company_document"] is None and re.fullmatch(r"[0-9A-Z]{14}", company):
        fill["company_document"] = company
    areas = _loaded(ficha["service_areas"])
    if not _loaded(user["service_areas"]) and isinstance(areas, list):
        codes = list(dict.fromkeys(str(code) for code in areas if isinstance(code, str) and code))
        if codes:
            fill["service_areas"] = codes
    return fill


def _review_entry(
    status: str,
    reviewed_at: datetime,
    by_id: Any,
    by_name: str | None,
    note: str | None,
) -> dict[str, Any] | None:
    """A entrada de `reviews` da análise de uma ficha (a última, a única que se conhecia): aprovada,
    reprovada ou expirada (a rotina reprovou sem ninguém: "Expirada sem análise"). Pendente: None."""
    if status == "approved":
        action = "approved"
    elif status == "rejected":
        action = "expired" if note == EXPIRED_NOTE and by_id is None else "rejected"
    else:
        return None
    by = {"id": str(by_id), "name": by_name} if by_id is not None and by_name else None
    return {"action": action, "at": _utc(reviewed_at).isoformat(), "by": by, "note": note}


def _rename_access(changes: list[Any], old: str, new: str) -> list[Any]:
    """As mudanças de uma linha do histórico com o texto do acesso ao app trocado (só no campo
    is_active, em "from" e "to")."""
    out: list[Any] = []
    for item in changes:
        if isinstance(item, Mapping) and item.get("field") == "is_active":
            item = {**item, **{key: new for key in ("from", "to") if item.get(key) == old}}
        out.append(item)
    return out


def _old_payout(changes: list[Any]) -> list[Any]:
    """Downgrade: as mudanças de uma linha do histórico com as formas de recebimento
    (payout_methods, payout_preferred) trocadas por um item "pix" só, no lugar do primeiro, com
    "***" onde havia texto (null continua null: "cadastrada", "alterada", "removida"). O código de
    antes não conhece esses campos e só esconde "pix" (e "pix_holder") de quem não tem Pagamentos.
    A lista de entrada não muda."""
    out: list[Any] = []
    merged: dict[str, Any] | None = None
    for item in changes:
        if not (isinstance(item, Mapping) and item.get("field") in PAYOUT_ITEMS):
            out.append(item)
            continue
        hidden = {key: PIX_HIDDEN if item.get(key) is not None else None for key in ("from", "to")}
        if merged is None:
            merged = {"field": "pix", **hidden}
            out.append(merged)
        else:
            for key, value in hidden.items():
                merged[key] = merged[key] or value
    return out


# ------------------------------------------------------------------ passos de dados

ADDRESSES = sa.text(
    "SELECT id, address_line FROM users WHERE address_line IS NOT NULL AND address_number IS NULL"
)
SET_ADDRESS = sa.text(
    "UPDATE users SET address_line = :street, address_number = :number,"
    " address_complement = :complement WHERE id = :id"
)
PIX_USERS = sa.text(
    """
    SELECT u.id, u.name, u.pix_key_type, u.pix_key, u.pix_holder_name, u.pix_updated_at
      FROM users u
     WHERE u.pix_key IS NOT NULL AND u.pix_key_type IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM technician_payout_methods m WHERE m.user_id = u.id)
    """
)
INSERT_METHOD = sa.text(
    """
    INSERT INTO technician_payout_methods
           (id, user_id, kind, pix_key_type, pix_key, holder_name, holder_document, preferred,
            preferred_since, changed_at, created_at, updated_at)
    VALUES (:id, :user_id, :kind, :pix_key_type, :pix_key, :holder_name, :holder_document,
            :preferred, :preferred_since, :changed_at, :created_at, :updated_at)
    """
)
# A ficha aprovada mais antiga primeiro: ela fica com o CPF se duas fichas tiverem o mesmo.
APPROVED_FICHAS = sa.text(
    """
    SELECT a.user_id, a.document, a.birth_date, a.company_document,
           a.service_areas::text AS service_areas
      FROM technician_applications a
      JOIN users u ON u.id = a.user_id
     WHERE CAST(a.status AS text) = 'approved'
     ORDER BY a.reviewed_at NULLS LAST, a.created_at, a.id
    """
)
USED_CPFS = sa.text("SELECT cpf FROM users WHERE cpf IS NOT NULL")
USER_FILLED = sa.text(
    "SELECT cpf, birth_date, company_document, service_areas::text AS service_areas"
    " FROM users WHERE id = :id"
)
REVIEWED = sa.text(
    """
    SELECT a.id, CAST(a.status AS text) AS status, a.reviewed_at, a.reviewed_by_id,
           r.name AS reviewed_by_name, a.review_note
      FROM technician_applications a
      LEFT JOIN users r ON r.id = a.reviewed_by_id
     WHERE a.reviewed_at IS NOT NULL AND a.reviews = '[]'::jsonb
    """
)
SET_REVIEWS = sa.text(
    "UPDATE technician_applications SET reviews = CAST(:reviews AS jsonb) WHERE id = :id"
)
ACCESS_ROWS = sa.text(
    "SELECT id, changes::text AS changes FROM user_changes"
    " WHERE changes @> CAST(:probe AS jsonb)"
)
PAYOUT_ROWS = sa.text(
    "SELECT id, changes::text AS changes FROM user_changes"
    " WHERE changes @> CAST(:methods AS jsonb) OR changes @> CAST(:preferred AS jsonb)"
)
SET_CHANGES = sa.text("UPDATE user_changes SET changes = CAST(:changes AS jsonb) WHERE id = :id")


def _split_addresses() -> int:
    """1. As linhas de endereço que casam viram logradouro, número e complemento."""
    conn = op.get_bind()
    count = 0
    for row in conn.execute(ADDRESSES).mappings().all():
        parts = split_address_line(row["address_line"])
        if parts is None:
            continue
        street, number, complement = parts
        conn.execute(
            SET_ADDRESS,
            {"id": row["id"], "street": street, "number": number, "complement": complement},
        )
        count += 1
    return count


def _move_pix() -> int:
    """2. A chave PIX de users vira a forma de recebimento preferencial (quem ainda não tem forma)."""
    conn = op.get_bind()
    now = datetime.now(UTC)
    rows = conn.execute(PIX_USERS).mappings().all()
    for row in rows:
        conn.execute(INSERT_METHOD, _pix_method_row(row, now))
    return len(rows)


def _copy_fichas() -> int:
    """3. Das fichas aprovadas para o técnico, só no que está vazio nele."""
    conn = op.get_bind()
    used = {str(cpf) for cpf in conn.execute(USED_CPFS).scalars().all()}
    count = 0
    for ficha in conn.execute(APPROVED_FICHAS).mappings().all():
        user = conn.execute(USER_FILLED, {"id": ficha["user_id"]}).mappings().first()
        if user is None:
            continue
        fill = _ficha_fill(ficha, user, used)
        if not fill:
            continue
        if "cpf" in fill:
            used.add(fill["cpf"])
        # As chaves vêm de _ficha_fill (cpf, birth_date, company_document, service_areas).
        assignments = ", ".join(
            "service_areas = CAST(:service_areas AS jsonb)"
            if key == "service_areas"
            else f"{key} = :{key}"
            for key in fill
        )
        params = {"id": ficha["user_id"], **fill}
        if "service_areas" in fill:
            params["service_areas"] = json.dumps(fill["service_areas"])
        conn.execute(sa.text(f"UPDATE users SET {assignments} WHERE id = :id"), params)
        count += 1
    return count


def _backfill_reviews() -> int:
    """4. A entrada da análise de cada ficha analisada (as que ainda não têm nenhuma)."""
    conn = op.get_bind()
    count = 0
    for row in conn.execute(REVIEWED).mappings().all():
        entry = _review_entry(
            row["status"],
            row["reviewed_at"],
            row["reviewed_by_id"],
            row["reviewed_by_name"],
            row["review_note"],
        )
        if entry is None:
            continue
        conn.execute(SET_REVIEWS, {"id": row["id"], "reviews": json.dumps([entry])})
        count += 1
    return count


def _rename_access_texts(old: str, new: str) -> int:
    """5. O texto do acesso ao app nas linhas do histórico com is_active."""
    conn = op.get_bind()
    count = 0
    probe = json.dumps([{"field": "is_active"}])
    for row in conn.execute(ACCESS_ROWS, {"probe": probe}).mappings().all():
        changes = _loaded(row["changes"])
        if not isinstance(changes, list):
            continue
        renamed = _rename_access(changes, old, new)
        if renamed != changes:
            conn.execute(SET_CHANGES, {"id": row["id"], "changes": json.dumps(renamed)})
            count += 1
    return count


def _restore_pix() -> None:
    """Downgrade: a preferencial que é PIX volta para as colunas pix_* de users."""
    op.execute(
        """
        UPDATE users u
           SET pix_key_type = m.pix_key_type,
               pix_key = m.pix_key,
               pix_holder_name = m.holder_name,
               pix_updated_at = GREATEST(m.changed_at, m.preferred_since)
          FROM technician_payout_methods m
         WHERE m.user_id = u.id AND m.preferred AND m.kind = 'pix'
        """
    )


def _join_addresses() -> None:
    """Downgrade: o endereço volta a uma linha ("rua, número - complemento"; na ficha, também o
    bairro, que ela não tinha antes)."""
    op.execute(
        """
        UPDATE users
           SET address_line = left(concat_ws(' - ',
                   NULLIF(concat_ws(', ', address_line, address_number), ''),
                   address_complement), 255)
         WHERE address_number IS NOT NULL OR address_complement IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE technician_applications
           SET address = left(concat_ws(' - ',
                   NULLIF(concat_ws(', ', address, address_number), ''),
                   address_complement, address_district), 255)
         WHERE address_number IS NOT NULL OR address_complement IS NOT NULL
            OR address_district IS NOT NULL
        """
    )


def _old_via() -> None:
    """Downgrade: o histórico de antes só conhece "app" e "central"."""
    op.execute("UPDATE user_changes SET via = 'central' WHERE via = 'ficha'")
    op.execute("UPDATE user_changes SET via = 'app' WHERE via = 'link'")


def _hide_payout_history() -> int:
    """Downgrade: as formas de recebimento no histórico viram o item "pix" de antes, com "***"
    (_old_payout): quem não tem Pagamentos não as vê pelo código de antes."""
    conn = op.get_bind()
    count = 0
    params = {
        "methods": json.dumps([{"field": "payout_methods"}]),
        "preferred": json.dumps([{"field": "payout_preferred"}]),
    }
    for row in conn.execute(PAYOUT_ROWS, params).mappings().all():
        changes = _loaded(row["changes"])
        if not isinstance(changes, list):
            continue
        hidden = _old_payout(changes)
        if hidden != changes:
            conn.execute(SET_CHANGES, {"id": row["id"], "changes": json.dumps(hidden)})
            count += 1
    return count


DATA_STEPS: tuple[Callable[[], int], ...] = (
    _split_addresses,
    _move_pix,
    _copy_fichas,
    _backfill_reviews,
    lambda: _rename_access_texts(ACCESS_OFF_BEFORE, ACCESS_OFF),
)


# ------------------------------------------------------------------ upgrade / downgrade


def upgrade() -> None:
    for name, type_ in USER_COLUMNS:
        op.add_column("users", sa.Column(name, type_, nullable=True))
    op.add_column("users", sa.Column("service_areas", JSONB, server_default="[]", nullable=False))
    op.add_column(
        "users",
        sa.Column("operational_status", sa.String(length=32), server_default="active", nullable=False),
    )
    op.add_column("users", sa.Column("unavailability", JSONB, server_default="[]", nullable=False))
    op.create_unique_constraint(op.f("uq_users_cpf"), "users", ["cpf"])
    op.create_foreign_key(
        op.f("fk_users_operational_changed_by_id_users"),
        "users",
        "users",
        ["operational_changed_by_id"],
        ["id"],
        ondelete="SET NULL",
    )

    for name, type_ in APPLICATION_COLUMNS:
        op.add_column("technician_applications", sa.Column(name, type_, nullable=True))
    op.add_column(
        "technician_applications",
        sa.Column("reviews", JSONB, server_default="[]", nullable=False),
    )
    op.create_foreign_key(
        op.f("fk_technician_applications_reopened_by_id_users"),
        "technician_applications",
        "users",
        ["reopened_by_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.add_column("user_changes", sa.Column("note", sa.Text(), nullable=True))

    op.create_table(
        "technician_payout_methods",
        sa.Column("id", UUID, primary_key=True),
        sa.Column(
            "user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("pix_key_type", sa.String(length=32), nullable=True),
        sa.Column("pix_key", sa.String(length=80), nullable=True),
        sa.Column("bank_code", sa.String(length=3), nullable=True),
        sa.Column("bank_name", sa.String(length=80), nullable=True),
        sa.Column("branch", sa.String(length=4), nullable=True),
        sa.Column("account_number", sa.String(length=20), nullable=True),
        sa.Column("account_digit", sa.String(length=1), nullable=True),
        sa.Column("account_type", sa.String(length=32), nullable=True),
        sa.Column("holder_name", sa.String(length=160), nullable=False),
        sa.Column("holder_document", sa.String(length=14), nullable=True),
        sa.Column("preferred", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("preferred_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("changed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "(kind = 'pix') = (pix_key IS NOT NULL AND pix_key_type IS NOT NULL)",
            name=op.f("ck_technician_payout_methods_pix_fields"),
        ),
        sa.CheckConstraint(
            "(kind = 'bank') = (bank_code IS NOT NULL AND branch IS NOT NULL"
            " AND account_number IS NOT NULL AND account_digit IS NOT NULL"
            " AND account_type IS NOT NULL)",
            name=op.f("ck_technician_payout_methods_bank_fields"),
        ),
    )
    op.create_index(
        "ix_technician_payout_methods_user_id", "technician_payout_methods", ["user_id"]
    )
    op.create_index(
        "uq_technician_payout_methods_preferred",
        "technician_payout_methods",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("preferred"),
    )
    op.create_index(
        "uq_technician_payout_methods_pix",
        "technician_payout_methods",
        ["user_id", "pix_key_type", "pix_key"],
        unique=True,
        postgresql_where=sa.text("kind = 'pix'"),
    )
    op.create_index(
        "uq_technician_payout_methods_bank",
        "technician_payout_methods",
        ["user_id", "bank_code", "branch", "account_number", "account_digit"],
        unique=True,
        postgresql_where=sa.text("kind = 'bank'"),
    )

    op.create_table(
        "account_tokens",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.String(length=16), nullable=True),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True
        ),
        sa.Column(
            "application_id",
            UUID,
            sa.ForeignKey("technician_applications.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("token_hash", name=op.f("uq_account_tokens_token_hash")),
        sa.CheckConstraint(
            "(user_id IS NULL) <> (application_id IS NULL)",
            name=op.f("ck_account_tokens_one_target"),
        ),
    )
    op.create_index("ix_account_tokens_user_id", "account_tokens", ["user_id"])
    op.create_index("ix_account_tokens_application_id", "account_tokens", ["application_id"])

    op.create_table(
        "email_outbox",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("template", sa.String(length=32), nullable=False),
        sa.Column("to_email", sa.String(length=255), nullable=False),
        sa.Column(
            "user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True
        ),
        sa.Column(
            "application_id",
            UUID,
            sa.ForeignKey("technician_applications.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("context", JSONB, server_default="{}", nullable=False),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("send_by", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(length=500), nullable=True),
        sa.Column(
            "created_by_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_email_outbox_user_id", "email_outbox", ["user_id"])
    op.create_index("ix_email_outbox_application_id", "email_outbox", ["application_id"])
    op.create_index("ix_email_outbox_status_next", "email_outbox", ["status", "next_attempt_at"])

    for step in DATA_STEPS:
        step()

    op.drop_constraint(op.f("ck_users_pix_pair"), "users", type_="check")
    for name, _ in reversed(PIX_COLUMNS):
        op.drop_column("users", name)


def downgrade() -> None:
    for name, type_ in PIX_COLUMNS:
        op.add_column("users", sa.Column(name, type_, nullable=True))
    _restore_pix()
    op.create_check_constraint(
        op.f("ck_users_pix_pair"), "users", "(pix_key IS NULL) = (pix_key_type IS NULL)"
    )
    _join_addresses()
    _rename_access_texts(ACCESS_OFF, ACCESS_OFF_BEFORE)
    _old_via()
    _hide_payout_history()

    op.drop_index("ix_email_outbox_status_next", table_name="email_outbox")
    op.drop_index("ix_email_outbox_application_id", table_name="email_outbox")
    op.drop_index("ix_email_outbox_user_id", table_name="email_outbox")
    op.drop_table("email_outbox")
    op.drop_index("ix_account_tokens_application_id", table_name="account_tokens")
    op.drop_index("ix_account_tokens_user_id", table_name="account_tokens")
    op.drop_table("account_tokens")
    op.drop_index("uq_technician_payout_methods_bank", table_name="technician_payout_methods")
    op.drop_index("uq_technician_payout_methods_pix", table_name="technician_payout_methods")
    op.drop_index(
        "uq_technician_payout_methods_preferred", table_name="technician_payout_methods"
    )
    op.drop_index("ix_technician_payout_methods_user_id", table_name="technician_payout_methods")
    op.drop_table("technician_payout_methods")

    op.drop_column("user_changes", "note")

    op.drop_constraint(
        op.f("fk_technician_applications_reopened_by_id_users"),
        "technician_applications",
        type_="foreignkey",
    )
    op.drop_column("technician_applications", "reviews")
    for name, _ in reversed(APPLICATION_COLUMNS):
        op.drop_column("technician_applications", name)

    op.drop_constraint(
        op.f("fk_users_operational_changed_by_id_users"), "users", type_="foreignkey"
    )
    op.drop_constraint(op.f("uq_users_cpf"), "users", type_="unique")
    for name in ("unavailability", "operational_status", "service_areas"):
        op.drop_column("users", name)
    for name, _ in reversed(USER_COLUMNS):
        op.drop_column("users", name)
