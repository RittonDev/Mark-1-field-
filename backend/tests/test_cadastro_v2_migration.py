"""Migração do cadastro V2 (b7e2d4f6a8c1): a cadeia, as funções puras dos passos de dados e os
passos de verdade no banco de teste.

O banco de teste nasce dos modelos (sem as colunas pix_* de antes): o teste com banco as recria numa
transação, roda os passos com o driver do alembic e desfaz tudo no fim.
"""

import importlib.util
import json
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from tests.conftest import requires_db

BACKEND = Path(__file__).resolve().parents[1]
MIGRATION = BACKEND / "alembic" / "versions" / "20261125_b7e2d4f6a8c1_cadastro_v2_dos_tecnicos.py"
NOW = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)
CPF = "12345678909"
CNPJ = "12345678000195"


def _migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("cadastro_v2", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


M = _migration()


# ------------------------------------------------------------------ cadeia


def test_revision_follows_the_head() -> None:
    config = Config()
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    script = ScriptDirectory.from_config(config)
    assert script.get_heads() == ["b7e2d4f6a8c1"]
    revision = script.get_revision("b7e2d4f6a8c1")
    assert revision is not None and revision.down_revision == "f5a7c9e1b3d6"
    assert (M.revision, M.down_revision) == ("b7e2d4f6a8c1", "f5a7c9e1b3d6")


def test_copies_match_the_app() -> None:
    """As cópias da migração seguem o código (ela não importa app.*)."""
    from app.services.onboarding import EXPIRED_NOTE

    assert M.EXPIRED_NOTE == EXPIRED_NOTE
    assert (M.ACCESS_OFF_BEFORE, M.ACCESS_OFF) == ("Bloqueado", "Sem acesso")
    assert M.COMPLEMENT_MAX == 60


# ------------------------------------------------------------------ endereço


@pytest.mark.parametrize(
    ("line", "parts"),
    [
        ("Rua das Flores, 123 - Apto 4", ("Rua das Flores", "123", "Apto 4")),
        ("Av. Exemplo, 1000", ("Av. Exemplo", "1000", None)),
        ("Rua A, S/N - Fundos", ("Rua A", "S/N", "Fundos")),
        ("Rua B, nº 45, casa 2", ("Rua B", "45", "casa 2")),
        ("Al. Exemplo, 1000, 5º andar", ("Al. Exemplo", "1000", "5º andar")),
        ("Rua 25 de Março, 300", ("Rua 25 de Março", "300", None)),
        ("Rua Exemplo, sn", ("Rua Exemplo", "S/N", None)),
        ("Rua Exemplo, s / n", ("Rua Exemplo", "S/N", None)),
        ("Rua Exemplo, N° 12b – Bloco B", ("Rua Exemplo", "12B", "Bloco B")),
        ("  Rua   Exemplo ,  77  -  Casa   2 ", ("Rua Exemplo", "77", "Casa 2")),
        ("Rua Exemplo, 10 -", ("Rua Exemplo", "10", None)),
        # Complemento no limite (60) separa; com 61 a linha fica inteira (caso abaixo).
        ("Rua Exemplo, 10 - " + "x" * 60, ("Rua Exemplo", "10", "x" * 60)),
    ],
)
def test_address_line_split(line: str, parts: tuple[str, str, str | None]) -> None:
    assert M.split_address_line(line) == parts


@pytest.mark.parametrize(
    "line",
    [
        "Rodovia SP-55, km 12",
        "Rua Exemplo 123",
        "Av. Brasil, 100 apto 3",
        "Rua Sem Saída, snack bar",
        "R, 12",
        "Rua Exemplo, 10 - " + "x" * 61,
        "",
        "   ",
        None,
    ],
)
def test_address_line_stays_whole(line: str | None) -> None:
    assert M.split_address_line(line) is None


# ------------------------------------------------------------------ PIX


def _pix_row(**fields: Any) -> dict[str, Any]:
    row = {
        "id": uuid.uuid4(),
        "name": "Tecnico Alfa",
        "pix_key_type": "cpf",
        "pix_key": CPF,
        "pix_holder_name": None,
        "pix_updated_at": datetime(2026, 11, 20, 9, 0, tzinfo=UTC),
    }
    row.update(fields)
    return row


def test_pix_becomes_the_preferred_method() -> None:
    row = _pix_row()
    method = M._pix_method_row(row, NOW)
    at = row["pix_updated_at"]
    assert isinstance(method.pop("id"), uuid.UUID)
    assert method == {
        "user_id": row["id"],
        "kind": "pix",
        "pix_key_type": "cpf",
        "pix_key": CPF,
        "holder_name": "Tecnico Alfa",
        "holder_document": CPF,
        "preferred": True,
        "preferred_since": at,
        "changed_at": at,
        "created_at": at,
        "updated_at": at,
    }


def test_pix_holder_and_document_by_key_type() -> None:
    cnpj = M._pix_method_row(_pix_row(pix_key_type="cnpj", pix_key=CNPJ), NOW)
    assert cnpj["holder_document"] == CNPJ
    email = M._pix_method_row(
        _pix_row(
            pix_key_type="email",
            pix_key="alfa@exemplo.com",
            pix_holder_name="  Empresa   Exemplo ",
            pix_updated_at=None,
        ),
        NOW,
    )
    assert email["holder_document"] is None
    assert email["holder_name"] == "Empresa Exemplo"
    assert email["preferred_since"] == email["changed_at"] == email["created_at"] == NOW


# ------------------------------------------------------------------ fichas e análises


def _empty_user(**fields: Any) -> dict[str, Any]:
    user = {"cpf": None, "birth_date": None, "company_document": None, "service_areas": "[]"}
    user.update(fields)
    return user


def _ficha(**fields: Any) -> dict[str, Any]:
    ficha = {
        "document": CPF,
        "birth_date": date(1990, 11, 25),
        "company_document": CNPJ,
        "service_areas": json.dumps(["redes", "cftv", "redes"]),
    }
    ficha.update(fields)
    return ficha


def test_ficha_fills_only_what_is_empty() -> None:
    used: set[str] = set()
    assert M._ficha_fill(_ficha(), _empty_user(), used) == {
        "cpf": CPF,
        "birth_date": date(1990, 11, 25),
        "company_document": CNPJ,
        "service_areas": ["redes", "cftv"],
    }
    filled = _empty_user(
        cpf="98765432100",
        birth_date=date(1980, 1, 1),
        company_document="11222333000181",
        service_areas=json.dumps(["energia"]),
    )
    assert M._ficha_fill(_ficha(), filled, used) == {}


def test_ficha_cpf_of_someone_else_and_bad_values_stay_out() -> None:
    assert "cpf" not in M._ficha_fill(_ficha(), _empty_user(), {CPF})
    odd = _ficha(document="123", company_document="123", service_areas="null", birth_date=None)
    assert M._ficha_fill(odd, _empty_user(), set()) == {}


def test_first_review_entries() -> None:
    at = datetime(2026, 11, 20, 9, 0, tzinfo=UTC)
    by = uuid.uuid4()
    assert M._review_entry("approved", at, by, "Analista Exemplo", None) == {
        "action": "approved",
        "at": "2026-11-20T09:00:00+00:00",
        "by": {"id": str(by), "name": "Analista Exemplo"},
        "note": None,
    }
    rejected = M._review_entry("rejected", at, by, "Analista Exemplo", "Sem experiência")
    assert rejected["action"] == "rejected" and rejected["note"] == "Sem experiência"
    expired = M._review_entry("rejected", at, None, None, "Expirada sem análise")
    assert expired == {
        "action": "expired",
        "at": "2026-11-20T09:00:00+00:00",
        "by": None,
        "note": "Expirada sem análise",
    }
    # Quem escreveu a mesma nota numa reprovação de verdade continua "rejected".
    assert M._review_entry("rejected", at, by, "Analista", "Expirada sem análise")["action"] == (
        "rejected"
    )
    assert M._review_entry("pending", at, None, None, None) is None
    # Sem fuso: UTC.
    naive = M._review_entry("approved", datetime(2026, 11, 20, 9, 0), None, None, None)
    assert naive["at"] == "2026-11-20T09:00:00+00:00"


def test_access_texts_are_renamed_both_ways() -> None:
    before = [
        {"field": "is_active", "from": "Liberado", "to": "Bloqueado"},
        {"field": "name", "from": "Bloqueado", "to": "Tecnico Alfa"},
        {"field": "is_active", "from": "Bloqueado", "to": "Liberado"},
    ]
    after = M._rename_access(before, "Bloqueado", "Sem acesso")
    assert after == [
        {"field": "is_active", "from": "Liberado", "to": "Sem acesso"},
        {"field": "name", "from": "Bloqueado", "to": "Tecnico Alfa"},
        {"field": "is_active", "from": "Sem acesso", "to": "Liberado"},
    ]
    assert before[0]["to"] == "Bloqueado"  # a lista de entrada não muda
    assert M._rename_access(after, "Sem acesso", "Bloqueado") == before


# ------------------------------------------------------------------ no banco


def _run(sync_conn: Any, steps: list[Any], out: list[Any]) -> None:
    with Operations.context(MigrationContext.configure(sync_conn)):
        out.extend(step() for step in steps)


async def _on_driver(conn: AsyncConnection, *steps: Any) -> list[Any]:
    out: list[Any] = []
    await conn.run_sync(_run, list(steps), out)
    return out


async def _user(conn: AsyncConnection, name: str, **fields: Any) -> uuid.UUID:
    user_id = uuid.uuid4()
    values = {
        "id": user_id,
        "name": name,
        "email": f"{name.lower().replace(' ', '.')}@exemplo.com",
        "password_hash": "x",
        "role": "technician",
        **fields,
    }
    columns = ", ".join(values)
    params = ", ".join(f":{key}" for key in values)
    await conn.execute(text(f"INSERT INTO users ({columns}) VALUES ({params})"), values)
    return user_id


async def _application(conn: AsyncConnection, **fields: Any) -> uuid.UUID:
    application_id = uuid.uuid4()
    values = {
        "id": application_id,
        "status": "approved",
        "full_name": "Tecnico Alfa",
        "email": f"ficha-{application_id.hex[:6]}@exemplo.com",
        "phone": "(11) 99999-0000",
        "document": CPF,
        "city": "Cidade Exemplo",
        "state": "SP",
        "service_areas": "[]",
        "skills": "[]",
        "has_vehicle": False,
        "has_driver_license": False,
        "coverage_area": "Cidade Exemplo",
        "availability": "[]",
        "privacy_consent_at": NOW,
        "privacy_version": "2026-11-20",
        **fields,
    }
    jsonb = {"service_areas", "skills", "availability"}
    columns = ", ".join(values)
    params = ", ".join(f"CAST(:{key} AS jsonb)" if key in jsonb else f":{key}" for key in values)
    await conn.execute(
        text(f"INSERT INTO technician_applications ({columns}) VALUES ({params})"), values
    )
    return application_id


async def _row(conn: AsyncConnection, sql: str, **params: Any) -> dict[str, Any]:
    return dict((await conn.execute(text(sql), params)).mappings().one())


@requires_db
async def test_data_steps_run_on_the_driver(engine: AsyncEngine) -> None:
    """Os passos de dados de verdade (asyncpg, como o alembic roda), com as colunas pix_* de antes
    recriadas numa transação desfeita no fim: endereços, PIX, fichas, análises e o histórico; rodar
    de novo não muda nada; e os passos do downgrade voltam o PIX, o endereço, o texto do acesso e o
    "por onde"."""
    async with engine.connect() as conn:
        transaction = await conn.begin()
        try:
            await conn.execute(
                text(
                    "ALTER TABLE users ADD COLUMN pix_key_type VARCHAR(32),"
                    " ADD COLUMN pix_key VARCHAR(80), ADD COLUMN pix_holder_name VARCHAR(160),"
                    " ADD COLUMN pix_updated_at TIMESTAMPTZ"
                )
            )
            pix_at = datetime(2026, 11, 20, 9, 0, tzinfo=UTC)
            reviewer = await _user(conn, "Analista Exemplo", role="analyst")
            alfa = await _user(
                conn,
                "Tecnico Alfa",
                address_line="Rua das Flores, 123 - Apto 4",
                pix_key_type="cpf",
                pix_key=CPF,
                pix_updated_at=pix_at,
            )
            beta = await _user(
                conn,
                "Tecnico Beta",
                address_line="Rodovia SP-55, km 12",
                pix_key_type="email",
                pix_key="beta@exemplo.com",
                pix_holder_name="Empresa Exemplo",
            )
            gama = await _user(conn, "Tecnico Gama", address_line="Av. Exemplo, 1000")
            # Mesmo CPF na ficha de outro técnico (duplicado): só a ficha mais antiga leva o CPF.
            delta = await _user(conn, "Tecnico Delta")
            approved = await _application(
                conn,
                user_id=alfa,
                birth_date=date(1990, 11, 25),
                company_document=CNPJ,
                service_areas=json.dumps(["redes", "cftv"]),
                reviewed_at=pix_at,
                reviewed_by_id=reviewer,
            )
            await _application(
                conn,
                user_id=delta,
                reviewed_at=pix_at + timedelta(days=1),
                reviewed_by_id=reviewer,
            )
            rejected = await _application(
                conn,
                status="rejected",
                document="98765432100",
                reviewed_at=pix_at,
                reviewed_by_id=reviewer,
                review_note="Sem experiência",
            )
            expired = await _application(
                conn,
                status="rejected",
                document="11144477735",
                reviewed_at=pix_at,
                review_note="Expirada sem análise",
            )
            pending = await _application(conn, status="pending", document="52998224725")
            change = uuid.uuid4()
            await conn.execute(
                text(
                    "INSERT INTO user_changes (id, user_id, via, changes)"
                    " VALUES (:id, :user_id, 'central', CAST(:changes AS jsonb))"
                ),
                {
                    "id": change,
                    "user_id": gama,
                    "changes": json.dumps(
                        [
                            {"field": "is_active", "from": "Liberado", "to": "Bloqueado"},
                            {"field": "name", "from": "Bloqueado", "to": "Tecnico Gama"},
                        ]
                    ),
                },
            )
            ficha_change, link_change = uuid.uuid4(), uuid.uuid4()
            for row_id, via in ((ficha_change, "ficha"), (link_change, "link")):
                await conn.execute(
                    text(
                        "INSERT INTO user_changes (id, user_id, via, changes)"
                        " VALUES (:id, :user_id, :via, '[]'::jsonb)"
                    ),
                    {"id": row_id, "user_id": alfa, "via": via},
                )

            counts = await _on_driver(conn, *M.DATA_STEPS)
            # Endereços de alfa e gama; os 2 PIX; a ficha de alfa (a de delta não traz nada: o CPF
            # já é de alfa); 4 fichas analisadas; 1 linha do histórico.
            assert counts == [2, 2, 1, 4, 1]

            alfa_row = await _row(
                conn,
                "SELECT address_line, address_number, address_complement, cpf, birth_date,"
                " company_document, service_areas::text AS areas, operational_status,"
                " unavailability::text AS unavailability FROM users WHERE id = :id",
                id=alfa,
            )
            assert json.loads(alfa_row.pop("areas")) == ["redes", "cftv"]
            assert json.loads(alfa_row.pop("unavailability")) == []
            assert alfa_row == {
                "address_line": "Rua das Flores",
                "address_number": "123",
                "address_complement": "Apto 4",
                "cpf": CPF,
                "birth_date": date(1990, 11, 25),
                "company_document": CNPJ,
                "operational_status": "active",
            }
            beta_row = await _row(
                conn,
                "SELECT address_line, address_number FROM users WHERE id = :id",
                id=beta,
            )
            assert beta_row == {"address_line": "Rodovia SP-55, km 12", "address_number": None}
            gama_row = await _row(
                conn,
                "SELECT address_line, address_number, address_complement FROM users WHERE id = :id",
                id=gama,
            )
            assert gama_row == {
                "address_line": "Av. Exemplo",
                "address_number": "1000",
                "address_complement": None,
            }
            delta_row = await _row(conn, "SELECT cpf FROM users WHERE id = :id", id=delta)
            assert delta_row == {"cpf": None}

            result = await conn.execute(
                text(
                    "SELECT user_id, kind, pix_key_type, pix_key, holder_name, holder_document,"
                    " preferred, preferred_since, changed_at FROM technician_payout_methods"
                )
            )
            methods = {row["user_id"]: dict(row) for row in result.mappings()}
            assert set(methods) == {alfa, beta}
            assert methods[alfa] == {
                "user_id": alfa,
                "kind": "pix",
                "pix_key_type": "cpf",
                "pix_key": CPF,
                "holder_name": "Tecnico Alfa",
                "holder_document": CPF,
                "preferred": True,
                "preferred_since": pix_at,
                "changed_at": pix_at,
            }
            beta_method = methods[beta]
            assert (beta_method["pix_key_type"], beta_method["holder_name"]) == (
                "email",
                "Empresa Exemplo",
            )
            assert beta_method["holder_document"] is None and beta_method["preferred"] is True
            assert beta_method["preferred_since"] == beta_method["changed_at"] is not None

            reviews = {
                row["id"]: json.loads(row["reviews"])
                for row in (
                    await conn.execute(
                        text("SELECT id, reviews::text AS reviews FROM technician_applications")
                    )
                ).mappings()
            }
            by = {"id": str(reviewer), "name": "Analista Exemplo"}
            assert reviews[approved] == [
                {"action": "approved", "at": pix_at.isoformat(), "by": by, "note": None}
            ]
            assert reviews[rejected] == [
                {
                    "action": "rejected",
                    "at": pix_at.isoformat(),
                    "by": by,
                    "note": "Sem experiência",
                }
            ]
            assert reviews[expired][0]["action"] == "expired" and reviews[expired][0]["by"] is None
            assert reviews[pending] == []

            history = await _row(
                conn, "SELECT changes::text AS changes FROM user_changes WHERE id = :id", id=change
            )
            assert json.loads(history["changes"]) == [
                {"field": "is_active", "from": "Liberado", "to": "Sem acesso"},
                {"field": "name", "from": "Bloqueado", "to": "Tecnico Gama"},
            ]

            # Rodar de novo não muda nada.
            assert await _on_driver(conn, *M.DATA_STEPS) == [0, 0, 0, 0, 0]

            # Downgrade: o PIX volta das formas (com as colunas zeradas antes), o endereço é
            # juntado de novo, o acesso volta a "Bloqueado" e "ficha"/"link" a "central"/"app".
            await conn.execute(
                text(
                    "UPDATE users SET pix_key_type = NULL, pix_key = NULL,"
                    " pix_holder_name = NULL, pix_updated_at = NULL"
                )
            )
            await _on_driver(
                conn,
                M._restore_pix,
                M._join_addresses,
                lambda: M._rename_access_texts(M.ACCESS_OFF, M.ACCESS_OFF_BEFORE),
                M._old_via,
            )
            restored = await _row(
                conn,
                "SELECT pix_key_type, pix_key, pix_holder_name, pix_updated_at, address_line"
                " FROM users WHERE id = :id",
                id=alfa,
            )
            assert restored == {
                "pix_key_type": "cpf",
                "pix_key": CPF,
                "pix_holder_name": "Tecnico Alfa",
                "pix_updated_at": pix_at,
                "address_line": "Rua das Flores, 123 - Apto 4",
            }
            gama_back = await _row(conn, "SELECT address_line FROM users WHERE id = :id", id=gama)
            assert gama_back == {"address_line": "Av. Exemplo, 1000"}
            history = await _row(
                conn, "SELECT changes::text AS changes FROM user_changes WHERE id = :id", id=change
            )
            assert json.loads(history["changes"])[0]["to"] == "Bloqueado"
            vias = {
                row["id"]: row["via"]
                for row in (await conn.execute(text("SELECT id, via FROM user_changes"))).mappings()
            }
            assert (vias[ficha_change], vias[link_change]) == ("central", "app")
        finally:
            await transaction.rollback()
