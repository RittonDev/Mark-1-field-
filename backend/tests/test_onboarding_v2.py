"""Homologação do cadastro V2: os campos novos da ficha, a validação do e-mail que vai no envio, a
aprovação num passo (copia tudo, linha no histórico, boas-vindas), reprovar e reabrir com as
análises, a retenção pela última análise, o reenvio da validação e o aviso onboarding.updated.

Dados fictícios (Tecnico Alfa, Cidade Exemplo, @exemplo.com, CPF 12345678909, CNPJ
12.345.678/0001-95, placa ABC1D23).
"""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.models import TechnicianApplication, User
from app.schemas import personal
from app.schemas.onboarding import ApplicationIn
from app.services import mail, realtime
from app.services import onboarding as onboarding_svc
from tests.conftest import MailBox, World, requires_db
from tests.test_b2_onboarding import cpf
from tests.test_onboarding import ficha, new_invite

pytestmark = requires_db

API = settings.API_PREFIX
APPS = f"{API}/onboarding/applications"
CNPJ = "12.345.678/0001-95"


def full_ficha(**extra: object) -> dict:
    """Uma ficha com todos os campos do cadastro V2 preenchidos."""
    values: dict[str, object] = {
        "full_name": "Tecnico Alfa",
        "email": "tecnico.alfa@exemplo.com",
        "document": "123.456.789-09",
        "phone_secondary": "11 3333-4444",
        "rg_number": "12.345.678-x",
        "rg_issuer": "ssp",
        "rg_state": "sp",
        "birth_date": "1990-11-25",
        "postal_code": "01001000",
        "address": "Praça   Exemplo",
        "address_number": "100",
        "address_complement": " Sala  2 ",
        "address_district": "Centro",
        "city": "Cidade Exemplo",
        "state": "SP",
        "bio": "Técnico de redes e CFTV.",
        "company_document": CNPJ,
        "company_name": "Tecnico Alfa Servicos",
        "company_trade_name": "Alfa Redes",
        "has_vehicle": True,
        "vehicle_type": "carro",
        "vehicle_model": "Modelo Exemplo",
        "vehicle_plate": "abc1d23",
        "photo": None,
    }
    return ficha(**{**values, **extra})


async def submit(client: AsyncClient, token: str, body: dict) -> dict:
    r = await client.post(f"{API}/public/onboarding/{token}", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def application_id(client: AsyncClient, world: World, email: str) -> str:
    listed = (await client.get(APPS, headers=world.analyst.headers)).json()
    return next(a["id"] for a in listed if a["email"] == email)


async def reject(client: AsyncClient, world: World, app_id: str, reason: str) -> dict:
    r = await client.post(
        f"{APPS}/{app_id}/reject", json={"reason": reason}, headers=world.analyst.headers
    )
    assert r.status_code == 200, r.text
    return r.json()


def capture(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    published: list[dict] = []

    async def publish(event: dict) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", publish)
    return published


async def deliver(engine: AsyncEngine) -> int:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        return await mail.deliver_pending(db)


async def test_ficha_new_fields_are_saved(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    token = await new_invite(client, world)
    received = await submit(client, token, full_ficha())
    # Sem envio configurado, a validação entra na fila e vence sem sair.
    assert received["email_verification"] == "not_configured"
    app_id = await application_id(client, world, "tecnico.alfa@exemplo.com")
    [summary] = (await client.get(APPS, headers=an)).json()
    assert (summary["email_verified_at"], summary["reopened_at"]) == (None, None)

    detail = (await client.get(f"{APPS}/{app_id}", headers=an)).json()
    expected = {
        "phone_secondary": "(11) 3333-4444",
        "rg_number": "12.345.678-X",
        "rg_issuer": "SSP",
        "rg_state": "SP",
        "birth_date": "1990-11-25",
        "address": "Praça Exemplo",
        "address_number": "100",
        "address_complement": "Sala 2",
        "address_district": "Centro",
        "bio": "Técnico de redes e CFTV.",
        "company_document": "12345678000195",
        "company_name": "Tecnico Alfa Servicos",
        "company_trade_name": "Alfa Redes",
        "vehicle_model": "Modelo Exemplo",
        "vehicle_plate": "ABC1D23",
    }
    assert {key: detail[key] for key in expected} == expected
    assert (detail["has_password"], detail["reviews"], detail["reopened_by"]) == (True, [], None)
    assert detail["purge_at"] is None
    # Relido do banco, coluna a coluna (campo com nome errado sumiria calado).
    columns = [getattr(TechnicianApplication, key) for key in expected]
    async with engine.connect() as conn:
        row = (await conn.execute(select(*columns).where(TechnicianApplication.id == app_id))).one()
    stored = dict(zip(expected, row, strict=True))
    stored["birth_date"] = stored["birth_date"].isoformat()
    assert stored == expected

    # Sem veículo próprio, modelo e placa não ficam; RG sem número sai inteiro.
    other = await new_invite(client, world)
    body = full_ficha(
        email="sem.veiculo@exemplo.com",
        document=cpf("321654987"),
        has_vehicle=False,
        rg_number="",
        company_document=None,
        company_name=None,
        company_trade_name=None,
    )
    await submit(client, other, body)
    plain = (
        await client.get(
            f"{APPS}/{await application_id(client, world, 'sem.veiculo@exemplo.com')}",
            headers=an,
        )
    ).json()
    keys = ("vehicle_model", "vehicle_plate", "rg_number", "rg_issuer", "rg_state")
    assert {key: plain[key] for key in keys} == dict.fromkeys(keys)


async def test_ficha_validations(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    token = await new_invite(client, world, reusable=True, days_valid=30)
    url = f"{API}/public/onboarding/{token}"
    incomplete = personal.RG_INCOMPLETE
    cases: list[tuple[dict, tuple[str, str]]] = [
        (
            {"rg_number": "12.345.678-9", "rg_issuer": "", "rg_state": "SP"},
            ("rg_issuer", incomplete),
        ),
        ({"rg_number": "12.345.678-9", "rg_issuer": "SSP"}, ("rg_state", incomplete)),
        ({"rg_number": "123"}, ("rg_number", "Confira o número do RG")),
        (
            {"rg_number": "12.345.678-9", "rg_issuer": "SSP", "rg_state": "XX"},
            ("rg_state", "UF inválida"),
        ),
        ({"company_name": "Alfa Servicos"}, ("company_document", "Informe o CNPJ")),
        ({"company_trade_name": "Alfa"}, ("company_document", "Informe o CNPJ")),
        (
            {"has_vehicle": True, "vehicle_plate": "AB12345"},
            ("vehicle_plate", "Placa inválida: confira as letras e os números"),
        ),
        ({"bio": "x" * 501}, ("bio", "No máximo 500 caracteres")),
        ({"birth_date": "1930-01-01"}, ("birth_date", "Confira a data de nascimento")),
        ({"birth_date": "2026-02-30"}, ("birth_date", "Confira a data de nascimento")),
        # Número não é data (viraria segundos desde 1970, sem passar pela idade).
        ({"birth_date": 1577836800}, ("birth_date", "Confira a data de nascimento")),
        ({"birth_date": -1262304000.0}, ("birth_date", "Confira a data de nascimento")),
        # O nome entra na saudação do e-mail de validação: só letras, como no app.
        ({"full_name": "https://golpe.exemplo/entrar Silva"}, ("full_name", personal.NAME_LETTERS)),
        ({"full_name": "Tecnico www.golpe.exemplo"}, ("full_name", personal.NAME_LETTERS)),
        ({"full_name": "Tecnico Alfa 11988887777"}, ("full_name", personal.NAME_LETTERS)),
        ({"phone_secondary": "123"}, ("phone_secondary", "Informe o telefone com DDD")),
        ({"address_number": "12345678901"}, ("address_number", "No máximo 10 caracteres")),
        ({"address_complement": "x" * 61}, ("address_complement", "No máximo 60 caracteres")),
        ({"vehicle_model": "x" * 61}, ("vehicle_model", "No máximo 60 caracteres")),
    ]
    for n, (extra, (field, message)) in enumerate(cases):
        body = ficha(email=f"v{n}@exemplo.com", document=cpf(f"55566677{n % 10}"), photo=None)
        r = await client.post(url, json={**body, **extra})
        assert r.status_code == 422, (extra, r.text)
        [issue] = r.json()["detail"]
        assert (issue["loc"][-1], issue["msg"]) == (field, message), extra
    # O CPF já é de um usuário (o cadastro da pessoa já existe).
    async with engine.begin() as conn:
        await conn.execute(
            update(User).where(User.id == world.tech.user.id).values(cpf="12345678909")
        )
    r = await client.post(url, json=ficha(email="cpf@exemplo.com", document="123.456.789-09"))
    assert r.status_code == 422 and "CPF" in r.json()["detail"]
    # O link não foi gasto por nenhuma das recusadas.
    assert (await client.get(url)).json()["valid"] is True


async def test_approval_copies_everything(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Um passo, sem corpo: o técnico nasce com tudo o que a ficha coletou, Ativo e com a
    validação do e-mail da ficha; a ficha ganha a análise "approved"."""
    an = world.analyst.headers
    token = await new_invite(client, world)
    await submit(client, token, full_ficha())
    app_id = await application_id(client, world, "tecnico.alfa@exemplo.com")
    verified_at = datetime(2026, 11, 20, 12, tzinfo=UTC)
    async with engine.begin() as conn:
        await conn.execute(
            update(TechnicianApplication)
            .where(TechnicianApplication.id == app_id)
            .values(email_verified_at=verified_at)
        )

    r = await client.post(f"{APPS}/{app_id}/approve", headers=an)
    assert r.status_code == 200, r.text
    tech_id = r.json()["technician"]["id"]
    assert r.json()["technician"]["must_change_password"] is False
    assert r.json()["password_link"] is False  # com a senha da ficha, nenhum link de senha

    copied = {
        "cpf": "12345678909",
        "rg_number": "12.345.678-X",
        "rg_issuer": "SSP",
        "rg_state": "SP",
        "birth_date": "1990-11-25",
        "phone_secondary": "(11) 3333-4444",
        "bio": "Técnico de redes e CFTV.",
        "address_line": "Praça Exemplo",
        "address_number": "100",
        "address_complement": "Sala 2",
        "address_district": "Centro",
        "address_zip": "01001-000",
        "company_document": "12345678000195",
        "company_name": "Tecnico Alfa Servicos",
        "company_trade_name": "Alfa Redes",
        "vehicle_model": "Modelo Exemplo",
        "vehicle_plate": "ABC1D23",
        "home_city": "Cidade Exemplo",
        "home_state": "SP",
    }
    one = (await client.get(f"{API}/technicians/{tech_id}", headers=an)).json()
    assert {key: one[key] for key in copied} == copied
    assert one["service_areas"] == ["cftv", "redes"]
    assert one["operational_status"] == "active"
    assert datetime.fromisoformat(one["email_verified_at"]) == verified_at
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                select(*(getattr(User, key) for key in copied)).where(User.id == tech_id)
            )
        ).one()
    stored = dict(zip(copied, row, strict=True))
    stored["birth_date"] = stored["birth_date"].isoformat()
    assert stored == copied

    detail = (await client.get(f"{APPS}/{app_id}", headers=an)).json()
    assert detail["status"] == "approved" and detail["user_id"] == tech_id
    [review] = detail["reviews"]
    assert (review["action"], review["by"], review["note"]) == (
        "approved",
        {"id": str(world.analyst.user.id), "name": "Analista"},
        None,
    )
    assert detail["purge_at"] is None and detail["has_password"] is False


async def test_ficha_uses_the_rules_of_the_app_and_the_central(
    client: AsyncClient, world: World
) -> None:
    """As regras de schemas/personal.py, iguais no app e na central: o número em maiúsculas ("s / n"
    vira "S/N"), o órgão emissor com a UF no fim gravado separado (a UF vazia recebe a do fim; com
    outra UF, vale a do campo) e a mini biografia com os parágrafos. Na ficha e no técnico que a
    aprovação cria."""
    an = world.analyst.headers
    token = await new_invite(client, world)
    bio = "Técnico de redes.  \r\n\r\n\r\nAtendo a Cidade Exemplo.  "
    body = full_ficha(address_number="s / n", rg_issuer="ssp/sp", rg_state="", bio=bio)
    await submit(client, token, body)
    app_id = await application_id(client, world, "tecnico.alfa@exemplo.com")
    expected = {
        "address_number": "S/N",
        "rg_issuer": "SSP",
        "rg_state": "SP",
        "bio": "Técnico de redes.\n\nAtendo a Cidade Exemplo.",
    }
    detail = (await client.get(f"{APPS}/{app_id}", headers=an)).json()
    assert {key: detail[key] for key in expected} == expected
    r = await client.post(f"{APPS}/{app_id}/approve", json={}, headers=an)
    assert r.status_code == 200, r.text
    tech_id = r.json()["technician"]["id"]
    one = (await client.get(f"{API}/technicians/{tech_id}", headers=an)).json()
    assert {key: one[key] for key in expected} == expected

    other = ApplicationIn.model_validate(full_ficha(rg_issuer="SSP-SP", rg_state="rj"))
    assert (other.rg_issuer, other.rg_state) == ("SSP", "RJ")
    odd = ApplicationIn.model_validate(full_ficha(rg_issuer="SSP/XX", rg_state="SP"))
    assert (odd.rg_issuer, odd.rg_state) == ("SSP XX", "SP")


def test_address_of_the_ficha_from_before_is_split() -> None:
    """Ficha com o endereço numa linha e sem o número (a de antes da publicação, ou o número
    digitado no logradouro): a aprovação separa como a migração (personal.split_address_line), com
    o complemento da ficha depois do da linha; o que não separa com segurança fica como está."""

    def approved(**fields: object) -> tuple[str | None, str | None, str | None]:
        return onboarding_svc.ficha_address(TechnicianApplication(**fields))

    assert approved(address="Rua Exemplo, 123 - Apto 4") == ("Rua Exemplo", "123", "Apto 4")
    assert approved(address="Rua Exemplo, s/n", address_complement="Fundos") == (
        "Rua Exemplo",
        "S/N",
        "Fundos",
    )
    assert approved(address="Rua Exemplo, 10 - Casa 2", address_complement="Fundos") == (
        "Rua Exemplo",
        "10",
        "Casa 2 - Fundos",
    )
    assert approved(address="Rua Exemplo, 10 - Casa 2", address_complement="Casa 2") == (
        "Rua Exemplo",
        "10",
        "Casa 2",
    )
    # Com o número, ou sem dar para separar, como veio.
    assert approved(address="Rua Exemplo, 10", address_number="12") == ("Rua Exemplo, 10", "12", None)
    assert approved(address="Rodovia SP-55, km 12") == ("Rodovia SP-55, km 12", None, None)
    assert approved(address=None, address_complement="Fundos") == (None, None, "Fundos")
    # Os dois complementos juntos passariam de 60: a linha fica inteira.
    long = "x" * 50
    assert approved(address=f"Rua Exemplo, 10 - {long}", address_complement="Bloco B Fundos") == (
        f"Rua Exemplo, 10 - {long}",
        None,
        "Bloco B Fundos",
    )


async def test_approval_refuses_a_cpf_of_another_user(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    token = await new_invite(client, world)
    await submit(client, token, full_ficha())
    app_id = await application_id(client, world, "tecnico.alfa@exemplo.com")
    # O CPF foi para outro cadastro depois do envio (a central corrigiu o de outra pessoa).
    async with engine.begin() as conn:
        await conn.execute(
            update(User).where(User.id == world.tech.user.id).values(cpf="12345678909")
        )
    r = await client.post(f"{APPS}/{app_id}/approve", json={}, headers=world.analyst.headers)
    assert r.status_code == 409, r.text
    assert r.json() == {"detail": "Este CPF já está em outro cadastro", "code": "CPF_TAKEN"}
    detail = (await client.get(f"{APPS}/{app_id}", headers=world.analyst.headers)).json()
    assert detail["status"] == "pending"


async def test_approval_in_one_step_queues_welcome(
    client: AsyncClient, world: World, engine: AsyncEngine, mail_box: MailBox
) -> None:
    """Com o envio ligado: a ficha manda a validação ("signup") e a aprovação a boas-vindas, que
    saem logo depois do commit. Com senha e o e-mail ainda não validado, a boas-vindas pede a
    validação (o link de criar senha é só para quem ficou sem senha)."""
    an = world.analyst.headers
    token = await new_invite(client, world)
    received = await submit(client, token, ficha(email="bem.vindo@exemplo.com", photo=None))
    assert received["email_verification"] == "queued"
    assert len(mail_box.soon) == 1
    app_id = await application_id(client, world, "bem.vindo@exemplo.com")

    r = await client.post(f"{APPS}/{app_id}/approve", json={}, headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["welcome"] == {"status": "queued", "to": "bem.vindo@exemplo.com"}
    assert r.json()["password_link"] is False
    assert len(mail_box.soon) == 2
    assert await deliver(engine) == 2
    subjects = [message["Subject"] for message in mail_box.messages]
    assert subjects[0] == "Confirme seu e-mail"
    assert subjects[1].startswith("Cadastro aprovado: boas-vindas à")
    assert all(message["To"] == "bem.vindo@exemplo.com" for message in mail_box.messages)
    signup, welcome = mail_box.texts()
    assert "Recebemos sua ficha de cadastro" in signup and "/validar-email#token=" in signup
    assert "/validar-email#token=" in welcome and "/definir-senha" not in welcome
    assert "a que você criou na ficha de cadastro" in welcome


async def test_reopen_rules(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    an = world.analyst.headers
    token = await new_invite(client, world, reusable=True, days_valid=30)
    same_cpf = cpf("100200300")
    await submit(client, token, ficha(email="a@exemplo.com", document=same_cpf, photo=None))
    a_id = await application_id(client, world, "a@exemplo.com")

    async def reopen(app_id: str, reason: str = "Documentação nova chegou") -> Response:
        return await client.post(f"{APPS}/{app_id}/reopen", json={"reason": reason}, headers=an)

    r = await reopen(a_id)
    assert r.status_code == 409 and r.json() == {
        "detail": "Só a ficha reprovada pode ser reaberta",
        "code": "APPLICATION_NOT_REJECTED",
    }
    await reject(client, world, a_id, "Sem experiência comprovada")
    r = await reopen(a_id, " x ")
    assert r.status_code == 422 and r.json()["detail"][0]["msg"] == "Informe o motivo"
    r = await client.post(
        f"{APPS}/{a_id}/reopen", json={"reason": "Nova análise", "note": "x"}, headers=an
    )
    assert r.status_code == 422  # só o motivo
    r = await client.post(
        f"{APPS}/{a_id}/reopen", json={"reason": "Nova análise"}, headers=world.tech.headers
    )
    assert r.status_code == 403

    # Outra ficha da mesma pessoa (o mesmo CPF) em análise: 409.
    await submit(client, token, ficha(email="b@exemplo.com", document=same_cpf, photo=None))
    b_id = await application_id(client, world, "b@exemplo.com")
    r = await reopen(a_id)
    assert r.status_code == 409 and r.json()["code"] == "APPLICATION_DUPLICATE"
    assert r.json()["detail"] == "Há outra ficha desta pessoa em análise ou aprovada"
    await reject(client, world, b_id, "Ficha repetida")

    r = await reopen(a_id)
    assert r.status_code == 200, r.text
    detail = r.json()
    assert detail["status"] == "pending" and detail["reopened_at"] is not None
    assert detail["reopened_by"] == {"id": str(world.analyst.user.id), "name": "Analista"}
    assert (detail["reviewed_at"], detail["reviewed_by"], detail["review_note"]) == (
        None,
        None,
        None,
    )
    assert (detail["purge_at"], detail["has_password"]) == (None, False)
    assert [(v["action"], v["note"], v["by"]["name"]) for v in detail["reviews"]] == [
        ("rejected", "Sem experiência comprovada", "Analista"),
        ("reopened", "Documentação nova chegou", "Analista"),
    ]
    listed = {a["id"]: a for a in (await client.get(APPS, headers=an)).json()}
    assert listed[a_id]["reopened_at"] == detail["reopened_at"]
    # Agora é a B que tem a mesma pessoa em análise.
    r = await reopen(b_id)
    assert r.status_code == 409 and r.json()["code"] == "APPLICATION_DUPLICATE"

    # O CPF virou o de um usuário: 409.
    await submit(client, token, ficha(email="c@exemplo.com", document=cpf("400500600"), photo=None))
    c_id = await application_id(client, world, "c@exemplo.com")
    await reject(client, world, c_id, "Fora da região")
    async with engine.begin() as conn:
        await conn.execute(
            update(User).where(User.id == world.tech.user.id).values(cpf=cpf("400500600"))
        )
    r = await reopen(c_id)
    assert r.status_code == 409 and r.json() == {
        "detail": "Este CPF já está em outro cadastro",
        "code": "CPF_TAKEN",
    }

    # O e-mail virou o login de um usuário: 409.
    await submit(client, token, ficha(email="d@exemplo.com", document=cpf("700800900"), photo=None))
    d_id = await application_id(client, world, "d@exemplo.com")
    await reject(client, world, d_id, "Fora da região")
    async with engine.begin() as conn:
        await conn.execute(
            update(User).where(User.id == world.tech_other.user.id).values(email="d@exemplo.com")
        )
    r = await reopen(d_id)
    assert r.status_code == 409 and r.json() == {
        "detail": "Já existe um usuário com este e-mail",
        "code": "EMAIL_TAKEN",
    }


async def _approve_reopened_without_password(
    client: AsyncClient, world: World, engine: AsyncEngine, email: str, *, verified: bool
) -> Response:
    """Reprovar apaga a senha da ficha: reaberta (com o e-mail validado ou não) e aprovada."""
    an = world.analyst.headers
    token = await new_invite(client, world)
    await submit(client, token, ficha(email=email, photo=None))
    app_id = await application_id(client, world, email)
    await reject(client, world, app_id, "Faltou o RG")
    r = await client.post(f"{APPS}/{app_id}/reopen", json={"reason": "RG enviado"}, headers=an)
    assert r.status_code == 200 and r.json()["has_password"] is False, r.text
    if verified:
        async with engine.begin() as conn:
            await conn.execute(
                update(TechnicianApplication)
                .where(TechnicianApplication.id == app_id)
                .values(email_verified_at=datetime.now(UTC))
            )
    r = await client.post(f"{APPS}/{app_id}/approve", json={}, headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["technician"]["must_change_password"] is True
    assert r.json()["welcome"]["status"] == "queued"
    # A senha da ficha não vale mais.
    login = await client.post(
        f"{API}/auth/login",
        json={"email": email, "password": "minha-senha-forte", "channel": "mobile"},
    )
    assert login.status_code == 401
    return r


async def test_reopened_approval_without_password_and_unverified_email_has_no_link(
    client: AsyncClient, world: World, engine: AsyncEngine, mail_box: MailBox
) -> None:
    """Sem senha e com o e-mail nunca validado (pode ter sido digitado errado), a boas-vindas não
    leva o link de criar senha (quem abrisse ficaria com a conta): ela diz que a central manda a
    senha provisória pelo WhatsApp, e a resposta avisa a central (`password_link` falso)."""
    r = await _approve_reopened_without_password(
        client, world, engine, "sem.validar@exemplo.com", verified=False
    )
    assert r.json()["password_link"] is False
    await deliver(engine)
    welcome = mail_box.texts()[-1]
    assert "/definir-senha" not in welcome
    assert "Senha: a central manda uma senha provisória pelo WhatsApp." in welcome


async def test_reopened_approval_without_password_and_verified_email_sends_create_link(
    client: AsyncClient, world: World, engine: AsyncEngine, mail_box: MailBox
) -> None:
    """Sem senha e com o e-mail validado: a boas-vindas leva o link para criar a senha (72 h) e a
    resposta diz isso (`password_link`)."""
    r = await _approve_reopened_without_password(
        client, world, engine, "validado@exemplo.com", verified=True
    )
    assert r.json()["password_link"] is True
    await deliver(engine)
    welcome = mail_box.texts()[-1]
    assert "/definir-senha#token=" in welcome and "/validar-email" not in welcome
    assert "senha provisória" not in welcome


async def test_retention_counts_from_last_rejection_and_reopen(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    token = await new_invite(client, world, reusable=True, days_valid=30)
    emails = {
        "reaberta": "reaberta@exemplo.com",  # pendente: enviada há muito, reaberta agora
        "recente": "recente@exemplo.com",  # reprovada agora, enviada há muito
        "antiga": "antiga@exemplo.com",  # reprovada há muito
        "parada": "parada@exemplo.com",  # pendente: reaberta há muito
    }
    ids: dict[str, str] = {}
    for n, (key, email) in enumerate(emails.items()):
        await submit(client, token, ficha(email=email, document=cpf(f"20030040{n}"), photo=None))
        ids[key] = await application_id(client, world, email)
    for key in ("reaberta", "recente", "antiga", "parada"):
        await reject(client, world, ids[key], "Sem experiência comprovada")
    for key in ("reaberta", "parada"):
        r = await client.post(
            f"{APPS}/{ids[key]}/reopen", json={"reason": "Nova análise"}, headers=an
        )
        assert r.status_code == 200, r.text

    old = datetime.now(UTC) - timedelta(days=settings.ONBOARDING_RETENTION_DAYS + 1)
    table = TechnicianApplication
    async with engine.begin() as conn:
        await conn.execute(update(table).values(created_at=old))
        await conn.execute(update(table).where(table.id == ids["antiga"]).values(reviewed_at=old))
        await conn.execute(update(table).where(table.id == ids["parada"]).values(reopened_at=old))

    recent = (await client.get(f"{APPS}/{ids['recente']}", headers=an)).json()
    reviewed = datetime.fromisoformat(recent["reviewed_at"])
    assert datetime.fromisoformat(recent["purge_at"]) == reviewed + timedelta(
        days=settings.ONBOARDING_RETENTION_DAYS
    )

    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        changed = await onboarding_svc.purge_expired(db)
    assert changed == 2
    assert (await client.get(f"{APPS}/{ids['antiga']}", headers=an)).status_code == 404
    assert (await client.get(f"{APPS}/{ids['reaberta']}", headers=an)).json()["status"] == "pending"
    assert (await client.get(f"{APPS}/{ids['recente']}", headers=an)).json()["status"] == "rejected"
    stale = (await client.get(f"{APPS}/{ids['parada']}", headers=an)).json()
    assert (stale["status"], stale["review_note"], stale["reviewed_by"]) == (
        "rejected",
        "Expirada sem análise",
        None,
    )
    assert [(v["action"], v["by"]) for v in stale["reviews"]][-1] == ("expired", None)
    assert stale["purge_at"] is not None


async def test_resend_verification_from_homologacao(
    client: AsyncClient, world: World, engine: AsyncEngine, mail_box: MailBox
) -> None:
    an = world.analyst.headers
    token = await new_invite(client, world, reusable=True, days_valid=30)
    await submit(client, token, ficha(email="reenvio@exemplo.com", photo=None))
    app_id = await application_id(client, world, "reenvio@exemplo.com")
    url = f"{APPS}/{app_id}/email-verification"
    assert (await client.post(url, headers=world.tech.headers)).status_code == 403

    for _ in range(5):
        r = await client.post(url, headers=an)
        assert r.status_code == 202, r.text
        assert r.json() == {"status": "queued", "to": "reenvio@exemplo.com"}
    r = await client.post(url, headers=an)
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    # Enquanto não sai, a mesma linha da fila (sem duplicar).
    assert len(set(mail_box.soon)) == 1

    # Já validada: 409.
    async with engine.begin() as conn:
        await conn.execute(
            update(TechnicianApplication)
            .where(TechnicianApplication.id == app_id)
            .values(email_verified_at=datetime.now(UTC))
        )
    await submit(client, token, ficha(email="validada@exemplo.com", document=cpf("909808707")))
    valid_id = await application_id(client, world, "validada@exemplo.com")
    async with engine.begin() as conn:
        await conn.execute(
            update(TechnicianApplication)
            .where(TechnicianApplication.id == valid_id)
            .values(email_verified_at=datetime.now(UTC))
        )
    r = await client.post(f"{APPS}/{valid_id}/email-verification", headers=an)
    assert r.status_code == 409 and r.json() == {
        "detail": "E-mail já validado",
        "code": "EMAIL_ALREADY_VERIFIED",
    }
    # Analisada: 409.
    await reject(client, world, valid_id, "Fora da região")
    r = await client.post(f"{APPS}/{valid_id}/email-verification", headers=an)
    assert r.status_code == 409 and r.json() == {
        "detail": "Reenvio só para ficha em análise",
        "code": "APPLICATION_NOT_PENDING",
    }


async def test_verify_ficha_email_before_and_after_approval(
    client: AsyncClient, world: World, engine: AsyncEngine, mail_box: MailBox
) -> None:
    """O link da ficha valida a ficha; aprovada antes de o candidato abrir o link, valida também o
    login do técnico (o mesmo e-mail)."""
    an = world.analyst.headers
    token = await new_invite(client, world, reusable=True, days_valid=30)
    await submit(client, token, ficha(email="antes@exemplo.com", photo=None))
    await submit(client, token, ficha(email="depois@exemplo.com", document=cpf("606505404")))
    await deliver(engine)
    before_link, after_link = mail_box.tokens()

    r = await client.post(f"{API}/auth/verify-email", json={"token": before_link})
    assert r.status_code == 200, r.text
    assert r.json() == {"email": "antes@exemplo.com", "kind": "signup"}
    before_id = await application_id(client, world, "antes@exemplo.com")
    detail = (await client.get(f"{APPS}/{before_id}", headers=an)).json()
    assert detail["email_verified_at"] is not None
    r = await client.post(f"{APPS}/{before_id}/approve", json={}, headers=an)
    one = (await client.get(f"{API}/technicians/{r.json()['technician']['id']}", headers=an)).json()
    assert one["email_verified_at"] == detail["email_verified_at"]

    after_id = await application_id(client, world, "depois@exemplo.com")
    r = await client.post(f"{APPS}/{after_id}/approve", json={}, headers=an)
    tech_id = r.json()["technician"]["id"]
    assert (await client.get(f"{API}/technicians/{tech_id}", headers=an)).json()[
        "email_verified_at"
    ] is None
    r = await client.post(f"{API}/auth/verify-email", json={"token": after_link})
    assert r.status_code == 200, r.text
    one = (await client.get(f"{API}/technicians/{tech_id}", headers=an)).json()
    assert one["email_verified_at"] is not None


async def test_onboarding_updated_event(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reprovar, reabrir e aprovar avisam a gestão (quem tem Homologação) com o nome e a ação; a
    aprovação avisa também a mudança no cadastro do técnico (via ficha)."""
    an = world.analyst.headers
    token = await new_invite(client, world)
    await submit(client, token, ficha(email="aviso@exemplo.com", photo=None))
    app_id = await application_id(client, world, "aviso@exemplo.com")
    published = capture(monkeypatch)
    await reject(client, world, app_id, "Faltou o RG")
    r = await client.post(f"{APPS}/{app_id}/reopen", json={"reason": "RG enviado"}, headers=an)
    assert r.status_code == 200, r.text
    r = await client.post(f"{APPS}/{app_id}/approve", json={}, headers=an)
    assert r.status_code == 200, r.text
    tech_id = r.json()["technician"]["id"]

    updates = [e for e in published if e["type"] == "onboarding.updated"]
    assert [e["data"]["action"] for e in updates] == ["rejected", "reopened", "approved"]
    for event in updates:
        assert (event["application_id"], event["name"]) == (app_id, "Tecnico Alfa da Silva")
        assert event["audience"] == {"managers_only": True}
    [changed] = [e for e in published if e["type"] == "profile.changed"]
    assert (changed["user_id"], changed["data"]["via"], changed["data"]["fields"]) == (
        tech_id,
        "ficha",
        ["application"],
    )
