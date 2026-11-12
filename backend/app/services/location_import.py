"""Importação da base de locais de atendimento (filiais, lojas, unidades) por planilha.

Cada linha é um local de um cliente. O cliente vem do parâmetro (importar só para ele) ou
das colunas da planilha (CNPJ do cliente ou nome; se não existir, é criado). O local é
encontrado no cliente pelo código, depois pelo CNPJ, depois pelo nome: achou, atualiza só o
que veio preenchido; não achou, cria. Na prévia (dry_run) nada é gravado.
"""

import uuid
from typing import Any, Literal

from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.documents import normalize_document
from app.models import Customer, Location
from app.schemas.customer import LocationCreate
from app.services.errors import NotFound
from app.services.spreadsheet import read_table

ALIASES = {
    "cliente": "customer_name",
    "nome_cliente": "customer_name",
    "razao_social": "customer_name",
    "cnpj_cliente": "customer_document",
    "documento_cliente": "customer_document",
    "local": "name",
    "nome": "name",
    "nome_do_local": "name",
    "filial": "name",
    "unidade": "name",
    "codigo": "code",
    "cod": "code",
    "codigo_filial": "code",
    "cnpj": "document",
    "cnpj_local": "document",
    "documento": "document",
    "endereco": "address_line",
    "logradouro": "address_line",
    "bairro": "district",
    "cidade": "city",
    "municipio": "city",
    "uf": "state",
    "estado": "state",
    "cep": "zip_code",
    "lat": "latitude",
    "lng": "longitude",
    "lon": "longitude",
    "contato": "contact_name",
    "responsavel": "contact_name",
    "telefone": "contact_phone",
    "telefone_contato": "contact_phone",
    "observacoes": "notes",
    "obs": "notes",
}

LOCATION_FIELDS = (
    "name",
    "code",
    "document",
    "address_line",
    "district",
    "city",
    "state",
    "zip_code",
    "latitude",
    "longitude",
    "contact_name",
    "contact_phone",
    "notes",
)


class LocationImportRow(BaseModel):
    line: int
    customer: str
    name: str
    city: str | None
    action: Literal["create", "update", "error"]
    new_customer: bool = False
    errors: list[str] = []


class LocationImportResult(BaseModel):
    dry_run: bool
    rows: list[LocationImportRow]
    created: int = 0
    updated: int = 0
    errors: int = 0
    customers_created: int = 0


def _number(value: str) -> float | None:
    """Coordenada com vírgula decimal (Excel brasileiro) ou ponto."""
    value = value.strip().replace(" ", "")
    if not value:
        return None
    if value.count(",") == 1 and "." not in value:
        value = value.replace(",", ".")
    return float(value)


def _fields(row: dict[str, str]) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for key in LOCATION_FIELDS:
        value = (row.get(key) or "").strip()
        if not value:
            continue
        if key in ("latitude", "longitude"):
            data[key] = _number(value)
        elif key == "state":
            data[key] = value.upper()
        else:
            data[key] = " ".join(value.split()) if key == "name" else value
    return data


def _messages(exc: ValidationError) -> list[str]:
    labels = {"name": "Nome do local", "document": "CNPJ", "state": "UF", "latitude": "Latitude"}
    out = []
    for err in exc.errors():
        field = str(err["loc"][-1]) if err.get("loc") else ""
        msg = err.get("msg", "inválido").replace("Value error, ", "")
        out.append(f"{labels.get(field, field)}: {msg}" if field else msg)
    return out


async def import_locations(
    db: AsyncSession,
    filename: str,
    data: bytes,
    dry_run: bool,
    customer_id: uuid.UUID | None = None,
) -> LocationImportResult:
    rows = read_table(filename, data, ALIASES)
    fixed_customer = None
    if customer_id is not None:
        fixed_customer = await db.get(Customer, customer_id)
        if fixed_customer is None:
            raise NotFound("Cliente não encontrado")

    customers = list(await db.scalars(select(Customer)))
    by_doc = {c.document: c for c in customers if c.document}
    by_name = {c.name.strip().lower(): c for c in customers}
    new_customers: dict[str, Customer] = {}  # chave: documento ou nome em minúsculas
    seen: set[tuple[str, str]] = set()
    result = LocationImportResult(dry_run=dry_run, rows=[])

    for index, row in enumerate(rows, start=2):
        errors: list[str] = []
        customer: Customer | None = fixed_customer
        new_customer = False
        customer_label = fixed_customer.name if fixed_customer else ""

        if customer is None:
            name = " ".join((row.get("customer_name") or "").split())
            raw_doc = (row.get("customer_document") or "").strip()
            doc = None
            if raw_doc:
                try:
                    doc = normalize_document(raw_doc)
                except ValueError:
                    errors.append("CNPJ do cliente inválido")
            customer_label = name or raw_doc
            keys = [k for k in (doc, name.lower()) if k]
            customer = (by_doc.get(doc) if doc else None) or (
                by_name.get(name.lower()) if name else None
            )
            if customer is None:
                # Cliente novo criado numa linha anterior desta mesma planilha.
                customer = next((new_customers[k] for k in keys if k in new_customers), None)
                new_customer = customer is not None
            if customer is None and not errors:
                if len(name) < 2:
                    errors.append("Informe o cliente (nome ou CNPJ cadastrado)")
                else:
                    customer = Customer(id=uuid.uuid4(), name=name, document=doc, is_active=True)
                    new_customer = True
                    for k in keys:
                        new_customers[k] = customer
            if customer is not None:
                customer_label = customer.name

        fields: dict[str, Any] = {}
        try:
            fields = LocationCreate.model_validate(_fields(row)).model_dump(exclude_unset=True)
        except ValidationError as exc:
            errors.extend(_messages(exc))
        except ValueError:
            errors.append("Latitude/longitude inválida")

        existing: Location | None = None
        if customer is not None and not errors and not new_customer:
            stmt = select(Location).where(Location.customer_id == customer.id)
            if fields.get("code"):
                existing = await db.scalar(stmt.where(Location.code == fields["code"]))
            if existing is None and fields.get("document"):
                existing = await db.scalar(stmt.where(Location.document == fields["document"]))
            if existing is None and fields.get("name"):
                existing = await db.scalar(
                    stmt.where(func.lower(Location.name) == fields["name"].lower())
                )
        if customer is not None and not errors:
            dedupe = (
                str(customer.id),
                (fields.get("code") or fields.get("document") or fields.get("name", "")).lower(),
            )
            if dedupe in seen:
                errors.append("Local repetido na planilha")
            seen.add(dedupe)

        action: Literal["create", "update", "error"] = (
            "error" if errors else ("update" if existing else "create")
        )
        result.rows.append(
            LocationImportRow(
                line=index,
                customer=customer_label,
                name=str(fields.get("name") or row.get("name") or ""),
                city=fields.get("city") or row.get("city") or None,
                action=action,
                new_customer=new_customer and action != "error",
                errors=errors,
            )
        )
        if action == "error":
            result.errors += 1
            continue
        if action == "update":
            result.updated += 1
        else:
            result.created += 1
        if dry_run:
            continue
        assert customer is not None
        if new_customer:
            db.add(customer)  # só entra no banco se ao menos um local dele foi aceito
        if existing is not None:
            for key, value in fields.items():
                setattr(existing, key, value)
        else:
            db.add(Location(id=uuid.uuid4(), customer_id=customer.id, is_active=True, **fields))

    result.customers_created = len(
        {r.customer for r in result.rows if r.new_customer and r.action != "error"}
    )
    if not dry_run:
        await db.flush()
    return result
