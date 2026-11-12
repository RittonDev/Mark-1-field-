"""Importação do export do Field Control (dados sintéticos, nunca o export real)."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.enums import TicketStatus, UserRole
from app.core.security import create_access_token
from app.importers.fieldcontrol import (
    UNUSABLE_PASSWORD,
    fmt_phone,
    map_status,
    question_to_field,
    run_import,
    split_location_code,
    to_uf,
)
from app.models import (
    Customer,
    LegacyRef,
    Location,
    Quote,
    Ticket,
    TicketAttachment,
    TicketComment,
    TicketForm,
    User,
)
from tests.conftest import World, requires_db

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


# ---------------------------------------------------------------------- regras puras


def _task(status: str, **kw):
    base = {
        "status": status,
        "createdAt": "2026-10-01T10:00:00Z",
        "position": 0,
        "employee": {"id": 1},
    }
    base.update(kw)
    return base


def test_status_mapping_from_tasks() -> None:
    order = {"createdAt": "2026-10-01T09:00:00Z", "status": "pending"}
    done = map_status(order, [_task("done", completedAt="2026-10-01T15:00:00Z")], NOW, 120)
    assert done.status == TicketStatus.CLOSED
    assert done.closed_at == datetime(2026, 10, 1, 15, tzinfo=UTC)

    assert (
        map_status({**order, "status": "canceled"}, [], NOW, 120).status == TicketStatus.CANCELLED
    )
    all_cancelled = map_status(order, [_task("canceled"), _task("canceled")], NOW, 120)
    assert all_cancelled.status == TicketStatus.CANCELLED

    reported = map_status(order, [_task("reported", completedAt="2026-11-01T10:00:00Z")], NOW, 120)
    assert reported.status == TicketStatus.ASSIGNED

    scheduled = _task("scheduled", scheduling={"date": "2026-11-20", "time": "10:00:00"})
    assert map_status(order, [scheduled], NOW, 120).status == TicketStatus.SCHEDULED
    assert map_status(order, [_task("in-progress")], NOW, 120).status == TicketStatus.IN_PROGRESS
    assert map_status(order, [_task("on-route")], NOW, 120).status == TicketStatus.EN_ROUTE
    assert map_status(order, [], NOW, 120).status == TicketStatus.NEW

    # Concluída antes e uma atividade cancelada depois: vale a conclusão.
    tasks = [
        _task("done", completedAt="2026-10-02T12:00:00Z"),
        _task("canceled", createdAt="2026-10-03T10:00:00Z", position=1),
    ]
    assert map_status(order, tasks, NOW, 120).status == TicketStatus.CLOSED


def test_stale_open_order_is_cancelled_with_note() -> None:
    order = {"createdAt": "2026-01-10T09:00:00Z", "status": "pending"}
    task = _task(
        "pending", createdAt="2026-01-10T10:00:00Z", scheduling={"date": "2026-01-15", "time": None}
    )
    mapped = map_status(order, [task], NOW, 120)
    assert mapped.status == TicketStatus.CANCELLED
    assert mapped.note == "Encerrada na migração: sem atividade desde 15/01/2026"
    # Agendada para depois de hoje não é parada.
    future = _task("scheduled", createdAt="2026-01-10T10:00:00Z", scheduling={"date": "2026-12-01"})
    assert map_status(order, [future], NOW, 120).status == TicketStatus.SCHEDULED


def test_normalizers() -> None:
    assert split_location_code("43 - Barra Teste") == ("43", "Barra Teste")
    assert split_location_code("Loja Centro - Térreo") == (None, "Loja Centro - Térreo")
    assert split_location_code("Matriz") == (None, "Matriz")
    assert to_uf("São Paulo") == "SP"
    assert to_uf("rj") == "RJ"
    assert to_uf("Paraíba") == "PB"
    assert to_uf("Atlântida") is None
    assert fmt_phone("55", "11987654321") == "(11) 98765-4321"
    assert fmt_phone("55", "551130001234") == "(11) 3000-1234"


def test_question_fallbacks_to_valid_fields() -> None:
    used: set[str] = set()
    pic = question_to_field(
        {"id": "q-1", "title": "Foto antes", "type": "multiple-picture"}, used, 0
    )
    assert pic["type"] == "photo"
    one_option = question_to_field(
        {"id": "q-2", "title": "Status", "type": "dropdown", "options": [{"description": "Ok"}]},
        used,
        1,
    )
    assert one_option["type"] == "text"  # escolha com 1 opção não é válida: vira texto
    choice = question_to_field(
        {
            "id": "q-3",
            "title": "Cabos",
            "type": "multiple-choice",
            "options": [{"description": "Sim"}, {"description": "Não"}],
        },
        used,
        2,
    )
    assert choice["type"] == "choice" and choice["options"] == ["Sim", "Não"]
    dup = question_to_field({"id": "q-1", "title": "Repetida", "type": "paragraph"}, used, 3)
    assert dup["id"] != "q-1" and dup["type"] == "textarea"


# ---------------------------------------------------------------------- export sintético


def _write(folder: Path, name: str, rows: list[dict]) -> None:
    (folder / name).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")


def _order(oid: str, ident: str, **kw) -> dict:
    base = {
        "id": oid,
        "identifier": ident,
        "status": "pending",
        "createdAt": "2026-10-01T09:00:00Z",
        "updatedAt": "2026-10-01T16:00:00Z",
        "description": f"Descrição {ident}",
        "service": {"id": 1, "description": "Computador - Manutenção Preventiva", "duration": 120},
        "customer": {"id": 10},
        "location": {"id": "loc-1"},
        "createdBy": {"id": "office-1"},
        "tasks": [],
        "labels": [],
        "signature": {},
        "signatures": [],
        "productsV2": {"items": []},
        "services": {"items": []},
        "productsTotalValue": 0,
        "servicesTotalValue": 0,
        "expensesTotalValue": 0,
        "totalValue": 0,
        "deadline": None,
        "metadata": {},
    }
    base.update(kw)
    return base


def _emp(eid: int) -> dict:
    return {"id": eid, "_id": f"emp-{eid}", "name": f"Técnico {eid}"}


@pytest.fixture
def export(tmp_path: Path) -> Path:
    folder = tmp_path / "fc"
    folder.mkdir()
    _write(
        folder,
        "usuarios.json",
        [
            {
                "id": "office-1",
                "_id": "office-1x",
                "name": "Ana Gestora",
                "email": "ana@empresa.test",
                "profile": {"admin": True, "owner": False},
                "phones": [],
                "metadata": {},
            },
            {
                "id": "office-2",
                "_id": "office-2x",
                "name": "Beto Analista",
                "email": "beto@empresa.test",
                "profile": {"admin": False, "owner": False},
                "phones": [],
                "metadata": {},
            },
        ],
    )
    _write(
        folder,
        "colaboradores.json",
        [
            {
                "id": 1,
                "_id": "emp-1",
                "name": "Técnico Um",
                "email": "Tec1@Teste.dev",
                "isInactivatedOrFired": False,
                "address": {"city": "São Paulo", "state": "São Paulo"},
            },
            {
                "id": 2,
                "_id": "emp-2",
                "name": "Ana Gestora",
                "email": "ana@empresa.test",
                "isInactivatedOrFired": True,
                "address": {"city": "Recife", "state": "Pernambuco"},
            },
            {
                "id": 3,
                "_id": "emp-3",
                "name": "Técnico Três",
                "email": "tec3@teste.dev",
                "isInactivatedOrFired": True,
                "address": {"city": "Natal", "state": "RN"},
            },
        ],
    )
    _write(
        folder,
        "clientes.json",
        [
            {
                "id": 10,
                "name": "Rede Exemplo",
                "documentNumber": "11.222.333/0001-81",
                "archived": False,
                "createdAt": "2022-09-06T15:00:00Z",
                "contacts": {
                    "emails": [{"address": "contato@rede.test", "primary": True}],
                    "phones": [{"countryCode": "55", "number": "1130001234", "primary": True}],
                },
                "labels": [{"name": "Avulso", "color": "orange"}],
            },
            {
                "id": 11,
                "name": "Rede Duplicada",
                "documentNumber": "11222333000181",
                "archived": False,
                "createdAt": "2022-09-06T15:00:00Z",
                "contacts": {"emails": [], "phones": []},
                "labels": [],
            },
            {
                "id": 12,
                "name": "Rede Antiga",
                "documentNumber": None,
                "archived": True,
                "createdAt": "2022-09-06T15:00:00Z",
                "contacts": {"emails": [], "phones": []},
                "labels": [],
            },
        ],
    )
    _write(
        folder,
        "localizacoes.json",
        [
            {
                "id": "loc-1",
                "name": "43 - Barra Teste",
                "customer": {"id": 10},
                "archived": False,
                "documentNumber": "11222333000262",
                "createdAt": "2022-09-06T15:00:00Z",
                "updatedAt": "2023-01-01T00:00:00Z",
                "address": {
                    "street": "Rua A",
                    "number": "10",
                    "complement": "Loja 2",
                    "neighborhood": "Centro",
                    "city": "São Paulo",
                    "state": "São Paulo",
                    "zipCode": "05503001",
                    "coords": {"latitude": -23.5, "longitude": -46.6},
                },
                "contacts": {
                    "phones": [{"name": "Gerente", "countryCode": "55", "number": "11987654321"}],
                    "emails": [],
                },
                "notes": "Entrada pelos fundos",
            },
            {
                "id": "loc-2",
                "name": "Matriz",
                "customer": {"id": 11},
                "archived": False,
                "createdAt": "2022-09-06T15:00:00Z",
                "updatedAt": "2023-01-01T00:00:00Z",
                "address": {
                    "city": "Rio de Janeiro",
                    "state": "RJ",
                    "coords": {"latitude": 0, "longitude": 0},
                },
                "contacts": {"phones": [], "emails": []},
            },
            {
                "id": "loc-x",
                "name": "Sem cliente",
                "customer": {"id": 999},
                "archived": False,
                "createdAt": "2022-09-06T15:00:00Z",
                "updatedAt": "2023-01-01T00:00:00Z",
                "address": {},
                "contacts": {},
            },
        ],
    )
    _write(
        folder,
        "servicos.json",
        [
            {"id": 1, "description": "Computador - Manutenção Preventiva", "duration": 120},
            {"id": 2, "description": "Instalação de PDV", "duration": 240},
        ],
    )
    _write(
        folder,
        "produtos.json",
        [
            {
                "id": "p-1",
                "name": "Velcro",
                "measure": "meter",
                "value": "12.5",
                "archived": False,
                "createdAt": "2023-01-01T00:00:00Z",
            },
            {
                "id": "p-2",
                "name": "velcro",
                "measure": "unity",
                "value": "3",
                "archived": False,
                "createdAt": "2023-01-01T00:00:00Z",
            },
        ],
    )
    _write(
        folder,
        "formularios_modelos.json",
        [
            {
                "id": "t-1",
                "name": "Preventiva",
                "archived": False,
                "createdAt": "2023-01-01T00:00:00Z",
                "questions": [
                    {
                        "id": "q-a",
                        "title": "O que foi feito",
                        "type": "paragraph",
                        "position": 0,
                        "required": True,
                    },
                    {
                        "id": "q-b",
                        "title": "Foto do rack",
                        "type": "multiple-picture",
                        "position": 1,
                        "required": True,
                    },
                    {
                        "id": "q-c",
                        "title": "Assinatura",
                        "type": "signature",
                        "position": 2,
                        "required": True,
                    },
                ],
            },
        ],
    )
    _write(
        folder,
        "sla_motivos_violacao.json",
        [{"id": "s-1", "name": "Cliente ausente", "archived": False}],
    )
    _write(folder, "prazo_motivos_violacao.json", [{"id": "d-1", "name": "Cliente ausente"}])
    _write(
        folder,
        "solicitacoes_tickets.json",
        [
            {
                "id": "r-1",
                "subject": "PDV parado",
                "message": "O caixa 3 não liga",
                "contact": {"email": "loja@rede.test", "phone": "11999990000"},
                "createdAt": "2026-10-01T08:50:00Z",
                "metadata": {"warg": {"serviceRequest": {"id": "sr-1"}}},
                "attachments": [
                    {"path": "https://files.example.test/pdv.jpg", "type": "image/jpeg"},
                    {"path": "accounts/1/services-requests/x/foto.png", "type": "image/png"},
                ],
            },
        ],
    )
    done_task = {
        "id": "task-a",
        "status": "done",
        "position": 0,
        "createdAt": "2026-10-01T09:30:00Z",
        "startedAt": "2026-10-01T13:00:00Z",
        "completedAt": "2026-10-01T15:00:00Z",
        "statusDescription": "Switch trocado",
        "employee": _emp(1),
        "duration": 120,
        "scheduling": {"date": "2026-10-01", "time": "10:00:00"},
        "totalPausedDuration": 0,
    }
    orders = [
        _order(
            "o-a",
            "101",
            tasks=[done_task],
            labels=[{"name": "Faturamento Matriz", "color": "purple"}],
            signature={
                "path": "https://files.example.test/sig.png",
                "signedAt": "2026-10-01T15:01:00Z",
                "signedBy": "Gerente da Loja",
            },
            metadata={"warg": {"serviceRequest": {"id": "sr-1"}}},
            productsV2={
                "items": [
                    {"item": {"name": "Velcro"}, "quantity": 2, "value": 12.5, "totalValue": 25}
                ]
            },
            productsTotalValue=25,
            totalValue=25,
            deadline={
                "responseAt": "2026-10-01T13:00:00Z",
                "solutionAt": "2026-10-02T09:00:00Z",
                "firstTaskStartedAt": "2026-10-01T13:00:00Z",
                "responseStatus": "completedOnSchedule",
                "solutionStatus": "completedOnSchedule",
                "responseViolationReason": {"id": None},
                "solutionViolationReason": {"id": "s-1"},
            },
        ),
        _order(
            "o-b",
            "205",
            tasks=[
                {
                    **done_task,
                    "id": "task-b",
                    "status": "scheduled",
                    "startedAt": None,
                    "completedAt": None,
                    "scheduling": {"date": "2026-11-20", "time": "10:00:00"},
                }
            ],
        ),
        _order(
            "o-c",
            "150",
            tasks=[
                {
                    **done_task,
                    "id": "task-c",
                    "status": "reported",
                    "completedAt": "2026-11-01T10:00:00Z",
                    "startedAt": "2026-11-01T09:00:00Z",
                    "statusDescription": "Loja fechada",
                }
            ],
        ),
        _order(
            "o-d",
            "120",
            createdAt="2026-01-10T09:00:00Z",
            tasks=[
                {
                    **done_task,
                    "id": "task-d",
                    "status": "pending",
                    "createdAt": "2026-01-10T10:00:00Z",
                    "startedAt": None,
                    "completedAt": None,
                    "scheduling": {"date": "2026-01-15", "time": None},
                }
            ],
        ),
        _order(
            "o-e",
            "X-77",
            createdAt="2026-11-01T09:00:00Z",
            service={"id": 2, "description": "Instalação de PDV", "duration": 240},
        ),
        _order("o-f", "130", status="canceled"),
    ]
    _write(folder, "ordens_de_servico.json", orders)
    _write(
        folder,
        "formularios_respondidos.json",
        [
            {
                "id": "fa-1",
                "name": "Preventiva",
                "reference": "t-1",
                "status": "done",
                "order": {"id": "o-a"},
                "createdAt": "2026-10-01T14:00:00Z",
                "completedAt": "2026-10-01T14:30:00Z",
                "createdByUser": {"id": "emp-1"},
                "questions": [
                    {
                        "id": "q-a",
                        "title": "O que foi feito",
                        "type": "paragraph",
                        "position": 0,
                        "answer": "Organizado",
                    },
                    {
                        "id": "q-b",
                        "title": "Foto do rack",
                        "type": "multiple-picture",
                        "position": 1,
                        "answer": "https://files.example.test/r1.jpg, https://files.example.test/r2.jpg",
                    },
                    {
                        "id": "q-c",
                        "title": "Assinatura",
                        "type": "signature",
                        "position": 2,
                        "answer": "https://files.example.test/s.png",
                    },
                ],
            },
            {
                "id": "fa-x",
                "name": "Órfão",
                "reference": "t-1",
                "status": "done",
                "order": {"id": "nao-existe"},
                "createdAt": "2026-10-01T14:00:00Z",
                "questions": [],
            },
        ],
    )
    _write(
        folder,
        "os_comentarios.json",
        [
            {
                "id": "c-1",
                "message": "Cliente pediu retorno",
                "createdAt": "2026-10-01T16:00:00Z",
                "order": {"id": "o-a"},
                "archived": False,
            },
            {
                "id": "c-2",
                "message": "Arquivado",
                "createdAt": "2026-10-01T16:00:00Z",
                "order": {"id": "o-a"},
                "archived": True,
            },
        ],
    )
    _write(
        folder,
        "orcamentos.json",
        [
            {
                "id": "q-1",
                "identifier": "ABCDEF1234",
                "name": "HD 500 GB",
                "status": "approved",
                "createdAt": "2026-10-01T10:00:00Z",
                "approvedAt": "2026-10-01T11:00:00Z",
                "approvedBy": "Gerente",
                "approvedMessage": "Pode executar",
                "approvedSignature": "https://files.example.test/q-sig.png",
                "expiredAt": "2026-10-08T10:00:00Z",
                "order": {"id": "o-a"},
                "subtotal": 300,
                "total": 280,
                "discount": {"type": "value", "value": 20, "total": 20},
                "items": [
                    {
                        "position": 0,
                        "quantity": 1,
                        "value": 250,
                        "total": 250,
                        "productService": {
                            "id": "p-1",
                            "name": "HD 500 GB",
                            "type": "product",
                            "measure": "unity",
                            "value": 250,
                        },
                    },
                    {
                        "position": 1,
                        "quantity": 1,
                        "value": 50,
                        "total": 50,
                        "productService": {
                            "id": "svc-9",
                            "name": "Hora técnica",
                            "type": "service",
                            "measure": None,
                            "value": 50,
                        },
                    },
                ],
                "attachments": [],
            },
            {
                "id": "q-2",
                "identifier": "SEMOS00001",
                "name": "Sem OS",
                "status": "expired",
                "createdAt": "2026-10-01T10:00:00Z",
                "order": None,
                "items": [],
                "attachments": [],
                "discount": {"total": 0},
            },
        ],
    )
    return folder


async def _run(engine: AsyncEngine, folder: Path, wipe: bool):
    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    async with maker() as db:
        report = await run_import(db, folder, wipe=wipe, stale_days=120, now=NOW)
        await db.commit()
    return report


async def _count(engine: AsyncEngine, model) -> int:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        return await db.scalar(select(func.count()).select_from(model)) or 0


@requires_db
async def test_full_import(
    client: AsyncClient, world: World, engine: AsyncEngine, export: Path
) -> None:
    report = await _run(engine, export, wipe=True)
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async with maker() as db:
        # A demonstração saiu; só o admin sobrou dos usuários antigos.
        old = set(await db.scalars(select(User.email).where(User.email.like("%@teste.com.br"))))
        assert old == {"admin@teste.com.br"}
        assert (
            await db.scalar(
                select(func.count()).select_from(Customer).where(Customer.name == "Cliente Teste")
            )
            == 0
        )

        users = {u.email: u for u in await db.scalars(select(User))}
        assert users["ana@empresa.test"].role == UserRole.SUPERVISOR  # admin no Field Control
        assert users["beto@empresa.test"].role == UserRole.ANALYST
        assert (
            users["tec1@teste.dev"].role == UserRole.TECHNICIAN
            and users["tec1@teste.dev"].is_active
        )
        assert users["tec1@teste.dev"].home_state == "SP"
        assert not users["tec3@teste.dev"].is_active
        assert users["tec1@teste.dev"].password_hash == UNUSABLE_PASSWORD
        # Mesmo e-mail no escritório e na equipe de campo: uma pessoa só.
        assert sum(1 for e in users if e == "ana@empresa.test") == 1

        customers = {c.name: c for c in await db.scalars(select(Customer))}
        assert customers["Rede Exemplo"].document == "11222333000181"
        assert customers["Rede Exemplo"].tags == [{"name": "Avulso", "color": "orange"}]
        assert customers["Rede Duplicada"].document is None
        assert "11222333000181" in (customers["Rede Duplicada"].notes or "")
        assert not customers["Rede Antiga"].is_active

        loc = await db.scalar(select(Location).where(Location.code == "43"))
        assert loc is not None and loc.name == "Barra Teste" and loc.state == "SP"
        assert loc.zip_code == "05503-001" and loc.contact_phone == "(11) 98765-4321"
        assert loc.address_line == "Rua A, 10 - Loja 2"
        matriz = await db.scalar(select(Location).where(Location.name == "Matriz"))
        assert matriz is not None and matriz.latitude is None  # 0,0 não é coordenada

        tickets = {t.number: t for t in await db.scalars(select(Ticket))}
        assert set(tickets) == {101, 205, 150, 120, 130, 206}  # "X-77" ganhou o próximo número
        a = tickets[101]
        assert a.status == TicketStatus.CLOSED and a.resolution_notes == "Switch trocado"
        assert a.arrived_at == datetime(2026, 10, 1, 13, tzinfo=UTC)
        assert a.work_seconds == 7200
        assert a.source.value == "portal" and a.tags == [
            {"name": "Faturamento Matriz", "color": "purple"}
        ]
        assert a.signer_name == "Gerente da Loja" and a.signature_attachment_id is not None
        assert a.legacy["identifier"] == "101" and a.legacy["request"]["subject"] == "PDV parado"
        assert len(a.legacy["files"]) == 2
        assert a.legacy["files"][1]["url"].startswith(
            "https://s3.amazonaws.com/attachments.fieldcontrol"
        )
        assert a.resolution_violation_reason_id is not None
        assert tickets[205].status == TicketStatus.SCHEDULED
        assert tickets[150].status == TicketStatus.ASSIGNED and tickets[150].unproductive_count == 1
        assert tickets[120].status == TicketStatus.CANCELLED
        assert tickets[120].legacy["migration_note"].startswith("Encerrada na migração")
        assert tickets[130].status == TicketStatus.CANCELLED
        assert (
            tickets[206].status == TicketStatus.NEW and tickets[206].legacy["identifier"] == "X-77"
        )

        form = await db.scalar(select(TicketForm).where(TicketForm.ticket_id == a.id))
        assert form is not None and form.answers.get("q-a") == "Organizado"
        photos = list(
            await db.scalars(select(TicketAttachment).where(TicketAttachment.form_id == form.id))
        )
        assert {p.external_url for p in photos} == {
            "https://files.example.test/r1.jpg",
            "https://files.example.test/r2.jpg",
            "https://files.example.test/s.png",
        }
        assert await db.scalar(select(func.count()).select_from(TicketComment)) == 1
        quote = await db.scalar(select(Quote))
        assert quote is not None and quote.status.value == "approved" and quote.ticket_id == a.id
        assert quote.legacy["identifier"] == "ABCDEF1234"
        assert {i["kind"] for i in quote.items} == {"product", "service"}

    assert report.counts["quotes"]["skipped_without_order"] == 1
    assert report.counts["locations"]["skipped_unknown_customer"] == 1
    assert report.counts["forms"]["skipped_unknown_order"] == 1
    assert report.counts["catalog_products"]["duplicate_name"] == 1

    # Arquivos externos: a lista de anexos devolve o link de origem (equipe e técnico da OS).
    tech = users["tec1@teste.dev"]
    tech_headers = {"Authorization": f"Bearer {create_access_token(str(tech.id), 'technician')}"}
    for headers in (world.admin.headers, tech_headers):
        res = await client.get(f"/api/v1/tickets/{a.id}/attachments", headers=headers)
        assert res.status_code == 200, res.text
        urls = {item["download_url"] for item in res.json()}
        assert "https://files.example.test/sig.png" in urls
        assert "https://files.example.test/r1.jpg" in urls

    # O link interno de download leva ao arquivo de origem.
    sig_id = str(a.signature_attachment_id)
    from app.core.security import create_download_token

    token = create_download_token(sig_id, str(tech.id))
    res = await client.get(f"/api/v1/attachments/{sig_id}/download", params={"token": token})
    assert (
        res.status_code == 307 and res.headers["location"] == "https://files.example.test/sig.png"
    )

    # Relatório do cliente: fotos e assinatura com o link de origem.
    res = await client.post(f"/api/v1/tickets/{a.id}/report-link", headers=world.admin.headers)
    assert res.status_code == 200, res.text
    public = await client.get(f"/api/v1/public/reports/{res.json()['token']}")
    assert public.status_code == 200, public.text
    body = public.json()
    assert body["signature"]["image_url"] == "https://files.example.test/sig.png"
    form_photos = [p["url"] for f in body["forms"] for i in f["items"] for p in i["photos"]]
    assert "https://files.example.test/r2.jpg" in form_photos

    # Dados de origem só para a equipe; etiquetas na lista.
    res = await client.get(f"/api/v1/tickets/{a.id}", headers=world.admin.headers)
    assert res.json()["legacy"]["values"]["total"] == 25.0
    listing = await client.get("/api/v1/tickets", params={"q": "101"}, headers=world.admin.headers)
    assert listing.json()["items"][0]["tags"][0]["name"] == "Faturamento Matriz"

    # A numeração continua depois do maior número importado.
    res = await client.post(
        "/api/v1/tickets",
        json={"title": "Primeira OS depois da migração"},
        headers=world.admin.headers,
    )
    assert res.status_code == 201, res.text
    assert res.json()["number"] == 207


@requires_db
async def test_import_is_idempotent(world: World, engine: AsyncEngine, export: Path) -> None:
    await _run(engine, export, wipe=True)
    before = {
        m.__name__: await _count(engine, m)
        for m in (
            User,
            Customer,
            Location,
            Ticket,
            TicketAttachment,
            TicketForm,
            TicketComment,
            Quote,
            LegacyRef,
        )
    }
    report = await _run(engine, export, wipe=False)
    after = {m: await _count(engine, globals()[m]) for m in before}
    assert after == before
    assert report.counts["tickets"]["skipped_existing"] == 6
    assert report.counts["customers"]["updated"] == 3
