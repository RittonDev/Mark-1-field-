"""Cadastro V2 pelo app (PATCH /me/profile): dados pessoais, endereço em partes, empresa, veículo,
e-mail pendente até o link, os grupos e o histórico; e as validações de schemas/personal.py.

Só dados fictícios: Tecnico Alfa, CPF 12345678909, CNPJ 12.345.678/0001-95, placa ABC1D23,
Cidade Exemplo, @exemplo.com.
"""

from datetime import date, timedelta

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import EmailStatus, EmailTemplate
from app.db.base import utcnow
from app.models import AccountToken, EmailOutbox, User
from app.schemas import personal
from app.services import mail, my_profile
from tests.conftest import MailBox, World, requires_db
from tests.test_my_profile import PASSWORD, history, messages, patch
from tests.test_payout_methods import OTHER_CPF

API = settings.API_PREFIX
CPF = "12345678909"
CNPJ = "12345678000195"
TODAY = date(2026, 11, 25)


async def stored(engine: AsyncEngine, world: World) -> User:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        return user


async def set_user(engine: AsyncEngine, world: World, **values: object) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        for key, value in values.items():
            setattr(user, key, value)
        await db.commit()


def ok(r: Response) -> dict:
    assert r.status_code == 200, r.text
    return r.json()


def coded(r: Response) -> tuple[int, str, str | None]:
    data = r.json()
    return r.status_code, data["detail"], data.get("code")


# ------------------------------------------------------------------ sem banco


def test_plate_formats() -> None:
    assert personal.plate("abc-1234") == "ABC1234"
    assert personal.format_plate("ABC1234") == "ABC-1234"
    assert personal.plate(" abc1d23 ") == "ABC1D23"
    assert personal.format_plate("ABC1D23") == "ABC1D23"
    for bad in ("AB12345", "ABCD123", "ABC12345"):
        with pytest.raises(ValueError, match=personal.PLATE_INVALID):
            personal.plate(bad)
    assert personal.plate("  ") is None and personal.format_plate(None) is None


def test_birth_date_limits() -> None:
    """De 18 a 90 anos no dia de Brasília (hoje 2026-11-25 nos casos do contrato)."""
    assert personal.birth_date("2008-11-25", TODAY) == date(2008, 11, 25)
    assert personal.birth_date("1936-11-25", TODAY) == date(1936, 11, 25)
    with pytest.raises(ValueError, match=personal.BIRTH_UNDERAGE):
        personal.birth_date("2008-11-26", TODAY)
    with pytest.raises(ValueError, match=personal.BIRTH_INVALID):
        personal.birth_date("1935-11-24", TODAY)
    for bad in ("2026-02-30", "25/11/1990", "1990-1-5"):
        with pytest.raises(ValueError, match=personal.BIRTH_INVALID):
            personal.birth_date(bad, TODAY)
    assert personal.age_at(date(2008, 11, 25), TODAY) == 18
    assert personal.age_at(date(2008, 11, 26), TODAY) == 17
    assert personal.birth_date("", TODAY) is None and personal.birth_date(None, TODAY) is None


def test_personal_validators() -> None:
    assert personal.rg_number("12.345.678-x") == "12.345.678-X"
    assert personal.rg_number("MG-12.345.678") == "MG-12.345.678"
    for bad in ("123", "AB-12C", "1" * 21):
        with pytest.raises(ValueError, match=personal.RG_INVALID):
            personal.rg_number(bad)
    assert personal.rg_issuer(" ssp ") == "SSP"
    assert personal.rg_issuer("Polícia  Civil") == "POLICIA CIVIL"
    for bad in ("S", "Secretaria de Segurança", "S/SP", "/", "ABCDEFGHIJKLMNOPQRSTU/SP"):
        with pytest.raises(ValueError, match=personal.ISSUER_INVALID):  # 2 a 20 letras
            personal.rg_issuer(bad)
    assert personal.uf("sp") == "SP"
    with pytest.raises(ValueError, match=personal.UF_INVALID):
        personal.uf("XX")
    # RG: os três ou nenhum (sem o número, nenhum).
    assert personal.rg_group(None, "SSP", "SP") == (None, None, None)
    assert personal.rg_group("12.345.678-9", "ssp", "sp") == ("12.345.678-9", "SSP", "SP")
    with pytest.raises(ValueError, match=personal.RG_INCOMPLETE):
        personal.rg_group("12.345.678-9", None, "SP")
    # Empresa: os nomes pedem o CNPJ.
    with pytest.raises(ValueError, match=personal.COMPANY_WITHOUT_CNPJ):
        personal.company_group(None, "Empresa Exemplo", None)
    assert personal.company_group("12.345.678/0001-95", " Empresa  Exemplo ", None) == (
        CNPJ,
        "Empresa Exemplo",
        None,
    )
    with pytest.raises(ValueError, match=personal.CNPJ_INVALID):
        personal.cnpj("12.345.678/0001-96")
    assert personal.cpf("123.456.789-09") == CPF
    for bad in ("123.456.789-00", "12345678909a", "111.111.111-11"):
        with pytest.raises(ValueError, match=personal.CPF_INVALID):
            personal.cpf(bad)
    assert personal.phone("11988887777") == "(11) 98888-7777"
    with pytest.raises(ValueError, match=personal.PHONE_INVALID):
        personal.phone("98888-777")
    with pytest.raises(ValueError, match="No máximo 500 caracteres"):
        personal.bio("a" * 501)
    # Exibição (histórico).
    assert personal.format_cpf(CPF) == "123.456.789-09"
    assert personal.format_cnpj(CNPJ) == "12.345.678/0001-95"
    assert personal.format_rg("12.345.678-9", "SSP", "SP") == "12.345.678-9 · SSP/SP"
    assert personal.format_rg("12.345.678-9", None, None) == "12.345.678-9"
    assert personal.format_date(date(1990, 11, 25)) == "25/11/1990"
    assert personal.format_date("1990-11-25") == "25/11/1990"


def test_issuer_with_the_state_at_the_end() -> None:
    """Órgão emissor com a UF no fim, "SSP/SP" ou "SSP-SP" (= splitIssuer): órgão e UF separados;
    a UF do fim vale quando a do RG está vazia (com outra, fica a do campo); o fim que não é UF
    fica no órgão, com espaço no lugar da barra."""
    assert personal.split_issuer("SSP/SP") == ("SSP", "SP")
    assert personal.split_issuer(" ssp-sp ") == ("SSP", "SP")
    assert personal.split_issuer("SSP / SP") == ("SSP", "SP")
    assert personal.split_issuer("Detran-RJ") == ("DETRAN", "RJ")
    assert personal.split_issuer("SSP/XX") == ("SSP XX", None)
    assert personal.split_issuer("PC-SSP/MG") == ("PC SSP", "MG")
    assert personal.split_issuer("/SP") == ("SP", None)  # sem o órgão antes, não separa
    assert personal.split_issuer("SSP") == ("SSP", None)
    assert personal.split_issuer(None) == (None, None)
    assert personal.split_issuer("  ") == (None, None)
    # O schema confere o órgão e guarda a UF do fim para o grupo separar.
    assert personal.rg_issuer("ssp-sp") == "SSP/SP"
    assert personal.rg_issuer("SSP / XX") == "SSP XX"
    rg = "12.345.678-9"
    assert personal.rg_group(rg, "SSP/SP", None) == (rg, "SSP", "SP")
    assert personal.rg_group(rg, "SSP-SP", "") == (rg, "SSP", "SP")
    assert personal.rg_group(rg, "SSP/SP", "rj") == (rg, "SSP", "RJ")
    assert personal.rg_group(rg, "SSP/XX", "SP") == (rg, "SSP XX", "SP")
    with pytest.raises(ValueError, match=personal.RG_INCOMPLETE):
        personal.rg_group(rg, "SSP/XX", None)


def test_bio_keeps_the_paragraphs() -> None:
    """= normalizeBio: "\\r\\n" vira "\\n", sem espaços no fim das linhas, três ou mais quebras
    viram duas e sem quebras nem espaços nas pontas; os 500 contam depois disso. A ficha, o app e
    a central usam esta mesma regra (personal.bio; os testes com banco passam pelos três)."""
    assert personal.bio("Técnico de redes.  \r\n\r\n\r\n\r\nAtendo a Cidade Exemplo.  ") == (
        "Técnico de redes.\n\nAtendo a Cidade Exemplo."
    )
    assert personal.bio("\n\n  Linha 1 \n Linha 2\t\n\n") == "Linha 1\n Linha 2"
    assert personal.bio("Um\rDois") == "Um\nDois"
    assert personal.bio("Técnico​ de‮ redes") == "Técnico de redes"
    assert personal.bio(" \r\n \n ") is None and personal.bio(None) is None
    assert personal.bio("a" * 500 + "\n\n\n\n") == "a" * 500
    with pytest.raises(ValueError, match="No máximo 500 caracteres"):
        personal.bio("a" * 499 + "\n\nb")


def test_address_number_rule() -> None:
    """O número em maiúsculas nos três caminhos (ficha, app e central): "SN" e "S / N" viram
    "S/N"; até 10 caracteres."""
    for raw in ("s/n", "SN", "sn", " s / n ", "S/N"):
        assert personal.address_number(raw) == "S/N", raw
    assert personal.address_number("100a") == "100A"
    assert personal.address_number("  12   b ") == "12 B"
    assert personal.address_number("") is None and personal.address_number(None) is None
    with pytest.raises(ValueError, match="No máximo 10 caracteres"):
        personal.address_number("12345678901")


# ------------------------------------------------------------------ com banco

NEW_FIELDS = {
    "cpf": "123.456.789-09",
    "rg_number": "12.345.678-x",
    "rg_issuer": "ssp",
    "rg_state": "sp",
    "birth_date": "1990-11-25",
    "phone_secondary": "11977776666",
    "bio": "  Técnico de redes e CFTV.  \r\n\r\n\r\nAtendo a Cidade Exemplo.  ",
    "address_line": "Rua Exemplo",
    "address_number": "s/n",
    "address_complement": "Fundos",
    "company_document": "12.345.678/0001-95",
    "company_name": "Empresa Exemplo Ltda",
    "company_trade_name": "Loja Exemplo",
    "vehicle_model": "Modelo Exemplo",
    "vehicle_plate": "abc-1234",
}
# A mini biografia como se grava: com os parágrafos (personal.bio).
BIO = "Técnico de redes e CFTV.\n\nAtendo a Cidade Exemplo."


@requires_db
async def test_new_fields_round_trip(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    start = personal.local_today() + timedelta(days=10)
    period = {"start": start.isoformat(), "end": (start + timedelta(days=5)).isoformat()}
    me = ok(
        await patch(client, world, **NEW_FIELDS, unavailability=[period], current_password=PASSWORD)
    )
    expected = {
        "cpf": CPF,
        "rg_number": "12.345.678-X",
        "rg_issuer": "SSP",
        "rg_state": "SP",
        "birth_date": "1990-11-25",
        "phone_secondary": "(11) 97777-6666",
        "bio": BIO,
        "address_line": "Rua Exemplo",
        "address_number": "S/N",
        "address_complement": "Fundos",
        "company_document": CNPJ,
        "company_name": "Empresa Exemplo Ltda",
        "company_trade_name": "Loja Exemplo",
        "vehicle_model": "Modelo Exemplo",
        "vehicle_plate": "ABC1234",
    }
    assert {key: me[key] for key in expected} == expected
    [saved_period] = me["unavailability"]
    assert (saved_period["start"], saved_period["end"]) == (period["start"], period["end"])

    # Relido do banco, coluna por coluna.
    user = await stored(engine, world)
    for key, value in expected.items():
        column = getattr(user, key)
        assert (column.isoformat() if key == "birth_date" else column) == value, key
    assert user.unavailability == [{"id": saved_period["id"], **period}]

    # O mesmo de novo (escrito de outro jeito): nada muda, sem histórico.
    count = len(await history(client, world))
    again = ok(
        await patch(
            client,
            world,
            **{**NEW_FIELDS, "cpf": CPF, "vehicle_plate": "ABC1234"},
            unavailability=[{"id": saved_period["id"], **period}],
            current_password=PASSWORD,
        )
    )
    assert again == me and len(await history(client, world)) == count
    # null limpa o que é opcional (o CPF não: só a central muda depois de gravado).
    cleared = ok(
        await patch(
            client,
            world,
            rg_number=None,
            birth_date=None,
            phone_secondary="",
            bio=None,
            vehicle_model=None,
            vehicle_plate=None,
            unavailability=None,
        )
    )
    assert [cleared[k] for k in ("rg_number", "rg_issuer", "rg_state", "birth_date")] == [None] * 4
    assert [cleared[k] for k in ("phone_secondary", "bio", "vehicle_model", "vehicle_plate")] == [
        None
    ] * 4
    assert cleared["unavailability"] == []
    user = await stored(engine, world)
    assert (user.rg_number, user.rg_issuer, user.rg_state, user.birth_date) == (None,) * 4
    assert (user.unavailability, user.cpf) == ([], CPF)


@requires_db
async def test_history_texts_of_new_fields(client: AsyncClient, world: World) -> None:
    start = personal.local_today() + timedelta(days=10)
    end = start + timedelta(days=5)
    period = {"start": start.isoformat(), "end": end.isoformat()}
    ok(await patch(client, world, **NEW_FIELDS, unavailability=[period], current_password=PASSWORD))
    [row] = await history(client, world)
    assert row["via"] == "app" and row["note"] is None
    changes = {c["field"]: (c["from"], c["to"]) for c in row["changes"]}
    assert changes == {
        "phone_secondary": (None, "(11) 97777-6666"),
        "cpf": (None, "123.456.789-09"),
        "rg": (None, "12.345.678-X · SSP/SP"),
        "birth_date": (None, "25/11/1990"),
        "address_line": (None, "Rua Exemplo"),
        "address_number": (None, "S/N"),
        "address_complement": (None, "Fundos"),
        "bio": (None, BIO),
        "company_document": (None, "12.345.678/0001-95"),
        "company_name": (None, "Empresa Exemplo Ltda"),
        "company_trade_name": (None, "Loja Exemplo"),
        "unavailability": (None, f"{start:%d/%m/%Y} a {end:%d/%m/%Y}"),
        "vehicle": (None, "Modelo Exemplo · ABC-1234"),
    }
    # Só o modelo: o veículo mostra o que houver.
    ok(await patch(client, world, vehicle_plate=None))
    assert (await history(client, world))[0]["changes"] == [
        {"field": "vehicle", "from": "Modelo Exemplo · ABC-1234", "to": "Modelo Exemplo"}
    ]


@requires_db
async def test_cpf_only_while_empty(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    r = await patch(client, world, cpf="123.456.789-00")
    assert r.status_code == 422 and messages(r) == ["CPF inválido"]
    assert r.json()["detail"][0]["label"] == "CPF"
    # Vazio com o gravado vazio: nada.
    assert ok(await patch(client, world, cpf=""))["cpf"] is None
    assert ok(await patch(client, world, cpf="123.456.789-09"))["cpf"] == CPF
    # O mesmo de novo: nada muda.
    count = len(await history(client, world))
    assert ok(await patch(client, world, cpf=CPF))["cpf"] == CPF
    assert len(await history(client, world)) == count
    # Depois de gravado, só a central muda.
    for value in (OTHER_CPF, None, ""):
        r = await patch(client, world, cpf=value)
        assert r.status_code == 422 and messages(r) == [my_profile.CPF_LOCKED], value
    assert (await stored(engine, world)).cpf == CPF


@requires_db
async def test_cpf_is_unique(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    r = await client.patch(f"{API}/me/profile", json={"cpf": CPF}, headers=world.tech_other.headers)
    assert r.status_code == 200, r.text
    r = await patch(client, world, cpf="123.456.789-09", name="Tecnico Alfa")
    assert coded(r) == (409, "Este CPF já está em outro cadastro", "CPF_TAKEN")
    user = await stored(engine, world)
    # Nada do pedido grava (nem o nome que veio junto).
    assert (user.cpf, user.name) == (None, "Tecnico")


@requires_db
async def test_rg_and_company_groups(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    r = await patch(client, world, rg_number="12.345.678-9")
    assert r.status_code == 422 and messages(r) == [personal.RG_INCOMPLETE]
    r = await patch(client, world, rg_number="12.345.678-9", rg_issuer="SSP")
    assert r.status_code == 422 and messages(r) == [personal.RG_INCOMPLETE]
    me = ok(await patch(client, world, rg_number="12.345.678-9", rg_issuer="SSP", rg_state="SP"))
    assert (me["rg_number"], me["rg_issuer"], me["rg_state"]) == ("12.345.678-9", "SSP", "SP")
    # O que não vem fica como está (o grupo continua completo).
    me = ok(await patch(client, world, rg_state="MG"))
    assert (me["rg_number"], me["rg_issuer"], me["rg_state"]) == ("12.345.678-9", "SSP", "MG")
    # Número vazio limpa os três.
    me = ok(await patch(client, world, rg_number=""))
    assert (me["rg_number"], me["rg_issuer"], me["rg_state"]) == (None, None, None)

    r = await patch(client, world, company_name="Empresa Exemplo", current_password=PASSWORD)
    assert r.status_code == 422 and messages(r) == [personal.COMPANY_WITHOUT_CNPJ]
    r = await patch(client, world, company_document="12.345.678/0001-96")
    assert r.status_code == 422 and messages(r) == ["CNPJ inválido"]
    me = ok(
        await patch(
            client,
            world,
            company_document="12.345.678/0001-95",
            company_name="Empresa Exemplo",
            current_password=PASSWORD,
        )
    )
    assert (me["company_document"], me["company_name"], me["company_trade_name"]) == (
        CNPJ,
        "Empresa Exemplo",
        None,
    )
    me = ok(
        await patch(client, world, company_trade_name="Loja Exemplo", current_password=PASSWORD)
    )
    assert (me["company_document"], me["company_trade_name"]) == (CNPJ, "Loja Exemplo")
    # Tirar o CNPJ com os nomes ainda lá não vale; os três vazios limpam.
    r = await patch(client, world, company_document=None, current_password=PASSWORD)
    assert r.status_code == 422 and messages(r) == [personal.COMPANY_WITHOUT_CNPJ]
    me = ok(
        await patch(
            client,
            world,
            company_document=None,
            company_name="",
            company_trade_name=None,
            current_password=PASSWORD,
        )
    )
    user = await stored(engine, world)
    assert (user.company_document, user.company_name, user.company_trade_name) == (None,) * 3


@requires_db
async def test_issuer_with_the_state_at_the_end_in_the_app(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O órgão emissor com a UF no fim grava separado: a UF vazia recebe a do fim; com a UF no
    campo, vale a do campo e o fim sai. O mesmo de novo, escrito de outro jeito, não muda nada."""
    me = ok(await patch(client, world, rg_number="12.345.678-9", rg_issuer="ssp/sp", rg_state=None))
    assert (me["rg_issuer"], me["rg_state"]) == ("SSP", "SP")
    assert (await history(client, world))[0]["changes"] == [
        {"field": "rg", "from": None, "to": "12.345.678-9 · SSP/SP"}
    ]
    count = len(await history(client, world))
    ok(await patch(client, world, rg_number="12.345.678-9", rg_issuer="SSP - SP", rg_state="sp"))
    assert len(await history(client, world)) == count
    me = ok(await patch(client, world, rg_issuer="Detran-RJ", rg_state="MG"))
    assert (me["rg_issuer"], me["rg_state"]) == ("DETRAN", "MG")
    user = await stored(engine, world)
    assert (user.rg_number, user.rg_issuer, user.rg_state) == ("12.345.678-9", "DETRAN", "MG")
    # Sem UF válida no fim, a barra vira espaço e a UF continua obrigatória.
    r = await patch(client, world, rg_issuer="SSP/XX", rg_state=None)
    assert r.status_code == 422 and messages(r) == [personal.RG_INCOMPLETE]
    me = ok(await patch(client, world, rg_issuer="SSP/XX", rg_state="SP"))
    assert (me["rg_issuer"], me["rg_state"]) == ("SSP XX", "SP")


@requires_db
async def test_number_saved_by_the_central_is_not_changed_by_the_app(
    client: AsyncClient, world: World
) -> None:
    """A central grava o número em maiúsculas, como o app e a ficha: o técnico que depois muda só o
    complemento (o app manda as três partes; aqui, o número como foi digitado na central) não lança
    uma troca de número em nome dele."""
    url = f"{API}/technicians/{world.tech.user.id}"
    address = {
        "address_line": "Rua Exemplo",
        "address_number": "s/n",
        "address_complement": "Fundos",
    }
    r = await client.patch(url, json=address, headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    assert r.json()["address_number"] == "S/N"
    me = ok(await patch(client, world, **{**address, "address_complement": "Casa 2"}))
    assert (me["address_number"], me["address_complement"]) == ("S/N", "Casa 2")
    row, central = (await history(client, world))[:2]
    assert central["via"] == "central"
    assert (row["via"], row["changes"]) == (
        "app",
        [{"field": "address_complement", "from": "Fundos", "to": "Casa 2"}],
    )


@requires_db
async def test_birth_date_must_be_a_date(client: AsyncClient, world: World) -> None:
    """Número não é data no app (como na ficha e na central): viraria segundos desde 1970."""
    for value in (1577836800, 1577836800.5, True):
        r = await patch(client, world, birth_date=value)
        assert r.status_code == 422 and messages(r) == [personal.BIRTH_INVALID], value
        assert r.json()["detail"][0]["label"] == "Data de nascimento"


@requires_db
async def test_company_needs_password(client: AsyncClient, world: World) -> None:
    r = await patch(client, world, company_document="12.345.678/0001-95")
    assert r.status_code == 422 and messages(r) == [my_profile.PASSWORD_REQUIRED]
    r = await patch(client, world, company_document="12.345.678/0001-95", current_password="x")
    assert r.status_code == 422 and messages(r) == [my_profile.WRONG_PASSWORD]
    me = ok(
        await patch(client, world, company_document="12.345.678/0001-95", current_password=PASSWORD)
    )
    assert me["company_document"] == CNPJ
    # O mesmo de novo não pede a senha (nada muda); o resto do cadastro também não.
    assert ok(await patch(client, world, company_document=CNPJ, bio="Redes"))["bio"] == "Redes"


@requires_db
async def test_email_waits_for_the_link(
    client: AsyncClient, world: World, engine: AsyncEngine, mail_box: MailBox
) -> None:
    me = ok(await patch(client, world, email="Novo.Alfa@Exemplo.com", current_password=PASSWORD))
    assert (me["email"], me["email_pending"]) == ("tecnico@teste.com.br", "novo.alfa@exemplo.com")
    assert me["mail_enabled"] is True and me["email_link_sent_at"] is not None
    assert len(mail_box.soon) == 1
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        assert await mail.deliver_pending(db) == 1
    [message] = mail_box.messages
    assert message["To"] == "novo.alfa@exemplo.com" and len(mail_box.tokens()) == 1
    user = await stored(engine, world)
    assert (user.email, user.email_pending) == ("tecnico@teste.com.br", "novo.alfa@exemplo.com")
    assert user.email_pending_at is not None

    # O mesmo pedido de novo: nada (sem histórico nem outro link).
    count = len(await history(client, world))
    again = ok(await patch(client, world, email="novo.alfa@exemplo.com", current_password=PASSWORD))
    assert again["email_pending"] == "novo.alfa@exemplo.com"
    assert len(await history(client, world)) == count and len(mail_box.soon) == 1

    # Outro e-mail: o pedido anterior sai (o link dele deixa de valer).
    me = ok(await patch(client, world, email="outro.alfa@exemplo.com", current_password=PASSWORD))
    assert me["email_pending"] == "outro.alfa@exemplo.com"
    async with maker() as db:
        tokens = list(await db.scalars(select(AccountToken)))
    assert [(t.email, t.revoked_at is not None) for t in tokens] == [
        ("novo.alfa@exemplo.com", True)
    ]
    assert (await history(client, world))[0]["changes"] == [
        {
            "field": "email_pending",
            "from": "novo.alfa@exemplo.com",
            "to": "outro.alfa@exemplo.com",
        }
    ]

    # Voltar ao e-mail do login cancela o pedido, sem senha.
    me = ok(await patch(client, world, email="tecnico@teste.com.br"))
    assert (me["email"], me["email_pending"]) == ("tecnico@teste.com.br", None)
    async with maker() as db:
        rows = list(await db.scalars(select(EmailOutbox).order_by(EmailOutbox.created_at)))
    assert [(r.to_email, r.status) for r in rows] == [
        ("novo.alfa@exemplo.com", EmailStatus.SENT),
        ("outro.alfa@exemplo.com", EmailStatus.EXPIRED),
    ]
    assert all(r.template == EmailTemplate.VERIFY_EMAIL for r in rows)
    assert rows[1].context == {"name": "Tecnico", "reason": "change"}


@requires_db
async def test_email_change_refused_with_mail_off(client: AsyncClient, world: World) -> None:
    """Sem envio de e-mail, a troca fica com a central (o app mostra o e-mail só leitura)."""
    me = ok(await client.get(f"{API}/me/profile", headers=world.tech.headers))
    assert me["mail_enabled"] is False and me["email_link_sent_at"] is None
    r = await patch(client, world, email="novo.alfa@exemplo.com", current_password=PASSWORD)
    assert r.status_code == 422 and messages(r) == [my_profile.EMAIL_MAIL_OFF]
    r = await client.post(f"{API}/me/profile/email/verification", headers=world.tech.headers)
    assert coded(r) == (503, my_profile.MAIL_DISABLED_TEXT, "MAIL_DISABLED")


@requires_db
async def test_resend_and_cancel(
    client: AsyncClient, world: World, engine: AsyncEngine, mail_box: MailBox
) -> None:
    url = f"{API}/me/profile/email/verification"
    th = world.tech.headers
    # O login ainda não validado: o link vai para ele ("check").
    me = ok(await client.post(url, headers=th))
    assert me["email_link_sent_at"] is not None and len(mail_box.soon) == 1
    for _ in range(2):
        ok(await client.post(url, headers=th))
    r = await client.post(url, headers=th)
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    assert (
        r.json()["detail"].startswith("Aguarde ") and "para pedir outro link" in r.json()["detail"]
    )
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        rows = list(await db.scalars(select(EmailOutbox)))
    # Ainda na fila: o mesmo pedido, sem duplicar.
    assert [(r.to_email, r.context["reason"]) for r in rows] == [("tecnico@teste.com.br", "check")]

    # Pedido de troca aberto: cancelar tira o pedido e o histórico registra.
    ok(await patch(client, world, email="novo.alfa@exemplo.com", current_password=PASSWORD))
    me = ok(await client.delete(f"{API}/me/profile/email/pending", headers=th))
    assert (me["email"], me["email_pending"]) == ("tecnico@teste.com.br", None)
    assert (await history(client, world))[0]["changes"] == [
        {"field": "email_pending", "from": "novo.alfa@exemplo.com", "to": None}
    ]
    # Sem pedido: 200 igual, sem histórico.
    count = len(await history(client, world))
    assert ok(await client.delete(f"{API}/me/profile/email/pending", headers=th)) == me
    assert len(await history(client, world)) == count
    async with maker() as db:
        statuses = {r.to_email: r.status for r in await db.scalars(select(EmailOutbox))}
    assert statuses["novo.alfa@exemplo.com"] == EmailStatus.EXPIRED

    # Validado e sem pedido: 409; endereço que não recebe mensagens: 422 (os dois antes do limite).
    await set_user(engine, world, email_verified_at=utcnow())
    r = await client.post(url, headers=th)
    assert coded(r) == (409, "Seu e-mail já está validado", "EMAIL_ALREADY_VERIFIED")
    await set_user(engine, world, email_verified_at=None, email="fc-12@importado.invalid")
    r = await client.post(url, headers=th)
    assert r.status_code == 422 and messages(r) == [my_profile.LINK_NOT_SENDABLE]


@requires_db
async def test_old_app_address_line_clears_number_and_complement(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    me = ok(
        await patch(
            client,
            world,
            address_line="Rua Exemplo",
            address_number="100",
            address_complement="Apto 4",
            address_district="Centro",
        )
    )
    assert (me["address_line"], me["address_number"], me["address_complement"]) == (
        "Rua Exemplo",
        "100",
        "Apto 4",
    )
    # O app de antes manda a linha de sempre (sem mudar): nada muda.
    me = ok(await patch(client, world, address_line="Rua Exemplo", home_city="Cidade Exemplo"))
    assert (me["address_number"], me["address_complement"]) == ("100", "Apto 4")
    # A linha nova inteira vira o logradouro; número e complemento ficam vazios.
    me = ok(await patch(client, world, address_line="Rua Exemplo, 200 - Casa 2"))
    assert (me["address_line"], me["address_number"], me["address_complement"]) == (
        "Rua Exemplo, 200 - Casa 2",
        None,
        None,
    )
    user = await stored(engine, world)
    assert (user.address_line, user.address_number, user.address_complement) == (
        "Rua Exemplo, 200 - Casa 2",
        None,
        None,
    )
    assert user.address_district == "Centro"
    # Só o número (app novo): o logradouro fica.
    me = ok(await patch(client, world, address_number="200", address_complement=None))
    assert (me["address_line"], me["address_number"]) == ("Rua Exemplo, 200 - Casa 2", "200")


@requires_db
async def test_me_never_shows_the_situation(client: AsyncClient, world: World) -> None:
    """O técnico é terceiro: nada da situação na operação, do motivo nem do histórico no app."""
    me = ok(await client.get(f"{API}/me/profile", headers=world.tech.headers))
    assert not [key for key in me if key.startswith("operational") or key in ("note", "changes")]
    r = await patch(client, world, operational_status="active")
    assert r.status_code == 422 and r.json()["detail"][0]["type"] == "extra_forbidden"
