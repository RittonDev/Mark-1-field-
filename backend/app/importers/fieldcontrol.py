"""Migração do export do Field Control (API GraphQL, um JSON por entidade) para o Maxx Field.

Uso (dentro do container da API; a pasta do export NUNCA vai para o repositório):

    python -m app.importers.fieldcontrol /tmp/fc_export --dry-run
    python -m app.importers.fieldcontrol /tmp/fc_export --wipe-demo --report /tmp/fc_report.json

- `--dry-run`: faz tudo numa transação e desfaz no fim (conta o que seria importado).
- `--wipe-demo`: antes de importar, apaga os dados de demonstração (OS, clientes, locais,
  catálogos, formulários, usuários que não são admin...). Mantém equipes, categorias e
  configurações.
- `--stale-days`: OS em aberto sem atividade há mais que isso entram canceladas, com nota.

A importação é idempotente: cada registro de origem fica em `legacy_refs`; rodar de novo
atualiza os cadastros (clientes, locais, usuários, catálogos) e não duplica OS, orçamentos,
formulários nem comentários. Os arquivos (fotos, assinaturas) continuam no armazenamento do
Field Control: os anexos guardam o link (`external_url`).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import mimetypes
import re
import time
import unicodedata
import uuid
from collections import Counter, defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import ValidationError
from sqlalchemy import func, insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.enums import (
    AuthorizationStatus,
    FormStatus,
    QuoteStatus,
    Responsibility,
    TicketEventType,
    TicketSource,
    TicketStatus,
    TicketType,
    UserRole,
    ViolationScope,
)
from app.models import (
    Customer,
    FormTemplate,
    LegacyRef,
    Location,
    Quote,
    QuoteItemCatalog,
    ServiceType,
    Ticket,
    TicketAttachment,
    TicketComment,
    TicketEvent,
    TicketForm,
    TicketWorklog,
    User,
    ViolationReason,
)
from app.schemas.forms import FormField
from app.schemas.records import dedupe_contacts, primary_contact
from app.services import cities, geo, technician_regions

log = logging.getLogger("fieldcontrol")

SOURCE = "fieldcontrol"
# Hash inválido de propósito: ninguém entra com senha até a equipe redefinir (ou usar a Microsoft).
UNUSABLE_PASSWORD = "!importado-do-field-control"
FC_FILES_BASE = "https://s3.amazonaws.com/attachments.fieldcontrol.com.br/"
LOCAL_TZ = ZoneInfo(settings.TIMEZONE)
ONSITE_HOURS = 4
ONSITE_WARNING_MINUTES = 30
BATCH = 400
# Coordenada repetida por mais que isto de colaboradores = endereço padrão (o do escritório),
# não o endereço real do técnico: vira "sem endereço".
PLACEHOLDER_HOME_SHARE = 20

UF_BY_NAME = {
    "acre": "AC",
    "alagoas": "AL",
    "amapa": "AP",
    "amazonas": "AM",
    "bahia": "BA",
    "ceara": "CE",
    "distrito federal": "DF",
    "espirito santo": "ES",
    "goias": "GO",
    "maranhao": "MA",
    "mato grosso": "MT",
    "mato grosso do sul": "MS",
    "minas gerais": "MG",
    "para": "PA",
    "paraiba": "PB",
    "parana": "PR",
    "pernambuco": "PE",
    "piaui": "PI",
    "rio de janeiro": "RJ",
    "rio grande do norte": "RN",
    "rio grande do sul": "RS",
    "rondonia": "RO",
    "roraima": "RR",
    "santa catarina": "SC",
    "sao paulo": "SP",
    "sergipe": "SE",
    "tocantins": "TO",
}
UFS = frozenset(UF_BY_NAME.values())
UNIT = {"unity": "un", "meter": "m", "centimeter": "cm", "kilogram": "kg", "liter": "l"}
LOCATION_CODE = re.compile(r"^\s*([A-Za-z0-9]{1,10})\s*-\s+(.+)$")
URL = re.compile(r"https?://[^\s,;\"'\]\[<>]+")
PHOTO_TYPES = {"picture", "multiple-picture", "signature"}
QUOTE_STATUS = {
    "approved": QuoteStatus.APPROVED,
    "refused": QuoteStatus.REJECTED,
    "expired": QuoteStatus.EXPIRED,
    "canceled": QuoteStatus.CANCELLED,
    "pending": QuoteStatus.SENT,
}
OPEN_AFTER_IMPORT = {
    TicketStatus.NEW,
    TicketStatus.ASSIGNED,
    TicketStatus.SCHEDULED,
    TicketStatus.EN_ROUTE,
    TicketStatus.IN_PROGRESS,
}


# ------------------------------------------------------------------------------------ leitura


def iter_records(path: Path) -> Iterator[dict[str, Any]]:
    """Registros de um array JSON do export, um por vez (sem carregar o arquivo inteiro).

    O export vem indentado com 1 espaço: cada registro começa numa linha " {" e termina em
    " }," ou " }". Arquivos em outro formato (pequenos) são lidos inteiros.
    """
    if not path.exists():
        return
    found = False
    buf: list[str] = []
    inside = False
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if not inside:
                if line.rstrip("\n") == " {":
                    inside = True
                    buf = ["{"]
                continue
            stripped = line.rstrip("\n")
            if stripped in (" },", " }"):
                buf.append("}")
                found = True
                yield json.loads("\n".join(buf))
                inside = False
                continue
            buf.append(line)
    if not found and path.stat().st_size < 50_000_000:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, list):
            yield from (r for r in data if isinstance(r, dict))


# ---------------------------------------------------------------------------- normalização


def plain(value: str | None) -> str:
    text_ = unicodedata.normalize("NFD", value or "")
    text_ = "".join(c for c in text_ if unicodedata.category(c) != "Mn")
    return " ".join(text_.lower().split())


def to_uf(state: str | None) -> str | None:
    raw = (state or "").strip()
    if len(raw) == 2 and raw.upper() in UFS:
        return raw.upper()
    return UF_BY_NAME.get(plain(raw))


def digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def clip(value: Any, size: int) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s[:size] if s else None


def fmt_zip(value: Any) -> str | None:
    d = digits(value)
    if len(d) == 8:
        return f"{d[:5]}-{d[5:]}"
    return d[:10] or None


def fmt_phone(country: Any, number: Any) -> str | None:
    d = digits(number)
    if not d:
        return None
    if d.startswith("55") and len(d) in (12, 13):
        d = d[2:]
    if len(d) == 11:
        return f"({d[:2]}) {d[2:7]}-{d[7:]}"
    if len(d) == 10:
        return f"({d[:2]}) {d[2:6]}-{d[6:]}"
    cc = digits(country)
    return clip(f"+{cc} {d}" if cc and cc != "55" else d, 40)


def parse_ts(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def local_datetime(day: Any, hour: Any) -> datetime | None:
    """Data e hora do agendamento (horário de Brasília) em UTC."""
    if not day or not isinstance(day, str) or not re.match(r"^\d{4}-\d{2}-\d{2}$", day):
        return None
    hh = hour if isinstance(hour, str) and re.match(r"^\d{2}:\d{2}", hour) else "08:00:00"
    try:
        naive = datetime.fromisoformat(f"{day}T{hh[:8] if len(hh) >= 8 else hh[:5]}")
    except ValueError:
        return None
    return naive.replace(tzinfo=LOCAL_TZ).astimezone(UTC)


def money(value: Any) -> Decimal:
    try:
        return Decimal(str(value).replace(",", ".")).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return Decimal("0.00")


def split_location_code(name: str) -> tuple[str | None, str]:
    """ "43 - Barra Salvador" vira código "43" e nome "Barra Salvador" (só com dígito no código)."""
    match = LOCATION_CODE.match(name or "")
    if match and any(c.isdigit() for c in match.group(1)):
        return match.group(1), match.group(2).strip()
    return None, (name or "").strip()


def _coords(address: dict[str, Any]) -> tuple[float, float] | None:
    c = address.get("coords") or {}
    try:
        lat, lon = float(c.get("latitude")), float(c.get("longitude"))
    except (TypeError, ValueError):
        return None
    if lat == 0 and lon == 0:
        return None
    return round(lat, 5), round(lon, 5)


def placeholder_homes(path: Path) -> set[tuple[float, float]]:
    """Coordenadas compartilhadas por muitos colaboradores: o endereço padrão, não o real."""
    counts: Counter[tuple[float, float]] = Counter()
    for e in iter_records(path):
        point = _coords(e.get("address") or {})
        if point is not None:
            counts[point] += 1
    return {point for point, n in counts.items() if n > PLACEHOLDER_HOME_SHARE}


def home_of(address: dict[str, Any], placeholders: set[tuple[float, float]]) -> dict[str, Any]:
    """Cidade, UF e coordenadas do endereço do técnico (vazio quando é o endereço padrão)."""
    point = _coords(address)
    if point is not None and point in placeholders:
        return {
            "city": None,
            "state": None,
            "latitude": None,
            "longitude": None,
            "placeholder": True,
        }
    return {
        "city": clip(address.get("city"), 120),
        "state": to_uf(address.get("state")),
        "latitude": point[0] if point else None,
        "longitude": point[1] if point else None,
        "placeholder": False,
    }


def _location_point(loc: dict[str, Any]) -> tuple[Any, Any, str | None]:
    address = loc.get("address") or {}
    coords = address.get("coords") or {}
    return coords.get("latitude"), coords.get("longitude"), to_uf(address.get("state"))


def contacts_of(raw: Any) -> list[dict[str, Any]]:
    """Todos os contatos do Field Control: [{kind, value, name, label, primary}], sem repetidos.

    Telefone fica só com dígitos, com o DDI na frente ("5511999998888"); e-mail em minúsculas.
    """
    out: list[dict[str, Any]] = []
    raw = raw or {}
    for item in raw.get("emails") or []:
        value = (item.get("address") or "").strip().lower()
        if not value:
            continue
        out.append(
            {
                "kind": "email",
                "value": value[:255],
                "name": clip(item.get("name"), 160),
                "label": clip(item.get("type"), 20),
                "primary": bool(item.get("primary")),
            }
        )
    for item in raw.get("phones") or []:
        number = digits(item.get("number"))
        if not number:
            continue
        country = digits(item.get("countryCode")) or "55"
        value = number if number.startswith(country) and len(number) > 11 else country + number
        out.append(
            {
                "kind": "phone",
                "value": value[:40],
                "name": clip(item.get("name"), 160),
                "label": clip(item.get("type"), 20),
                "primary": bool(item.get("primary")),
            }
        )
    return dedupe_contacts(out)


def address_parts(address: dict[str, Any]) -> dict[str, Any]:
    """Endereço do Field Control nos nossos campos (rua, número - complemento; bairro; CEP)."""
    street = ", ".join(p for p in (address.get("street"), address.get("number")) if p)
    line = " - ".join(p for p in (street, address.get("complement")) if p)
    return {
        "line": clip(line, 255),
        "district": clip(address.get("neighborhood"), 120),
        "city": clip(address.get("city"), 120),
        "state": to_uf(address.get("state")),
        "zip": fmt_zip(address.get("zipCode") or address.get("postalCode")),
    }


def territories_of(record: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for item in [*(record.get("territories") or []), *(record.get("subTerritories") or [])]:
        name = clip((item or {}).get("name") if isinstance(item, dict) else item, 120)
        if name and name not in names:
            names.append(name)
    return names


def customer_legacy(c: dict[str, Any]) -> dict[str, Any]:
    stats = c.get("statistics") or {}
    rating = stats.get("rating") or {}
    service = stats.get("service") or {}
    attachments = []
    for item in c.get("attachments") or []:
        if not item or item.get("archived"):
            continue
        url = absolute_file(item.get("path"))
        if url:
            attachments.append({"url": url, "title": item.get("title"), "type": item.get("type")})
    return {
        "source": SOURCE,
        "id": c.get("id"),
        "created_at": c.get("createdAt"),
        "rating": {
            "average": rating.get("averageStars") or 0,
            "last_star": rating.get("lastStar") or 0,
            "last_comment": rating.get("lastComment"),
        }
        if rating
        else None,
        "service": {
            "first_at": service.get("firstAt"),
            "last_at": service.get("lastAt"),
            "total": service.get("total") or 0,
        }
        if service
        else None,
        "attachments": attachments,
    }


def work_schedule_of(raw: Any) -> dict[str, Any] | None:
    raw = raw or {}
    pause = raw.get("break") or {}
    schedule = {
        "start": raw.get("start"),
        "end": raw.get("end"),
        "break_start": pause.get("start"),
        "break_end": pause.get("end"),
    }
    return schedule if any(schedule.values()) else None


def tags_of(labels: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for label in labels or []:
        name = clip((label or {}).get("name"), 60)
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append({"name": name, "color": (label or {}).get("color")})
    return out


def ticket_type_for(service_name: str) -> TicketType:
    p = plain(service_name)
    if "preventiv" in p:
        return TicketType.PREVENTIVE
    if any(k in p for k in ("instalac", "inaugurac", "implantac", "ativacao")):
        return TicketType.INSTALLATION
    return TicketType.INCIDENT


def file_meta(url: str, title: str | None = None, ctype: str | None = None) -> tuple[str, str]:
    name = title or url.split("?")[0].rstrip("/").split("/")[-1] or "arquivo"
    guessed = ctype or mimetypes.guess_type(name)[0] or "image/jpeg"
    return name[:255], guessed[:120]


def absolute_file(path: Any) -> str | None:
    if not path or not isinstance(path, str):
        return None
    if path.startswith(("http://", "https://")):
        return path[:1000]
    return (FC_FILES_BASE + path.lstrip("/"))[:1000]


# --------------------------------------------------------------------------------- formulários


def _field_id(raw: Any, used: set[str], position: int) -> str:
    base = re.sub(r"[^A-Za-z0-9_-]", "", str(raw or ""))[:36] or f"q{position}"
    candidate = base
    n = 2
    while candidate in used:
        candidate = f"{base[:34]}_{n}"
        n += 1
    used.add(candidate)
    return candidate


def question_to_field(q: dict[str, Any], used: set[str], position: int) -> dict[str, Any]:
    """Pergunta do Field Control -> campo de formulário válido (cai para texto se não couber)."""
    fid = _field_id(q.get("id"), used, position)
    label = clip(q.get("title"), 200) or f"Pergunta {position + 1}"
    help_ = clip(q.get("description"), 500)
    fc_type = q.get("type") or ""
    required = bool(q.get("required"))
    data: dict[str, Any] = {"id": fid, "label": label, "help": help_, "required": required}
    if fc_type in PHOTO_TYPES:
        data.update(type="photo", min_photos=0, max_photos=30)
        data["required"] = False if fc_type == "signature" else required
        if data["required"]:
            data["min_photos"] = 1
    elif fc_type == "numeric":
        data["type"] = "number"
    elif fc_type in ("multiple-choice", "dropdown"):
        options = []
        for opt in q.get("options") or []:
            label_opt = clip((opt or {}).get("description") or (opt or {}).get("value"), 200)
            if label_opt and label_opt not in options:
                options.append(label_opt)
        data.update(type="choice", options=options)
    elif fc_type == "paragraph":
        data["type"] = "textarea"
    else:  # short-answer, checkboxes, hour, date, email, phone...
        data["type"] = "text"
    try:
        return FormField.model_validate(data).model_dump()
    except ValidationError:
        data.update(type="text", options=[])
        data.pop("min_photos", None)
        data.pop("max_photos", None)
        return FormField.model_validate(data).model_dump()


# ------------------------------------------------------------------------------------ status


@dataclass
class MappedStatus:
    status: TicketStatus
    resolved_at: datetime | None = None
    closed_at: datetime | None = None
    cancelled_at: datetime | None = None
    last_activity: datetime | None = None
    note: str | None = None


def active_tasks(order: dict[str, Any]) -> list[dict[str, Any]]:
    tasks = [t for t in order.get("tasks") or [] if not t.get("archived")]
    return sorted(tasks, key=lambda t: (t.get("createdAt") or "", t.get("position") or 0))


def _task_times(task: dict[str, Any]) -> list[datetime]:
    out = [parse_ts(task.get(k)) for k in ("createdAt", "startedAt", "completedAt")]
    sched = task.get("scheduling") or {}
    out.append(local_datetime(sched.get("date"), sched.get("time")))
    return [t for t in out if t]


def map_status(
    order: dict[str, Any], tasks: list[dict[str, Any]], now: datetime, stale_days: int
) -> MappedStatus:
    """Situação da OS pelas atividades (a situação da OS no Field Control não é confiável)."""
    created = parse_ts(order.get("createdAt")) or now
    times = [created] + [t for task in tasks for t in _task_times(task)]
    last_activity = max(times)
    statuses = [t.get("status") for t in tasks]
    last = tasks[-1] if tasks else None

    def ended(task: dict[str, Any]) -> datetime:
        return parse_ts(task.get("completedAt")) or parse_ts(task.get("startedAt")) or last_activity

    if order.get("status") == "canceled" or (tasks and all(s == "canceled" for s in statuses)):
        when = max((ended(t) for t in tasks), default=last_activity)
        return MappedStatus(TicketStatus.CANCELLED, cancelled_at=when, last_activity=last_activity)

    # A última atividade que vale (cancelada no fim não apaga uma visita concluída antes).
    effective = last
    if last is not None and last.get("status") == "canceled":
        effective = next((t for t in reversed(tasks) if t.get("status") != "canceled"), None)

    if effective is None:
        mapped = MappedStatus(TicketStatus.NEW, last_activity=last_activity)
    else:
        st = effective.get("status")
        if st == "done":
            done_at = ended(effective)
            return MappedStatus(
                TicketStatus.CLOSED,
                resolved_at=done_at,
                closed_at=done_at,
                last_activity=last_activity,
            )
        if st == "in-progress":
            mapped = MappedStatus(TicketStatus.IN_PROGRESS, last_activity=last_activity)
        elif st == "on-route":
            mapped = MappedStatus(TicketStatus.EN_ROUTE, last_activity=last_activity)
        elif st in ("scheduled", "pending"):
            sched = effective.get("scheduling") or {}
            if sched.get("date"):
                mapped = MappedStatus(TicketStatus.SCHEDULED, last_activity=last_activity)
            elif effective.get("employee"):
                mapped = MappedStatus(TicketStatus.ASSIGNED, last_activity=last_activity)
            else:
                mapped = MappedStatus(TicketStatus.NEW, last_activity=last_activity)
        elif st == "reported":
            mapped = MappedStatus(
                TicketStatus.ASSIGNED if effective.get("employee") else TicketStatus.NEW,
                last_activity=last_activity,
            )
        else:
            mapped = MappedStatus(TicketStatus.NEW, last_activity=last_activity)

    if mapped.status in OPEN_AFTER_IMPORT and now - last_activity > timedelta(days=stale_days):
        local_day = last_activity.astimezone(LOCAL_TZ).strftime("%d/%m/%Y")
        return MappedStatus(
            TicketStatus.CANCELLED,
            cancelled_at=last_activity,
            last_activity=last_activity,
            note=f"Encerrada na migração: sem atividade desde {local_day}",
        )
    return mapped


# --------------------------------------------------------------------------------- importação


@dataclass
class Report:
    started_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    dry_run: bool = False
    wiped: dict[str, int] = field(default_factory=dict)
    counts: dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    timings: dict[str, float] = field(default_factory=dict)

    def add(self, entity: str, what: str, n: int = 1) -> None:
        self.counts[entity][what] += n

    def as_dict(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at,
            "dry_run": self.dry_run,
            "wiped": self.wiped,
            "counts": {k: dict(sorted(v.items())) for k, v in sorted(self.counts.items())},
            "timings_s": {k: round(v, 1) for k, v in self.timings.items()},
        }


WIPE_SQL = [
    ("ticket_part_requests", "DELETE FROM ticket_part_requests"),
    ("quotes", "DELETE FROM quotes"),
    ("ticket_expenses", "DELETE FROM ticket_expenses"),
    ("ticket_attachments", "DELETE FROM ticket_attachments"),
    ("ticket_forms", "DELETE FROM ticket_forms"),
    ("ticket_worklogs", "DELETE FROM ticket_worklogs"),
    ("ticket_events", "DELETE FROM ticket_events"),
    ("ticket_comments", "DELETE FROM ticket_comments"),
    ("sync_operations", "DELETE FROM sync_operations"),
    ("repair_photos", "DELETE FROM repair_photos"),
    ("repair_events", "DELETE FROM repair_events"),
    ("repair_orders", "DELETE FROM repair_orders"),
    ("tickets", "DELETE FROM tickets"),
    ("projects", "DELETE FROM projects"),
    ("technician_applications", "DELETE FROM technician_applications"),
    ("onboarding_invites", "DELETE FROM onboarding_invites"),
    ("assets", "DELETE FROM assets"),
    ("locations", "DELETE FROM locations"),
    ("service_types", "DELETE FROM service_types"),
    ("customers", "DELETE FROM customers"),
    ("form_templates", "DELETE FROM form_templates"),
    ("quote_item_catalog", "DELETE FROM quote_item_catalog"),
    ("legacy_refs", "DELETE FROM legacy_refs"),
    ("users", "DELETE FROM users WHERE role <> 'admin'"),
]


async def wipe_demo(db: AsyncSession) -> dict[str, int]:
    """Apaga os dados de demonstração (mantém admins, equipes, categorias e configurações)."""
    out: dict[str, int] = {}
    for table, sql in WIPE_SQL:
        result = await db.execute(text(sql))
        out[table] = result.rowcount or 0  # type: ignore[attr-defined]
    return out


class Importer:
    def __init__(
        self, db: AsyncSession, folder: Path, report: Report, stale_days: int, now: datetime
    ):
        self.db = db
        self.folder = folder
        self.report = report
        self.stale_days = stale_days
        self.now = now
        self.refs: dict[str, dict[str, uuid.UUID]] = defaultdict(dict)
        self.new_refs: list[dict[str, Any]] = []
        self.user_names: dict[uuid.UUID, str] = {}
        self.office_by_name: dict[str, uuid.UUID] = {}

    # ------------------------------------------------------------------ apoio

    def file(self, name: str) -> Path:
        return self.folder / name

    async def load_refs(self) -> None:
        rows = await self.db.execute(
            select(LegacyRef.kind, LegacyRef.external_id, LegacyRef.internal_id).where(
                LegacyRef.source == SOURCE
            )
        )
        for kind, external_id, internal_id in rows:
            self.refs[kind][external_id] = internal_id

    def ref(self, kind: str, external_id: Any) -> uuid.UUID | None:
        if external_id is None:
            return None
        return self.refs[kind].get(str(external_id))

    def remember(self, kind: str, external_id: Any, internal_id: uuid.UUID) -> None:
        key = str(external_id)[:80]
        if key in self.refs[kind]:
            return
        self.refs[kind][key] = internal_id
        self.new_refs.append(
            {
                "id": uuid.uuid4(),
                "source": SOURCE,
                "kind": kind,
                "external_id": key,
                "internal_id": internal_id,
            }
        )

    async def flush_refs(self) -> None:
        if self.new_refs:
            await self.db.execute(insert(LegacyRef), self.new_refs)
            self.new_refs = []

    async def bulk(self, model: Any, rows: list[dict[str, Any]]) -> None:
        for start in range(0, len(rows), 1000):
            chunk = rows[start : start + 1000]
            if chunk:
                await self.db.execute(insert(model), chunk)

    def user(self, *ids: Any) -> uuid.UUID | None:
        for value in ids:
            found = self.ref("user", value)
            if found:
                return found
        return None

    # ------------------------------------------------------------------ cadastros

    async def import_users(self) -> None:
        existing = {
            email.lower(): uid for uid, email in await self.db.execute(select(User.id, User.email))
        }
        by_email: dict[str, uuid.UUID] = dict(existing)
        rows: list[dict[str, Any]] = []
        now = self.now

        def mapped(email: str, fc_ids: list[Any]) -> uuid.UUID | None:
            uid = by_email.get(email)
            if uid:
                for fc_id in fc_ids:
                    self.remember("user", fc_id, uid)
            return uid

        for u in iter_records(self.file("usuarios.json")):
            email = (u.get("email") or "").strip().lower()
            ids = [u.get("id"), u.get("_id")]
            if not email:
                self.report.add("users", "skipped_no_email")
                continue
            uid = self.user(*ids) or mapped(email, ids)
            profile = u.get("profile") or {}
            role = (
                UserRole.SUPERVISOR
                if profile.get("admin") or profile.get("owner")
                else UserRole.ANALYST
            )
            name = clip(u.get("name"), 160) or email
            if uid:
                self.report.add("users", "office_existing")
            else:
                uid = uuid.uuid4()
                phones = u.get("phones") or []
                rows.append(
                    {
                        "id": uid,
                        "name": name,
                        "email": email,
                        "phone": fmt_phone(None, phones[0].get("number")) if phones else None,
                        "password_hash": UNUSABLE_PASSWORD,
                        "role": role,
                        "job_title": clip(u.get("workPosition"), 120),
                        "is_active": True,
                        "avatar_external_url": clip(u.get("avatarUrl"), 1000),
                        "legacy": {"source": SOURCE, "id": u.get("id")},
                        "created_at": parse_ts((u.get("metadata") or {}).get("createdAt")) or now,
                        "updated_at": now,
                    }
                )
                by_email[email] = uid
                self.report.add("users", f"office_created_{role.value}")
            for fc_id in ids:
                if fc_id:
                    self.remember("user", fc_id, uid)
            self.user_names[uid] = name
            self.office_by_name[plain(name)] = uid

        placeholders = placeholder_homes(self.file("colaboradores.json"))
        # Quem já é técnico aqui (o mesmo e-mail no escritório continua no escritório).
        technician_ids = set(
            await self.db.scalars(select(User.id).where(User.role == UserRole.TECHNICIAN))
        )
        for e in iter_records(self.file("colaboradores.json")):
            email = (e.get("email") or "").strip().lower()
            ids = [e.get("id"), e.get("_id")]
            known = self.user(*ids) or (mapped(email, ids) if email else None)
            name = clip(e.get("name"), 160) or email or "Técnico"
            active = not e.get("isInactivatedOrFired")
            address = e.get("address") or {}
            home = home_of(address, placeholders)
            if home["placeholder"]:
                self.report.add("technicians", "home_placeholder_cleared")
            # Ficha completa: endereço (menos o padrão do escritório), jornada, foto e origem.
            parts = address_parts(address)
            profile = {
                "address_line": None if home["placeholder"] else parts["line"],
                "address_district": None if home["placeholder"] else parts["district"],
                "address_zip": None if home["placeholder"] else parts["zip"],
                "work_schedule": work_schedule_of(e.get("workSchedule")),
                "avatar_external_url": clip(e.get("avatarUrl"), 1000),
                "legacy": {"source": SOURCE, "id": e.get("id"), "territories": territories_of(e)},
            }
            if not known or known in technician_ids:
                if profile["address_line"]:
                    self.report.add("technicians", "with_address")
                if profile["work_schedule"]:
                    self.report.add("technicians", "with_schedule")
            if known:
                self.report.add("technicians", "existing")
                await self.db.execute(
                    update(User)
                    .where(User.id == known, User.role == UserRole.TECHNICIAN)
                    .values(
                        name=name,
                        is_active=active,
                        home_city=home["city"],
                        home_state=home["state"],
                        home_latitude=home["latitude"],
                        home_longitude=home["longitude"],
                        **profile,
                    )
                )
                uid = known
            else:
                if not email:
                    email = f"fc-{e.get('id')}@importado.invalid"
                    self.report.add("technicians", "placeholder_email")
                uid = uuid.uuid4()
                rows.append(
                    {
                        "id": uid,
                        "name": name,
                        "email": email,
                        "password_hash": UNUSABLE_PASSWORD,
                        "role": UserRole.TECHNICIAN,
                        "is_active": active,
                        "home_city": home["city"],
                        "home_state": home["state"],
                        "home_latitude": home["latitude"],
                        "home_longitude": home["longitude"],
                        **profile,
                        "created_at": now,
                        "updated_at": now,
                    }
                )
                by_email[email] = uid
                self.report.add("technicians", "created_active" if active else "created_inactive")
            for fc_id in ids:
                if fc_id is not None:
                    self.remember("user", fc_id, uid)
            self.user_names[uid] = name
        await self.bulk(User, rows)
        await self.flush_refs()

    async def import_customers(self) -> None:
        taken = {d for (d,) in await self.db.execute(select(Customer.document)) if d}
        rows: list[dict[str, Any]] = []
        for c in iter_records(self.file("clientes.json")):
            contacts = c.get("contacts") or {}
            phones = contacts.get("phones") or []
            phone = next((p for p in phones if p.get("primary")), phones[0] if phones else None)
            notes = clip(c.get("notes"), 5000)
            doc = digits(c.get("documentNumber"))[:20] or None
            # Ficha completa: todos os contatos, endereço da matriz, logo e origem.
            all_contacts = contacts_of(contacts)
            # Campo único = o contato principal (e-mail em minúsculas, como na lista).
            email = primary_contact(all_contacts, "email")
            hq = c.get("address") or {}
            hq_parts = address_parts(hq)
            hq_coords = hq.get("coords") or {}
            hq_lat, hq_lng = hq_coords.get("latitude"), hq_coords.get("longitude")
            if not geo.valid_coords(hq_lat, hq_lng):
                hq_lat = hq_lng = None
            if len(all_contacts) >= 2:
                self.report.add("customers", "with_2plus_contacts")
            values = {
                "name": clip(c.get("name"), 200) or "Cliente sem nome",
                "email": email["value"] if email else None,
                "phone": fmt_phone(phone.get("countryCode"), phone.get("number"))
                if phone
                else None,
                "notes": notes,
                "is_active": not c.get("archived"),
                "tags": tags_of(c.get("labels")),
                "contacts": all_contacts,
                "address_line": hq_parts["line"],
                "district": hq_parts["district"],
                "city": hq_parts["city"],
                "state": hq_parts["state"],
                "zip_code": hq_parts["zip"],
                "latitude": hq_lat,
                "longitude": hq_lng,
                "logo_url": clip(c.get("avatarUrl"), 1000),
                "legacy": customer_legacy(c),
            }
            existing = self.ref("customer", c.get("id"))
            if existing:
                fc_created = parse_ts(c.get("createdAt"))
                await self.db.execute(
                    update(Customer)
                    .where(Customer.id == existing)
                    .values(**values, **({"created_at": fc_created} if fc_created else {}))
                )
                self.report.add("customers", "updated")
                continue
            if doc and doc in taken:
                values["notes"] = "\n".join(
                    p for p in (notes, f"CNPJ/CPF repetido em outro cliente: {doc}") if p
                )
                doc = None
                self.report.add("customers", "duplicate_document")
            if doc:
                taken.add(doc)
            uid = uuid.uuid4()
            created = parse_ts(c.get("createdAt")) or self.now
            rows.append(
                {"id": uid, "document": doc, "created_at": created, "updated_at": created, **values}
            )
            self.remember("customer", c.get("id"), uid)
            self.report.add("customers", "created")
        await self.bulk(Customer, rows)
        await self.flush_refs()

    async def import_locations(self) -> None:
        rows: list[dict[str, Any]] = []
        # Ponto padrão do geocodificador (centro do Brasil, mesmo ponto em várias UFs): ignorado.
        bad_points = geo.cross_state_pairs(
            _location_point(item) for item in iter_records(self.file("localizacoes.json"))
        )
        for loc in iter_records(self.file("localizacoes.json")):
            customer_id = self.ref("customer", (loc.get("customer") or {}).get("id"))
            if not customer_id:
                self.report.add("locations", "skipped_unknown_customer")
                continue
            address = loc.get("address") or {}
            code, name = split_location_code(loc.get("name") or "")
            street = ", ".join(p for p in (address.get("street"), address.get("number")) if p)
            line = " - ".join(p for p in (street, address.get("complement")) if p)
            coords = address.get("coords") or {}
            lat, lng = coords.get("latitude"), coords.get("longitude")
            if not lat and not lng:
                lat = lng = None
            elif not geo.valid_coords(lat, lng) or geo.coord_key(lat, lng) in bad_points:
                lat = lng = None
                self.report.add("locations", "coords_invalid_cleared")
            contacts = loc.get("contacts") or {}
            phones = contacts.get("phones") or []
            emails = contacts.get("emails") or []
            all_contacts = contacts_of(contacts)
            if len(all_contacts) >= 2:
                self.report.add("locations", "with_2plus_contacts")
            primary_phone = next(
                (p for p in phones if p.get("primary")), phones[0] if phones else None
            )
            contact_name = (primary_phone.get("name") if primary_phone else None) or (
                emails[0].get("name") if emails else None
            )
            uf = to_uf(address.get("state"))
            if address.get("state") and not uf:
                self.report.add("locations", "unknown_state")
            values = {
                "customer_id": customer_id,
                "name": clip(name, 200) or "Local",
                "code": clip(code, 40),
                "document": digits(loc.get("documentNumber"))[:20] or None,
                "address_line": clip(line, 255),
                "district": clip(address.get("neighborhood"), 120),
                "city": clip(address.get("city"), 120),
                "state": uf,
                "zip_code": fmt_zip(address.get("zipCode") or address.get("postalCode")),
                "latitude": lat,
                "longitude": lng,
                "contact_name": clip(contact_name, 160),
                "contact_phone": fmt_phone(
                    primary_phone.get("countryCode"), primary_phone.get("number")
                )
                if primary_phone
                else None,
                "notes": clip(loc.get("notes"), 5000),
                "is_active": not loc.get("archived"),
                # Ficha completa: todos os contatos e a origem.
                "contacts": all_contacts,
                "legacy": {
                    "source": SOURCE,
                    "id": loc.get("id"),
                    "created_at": loc.get("createdAt"),
                    "territories": territories_of(loc),
                },
            }
            existing = self.ref("location", loc.get("id"))
            if existing:
                fc_created = parse_ts(loc.get("createdAt"))
                await self.db.execute(
                    update(Location)
                    .where(Location.id == existing)
                    .values(**values, **({"created_at": fc_created} if fc_created else {}))
                )
                self.report.add("locations", "updated")
                continue
            uid = uuid.uuid4()
            created = parse_ts(loc.get("createdAt")) or self.now
            rows.append(
                {
                    "id": uid,
                    "created_at": created,
                    "updated_at": parse_ts(loc.get("updatedAt")) or created,
                    **values,
                }
            )
            self.remember("location", loc.get("id"), uid)
            self.report.add("locations", "created" if code is None else "created_with_code")
            if len(rows) >= 2000:
                await self.bulk(Location, rows)
                rows = []
        await self.bulk(Location, rows)
        await self.flush_refs()

    async def assign_technician_services(self) -> None:
        """Serviços que cada técnico faz (skills do Field Control), já com os tipos de serviço."""
        for e in iter_records(self.file("colaboradores.json")):
            uid = self.user(e.get("id"), e.get("_id"))
            if not uid:
                continue
            ids: list[str] = []
            for skill in e.get("skills") or []:
                sid = self.ref("service_type", (skill or {}).get("serviceId"))
                if sid and str(sid) not in ids:
                    ids.append(str(sid))
            result = await self.db.execute(
                update(User)
                .where(User.id == uid, User.role == UserRole.TECHNICIAN)
                .values(service_type_ids=ids)
            )
            if ids and result.rowcount:  # type: ignore[attr-defined]
                self.report.add("technicians", "with_services")

    async def import_catalogs(self) -> None:
        # Tipos de serviço (o "serviço" do Field Control).
        names = {
            plain(n): uid
            for uid, n in await self.db.execute(
                select(ServiceType.id, ServiceType.name).where(ServiceType.customer_id.is_(None))
            )
        }
        rows: list[dict[str, Any]] = []
        for s in iter_records(self.file("servicos.json")):
            name = clip(s.get("description"), 160) or f"Serviço {s.get('id')}"
            minutes = int(s.get("duration") or 0) or 60
            existing = self.ref("service_type", s.get("id")) or names.get(plain(name))
            if existing:
                await self.db.execute(
                    update(ServiceType)
                    .where(ServiceType.id == existing)
                    .values(estimated_minutes=minutes)
                )
                self.remember("service_type", s.get("id"), existing)
                self.report.add("service_types", "existing")
                continue
            uid = uuid.uuid4()
            rows.append(
                {
                    "id": uid,
                    "name": name,
                    "estimated_minutes": minutes,
                    "is_active": True,
                    "created_at": self.now,
                    "updated_at": self.now,
                }
            )
            names[plain(name)] = uid
            self.remember("service_type", s.get("id"), uid)
            self.report.add("service_types", "created")
        await self.bulk(ServiceType, rows)

        # Catálogo de preços dos orçamentos: produtos.
        catalog = {
            plain(n): uid
            for uid, n in await self.db.execute(select(QuoteItemCatalog.id, QuoteItemCatalog.name))
        }
        rows = []
        for p in iter_records(self.file("produtos.json")):
            name = clip(p.get("name"), 200) or f"Produto {p.get('id')}"
            existing = self.ref("catalog_item", p.get("id")) or catalog.get(plain(name))
            values = {
                "unit": UNIT.get(p.get("measure") or "", "un"),
                "price": money(p.get("value")),
                "description": clip(p.get("description"), 2000),
                "is_active": not p.get("archived"),
                "kind": "product",
            }
            if existing:
                if self.ref("catalog_item", p.get("id")):
                    await self.db.execute(
                        update(QuoteItemCatalog)
                        .where(QuoteItemCatalog.id == existing)
                        .values(**values)
                    )
                    self.report.add("catalog_products", "updated")
                else:
                    self.report.add("catalog_products", "duplicate_name")
                self.remember("catalog_item", p.get("id"), existing)
                continue
            uid = uuid.uuid4()
            rows.append(
                {
                    "id": uid,
                    "name": name,
                    "created_at": parse_ts(p.get("createdAt")) or self.now,
                    "updated_at": self.now,
                    **values,
                }
            )
            catalog[plain(name)] = uid
            self.remember("catalog_item", p.get("id"), uid)
            self.report.add("catalog_products", "created")
        await self.bulk(QuoteItemCatalog, rows)

        # Serviços com preço que aparecem nos orçamentos viram itens do catálogo (tipo serviço).
        rows = []
        for q in iter_records(self.file("orcamentos.json")):
            for item in q.get("items") or []:
                ps = item.get("productService") or {}
                if ps.get("type") != "service":
                    continue
                name = clip(ps.get("name"), 200)
                if not name or catalog.get(plain(name)) or self.ref("catalog_item", ps.get("id")):
                    if name and ps.get("id") and catalog.get(plain(name)):
                        self.remember("catalog_item", ps.get("id"), catalog[plain(name)])
                    continue
                uid = uuid.uuid4()
                rows.append(
                    {
                        "id": uid,
                        "name": name,
                        "unit": UNIT.get(ps.get("measure") or "", "un"),
                        "price": money(ps.get("value")),
                        "is_active": not ps.get("archived"),
                        "kind": "service",
                        "created_at": self.now,
                        "updated_at": self.now,
                    }
                )
                catalog[plain(name)] = uid
                if ps.get("id"):
                    self.remember("catalog_item", ps.get("id"), uid)
                self.report.add("catalog_services", "created")
        await self.bulk(QuoteItemCatalog, rows)

        # Modelos de formulário.
        rows = []
        for f in iter_records(self.file("formularios_modelos.json")):
            used: set[str] = set()
            questions = sorted(f.get("questions") or [], key=lambda q: q.get("position") or 0)
            fields = [question_to_field(q, used, i) for i, q in enumerate(questions)]
            if not fields:
                self.report.add("form_templates", "skipped_empty")
                continue
            values = {
                "name": clip(f.get("name"), 160) or "Formulário",
                "description": clip((f.get("metadata") or {}).get("description"), 2000),
                "fields": fields,
                "requires_signature": any(q.get("type") == "signature" for q in questions),
                "is_active": not f.get("archived"),
            }
            existing = self.ref("form_template", f.get("id"))
            if existing:
                await self.db.execute(
                    update(FormTemplate).where(FormTemplate.id == existing).values(**values)
                )
                self.report.add("form_templates", "updated")
                continue
            uid = uuid.uuid4()
            created = parse_ts(f.get("createdAt")) or self.now
            rows.append(
                {
                    "id": uid,
                    "service_type_ids": [],
                    "version": 1,
                    "created_at": created,
                    "updated_at": parse_ts(f.get("updatedAt")) or created,
                    **values,
                }
            )
            self.remember("form_template", f.get("id"), uid)
            self.report.add("form_templates", "created")
        await self.bulk(FormTemplate, rows)

        # Motivos de violação (SLA e prazo), juntados pelo nome.
        reasons = {
            plain(n): uid
            for uid, n in await self.db.execute(select(ViolationReason.id, ViolationReason.name))
        }
        rows = []
        for prefix, file_name in (
            ("sla", "sla_motivos_violacao.json"),
            ("prazo", "prazo_motivos_violacao.json"),
        ):
            for r in iter_records(self.file(file_name)):
                name = clip(r.get("name"), 160)
                if not name:
                    continue
                uid = reasons.get(plain(name))
                if uid is None:
                    uid = uuid.uuid4()
                    rows.append(
                        {
                            "id": uid,
                            "name": name,
                            "applies_to": ViolationScope.BOTH,
                            "responsibility": Responsibility.INTERNAL,
                            "is_active": not r.get("archived"),
                            "created_at": self.now,
                            "updated_at": self.now,
                        }
                    )
                    reasons[plain(name)] = uid
                    self.report.add("violation_reasons", "created")
                else:
                    self.report.add("violation_reasons", "merged")
                self.remember("violation_reason", f"{prefix}:{r.get('id')}", uid)
        await self.bulk(ViolationReason, rows)
        await self.flush_refs()

    # ------------------------------------------------------------------ OS

    def load_requests(self) -> dict[str, dict[str, Any]]:
        """Solicitações do portal do cliente, pelo id de serviceRequest (liga com a OS)."""
        out: dict[str, dict[str, Any]] = {}
        for r in iter_records(self.file("solicitacoes_tickets.json")):
            sid = (((r.get("metadata") or {}).get("warg") or {}).get("serviceRequest") or {}).get(
                "id"
            )
            if not sid:
                continue
            files = []
            for att in r.get("attachments") or []:
                url = absolute_file(att.get("path"))
                if url:
                    files.append({"url": url, "title": att.get("title"), "type": att.get("type")})
            contact = r.get("contact") or {}
            out[sid] = {
                "subject": clip(r.get("subject") or r.get("name"), 300),
                "message": clip(r.get("message"), 10000),
                "contact_email": clip(contact.get("email"), 255),
                "contact_phone": clip(contact.get("phone"), 40),
                "created_at": r.get("createdAt"),
                "files": files,
            }
        return out

    async def import_tickets(self) -> None:
        requests = self.load_requests()
        taken_numbers = {n for (n,) in await self.db.execute(select(Ticket.number))}
        max_number = max(taken_numbers, default=0)
        batch: dict[str, list[dict[str, Any]]] = defaultdict(list)
        # OS sem número aproveitável (identificador não numérico ou já usado): ficam para o fim,
        # quando já se sabe o maior número.
        held: dict[str, list[dict[str, Any]]] = defaultdict(list)
        processed = 0

        async def flush(rows: dict[str, list[dict[str, Any]]]) -> None:
            await self.bulk(Ticket, rows["tickets"])
            await self.bulk(TicketEvent, rows["events"])
            await self.bulk(TicketWorklog, rows["worklogs"])
            await self.bulk(TicketAttachment, rows["attachments"])
            await self.flush_refs()
            rows.clear()

        for order in iter_records(self.file("ordens_de_servico.json")):
            processed += 1
            if self.ref("ticket", order.get("id")):
                self.report.add("tickets", "skipped_existing")
                continue
            ident = str(order.get("identifier") or "")
            number: int | None = int(ident) if ident.isdigit() else None
            if number is not None and number in taken_numbers:
                self.report.add("tickets", "renumbered_taken")
                number = None
            row, children = self.build_ticket(order, requests)
            target = held
            if number is not None:
                row["number"] = number
                taken_numbers.add(number)
                max_number = max(max_number, number)
                target = batch
            else:
                self.report.add(
                    "tickets", "renumbered_not_numeric" if not ident.isdigit() else "renumbered"
                )
            target["tickets"].append(row)
            for key, rows in children.items():
                target[key].extend(rows)
            self.remember("ticket", order.get("id"), row["id"])
            self.report.add("tickets", "created")
            self.report.add("tickets_status", row["status"].value)
            if len(batch["tickets"]) >= BATCH:
                await flush(batch)
                log.info("OS: %s processadas", processed)
        for row in held["tickets"]:
            max_number += 1
            row["number"] = max_number
        await flush(batch)
        await flush(held)
        await self.db.execute(
            text("SELECT setval(pg_get_serial_sequence('tickets', 'number'), :n, true)"),
            {"n": max(max_number, 1)},
        )
        self.report.add("tickets", "next_number", max_number + 1)
        log.info("OS: %s processadas (fim)", processed)

    def build_ticket(
        self, order: dict[str, Any], requests: dict[str, dict[str, Any]]
    ) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
        tid = uuid.uuid4()
        tasks = active_tasks(order)
        mapped = map_status(order, tasks, self.now, self.stale_days)
        created = parse_ts(order.get("createdAt")) or self.now
        updated = parse_ts(order.get("updatedAt")) or created
        service = order.get("service") or {}
        service_name = clip(service.get("description"), 200) or "Ordem de serviço"
        location = order.get("location") or {}
        customer = order.get("customer") or {}
        created_by = self.user((order.get("createdBy") or {}).get("id"))
        last = tasks[-1] if tasks else None
        effective = last
        if last is not None and last.get("status") == "canceled":
            effective = next((t for t in reversed(tasks) if t.get("status") != "canceled"), last)
        employee = (effective or {}).get("employee") or {}
        assignee = self.user(employee.get("id"), employee.get("_id"))
        sched = (effective or {}).get("scheduling") or {}
        scheduled_start = local_datetime(sched.get("date"), sched.get("time"))
        duration = int((effective or {}).get("duration") or service.get("duration") or 0)
        scheduled_end = (
            scheduled_start + timedelta(minutes=duration) if scheduled_start and duration else None
        )

        done = [t for t in tasks if t.get("status") == "done"]
        reported = [t for t in tasks if t.get("status") == "reported"]
        work_seconds = 0
        for t in done:
            start, end = parse_ts(t.get("startedAt")), parse_ts(t.get("completedAt"))
            if start and end and end > start:
                work_seconds += int((end - start).total_seconds()) - int(
                    t.get("totalPausedDuration") or 0
                )
        deadline = order.get("deadline") or {}
        first_started = next(
            (parse_ts(t.get("startedAt")) for t in tasks if t.get("startedAt")), None
        )

        arrived_at = None
        if mapped.status in (TicketStatus.IN_PROGRESS, TicketStatus.CLOSED):
            source_task = (
                effective
                if mapped.status == TicketStatus.IN_PROGRESS
                else (done[-1] if done else None)
            )
            arrived_at = parse_ts((source_task or {}).get("startedAt"))
        onsite_due = arrived_at + timedelta(hours=ONSITE_HOURS) if arrived_at else None

        sid = (((order.get("metadata") or {}).get("warg") or {}).get("serviceRequest") or {}).get(
            "id"
        )
        request = requests.get(sid) if sid else None
        files: list[dict[str, Any]] = list(request["files"]) if request else []
        main_sig = (order.get("signature") or {}).get("path")
        for sig in order.get("signatures") or []:
            url = absolute_file(sig.get("path"))
            if url and url != main_sig:
                files.append(
                    {
                        "url": url,
                        "title": clip(sig.get("name"), 160) or "Assinatura",
                        "type": "image/png",
                    }
                )

        items = []
        for group, kind in (("productsV2", "product"), ("services", "service")):
            for it in ((order.get(group) or {}).get("items")) or []:
                info = it.get("item") or {}
                items.append(
                    {
                        "type": kind,
                        "name": clip(info.get("name") or info.get("description"), 200) or "Item",
                        "quantity": float(it.get("quantity") or 0),
                        "value": float(money(it.get("value"))),
                        "total": float(money(it.get("totalValue"))),
                    }
                )
        legacy = {
            "source": SOURCE,
            "identifier": str(order.get("identifier") or "") or None,
            "fc_status": order.get("status"),
            "values": {
                "products": float(money(order.get("productsTotalValue"))),
                "services": float(money(order.get("servicesTotalValue"))),
                "expenses": float(money(order.get("expensesTotalValue"))),
                "total": float(money(order.get("totalValue"))),
            },
            "items": items,
            "request": (
                {
                    k: request[k]
                    for k in ("subject", "message", "contact_email", "contact_phone", "created_at")
                }
                if request
                else None
            ),
            "files": files,
            "deadline": (
                {
                    "response_status": deadline.get("responseStatus"),
                    "solution_status": deadline.get("solutionStatus"),
                }
                if deadline
                else None
            ),
            "migration_note": mapped.note,
        }
        resolution_notes = clip(done[-1].get("statusDescription"), 20000) if done else None
        contact = request and " · ".join(
            p for p in (request.get("contact_email"), request.get("contact_phone")) if p
        )

        row: dict[str, Any] = {
            "id": tid,
            "title": service_name,
            "description": order.get("description") or "",
            "type": ticket_type_for(service_name),
            "status": mapped.status,
            "source": TicketSource.PORTAL if request else TicketSource.WEB,
            "customer_id": self.ref("customer", customer.get("id")),
            "location_id": self.ref("location", location.get("id")),
            "requester_contact": clip(contact, 160) if contact else None,
            "created_by_id": created_by,
            "owner_id": created_by,
            "assignee_id": assignee,
            "scheduled_start": scheduled_start,
            "scheduled_end": scheduled_end,
            "response_due_at": parse_ts(deadline.get("responseAt")),
            "resolution_due_at": parse_ts(deadline.get("solutionAt")),
            "first_response_at": parse_ts(deadline.get("firstTaskStartedAt")) or first_started,
            "resolved_at": mapped.resolved_at,
            "closed_at": mapped.closed_at,
            "cancelled_at": mapped.cancelled_at,
            "resolution_notes": resolution_notes,
            "service_type_id": self.ref("service_type", service.get("id")),
            "estimated_minutes": int(service.get("duration") or 0) or None,
            "work_seconds": max(0, work_seconds),
            "response_violation_reason_id": self.ref(
                "violation_reason",
                f"sla:{(deadline.get('responseViolationReason') or {}).get('id')}",
            )
            or self.ref(
                "violation_reason",
                f"prazo:{(deadline.get('responseViolationReason') or {}).get('id')}",
            ),
            "resolution_violation_reason_id": self.ref(
                "violation_reason",
                f"sla:{(deadline.get('solutionViolationReason') or {}).get('id')}",
            )
            or self.ref(
                "violation_reason",
                f"prazo:{(deadline.get('solutionViolationReason') or {}).get('id')}",
            ),
            "unproductive_count": len(reported),
            "last_unproductive_at": max(
                (
                    parse_ts(t.get("completedAt"))
                    or parse_ts(t.get("startedAt"))
                    or parse_ts(t.get("createdAt"))
                    for t in reported
                ),
                default=None,
            ),
            "arrived_at": arrived_at,
            "onsite_due_at": onsite_due,
            "onsite_warning_at": onsite_due - timedelta(minutes=ONSITE_WARNING_MINUTES)
            if onsite_due
            else None,
            "authorization_status": AuthorizationStatus.NOT_REQUIRED,
            "tags": tags_of(order.get("labels")),
            "legacy": legacy,
            "version": 1,
            "created_at": created,
            "updated_at": updated,
        }

        events: list[dict[str, Any]] = []
        worklogs: list[dict[str, Any]] = []
        attachments: list[dict[str, Any]] = []

        def event(
            kind: TicketEventType, at: datetime | None, actor: uuid.UUID | None = None, **kw: Any
        ) -> None:
            events.append(
                {
                    "id": uuid.uuid4(),
                    "ticket_id": tid,
                    "actor_id": actor,
                    "event_type": kind,
                    "from_value": clip(kw.get("from_value"), 64),
                    "to_value": clip(kw.get("to_value"), 64),
                    "note": kw.get("note"),
                    "data": {"source": SOURCE, **(kw.get("data") or {})},
                    "created_at": at or created,
                }
            )

        event(TicketEventType.CREATED, created, created_by, note="OS importada do Field Control")
        for task in tasks:
            emp = task.get("employee") or {}
            tech = self.user(emp.get("id"), emp.get("_id"))
            t_created = parse_ts(task.get("createdAt")) or created
            started = parse_ts(task.get("startedAt"))
            completed = parse_ts(task.get("completedAt"))
            desc = clip(task.get("statusDescription"), 20000)
            if emp:
                event(
                    TicketEventType.ASSIGNED,
                    t_created,
                    created_by,
                    to_value=emp.get("name"),
                    data={"task": task.get("id")},
                )
            status = task.get("status")
            if started and status in ("done", "in-progress", "reported"):
                event(
                    TicketEventType.STATUS_CHANGED,
                    started,
                    tech,
                    to_value=TicketStatus.IN_PROGRESS.value,
                )
            if status == "done":
                end = completed or started or t_created
                begin = started or end
                minutes = max(1, round((end - begin).total_seconds() / 60)) if end and begin else 1
                worklogs.append(
                    {
                        "id": uuid.uuid4(),
                        "ticket_id": tid,
                        "user_id": tech,
                        "description": desc or "Atendimento concluído (Field Control)",
                        "started_at": begin,
                        "ended_at": end,
                        "minutes": minutes,
                        "created_at": end,
                    }
                )
                event(
                    TicketEventType.STATUS_CHANGED,
                    end,
                    tech,
                    to_value=TicketStatus.RESOLVED.value,
                    note=desc,
                )
            elif status == "reported":
                event(
                    TicketEventType.UNPRODUCTIVE_VISIT,
                    completed or started or t_created,
                    tech,
                    note=desc or "Visita reportada no Field Control",
                )
            elif status == "canceled":
                event(
                    TicketEventType.STATUS_CHANGED,
                    completed or t_created,
                    None,
                    to_value=TicketStatus.CANCELLED.value,
                    note=" · ".join(p for p in ("Atividade cancelada no Field Control", desc) if p),
                )
        if mapped.status == TicketStatus.CLOSED:
            event(
                TicketEventType.STATUS_CHANGED,
                mapped.closed_at,
                None,
                to_value=TicketStatus.CLOSED.value,
            )
        elif mapped.status == TicketStatus.CANCELLED and mapped.note:
            event(
                TicketEventType.STATUS_CHANGED,
                mapped.cancelled_at,
                None,
                to_value=TicketStatus.CANCELLED.value,
                note=mapped.note,
            )

        signature = order.get("signature") or {}
        sig_url = absolute_file(signature.get("path"))
        if sig_url:
            att_id = uuid.uuid4()
            signed = parse_ts(signature.get("signedAt")) or mapped.closed_at or updated
            attachments.append(
                {
                    "id": att_id,
                    "ticket_id": tid,
                    "filename": "assinatura.png",
                    "content_type": "image/png",
                    "size_bytes": 0,
                    "kind": "signature",
                    "storage_key": None,
                    "external_url": sig_url,
                    "created_at": signed,
                }
            )
            row["signer_name"] = clip(signature.get("signedBy"), 160)
            row["signed_at"] = signed
            row["signature_attachment_id"] = att_id
        return row, {"events": events, "worklogs": worklogs, "attachments": attachments}

    # ------------------------------------------------ formulários, comentários, orçamentos

    async def import_forms(self) -> None:
        forms: list[dict[str, Any]] = []
        attachments: list[dict[str, Any]] = []
        for f in iter_records(self.file("formularios_respondidos.json")):
            if self.ref("ticket_form", f.get("id")):
                self.report.add("forms", "skipped_existing")
                continue
            ticket_id = self.ref("ticket", (f.get("order") or {}).get("id"))
            if not ticket_id:
                self.report.add("forms", "skipped_unknown_order")
                continue
            used: set[str] = set()
            questions = sorted(f.get("questions") or [], key=lambda q: q.get("position") or 0)
            fields: list[dict[str, Any]] = []
            answers: dict[str, Any] = {}
            form_id = uuid.uuid4()
            created = parse_ts(f.get("createdAt")) or self.now
            completed = parse_ts(f.get("completedAt"))
            author = self.user((f.get("createdByUser") or {}).get("id"), f.get("createdBy"))
            for i, q in enumerate(questions):
                fld = question_to_field(q, used, i)
                fields.append(fld)
                answer = q.get("answer")
                if answer in (None, ""):
                    continue
                if fld["type"] == "photo" or q.get("type") in PHOTO_TYPES:
                    for url in dict.fromkeys(URL.findall(str(answer))):
                        name, ctype = file_meta(url)
                        attachments.append(
                            {
                                "id": uuid.uuid4(),
                                "ticket_id": ticket_id,
                                "uploaded_by_id": author,
                                "filename": name,
                                "content_type": ctype,
                                "size_bytes": 0,
                                "kind": "photo",
                                "storage_key": None,
                                "external_url": url[:1000],
                                "form_id": form_id,
                                "field_id": fld["id"],
                                "created_at": completed or created,
                            }
                        )
                        self.report.add("forms", "photos")
                else:
                    answers[fld["id"]] = str(answer)[:10000]
            if not fields:
                self.report.add("forms", "skipped_empty")
                continue
            done = f.get("status") == "done"
            forms.append(
                {
                    "id": form_id,
                    "ticket_id": ticket_id,
                    "template_id": self.ref("form_template", f.get("reference")),
                    "template_version": 1,
                    "name": clip(f.get("name"), 160) or "Formulário",
                    "fields": fields,
                    "required": False,
                    "status": FormStatus.COMPLETED if done else FormStatus.IN_PROGRESS,
                    "answers": answers,
                    "completed_at": completed if done else None,
                    "completed_by_id": author if done else None,
                    "created_at": created,
                    "updated_at": parse_ts(f.get("updatedAt")) or completed or created,
                }
            )
            self.remember("ticket_form", f.get("id"), form_id)
            self.report.add("forms", "created")
            if len(forms) >= BATCH:
                await self.bulk(TicketForm, forms)
                await self.bulk(TicketAttachment, attachments)
                await self.flush_refs()
                forms, attachments = [], []
        await self.bulk(TicketForm, forms)
        await self.bulk(TicketAttachment, attachments)
        await self.flush_refs()

    async def import_comments(self) -> None:
        rows: list[dict[str, Any]] = []
        for c in iter_records(self.file("os_comentarios.json")):
            if c.get("archived"):
                self.report.add("comments", "skipped_archived")
                continue
            if self.ref("comment", c.get("id")):
                self.report.add("comments", "skipped_existing")
                continue
            ticket_id = self.ref("ticket", (c.get("order") or {}).get("id"))
            body = (c.get("message") or "").strip()
            if not ticket_id or not body:
                self.report.add("comments", "skipped_unknown_order_or_empty")
                continue
            uid = uuid.uuid4()
            rows.append(
                {
                    "id": uid,
                    "ticket_id": ticket_id,
                    "author_id": None,
                    "body": body,
                    "is_internal": True,
                    "created_at": parse_ts(c.get("createdAt")) or self.now,
                }
            )
            self.remember("comment", c.get("id"), uid)
            self.report.add("comments", "created")
        await self.bulk(TicketComment, rows)
        await self.flush_refs()

    async def import_quotes(self) -> None:
        rows: list[dict[str, Any]] = []
        for q in iter_records(self.file("orcamentos.json")):
            if self.ref("quote", q.get("id")):
                self.report.add("quotes", "skipped_existing")
                continue
            order = q.get("order") or {}
            ticket_id = self.ref("ticket", order.get("id"))
            if not ticket_id:
                self.report.add(
                    "quotes", "skipped_without_order" if not order else "skipped_unknown_order"
                )
                continue
            items = []
            subtotal = Decimal("0.00")
            for it in sorted(q.get("items") or [], key=lambda i: i.get("position") or 0):
                ps = it.get("productService") or {}
                quantity = money(it.get("quantity") or 0)
                unit_price = money(it.get("value"))
                line = money(
                    it.get("total") if it.get("total") is not None else quantity * unit_price
                )
                subtotal += line
                description = clip(ps.get("name"), 300) or "Item"
                if it.get("description") and plain(it.get("description")) != plain(description):
                    description = clip(f"{description} — {it['description']}", 300) or description
                items.append(
                    {
                        "description": description,
                        "quantity": str(quantity),
                        "unit": UNIT.get(ps.get("measure") or "", "un"),
                        "unit_price": str(unit_price),
                        "total": str(line),
                        "catalog_item_id": str(self.ref("catalog_item", ps.get("id")) or "")
                        or None,
                        "kind": "service" if ps.get("type") == "service" else "product",
                    }
                )
            status = QUOTE_STATUS.get(q.get("status") or "", QuoteStatus.DRAFT)
            created = parse_ts(q.get("createdAt")) or self.now
            decided = parse_ts(q.get("approvedAt")) or parse_ts(q.get("refusedAt"))
            message = clip(q.get("approvedMessage"), 5000)
            expires = parse_ts(q.get("expiredAt"))
            uid = uuid.uuid4()
            rows.append(
                {
                    "id": uid,
                    "ticket_id": ticket_id,
                    "status": status,
                    "title": clip(q.get("name"), 200) or "Orçamento",
                    "items": items,
                    "subtotal": money(
                        q.get("subtotal") if q.get("subtotal") is not None else subtotal
                    ),
                    "discount": money((q.get("discount") or {}).get("total") or 0),
                    "total": money(q.get("total") if q.get("total") is not None else subtotal),
                    "valid_until": expires.astimezone(LOCAL_TZ).date() if expires else None,
                    "notes": clip(q.get("additionalInformation"), 5000),
                    "sent_at": created if status != QuoteStatus.DRAFT else None,
                    "decided_at": decided
                    if status in (QuoteStatus.APPROVED, QuoteStatus.REJECTED)
                    else None,
                    "approver_name": clip(q.get("approvedBy"), 160),
                    "client_comment": message if status == QuoteStatus.APPROVED else None,
                    "rejection_reason": (message or "Recusado no Field Control")
                    if status == QuoteStatus.REJECTED
                    else None,
                    "created_by_id": self.user(q.get("createdBy")),
                    "legacy": {
                        "source": SOURCE,
                        "identifier": q.get("identifier"),
                        "signature_url": absolute_file(q.get("approvedSignature")),
                        "attachments": [
                            {
                                "url": absolute_file(a.get("path")),
                                "title": a.get("title"),
                                "type": a.get("type"),
                            }
                            for a in q.get("attachments") or []
                            if absolute_file(a.get("path"))
                        ],
                        "description": clip(q.get("description"), 5000),
                    },
                    "created_at": created,
                    "updated_at": parse_ts(q.get("updatedAt")) or created,
                }
            )
            self.remember("quote", q.get("id"), uid)
            self.report.add("quotes", "created")
            self.report.add("quotes_status", status.value)
        await self.bulk(Quote, rows)
        await self.flush_refs()


async def run_import(
    db: AsyncSession,
    folder: Path,
    *,
    wipe: bool = False,
    stale_days: int = 120,
    now: datetime | None = None,
    report: Report | None = None,
) -> Report:
    """Roda a importação inteira na sessão dada (quem chama decide commit ou rollback)."""
    report = report or Report()
    importer = Importer(db, folder, report, stale_days, now or datetime.now(UTC))
    if wipe:
        started = time.monotonic()
        report.wiped = await wipe_demo(db)
        report.timings["wipe"] = time.monotonic() - started
    await importer.load_refs()
    for name, step in (
        ("users", importer.import_users),
        ("customers", importer.import_customers),
        ("locations", importer.import_locations),
        ("catalogs", importer.import_catalogs),
        ("technician_services", importer.assign_technician_services),
        ("tickets", importer.import_tickets),
        ("forms", importer.import_forms),
        ("comments", importer.import_comments),
        ("quotes", importer.import_quotes),
    ):
        started = time.monotonic()
        log.info("Importando %s...", name)
        await step()
        await db.flush()
        report.timings[name] = time.monotonic() - started
    # Coordenadas inválidas que já estavam no banco (de outra origem) também saem.
    report.counts["locations_coords"] = Counter(
        {"invalid_cleared_in_db": await geo.clear_invalid_location_coords(db)}
    )
    # Uma grafia por cidade ("FORTALEZA" e "Fortaleza" viram "Fortaleza") antes das regiões.
    report.counts["cities_normalized"] = Counter(await cities.normalize_all(db))
    # Região de atuação dos técnicos (a cidade onde mais atenderam), com o histórico já importado.
    started = time.monotonic()
    report.counts["technician_regions"] = Counter(await technician_regions.refresh_bases(db))
    report.timings["technician_regions"] = time.monotonic() - started
    totals = await db.execute(
        select(Ticket.status, func.count()).group_by(Ticket.status)  # type: ignore[arg-type]
    )
    report.counts["final_ticket_status"] = Counter(
        {str(s.value if hasattr(s, "value") else s): n for s, n in totals}
    )
    return report


async def _main(args: argparse.Namespace) -> int:
    folder = Path(args.folder)
    if not (folder / "ordens_de_servico.json").exists():
        log.error("Pasta do export sem ordens_de_servico.json: %s", folder)
        return 2
    engine = create_async_engine(settings.DATABASE_URL)
    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    report = Report(dry_run=args.dry_run)
    started = time.monotonic()
    async with maker() as db:
        try:
            await run_import(
                db, folder, wipe=args.wipe_demo, stale_days=args.stale_days, report=report
            )
            if args.dry_run:
                await db.rollback()
                log.info("Simulação: nada foi gravado.")
            else:
                await db.commit()
        except Exception:
            await db.rollback()
            raise
    await engine.dispose()
    report.timings["total"] = time.monotonic() - started
    data = report.as_dict()
    text_ = json.dumps(data, ensure_ascii=False, indent=2, default=str)
    print(text_)
    if args.report:
        await asyncio.to_thread(Path(args.report).write_text, text_, encoding="utf-8")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Importa o export do Field Control.")
    parser.add_argument("folder", help="Pasta com os JSON do export (fora do repositório)")
    parser.add_argument("--dry-run", action="store_true", help="Simula e desfaz no fim")
    parser.add_argument("--wipe-demo", action="store_true", help="Apaga a demonstração antes")
    parser.add_argument(
        "--stale-days", type=int, default=120, help="Dias sem atividade para encerrar"
    )
    parser.add_argument("--report", help="Arquivo JSON do relatório (fora do repositório)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    raise SystemExit(asyncio.run(_main(args)))


if __name__ == "__main__":
    main()
