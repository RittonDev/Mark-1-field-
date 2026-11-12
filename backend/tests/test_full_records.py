"""Fichas completas (técnico, cliente e loja), busca por palavras e cidades padronizadas.

Tudo com dados sintéticos: o export real nunca entra no repositório.
"""

import json
import uuid
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import UserRole
from app.importers.fieldcontrol import (
    SOURCE,
    address_parts,
    contacts_of,
    customer_legacy,
    territories_of,
    work_schedule_of,
)
from app.models import Customer, Location, ServiceType, User
from app.schemas.records import (
    ContactIn,
    WorkSchedule,
    dedupe_contacts,
    format_phone,
    primary_contact,
)
from app.services import cities, search
from tests.conftest import World, requires_db
from tests.test_fieldcontrol_import import _run, export  # noqa: F401 (fixture do export sintético)

API = settings.API_PREFIX


# ---------------------------------------------------------------------- regras puras


def test_contacts_from_field_control() -> None:
    raw = {
        "emails": [
            {"address": "Loja@Rede.TEST", "primary": True, "type": "work", "name": "Gerente"},
            {"address": "loja@rede.test"},  # repetido (só muda a caixa)
            {"address": "  "},
        ],
        "phones": [
            {"countryCode": "55", "number": "(11) 98765-4321", "type": "mobile", "primary": True},
            {"countryCode": "55", "number": "5511987654321"},  # o mesmo, já com DDI
            {"number": "1130001234", "type": "work", "name": "Recepção"},  # sem DDI: Brasil
            {"countryCode": "1", "number": "2025550123"},
            {"countryCode": "55", "number": ""},
        ],
    }
    assert contacts_of(raw) == [
        {
            "kind": "email",
            "value": "loja@rede.test",
            "name": "Gerente",
            "label": "work",
            "primary": True,
        },
        {
            "kind": "phone",
            "value": "5511987654321",
            "name": None,
            "label": "mobile",
            "primary": True,
        },
        {
            "kind": "phone",
            "value": "551130001234",
            "name": "Recepção",
            "label": "work",
            "primary": False,
        },
        {"kind": "phone", "value": "12025550123", "name": None, "label": None, "primary": False},
    ]
    assert contacts_of(None) == [] and contacts_of({"emails": None}) == []


def test_contact_input_rules() -> None:
    email = ContactIn(kind="email", value=" Compras@Cliente.TEST ", label=" Work ")
    assert (email.value, email.label) == ("compras@cliente.test", "work")
    assert ContactIn(kind="phone", value="(85) 3333-2222").value == "558533332222"
    assert ContactIn(kind="phone", value="+55 85 99999-1111").value == "5585999991111"
    assert ContactIn(kind="phone", value="+1 202 555 0123").value == "12025550123"
    for bad in ({"kind": "email", "value": "sem-arroba"}, {"kind": "phone", "value": "12-34"}):
        with pytest.raises(ValidationError):
            ContactIn(**bad)
    with pytest.raises(ValidationError):
        ContactIn(kind="fax", value="1133334444")

    contacts = dedupe_contacts(
        [
            ContactIn(kind="phone", value="85 3333-2222"),
            ContactIn(kind="phone", value="+55 (85) 3333-2222", primary=True),
            ContactIn(kind="email", value="a@b.test"),
        ]
    )
    assert [c["value"] for c in contacts] == ["558533332222", "a@b.test"]
    assert contacts[0]["primary"] is True  # o repetido marcado como principal passa a marca
    assert primary_contact(contacts, "phone")["value"] == "558533332222"
    # Nenhum e-mail marcado como principal: vale o primeiro do tipo.
    assert primary_contact(contacts, "email")["value"] == "a@b.test"
    assert primary_contact([], "email") is None
    assert format_phone("5511987654321") == "(11) 98765-4321"
    assert format_phone("551130001234") == "(11) 3000-1234"
    assert format_phone("") is None


def test_work_schedule_times() -> None:
    schedule = WorkSchedule(start="08:00", end="17:30:15", break_start=" ", break_end=None)
    assert schedule.model_dump() == {
        "start": "08:00:00",
        "end": "17:30:15",
        "break_start": None,
        "break_end": None,
    }
    for bad in ("24:00", "8:00", "08h00", "12:60"):
        with pytest.raises(ValidationError):
            WorkSchedule(start=bad)
    assert work_schedule_of(
        {"start": "08:00:00", "end": "18:00:00", "break": {"start": "12:00:00", "end": "13:00:00"}}
    ) == {
        "start": "08:00:00",
        "end": "18:00:00",
        "break_start": "12:00:00",
        "break_end": "13:00:00",
    }
    assert work_schedule_of({"break": {}}) is None and work_schedule_of(None) is None


def test_customer_origin_and_address() -> None:
    legacy = customer_legacy(
        {
            "id": 10,
            "createdAt": "2022-09-06T15:00:00Z",
            "statistics": {
                "rating": {"averageStars": 4.5, "lastStar": 5, "lastComment": "Ótimo"},
                "service": {"firstAt": "2022-10-01T10:00:00Z", "lastAt": None, "total": 42},
            },
            "attachments": [
                {"path": "accounts/1/customers/contrato.pdf", "title": "Contrato", "type": "pdf"},
                {"path": "https://files.example.test/velho.pdf", "archived": True},
                None,
            ],
        }
    )
    assert legacy == {
        "source": SOURCE,
        "id": 10,
        "created_at": "2022-09-06T15:00:00Z",
        "rating": {"average": 4.5, "last_star": 5, "last_comment": "Ótimo"},
        "service": {"first_at": "2022-10-01T10:00:00Z", "last_at": None, "total": 42},
        "attachments": [
            {
                "url": "https://s3.amazonaws.com/attachments.fieldcontrol.com.br/"
                "accounts/1/customers/contrato.pdf",
                "title": "Contrato",
                "type": "pdf",
            }
        ],
    }
    empty = customer_legacy({"id": 11})
    assert empty["rating"] is None and empty["service"] is None and empty["attachments"] == []

    assert address_parts(
        {
            "street": "Av. Paulista",
            "number": "1000",
            "complement": "10º andar",
            "neighborhood": "Bela Vista",
            "city": "São Paulo",
            "state": "São Paulo",
            "zipCode": "01310100",
        }
    ) == {
        "line": "Av. Paulista, 1000 - 10º andar",
        "district": "Bela Vista",
        "city": "São Paulo",
        "state": "SP",
        "zip": "01310-100",
    }
    assert address_parts({})["line"] is None
    assert territories_of(
        {"territories": [{"name": "Nordeste"}], "subTerritories": [{"name": "CE"}, "Nordeste"]}
    ) == ["Nordeste", "CE"]


def test_search_words() -> None:
    assert search.words("Le Biscuit - Shopping Iguatemi,  FORTALEZA") == [
        "le",
        "biscuit",
        "shopping",
        "iguatemi",
        "fortaleza",
    ]
    assert search.words("11.222.333/0001-81") == ["11", "222", "333", "0001", "81"]
    assert search.words("São João") == ["sao", "joao"]
    assert search.words("  - ") == [] and search.words(None) == []
    assert search.all_words("  ", []) is None


def test_city_spelling_rules() -> None:
    assert cities.title_pt("SAO BERNARDO DO CAMPO") == "Sao Bernardo do Campo"
    assert cities.title_pt("SANTA BARBARA D'OESTE") == "Santa Barbara d'Oeste"
    assert cities.title_pt("SÃO JOÃO DEL-REI") == "São João del-Rei"
    assert cities.title_pt("embu-guaçu") == "Embu-Guaçu"
    assert cities.title_pt("E DOS ANJOS") == "E dos Anjos"  # conector só minúsculo no meio

    # A grafia de nome próprio ganha da mais usada em maiúsculas.
    assert cities.canonical(Counter({"FORTALEZA": 10, "Fortaleza": 3})) == "Fortaleza"
    # Entre as de nome próprio, a acentuada (mesmo sendo menos usada).
    assert (
        cities.canonical(
            Counter(
                {
                    "SAO BERNARDO DO CAMPO": 50,
                    "Sao Bernardo do Campo": 7,
                    "São Bernardo do Campo": 2,
                }
            )
        )
        == "São Bernardo do Campo"
    )
    # Só em maiúsculas tem acento: vira título pt-BR dela.
    assert cities.canonical(Counter({"Sao Paulo": 500, "SÃO PAULO": 3})) == "São Paulo"
    # Conector maiúsculo ou palavra toda minúscula não é grafia de nome próprio.
    assert cities.canonical(Counter({"Rio De Janeiro": 9, "RIO DE JANEIRO": 1})) == (
        "Rio de Janeiro"
    )
    assert cities.canonical(Counter({"rio de janeiro": 2})) == "Rio de Janeiro"
    assert cities.canonical(Counter({"Sao paulo": 4, "SAO PAULO": 1})) == "Sao Paulo"
    assert cities.canonical(Counter({"Natal": 1})) == "Natal"


# ---------------------------------------------------------------------- importação


def _patch(folder: Path, name: str, change: Callable[[list[dict]], None]) -> None:
    path = folder / name
    rows = json.loads(path.read_text(encoding="utf-8"))
    change(rows)
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")


def _full_technician(rows: list[dict]) -> None:
    one = rows[0]  # "Técnico Um"
    one["address"] = {
        "street": "Rua das Flores",
        "number": "100",
        "complement": "Casa 2",
        "neighborhood": "Vila Nova",
        "city": "SAO PAULO",
        "state": "São Paulo",
        "zipCode": "01001000",
        "coords": {"latitude": -23.55, "longitude": -46.63},
    }
    one["workSchedule"] = {
        "start": "08:00:00",
        "end": "18:00:00",
        "break": {"start": "12:00:00", "end": "13:00:00"},
    }
    one["skills"] = [{"serviceId": 1}, {"serviceId": 2}, {"serviceId": 1}, {"serviceId": 999}]
    one["avatarUrl"] = "https://files.example.test/tec1.jpg"
    one["territories"] = [{"name": "Grande SP"}]
    one["subTerritories"] = [{"name": "Zona Sul"}, {"name": "Grande SP"}]
    # 21 colaboradores no mesmo ponto: é o endereço padrão do escritório, não a casa deles.
    for n in range(21):
        rows.append(
            {
                "id": 100 + n,
                "_id": f"emp-{100 + n}",
                "name": f"Padrão {n}",
                "email": f"padrao{n}@teste.dev",
                "isInactivatedOrFired": False,
                "address": {
                    "street": "Av. do Escritório",
                    "number": "1",
                    "neighborhood": "Centro",
                    "city": "Fortaleza",
                    "state": "CE",
                    "zipCode": "60000000",
                    "coords": {"latitude": -3.73, "longitude": -38.52},
                },
            }
        )


def _full_customers(rows: list[dict]) -> None:
    rede = rows[0]  # "Rede Exemplo"
    rede["contacts"] = {
        "emails": [
            {"address": "Contato@Rede.test", "primary": True, "type": "work"},
            {"address": "financeiro@rede.test", "name": "Financeiro", "type": "work"},
            {"address": "CONTATO@rede.test"},
        ],
        "phones": [
            {"countryCode": "55", "number": "1130001234", "primary": True, "type": "work"},
            {"countryCode": "55", "number": "11987650000", "type": "mobile", "name": "Compras"},
        ],
    }
    rede["address"] = {
        "street": "Av. Paulista",
        "number": "1000",
        "complement": "10º andar",
        "neighborhood": "Bela Vista",
        "city": "SAO PAULO",
        "state": "São Paulo",
        "zipCode": "01310100",
        "coords": {"latitude": -23.5614, "longitude": -46.6559},
    }
    rede["avatarUrl"] = "https://files.example.test/logo.png"
    rede["statistics"] = {
        "rating": {"averageStars": 4.5, "lastStar": 5, "lastComment": "Ótimo atendimento"},
        "service": {
            "firstAt": "2022-10-01T10:00:00Z",
            "lastAt": "2026-10-01T10:00:00Z",
            "total": 42,
        },
    }
    rede["attachments"] = [
        {"path": "accounts/1/customers/contrato.pdf", "title": "Contrato", "type": "pdf"},
        {"path": "https://files.example.test/velho.pdf", "title": "Velho", "archived": True},
    ]
    # Matriz com o ponto 0,0: endereço fica, coordenada não.
    rows[1]["address"] = {
        "city": "Rio de Janeiro",
        "state": "RJ",
        "coords": {"latitude": 0, "longitude": 0},
    }


def _full_locations(rows: list[dict]) -> None:
    loc = rows[0]  # "43 - Barra Teste"
    loc["contacts"]["emails"] = [{"address": "Loja43@Rede.test", "name": "Loja 43"}]
    loc["contacts"]["phones"].append({"countryCode": "55", "number": "1133334444", "type": "work"})
    loc["territories"] = [{"name": "SP Capital"}]
    # A mesma cidade com outra grafia, na mesma UF.
    rows.append(
        {
            "id": "loc-3",
            "name": "44 - Paulista",
            "customer": {"id": 10},
            "archived": False,
            "createdAt": "2021-05-05T10:00:00Z",
            "updatedAt": "2023-01-01T00:00:00Z",
            "address": {"city": "SAO PAULO", "state": "SP"},
            "contacts": {"phones": [], "emails": []},
        }
    )


@requires_db
async def test_import_fills_full_records(
    world: World,
    engine: AsyncEngine,
    export: Path,  # noqa: F811
) -> None:
    _patch(export, "colaboradores.json", _full_technician)
    _patch(export, "clientes.json", _full_customers)
    _patch(export, "localizacoes.json", _full_locations)
    report = await _run(engine, export, wipe=True)
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async with maker() as db:
        rede = await db.scalar(select(Customer).where(Customer.name == "Rede Exemplo"))
        assert rede is not None
        assert [(c["kind"], c["value"]) for c in rede.contacts] == [
            ("email", "contato@rede.test"),
            ("email", "financeiro@rede.test"),
            ("phone", "551130001234"),
            ("phone", "5511987650000"),
        ]
        assert rede.contacts[0]["primary"] and rede.contacts[0]["label"] == "work"
        assert (rede.contacts[3]["name"], rede.contacts[3]["label"]) == ("Compras", "mobile")
        # Os campos únicos seguem o contato principal.
        assert (rede.email, rede.phone) == ("contato@rede.test", "(11) 3000-1234")
        assert (rede.address_line, rede.district, rede.city, rede.state, rede.zip_code) == (
            "Av. Paulista, 1000 - 10º andar",
            "Bela Vista",
            "São Paulo",  # "SAO PAULO" com a grafia da loja de SP
            "SP",
            "01310-100",
        )
        assert (rede.latitude, rede.longitude) == (-23.5614, -46.6559)
        assert rede.logo_url == "https://files.example.test/logo.png"
        assert rede.created_at == datetime(2022, 9, 6, 15, tzinfo=UTC)
        assert rede.legacy["source"] == SOURCE and rede.legacy["id"] == 10
        assert rede.legacy["rating"]["average"] == 4.5 and rede.legacy["service"]["total"] == 42
        assert [a["title"] for a in rede.legacy["attachments"]] == ["Contrato"]
        dup = await db.scalar(select(Customer).where(Customer.name == "Rede Duplicada"))
        assert dup is not None and dup.city == "Rio de Janeiro" and dup.latitude is None

        loc = await db.scalar(select(Location).where(Location.code == "43"))
        assert loc is not None
        assert [(c["kind"], c["value"]) for c in loc.contacts] == [
            ("email", "loja43@rede.test"),
            ("phone", "5511987654321"),
            ("phone", "551133334444"),
        ]
        assert (loc.contact_name, loc.contact_phone) == ("Gerente", "(11) 98765-4321")
        assert loc.legacy == {
            "source": SOURCE,
            "id": "loc-1",
            "created_at": "2022-09-06T15:00:00Z",
            "territories": ["SP Capital"],
        }
        paulista = await db.scalar(select(Location).where(Location.code == "44"))
        assert paulista is not None and paulista.city == "São Paulo"
        assert paulista.created_at == datetime(2021, 5, 5, 10, tzinfo=UTC)

        tec = await db.scalar(select(User).where(User.email == "tec1@teste.dev"))
        assert tec is not None
        assert (tec.address_line, tec.address_district, tec.address_zip) == (
            "Rua das Flores, 100 - Casa 2",
            "Vila Nova",
            "01001-000",
        )
        assert (tec.home_city, tec.home_state) == ("São Paulo", "SP")
        assert tec.work_schedule == {
            "start": "08:00:00",
            "end": "18:00:00",
            "break_start": "12:00:00",
            "break_end": "13:00:00",
        }
        assert tec.avatar_external_url == "https://files.example.test/tec1.jpg"
        assert tec.legacy == {"source": SOURCE, "id": 1, "territories": ["Grande SP", "Zona Sul"]}
        names = dict((await db.execute(select(ServiceType.id, ServiceType.name))).all())
        assert [names[uuid.UUID(sid)] for sid in tec.service_type_ids] == [
            "Computador - Manutenção Preventiva",
            "Instalação de PDV",
        ]
        # Endereço padrão do escritório não vira a casa de ninguém.
        padrao = await db.scalar(select(User).where(User.email == "padrao0@teste.dev"))
        assert padrao is not None
        assert (padrao.address_line, padrao.address_district, padrao.address_zip) == (
            None,
            None,
            None,
        )
        assert padrao.home_city is None and padrao.work_schedule is None
        assert padrao.service_type_ids == []
        # Sem jornada é NULL no banco (não o null do JSON).
        no_schedule = await db.scalar(
            select(func.count())
            .select_from(User)
            .where(User.role == UserRole.TECHNICIAN, User.work_schedule.is_(None))
        )
        assert no_schedule == 22  # os 21 do ponto padrão e o Técnico Três

    technicians = report.counts["technicians"]
    assert (technicians["with_address"], technicians["with_schedule"]) == (1, 1)
    assert technicians["with_services"] == 1 and technicians["home_placeholder_cleared"] == 21
    assert report.counts["customers"]["with_2plus_contacts"] == 1
    assert report.counts["locations"]["with_2plus_contacts"] == 1
    assert report.counts["cities_normalized"] == Counter(
        {"locations.city": 1, "customers.city": 1, "users.home_city": 1}
    )

    # Nova rodada: o cadastro de origem mudou e a ficha acompanha.
    def customers_again(rows: list[dict]) -> None:
        rows[0]["contacts"] = {"emails": [{"address": "Novo@Rede.test"}], "phones": []}
        rows[0]["createdAt"] = "2020-01-02T03:00:00Z"

    def technicians_again(rows: list[dict]) -> None:
        rows[0]["workSchedule"] = {"start": "07:00:00", "end": "16:00:00"}
        rows[0]["skills"] = [{"serviceId": 2}]

    _patch(export, "clientes.json", customers_again)
    _patch(export, "colaboradores.json", technicians_again)
    report = await _run(engine, export, wipe=False)
    async with maker() as db:
        rede = await db.scalar(select(Customer).where(Customer.name == "Rede Exemplo"))
        assert rede is not None
        assert [c["value"] for c in rede.contacts] == ["novo@rede.test"]
        assert (rede.email, rede.phone) == ("novo@rede.test", None)
        assert rede.created_at == datetime(2020, 1, 2, 3, tzinfo=UTC)
        tec = await db.scalar(select(User).where(User.email == "tec1@teste.dev"))
        assert tec is not None and tec.work_schedule == {
            "start": "07:00:00",
            "end": "16:00:00",
            "break_start": None,
            "break_end": None,
        }
        assert [names[uuid.UUID(sid)] for sid in tec.service_type_ids] == ["Instalação de PDV"]
        assert tec.home_city == "São Paulo"
    assert report.counts["customers"]["updated"] == 3


# ---------------------------------------------------------------------- API


@requires_db
async def test_technician_record_api(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        preventive = ServiceType(name="Preventiva", estimated_minutes=120)
        install = ServiceType(name="Instalação", estimated_minutes=240)
        db.add_all([preventive, install])
        await db.commit()
    url = f"{API}/technicians/{world.tech.user.id}"

    r = await client.patch(
        url,
        json={
            "address_line": "  Rua das Flores, 100  ",
            "address_district": "Centro",
            "address_zip": "60000000",
            "work_schedule": {
                "start": "08:00",
                "end": "17:30",
                "break_start": "12:00",
                "break_end": "13:00:00",
            },
            "service_type_ids": [str(preventive.id), str(install.id), str(preventive.id)],
        },
        headers=an,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["address_line"], body["address_district"], body["address_zip"]) == (
        "Rua das Flores, 100",
        "Centro",
        "60000-000",
    )
    assert body["work_schedule"] == {
        "start": "08:00:00",
        "end": "17:30:00",
        "break_start": "12:00:00",
        "break_end": "13:00:00",
    }
    assert body["services"] == [
        {"id": str(preventive.id), "name": "Preventiva"},
        {"id": str(install.id), "name": "Instalação"},
    ]

    bad_time = await client.patch(url, json={"work_schedule": {"start": "25:00"}}, headers=an)
    assert bad_time.status_code == 422 and "Horário inválido" in bad_time.text
    unknown = await client.patch(
        url, json={"service_type_ids": [str(install.id), str(uuid.uuid4())]}, headers=an
    )
    assert unknown.status_code == 422 and "Tipo de serviço não encontrado" in unknown.text

    # Jornada em branco e lista vazia limpam a ficha.
    r = await client.patch(
        url, json={"work_schedule": {"start": "", "end": None}, "service_type_ids": []}, headers=an
    )
    assert r.status_code == 200, r.text
    assert r.json()["work_schedule"] is None and r.json()["services"] == []
    assert r.json()["address_line"] == "Rua das Flores, 100"  # o que não veio fica

    # Sem foto enviada aqui, vale a do Field Control; a origem aparece para a equipe.
    async with maker() as db:
        await db.execute(
            update(User)
            .where(User.id == world.tech.user.id)
            .values(
                avatar_external_url="https://files.example.test/foto.jpg",
                legacy={"source": SOURCE, "id": 7, "territories": ["Litoral"]},
            )
        )
        await db.commit()
    listing = await client.get(f"{API}/technicians", headers=an)
    item = next(t for t in listing.json() if t["id"] == str(world.tech.user.id))
    assert item["avatar_url"] == "https://files.example.test/foto.jpg"
    assert item["legacy"]["territories"] == ["Litoral"]


@requires_db
async def test_contacts_keep_single_fields_in_sync(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    r = await client.patch(
        f"{API}/customers/{world.customer_id}",
        json={
            "contacts": [
                {"kind": "phone", "value": "(85) 99999-1111", "label": "Mobile"},
                {"kind": "email", "value": " Compras@Cliente.TEST ", "name": "Compras"},
                {"kind": "phone", "value": "+55 85 3333-2222", "primary": True},
                {"kind": "email", "value": "compras@cliente.test", "primary": True},
            ],
            "address_line": "Av. Beira Mar, 500",
            "city": "Fortaleza",
            "state": "CE",
        },
        headers=an,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert [(c["kind"], c["value"]) for c in body["contacts"]] == [
        ("phone", "5585999991111"),
        ("email", "compras@cliente.test"),
        ("phone", "558533332222"),
    ]
    assert body["contacts"][0]["label"] == "mobile"
    assert (body["email"], body["phone"]) == ("compras@cliente.test", "(85) 3333-2222")
    assert (body["address_line"], body["city"]) == ("Av. Beira Mar, 500", "Fortaleza")

    # O campo único enviado junto vale mais que o principal da lista.
    r = await client.patch(
        f"{API}/customers/{world.customer_id}",
        json={
            "email": "financeiro@cliente.test",
            "contacts": [{"kind": "email", "value": "outro@cliente.test"}],
        },
        headers=an,
    )
    assert (r.json()["email"], r.json()["phone"]) == ("financeiro@cliente.test", None)

    r = await client.patch(
        f"{API}/locations/{world.location_id}",
        json={
            "contacts": [
                {"kind": "email", "value": "loja@cliente.test", "name": "Loja"},
                {"kind": "phone", "value": "85 98888-7777", "name": "Gerente Ana"},
            ]
        },
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert (r.json()["contact_name"], r.json()["contact_phone"]) == (
        "Gerente Ana",
        "(85) 98888-7777",
    )
    assert len(r.json()["contacts"]) == 2

    bad = await client.patch(
        f"{API}/customers/{world.customer_id}",
        json={"contacts": [{"kind": "email", "value": "sem-arroba"}]},
        headers=an,
    )
    assert bad.status_code == 422

    # Dados de origem só para a equipe interna.
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        await db.execute(
            update(Customer)
            .where(Customer.id == uuid.UUID(world.customer_id))
            .values(legacy={"source": SOURCE, "id": 10, "rating": None})
        )
        await db.commit()
    staff = await client.get(f"{API}/customers/{world.customer_id}", headers=an)
    assert staff.json()["legacy"]["id"] == 10
    outside = await client.get(
        f"{API}/customers/{world.customer_id}", headers=world.requester.headers
    )
    assert outside.status_code == 200 and outside.json()["legacy"] is None


@requires_db
async def test_word_search(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    an = world.analyst.headers
    maker = async_sessionmaker(engine, expire_on_commit=False)
    iguatemi = "Le Biscuit - Shopping Iguatemi Fortaleza"
    north = "Le Biscuit - North Shopping"
    salvador = "Le Biscuit - Shopping Iguatemi Salvador"
    async with maker() as db:
        brand = Customer(name="Comercial Le Biscuit S.A.", document="12345678000190")
        house = Customer(name="Biscuit House")
        db.add_all([brand, house])
        await db.flush()
        db.add_all(
            [
                Location(
                    customer_id=brand.id,
                    name=iguatemi,
                    code="120",
                    city="Fortaleza",
                    state="CE",
                    document="12345678000271",
                ),
                Location(customer_id=brand.id, name=north, code="121", city="Fortaleza"),
                Location(customer_id=brand.id, name=salvador, code="300", city="Salvador"),
                Location(customer_id=house.id, name="Loja 120 Centro", code="999", city="Recife"),
            ]
        )
        for name, email in (
            ("Ana Técnica", "ana.tecnica@campo.test"),
            ("Técnico Bruno", "bruno@campo.test"),
        ):
            db.add(
                User(
                    name=name,
                    email=email,
                    password_hash="x",
                    role=UserRole.TECHNICIAN,
                    is_active=True,
                )
            )
        await db.execute(
            update(User).where(User.id == world.tech.user.id).values(phone="(85) 98888-7777")
        )
        await db.commit()

    async def stores(q: str) -> list[str]:
        r = await client.get(f"{API}/locations", params={"q": q}, headers=an)
        assert r.status_code == 200, r.text
        return [item["name"] for item in r.json()["items"]]

    assert await stores("Le Biscuit Iguatemi Fortaleza") == [iguatemi]
    assert set(await stores("iguatemi LE BISCUIT")) == {iguatemi, salvador}  # qualquer ordem
    assert await stores("íguatemi FORTALÉZA") == [iguatemi]  # sem acento e sem caixa
    assert set(await stores("biscuit fortaleza")) == {iguatemi, north}  # cidade conta
    assert await stores("comercial salvador") == [salvador]  # nome do cliente conta
    assert await stores("12.345.678/0002-71") == [iguatemi]  # documento com pontuação
    assert await stores("iguatemi recife") == []
    by_code = await stores("120")
    assert by_code[0] == iguatemi and "Loja 120 Centro" in by_code  # código exato primeiro

    async def customers(q: str) -> list[str]:
        r = await client.get(f"{API}/customers", params={"q": q}, headers=an)
        assert r.status_code == 200, r.text
        return [item["name"] for item in r.json()]

    # Nome que começa com a busca vem antes.
    assert await customers("biscuit") == ["Biscuit House", "Comercial Le Biscuit S.A."]
    assert await customers("le biscuit comercial") == ["Comercial Le Biscuit S.A."]
    assert await customers("12.345.678/0001-90") == ["Comercial Le Biscuit S.A."]
    assert await customers("biscuit 0001") == ["Comercial Le Biscuit S.A."]

    async def technicians(q: str) -> list[str]:
        r = await client.get(f"{API}/technicians", params={"q": q}, headers=an)
        assert r.status_code == 200, r.text
        return [item["name"] for item in r.json()]

    assert set(await technicians("TÉCNICO")) == {"Tecnico", "Técnico Bruno"}
    assert (await technicians("tecnic"))[-1] == "Ana Técnica"  # começa com a busca: antes
    assert await technicians("98888 7777") == ["Tecnico"]  # telefone
    assert await technicians("campo bruno") == ["Técnico Bruno"]  # e-mail + nome
    assert await technicians("teste redes") == ["Redes"]


# ---------------------------------------------------------------------- cidades


@requires_db
async def test_normalize_cities_in_db(world: World, engine: AsyncEngine) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    customer_id = uuid.UUID(world.customer_id)
    async with maker() as db:
        await db.execute(
            update(Customer)
            .where(Customer.id == customer_id)
            .values(city="SAO BERNARDO DO CAMPO", state="SP")
        )
        for name, city, state in (
            ("L1", "FORTALEZA", "CE"),
            ("L2", "FORTALEZA ", "CE"),
            ("L3", "Fortaleza", "CE"),
            ("L4", "fortaleza", "RN"),  # outra UF: outro grupo
            ("L5", "São Bernardo do Campo", "SP"),
            ("L6", "SANTA BARBARA D'OESTE", "SP"),
        ):
            db.add(Location(customer_id=customer_id, name=name, city=city, state=state))
        await db.execute(
            update(User)
            .where(User.id == world.tech.user.id)
            .values(
                home_city="Sao Bernardo do Campo",
                home_state="SP",
                base_city="FORTALEZA",
                base_state="CE",
            )
        )
        await db.commit()

    async with maker() as db:
        changed = await cities.normalize_all(db)
        await db.commit()
    assert changed == {
        "locations.city": 4,
        "customers.city": 1,
        "users.home_city": 1,
        "users.base_city": 1,
    }
    async with maker() as db:
        rows = dict(
            (await db.execute(select(Location.name, Location.city).where(Location.name != "Matriz")))
            .tuples()
            .all()
        )
        assert rows == {
            "L1": "Fortaleza",
            "L2": "Fortaleza",
            "L3": "Fortaleza",
            "L4": "Fortaleza",
            "L5": "São Bernardo do Campo",
            "L6": "Santa Barbara d'Oeste",
        }
        assert await db.scalar(select(Customer.city).where(Customer.id == customer_id)) == (
            "São Bernardo do Campo"
        )
        tech = await db.get(User, world.tech.user.id)
        assert tech is not None
        assert (tech.home_city, tech.base_city) == ("São Bernardo do Campo", "Fortaleza")
        # Já padronizado: nada muda na segunda vez.
        assert await cities.normalize_all(db) == {}
