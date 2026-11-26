"""Formas de recebimento do técnico (chaves PIX e contas): o técnico cadastra no app com a senha,
uma é a preferencial, a central vê e remove em Pagamentos, e o histórico e o pagamento guardam só o
texto mascarado.

Só dados fictícios: Tecnico Alfa, CPF 12345678909, CNPJ 12.345.678/0001-95, Banco Exemplo 999.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient, Response
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core import payout
from app.core.config import settings
from app.models import TechnicianPayoutMethod
from app.schemas.my_profile import PIX_MOVED
from app.schemas.payout_method import PayoutMethodCreate, PayoutMethodUpdate
from app.services import my_profile, payout_methods
from tests.conftest import MailBox, World, requires_db
from tests.test_access import restrict_analyst
from tests.test_api import create
from tests.test_my_profile import (
    METHODS,
    PASSWORD,
    PAYOUT_FIELDS,
    add_method,
    capture_events,
    change_password,
    history,
    login_mobile,
    messages,
    patch,
    reset_by_central,
)

API = settings.API_PREFIX
CPF = "12345678909"
CNPJ = "12345678000195"
CPF_KEY = {
    "kind": "pix",
    "pix_key_type": "cpf",
    "pix_key": "123.456.789-09",
    "holder_name": "Tecnico Alfa",
}
ACCOUNT = {
    "kind": "bank",
    "bank_code": "999",
    "bank_name": "Banco Exemplo",
    "branch": "1",
    "account_number": "12345678",
    "account_digit": "9",
    "account_type": "checking",
    "holder_name": "Tecnico Alfa",
    "holder_document": "123.456.789-09",
}


def cpf_from(base: str) -> str:
    """Um CPF fictício com os dígitos verificadores certos, a partir de 9 números."""
    digits = [int(c) for c in base]
    for n in (9, 10):
        total = sum(d * (n + 1 - i) for i, d in enumerate(digits[:n]))
        digits.append(total * 10 % 11 % 10)
    return "".join(map(str, digits))


OTHER_CPF = cpf_from("987654321")


def random_key(i: int) -> dict:
    return {
        "kind": "pix",
        "pix_key_type": "random",
        "pix_key": f"{i:08d}-0000-4000-8000-000000000000",
        "holder_name": "Tecnico Alfa",
        "holder_document": CPF,
    }


def body(r: Response) -> dict:
    assert r.status_code == 200, r.text
    return r.json()


async def action(client: AsyncClient, world: World, method_id: str, what: str, **extra: object):
    """POST /me/profile/payout-methods/{id}/preferred ou /remove com a senha."""
    payload = {"current_password": PASSWORD, **extra}
    return await client.post(
        f"{METHODS}/{method_id}/{what}", json=payload, headers=world.tech.headers
    )


async def stored(engine: AsyncEngine, user_id: uuid.UUID) -> list[TechnicianPayoutMethod]:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        rows = await db.scalars(
            select(TechnicianPayoutMethod).where(TechnicianPayoutMethod.user_id == user_id)
        )
        return list(rows)


# ------------------------------------------------------------------ sem banco


def test_describe_texts() -> None:
    """Os casos do contrato (= payoutMethodText/maskAccount de lib/constants.ts com "*")."""
    key = {"kind": "pix", "pix_key_type": "cpf", "pix_key": CPF, "holder_name": "Tecnico Alfa"}
    assert payout.describe(key) == "PIX CPF ***.456.789-**"
    assert payout.describe_with_holder(key) == "PIX CPF ***.456.789-** · Tecnico Alfa"
    account = {
        "kind": "bank",
        "bank_name": "Banco Exemplo",
        "account_number": "12345678",
        "account_digit": "9",
    }
    assert payout.describe(account) == "Banco Exemplo ****5678-9"
    short = {**account, "account_number": "234", "account_digit": "4"}
    assert payout.describe(short) == "Banco Exemplo **34-4"
    assert payout.mask_account("12345678", "9") == "****5678-9"
    assert payout.mask_account("1234", None) == "**34"
    phone = {"kind": "pix", "pix_key_type": "phone", "pix_key": "+5511988887777"}
    assert payout.describe(phone) == "PIX Celular +55 (11) *****-7777"


def test_input_is_normalized() -> None:
    """A chave CPF é o documento do titular (o que vier é ignorado); agência com 4 números; dígito
    em maiúscula; os campos do outro tipo ficam null."""
    data = PayoutMethodCreate.model_validate(
        {**CPF_KEY, "holder_document": OTHER_CPF, "bank_code": "001", "branch": "12"}
    )
    assert (data.pix_key, data.holder_document, data.bank_code, data.branch) == (
        CPF,
        CPF,
        None,
        None,
    )
    data = PayoutMethodCreate.model_validate(
        {**ACCOUNT, "account_digit": "x", "pix_key": "abc", "holder_name": "  Tecnico   Alfa "}
    )
    values = data.values()
    assert (values["branch"], values["account_digit"], values["holder_document"]) == (
        "0001",
        "X",
        CPF,
    )
    assert (values["pix_key"], values["pix_key_type"], values["holder_name"]) == (
        None,
        None,
        "Tecnico Alfa",
    )
    cnpj_key = {**CPF_KEY, "pix_key_type": "cnpj", "pix_key": "12.345.678/0001-95"}
    assert PayoutMethodCreate.model_validate(cnpj_key).holder_document == CNPJ
    phone = {**CPF_KEY, "pix_key_type": "phone", "pix_key": "11988887777"}
    data = PayoutMethodUpdate.model_validate({**phone, "holder_document": "123.456.789-09"})
    assert (data.pix_key, data.holder_document) == ("+5511988887777", CPF)


@pytest.mark.parametrize(
    ("changes", "field", "message"),
    [
        ({"pix_key_type": "boleto"}, "pix_key_type", "Escolha o tipo da chave PIX"),
        ({"pix_key": "  "}, "pix_key", "Informe a chave PIX"),
        ({"pix_key": "111.111.111-11"}, "pix_key", "CPF inválido: confira os números"),
        (
            {"pix_key_type": "phone", "pix_key": "(11) 3333-4444", "holder_document": CPF},
            "pix_key",
            "Celular inválido: use DDD e número, com o 9",
        ),
        ({"pix_key_type": "email", "pix_key": "alfa@exemplo.com"}, "holder_document", None),
        (
            {"pix_key_type": "email", "pix_key": "alfa@exemplo.com", "holder_document": "123"},
            "holder_document",
            "CPF ou CNPJ do titular inválido",
        ),
        ({"holder_name": "Al"}, "holder_name", "Informe o nome do titular"),
        ({"kind": "bank"}, "bank_code", None),
    ],
)
def test_pix_validation_messages(changes: dict, field: str, message: str | None) -> None:
    with pytest.raises(ValidationError) as caught:
        PayoutMethodCreate.model_validate({**CPF_KEY, **changes})
    errors = {e["loc"][0]: e["msg"].removeprefix("Value error, ") for e in caught.value.errors()}
    if message is None:  # o campo obrigatório que faltou
        assert field in errors
        return
    assert errors == {field: message}


@pytest.mark.parametrize(
    ("changes", "field", "message"),
    [
        ({"bank_code": "99"}, "bank_code", "Código do banco com 3 números"),
        ({"bank_code": "abc"}, "bank_code", "Código do banco com 3 números"),
        ({"bank_name": " B "}, "bank_name", "Informe o banco"),
        ({"branch": "12345"}, "branch", "Agência inválida: use até 4 números"),
        ({"branch": ""}, "branch", "Agência inválida: use até 4 números"),
        ({"account_number": "12.345"}, "account_number", "Conta inválida: use só números"),
        ({"account_number": "1" * 21}, "account_number", "Conta inválida: use só números"),
        ({"account_digit": "12"}, "account_digit", "Dígito da conta inválido"),
        ({"account_digit": None}, "account_digit", "Dígito da conta inválido"),
        ({"account_type": "corrente"}, "account_type", "Escolha o tipo de conta"),
        ({"holder_name": None}, "holder_name", "Informe o nome do titular"),
        ({"holder_document": None}, "holder_document", "Informe o CPF ou CNPJ do titular"),
        ({"holder_document": "11111111111"}, "holder_document", "CPF ou CNPJ do titular inválido"),
    ],
)
def test_bank_validation_messages(changes: dict, field: str, message: str) -> None:
    with pytest.raises(ValidationError) as caught:
        PayoutMethodCreate.model_validate({**ACCOUNT, **changes})
    errors = {e["loc"][0]: e["msg"].removeprefix("Value error, ") for e in caught.value.errors()}
    assert errors == {field: message}


# ------------------------------------------------------------------ com banco


@requires_db
async def test_create_needs_password_and_not_temporary(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    r = await add_method(client, world.tech.headers, CPF_KEY, password=None)
    assert r.status_code == 422 and messages(r) == [my_profile.PASSWORD_REQUIRED]
    r = await add_method(client, world.tech.headers, CPF_KEY, password="errada")
    assert r.status_code == 422 and messages(r) == [my_profile.WRONG_PASSWORD]
    # A validação vem antes (com o rótulo do campo) e não gasta tentativa de senha.
    r = await add_method(client, world.tech.headers, {**CPF_KEY, "pix_key": "123"})
    assert r.status_code == 422 and r.json()["detail"][0]["label"] == "Chave PIX"
    assert await stored(engine, world.tech.user.id) == []

    temp = await reset_by_central(client, world)
    h = await login_mobile(client, "tecnico@teste.com.br", temp)
    r = await add_method(client, h, CPF_KEY, password=temp)
    assert r.status_code == 422 and messages(r) == [my_profile.TEMPORARY_PASSWORD]
    h = await change_password(client, h, temp, "senha-do-tecnico-1")
    me = body(await add_method(client, h, CPF_KEY, password="senha-do-tecnico-1"))
    [method] = me["payout_methods"]
    assert (method["kind"], method["pix_key_type"], method["pix_key"]) == ("pix", "cpf", CPF)
    assert (method["holder_name"], method["holder_document"], method["preferred"]) == (
        "Tecnico Alfa",
        CPF,
        True,
    )
    assert method["bank_code"] is None and method["account_number"] is None
    # O app de antes ainda lê a chave preferencial em `pix`.
    assert me["pix"] == {
        "key_type": "cpf",
        "key": CPF,
        "holder_name": "Tecnico Alfa",
        "updated_at": method["changed_at"],
    }
    # Técnico só; a central usa Pagamentos.
    r = await client.post(METHODS, json=CPF_KEY, headers=world.analyst.headers)
    assert r.status_code == 403


@requires_db
async def test_first_method_is_preferred_and_only_one_is(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    h = world.tech.headers
    first = body(await add_method(client, h, CPF_KEY, preferred=False))["payout_methods"][0]
    assert first["preferred"] is True
    me = body(await add_method(client, h, ACCOUNT))
    assert [(m["id"], m["preferred"]) for m in me["payout_methods"]][0] == (first["id"], True)
    account = me["payout_methods"][1]
    assert (account["kind"], account["branch"], account["preferred"]) == ("bank", "0001", False)

    phone = {
        **CPF_KEY,
        "pix_key_type": "phone",
        "pix_key": "(11) 98888-7777",
        "holder_document": CPF,
    }
    me = body(await add_method(client, h, phone, preferred=True))
    # A preferencial primeiro, depois as mais novas.
    kinds = [(m["pix_key_type"] or m["kind"], m["preferred"]) for m in me["payout_methods"]]
    assert kinds == [("phone", True), ("bank", False), ("cpf", False)]
    assert me["pix"]["key"] == "+5511988887777"
    rows = await stored(engine, world.tech.user.id)
    assert sum(row.preferred for row in rows) == 1
    assert all((row.preferred_since is not None) == row.preferred for row in rows)

    # A conta como preferencial: o `pix` do app de antes fica vazio.
    me = body(await action(client, world, account["id"], "preferred"))
    assert me["payout_methods"][0]["id"] == account["id"] and me["pix"] is None
    rows = await stored(engine, world.tech.user.id)
    assert [row.id for row in rows if row.preferred] == [uuid.UUID(account["id"])]


@requires_db
async def test_prefer_marks_the_destination_as_new(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    h, url = world.tech.headers, f"{API}/technicians/{world.tech.user.id}/payout-methods"
    body(await add_method(client, h, CPF_KEY))
    account = body(await add_method(client, h, ACCOUNT))["payout_methods"][1]
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE technician_payout_methods SET changed_at = changed_at - interval '30 days',"
                " created_at = created_at - interval '30 days',"
                " preferred_since = preferred_since - interval '30 days'"
            )
        )
    old = body(await client.get(url, headers=world.analyst.headers))
    limit = datetime.now(UTC) - timedelta(days=7)
    assert all(datetime.fromisoformat(m["destination_changed_at"]) < limit for m in old)

    r = await action(client, world, account["id"], "preferred", current_password="errada")
    assert r.status_code == 422 and messages(r) == [my_profile.WRONG_PASSWORD]
    body(await action(client, world, account["id"], "preferred"))
    new = body(await client.get(url, headers=world.analyst.headers))
    assert new[0]["id"] == account["id"] and new[0]["preferred"] is True
    assert datetime.fromisoformat(new[0]["destination_changed_at"]) > limit
    # changed_at continua o de antes (o destino de pagar mudou pela escolha, não pela conta).
    assert datetime.fromisoformat(new[0]["changed_at"]) < limit
    rows = len(await history(client, world))
    # Já é a preferencial: nada muda.
    body(await action(client, world, account["id"], "preferred"))
    assert len(await history(client, world)) == rows

    r = await action(client, world, str(uuid.uuid4()), "preferred")
    assert r.status_code == 404 and r.json()["code"] == "PAYOUT_METHOD_NOT_FOUND"
    assert r.json()["detail"] == payout_methods.NOT_FOUND_TEXT


@requires_db
async def test_remove_promotes_the_newest(client: AsyncClient, world: World) -> None:
    h = world.tech.headers
    first = body(await add_method(client, h, CPF_KEY))["payout_methods"][0]
    body(await add_method(client, h, ACCOUNT))
    me = body(await add_method(client, h, random_key(1)))
    newest = next(m for m in me["payout_methods"] if m["pix_key_type"] == "random")

    r = await client.post(f"{METHODS}/{first['id']}/remove", json={}, headers=h)
    assert r.status_code == 422 and messages(r) == [my_profile.PASSWORD_REQUIRED]
    me = body(await action(client, world, first["id"], "remove"))
    assert [m["id"] for m in me["payout_methods"]][0] == newest["id"]
    assert me["payout_methods"][0]["preferred"] is True and len(me["payout_methods"]) == 2

    # Excluir uma que não é a preferencial não mexe na preferencial.
    account = me["payout_methods"][1]
    me = body(await action(client, world, account["id"], "remove"))
    assert [(m["id"], m["preferred"]) for m in me["payout_methods"]] == [(newest["id"], True)]
    me = body(await action(client, world, newest["id"], "remove"))
    assert (me["payout_methods"], me["pix"]) == ([], None)

    r = await action(client, world, newest["id"], "remove")
    assert r.status_code == 404 and r.json()["code"] == "PAYOUT_METHOD_NOT_FOUND"
    # A forma de outro técnico também é "não existe".
    other = body(await add_method(client, world.tech_other.headers, CPF_KEY))
    r = await action(client, world, other["payout_methods"][0]["id"], "remove")
    assert r.status_code == 404


@requires_db
async def test_duplicates_and_limit(client: AsyncClient, world: World) -> None:
    h = world.tech.headers
    body(await add_method(client, h, CPF_KEY))
    r = await add_method(client, h, {**CPF_KEY, "pix_key": "12345678909"})
    assert (r.status_code, r.json()) == (
        409,
        {"detail": "Esta chave PIX já está na lista", "code": "PAYOUT_METHOD_DUPLICATE"},
    )
    body(await add_method(client, h, ACCOUNT))
    # A mesma conta com zeros à esquerda e a agência completa.
    same = {**ACCOUNT, "branch": "0001", "account_number": "0012345678"}
    r = await add_method(client, h, same)
    assert (r.status_code, r.json()) == (
        409,
        {"detail": "Esta conta já está na lista", "code": "PAYOUT_METHOD_DUPLICATE"},
    )
    # Outro dígito é outra conta.
    me = body(await add_method(client, h, {**ACCOUNT, "account_digit": "1"}))
    assert len(me["payout_methods"]) == 3

    # Editar uma para ficar igual a outra também é repetida.
    other_account = next(
        m for m in me["payout_methods"] if m["kind"] == "bank" and m["account_digit"] == "1"
    )
    r = await client.put(
        f"{METHODS}/{other_account['id']}",
        json={**ACCOUNT, "current_password": PASSWORD},
        headers=h,
    )
    assert r.status_code == 409 and r.json()["detail"] == "Esta conta já está na lista"

    for i in range(7):
        body(await add_method(client, h, random_key(i)))
    r = await add_method(client, h, random_key(99))
    assert (r.status_code, r.json()) == (
        422,
        {
            "detail": "Limite de 10 formas de recebimento. Exclua uma para incluir outra",
            "code": "PAYOUT_METHODS_LIMIT",
        },
    )


@requires_db
async def test_edit_keeps_the_kind_and_marks_the_destination(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    h = world.tech.headers
    me = body(await add_method(client, h, ACCOUNT))
    account = me["payout_methods"][0]
    url = f"{METHODS}/{account['id']}"

    r = await client.put(url, json={**CPF_KEY, "current_password": PASSWORD}, headers=h)
    assert (r.status_code, r.json()["detail"]) == (
        422,
        "Para mudar o tipo, exclua e cadastre de novo",
    )
    r = await client.put(url, json={**ACCOUNT, "bank_name": "Banco Exemplo SA"}, headers=h)
    assert r.status_code == 422 and messages(r) == [my_profile.PASSWORD_REQUIRED]

    # Só o nome do banco: grava, sem mudar o destino.
    me = body(
        await client.put(
            url,
            json={**ACCOUNT, "bank_name": "Banco Exemplo SA", "current_password": PASSWORD},
            headers=h,
        )
    )
    assert me["payout_methods"][0]["bank_name"] == "Banco Exemplo SA"
    assert me["payout_methods"][0]["changed_at"] == account["changed_at"]
    # A conta muda: changed_at é agora.
    changed = {**ACCOUNT, "bank_name": "Banco Exemplo SA", "account_number": "87654321"}
    me = body(await client.put(url, json={**changed, "current_password": PASSWORD}, headers=h))
    assert datetime.fromisoformat(me["payout_methods"][0]["changed_at"]) > datetime.fromisoformat(
        account["changed_at"]
    )
    rows = await history(client, world)
    assert rows[0]["changes"] == [
        {
            "field": "payout_methods",
            "from": "Banco Exemplo SA ****5678-9 · Tecnico Alfa",
            "to": "Banco Exemplo SA ****4321-9 · Tecnico Alfa",
        }
    ]
    assert rows[1]["changes"] == [
        {
            "field": "payout_methods",
            "from": "Banco Exemplo ****5678-9 · Tecnico Alfa",
            "to": "Banco Exemplo SA ****5678-9 · Tecnico Alfa",
        }
    ]
    # Só o documento do titular: a linha mostra o documento mascarado (senão sairia igual).
    body(
        await client.put(
            url,
            json={**changed, "holder_document": OTHER_CPF, "current_password": PASSWORD},
            headers=h,
        )
    )
    line = (await history(client, world))[0]["changes"][0]
    assert line["from"] == "Banco Exemplo SA ****4321-9 · Tecnico Alfa · CPF ***.456.789-**"
    assert line["to"].startswith("Banco Exemplo SA ****4321-9 · Tecnico Alfa · CPF ***.")
    assert OTHER_CPF not in str(line) and CPF not in str(line)
    # O mesmo de novo: nada muda.
    count = len(await history(client, world))
    again = {**changed, "holder_document": OTHER_CPF, "current_password": PASSWORD}
    body(await client.put(url, json=again, headers=h))
    assert len(await history(client, world)) == count

    r = await client.put(f"{METHODS}/{uuid.uuid4()}", json=again, headers=h)
    assert r.status_code == 404 and r.json()["code"] == "PAYOUT_METHOD_NOT_FOUND"
    [row] = await stored(engine, world.tech.user.id)
    assert (row.bank_code, row.branch, row.account_number, row.account_digit) == (
        "999",
        "0001",
        "87654321",
        "9",
    )
    assert (row.account_type, row.holder_name, row.holder_document) == (
        "checking",
        "Tecnico Alfa",
        OTHER_CPF,
    )


@requires_db
async def test_history_tells_what_changed_behind_the_same_mask(
    client: AsyncClient, world: World
) -> None:
    """O destino muda sem mudar a máscara (só a agência, só o tipo de conta, só o código do banco,
    outra conta com os mesmos 4 finais, outra chave e-mail ou celular com a mesma máscara): a linha
    não sai com "de" igual a "para" e não abre a chave nem a conta (a agência e o tipo de conta vão
    pelo rótulo; a conta e a chave, com a marca neutra no que entrou)."""
    h = world.tech.headers

    async def edit(method_id: str, payload: dict) -> dict:
        r = await client.put(
            f"{METHODS}/{method_id}", json={**payload, "current_password": PASSWORD}, headers=h
        )
        body(r)
        [line] = (await history(client, world))[0]["changes"]
        assert line["field"] == "payout_methods" and line["from"] != line["to"], line
        return line

    account = body(await add_method(client, h, ACCOUNT))["payout_methods"][0]
    base = "Banco Exemplo ****5678-9 · Tecnico Alfa"
    branch = {**ACCOUNT, "branch": "2"}
    line = await edit(account["id"], branch)
    assert (line["from"], line["to"]) == (f"{base} · Ag. 0001", f"{base} · Ag. 0002")
    savings = {**branch, "account_type": "savings"}
    line = await edit(account["id"], savings)
    assert (line["from"], line["to"]) == (f"{base} · Conta corrente", f"{base} · Conta poupança")
    code = {**savings, "bank_code": "998"}
    line = await edit(account["id"], code)
    assert (line["from"], line["to"]) == (f"{base} · banco 999", f"{base} · banco 998")
    # Outra conta com os mesmos 4 últimos números (e o mesmo dígito).
    line = await edit(account["id"], {**code, "account_number": "99995678"})
    assert (line["from"], line["to"]) == (base, f"{base} · outra conta")
    assert "99995678" not in str(line) and "12345678" not in str(line)

    email = {
        "kind": "pix",
        "pix_key_type": "email",
        "pix_key": "tecnico.alfa@exemplo.com",
        "holder_name": "Tecnico Alfa",
        "holder_document": CPF,
    }
    me = body(await add_method(client, h, email))
    key = next(m for m in me["payout_methods"] if m["pix_key_type"] == "email")
    line = await edit(key["id"], {**email, "pix_key": "tecnico.outro@exemplo.com"})
    masked = "PIX E-mail t***@exemplo.com · Tecnico Alfa"
    assert (line["from"], line["to"]) == (masked, f"{masked} · outra chave")
    assert "tecnico.alfa" not in str(line) and "tecnico.outro" not in str(line)

    phone = {**email, "pix_key_type": "phone", "pix_key": "(11) 91234-7777"}
    me = body(await add_method(client, h, phone))
    key = next(m for m in me["payout_methods"] if m["pix_key_type"] == "phone")
    line = await edit(key["id"], {**phone, "pix_key": "(11) 98888-7777"})
    masked = "PIX Celular +55 (11) *****-7777 · Tecnico Alfa"
    assert (line["from"], line["to"]) == (masked, f"{masked} · outra chave")
    assert "91234" not in str(line) and "98888" not in str(line)


@requires_db
async def test_preferred_history_with_the_same_mask(client: AsyncClient, world: World) -> None:
    """Outra forma vira a preferencial com a mesma máscara: a linha leva o titular e o documento
    dele mascarado; com o mesmo titular e documento, " (outra forma)" no "para"."""
    h = world.tech.headers
    alfa = {
        "kind": "pix",
        "pix_key_type": "email",
        "pix_key": "tecnico.alfa@exemplo.com",
        "holder_name": "Tecnico Alfa",
        "holder_document": CPF,
    }
    other = {
        **alfa,
        "pix_key": "tecnico.beta@exemplo.com",
        "holder_name": "Outra Pessoa Ficticia",
        "holder_document": OTHER_CPF,
    }
    first = body(await add_method(client, h, alfa))["payout_methods"][0]
    me = body(await add_method(client, h, other))
    second = next(m for m in me["payout_methods"] if m["pix_key"] == other["pix_key"])
    me = body(await add_method(client, h, {**alfa, "pix_key": "tecnico.gama@exemplo.com"}))
    third = next(m for m in me["payout_methods"] if m["pix_key"] == "tecnico.gama@exemplo.com")

    async def prefer(method_id: str) -> dict:
        body(await action(client, world, method_id, "preferred"))
        [line] = (await history(client, world))[0]["changes"]
        assert line["field"] == "payout_preferred" and line["from"] != line["to"], line
        for secret in ("tecnico.alfa", "tecnico.beta", "tecnico.gama", CPF, OTHER_CPF):
            assert secret not in str(line), secret
        return line

    masked = "PIX E-mail t***@exemplo.com"
    alfa_text = f"{masked} · Tecnico Alfa · CPF ***.456.789-**"
    other_text = f"{masked} · Outra Pessoa Ficticia · CPF ***.{OTHER_CPF[3:6]}.{OTHER_CPF[6:9]}-**"
    line = await prefer(second["id"])
    assert (line["from"], line["to"]) == (alfa_text, other_text)
    line = await prefer(third["id"])
    assert (line["from"], line["to"]) == (other_text, alfa_text)
    # O mesmo titular e o mesmo documento: nada do que se pode mostrar difere.
    line = await prefer(first["id"])
    assert (line["from"], line["to"]) == (alfa_text, f"{alfa_text} (outra forma)")


@requires_db
async def test_old_app_pix_patch_is_refused(client: AsyncClient, world: World) -> None:
    """O app de antes gravava a chave no PATCH: agora 422 com o aviso de atualizar o app (o GET
    continua com `pix` para ele ler)."""
    old = {"key_type": "cpf", "key": "123.456.789-09", "holder_name": "Tecnico Alfa"}
    for value in (old, None):
        r = await patch(client, world, pix=value, current_password=PASSWORD)
        assert r.status_code == 422 and messages(r) == [PIX_MOVED]
        assert r.json()["detail"][0]["label"] == "Chave PIX"
    me = (await client.get(f"{API}/me/profile", headers=world.tech.headers)).json()
    assert (me["pix"], me["payout_methods"]) == (None, [])


@requires_db
async def test_central_sees_with_payouts_only_and_flags_holder(
    client: AsyncClient, world: World
) -> None:
    h, tech_id = world.tech.headers, str(world.tech.user.id)
    url = f"{API}/technicians/{tech_id}/payout-methods"
    body(await patch(client, world, name="Tecnico Alfa"))
    body(await add_method(client, h, CPF_KEY))
    other_holder = {**ACCOUNT, "holder_name": "Outra Pessoa Ficticia", "holder_document": OTHER_CPF}
    body(await add_method(client, h, other_holder))

    def flags(rows: list[dict]) -> dict[str, bool]:
        return {(m["pix_key_type"] or m["kind"]): m["holder_differs"] for m in rows}

    # Sem CPF no cadastro: pelo nome.
    listed = body(await client.get(url, headers=world.analyst.headers))
    assert flags(listed) == {"cpf": False, "bank": True}
    assert listed[1]["account_number"] == "12345678" and listed[1]["holder_document"] == OTHER_CPF

    # Com o CPF: pelo documento (o nome igual não basta).
    body(await patch(client, world, cpf="123.456.789-09"))
    same_name = {**ACCOUNT, "account_number": "555", "holder_document": OTHER_CPF}
    body(await add_method(client, h, same_name))
    listed = body(await client.get(url, headers=world.analyst.headers))
    assert [m["holder_differs"] for m in listed] == [False, True, True]
    # A empresa dele também é ele.
    body(
        await patch(client, world, company_document="12.345.678/0001-95", current_password=PASSWORD)
    )
    company_key = {**CPF_KEY, "pix_key_type": "cnpj", "pix_key": "12.345.678/0001-95"}
    me = body(await add_method(client, h, company_key))
    listed = body(await client.get(url, headers=world.analyst.headers))
    assert next(m for m in listed if m["pix_key_type"] == "cnpj")["holder_differs"] is False
    assert len(listed) == len(me["payout_methods"]) == 4

    # Quem paga: o mapa da tela de Pagamentos.
    board = body(
        await client.get(
            f"{API}/payouts",
            params={"technician_id": tech_id, "with_payout_methods": "true"},
            headers=world.analyst.headers,
        )
    )
    summary = board["payout_methods"][tech_id]
    assert summary["total"] == 4 and summary["preferred"]["pix_key"] == CPF
    assert summary["preferred"]["holder_differs"] is False
    other = body(
        await client.get(
            f"{API}/payouts",
            params={"technician_id": str(world.tech_other.user.id), "with_payout_methods": "1"},
            headers=world.analyst.headers,
        )
    )
    assert other["payout_methods"] == {}

    # Técnico, quem não tem Pagamentos e quem não é técnico.
    assert (await client.get(url, headers=h)).status_code == 403
    r = await client.get(
        f"{API}/technicians/{world.analyst.user.id}/payout-methods",
        headers=world.supervisor.headers,
    )
    assert r.status_code == 404
    await restrict_analyst(
        client, world, **{"base.technicians": "edit", "commercial.payouts": "none"}
    )
    denied = await client.get(url, headers=world.analyst.headers)
    assert denied.status_code == 403 and denied.json()["code"] == "MODULE_FORBIDDEN"


@requires_db
async def test_central_removes_with_history(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    h, tech_id = world.tech.headers, str(world.tech.user.id)
    first = body(await add_method(client, h, CPF_KEY))["payout_methods"][0]
    body(await add_method(client, h, ACCOUNT))
    url = f"{API}/technicians/{tech_id}/payout-methods"

    # O técnico e quem só vê Pagamentos não removem.
    assert (await client.delete(f"{url}/{first['id']}", headers=h)).status_code == 403
    await restrict_analyst(client, world, **{"commercial.payouts": "view"})
    denied = await client.delete(f"{url}/{first['id']}", headers=world.analyst.headers)
    assert denied.status_code == 403 and denied.json()["code"] == "MODULE_FORBIDDEN"
    assert len(body(await client.get(url, headers=world.analyst.headers))) == 2

    events = capture_events(monkeypatch)
    sup = world.supervisor.headers
    r = await client.delete(f"{url}/{first['id']}", headers=sup)
    assert r.status_code == 204
    left = body(await client.get(url, headers=sup))
    assert [(m["kind"], m["preferred"]) for m in left] == [("bank", True)]
    latest = body(await client.get(f"{API}/technicians/{tech_id}/changes", headers=sup))[0]
    assert latest["via"] == "central" and latest["actor"]["name"] == "Super"
    assert latest["changes"] == [
        {"field": "payout_methods", "from": "PIX CPF ***.456.789-** · Tecnico Alfa", "to": None},
        {
            "field": "payout_preferred",
            "from": "PIX CPF ***.456.789-**",
            "to": "Banco Exemplo ****5678-9",
        },
    ]
    assert events == [{"fields": PAYOUT_FIELDS, "via": "central"}]
    # Já removida: 404 com o código, sem histórico novo.
    r = await client.delete(f"{url}/{first['id']}", headers=sup)
    assert r.status_code == 404 and r.json()["code"] == "PAYOUT_METHOD_NOT_FOUND"
    me = (await client.get(f"{API}/me/profile", headers=h)).json()
    assert [m["kind"] for m in me["payout_methods"]] == ["bank"] and me["pix"] is None


@requires_db
async def test_history_masks_payout_data(client: AsyncClient, world: World) -> None:
    h = world.tech.headers
    body(await add_method(client, h, CPF_KEY))
    body(await add_method(client, h, ACCOUNT, preferred=True))
    rows = await history(client, world)
    assert rows[0]["changes"] == [
        {"field": "payout_methods", "from": None, "to": "Banco Exemplo ****5678-9 · Tecnico Alfa"},
        {
            "field": "payout_preferred",
            "from": "PIX CPF ***.456.789-**",
            "to": "Banco Exemplo ****5678-9",
        },
    ]
    assert rows[1]["changes"] == [
        {"field": "payout_methods", "from": None, "to": "PIX CPF ***.456.789-** · Tecnico Alfa"},
        {"field": "payout_preferred", "from": None, "to": "PIX CPF ***.456.789-**"},
    ]
    text_ = str(rows)
    assert CPF not in text_ and "456.789-09" not in text_ and "12345678" not in text_


@requires_db
async def test_paid_event_uses_the_preferred(client: AsyncClient, world: World) -> None:
    an, tech_id = world.analyst.headers, str(world.tech.user.id)
    other_id = str(world.tech_other.user.id)
    body(await add_method(client, world.tech.headers, ACCOUNT))
    t = await create(client, world, title="Rack", assignee_id=tech_id)
    r = await client.patch(f"{API}/tickets/{t['id']}", json={"helper_ids": [other_id]}, headers=an)
    assert r.status_code == 200, r.text
    for who in (tech_id, other_id):
        r = await client.put(
            f"{API}/tickets/{t['id']}/payouts/{who}", json={"amount": 90}, headers=an
        )
        assert r.status_code == 200, r.text
    ids = [p["id"] for p in r.json()]
    assert body(await client.post(f"{API}/payouts/pay", json={"ids": ids}, headers=an)) == {
        "changed": 2
    }
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    paid = {
        e["data"]["technician"]: e["data"]
        for e in events
        if (e.get("data") or {}).get("action") == "paid"
    }
    assert paid["Tecnico"]["payout_method"] == "Banco Exemplo ****5678-9"
    # Sem forma de recebimento, o pagamento sai do mesmo jeito.
    assert "payout_method" not in paid["Redes"]


@requires_db
async def test_reset_alert_covers_payouts_email_and_company(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch, mail_box: MailBox
) -> None:
    """Até 72 h depois de a central redefinir a senha: formas de recebimento, o e-mail pedido e o
    CNPJ vão com quem redefiniu; o resto não."""
    events = capture_events(monkeypatch)
    temp = await reset_by_central(client, world)
    h = await login_mobile(client, "tecnico@teste.com.br", temp)
    h = await change_password(client, h, temp, "senha-do-tecnico-1")
    events.clear()
    pw = "senha-do-tecnico-1"
    me = body(await add_method(client, h, CPF_KEY, password=pw))
    method_id = me["payout_methods"][0]["id"]
    body(
        await client.put(
            f"{METHODS}/{method_id}",
            json={**CPF_KEY, "holder_name": "Tecnico Alfa Silva", "current_password": pw},
            headers=h,
        )
    )
    body(
        await client.patch(
            f"{API}/me/profile",
            json={"company_document": "12.345.678/0001-95", "current_password": pw},
            headers=h,
        )
    )
    body(
        await client.patch(
            f"{API}/me/profile",
            json={"email": "tecnico.alfa@exemplo.com", "current_password": pw},
            headers=h,
        )
    )
    body(await client.patch(f"{API}/me/profile", json={"bio": "Tecnico de campo"}, headers=h))
    fields = [(e["fields"], "after_reset" in e) for e in events]
    assert fields == [
        (PAYOUT_FIELDS, True),
        (["payout_methods"], True),
        (["company_document"], True),
        (["email_pending"], True),
        (["bio"], False),
    ]
    assert all(e["after_reset"]["by"] == "Analista" for e in events if "after_reset" in e)


@requires_db
async def test_counts_and_summary_map(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O que a lista de técnicos (B3) e Pagamentos usam."""
    h = world.tech.headers
    body(await add_method(client, h, CPF_KEY))
    body(await add_method(client, h, ACCOUNT))
    tech, other = world.tech.user.id, world.tech_other.user.id
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        counts = await payout_methods.counts(db, [tech, other])
        summary = await payout_methods.summary_map(db, {tech, other})
        rows = await payout_methods.list_for(db, tech)
        assert await payout_methods.counts(db, []) == {}
    preferred = rows[0]
    assert counts[other] == (0, None)
    assert counts[tech] == (2, payout_methods.destination_changed_at(preferred))
    assert set(summary) == {tech}
    assert summary[tech].total == 2 and summary[tech].preferred.id == preferred.id
