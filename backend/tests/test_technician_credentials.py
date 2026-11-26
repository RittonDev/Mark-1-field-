"""Central: credenciais e dados do técnico (Técnicos em Editar). Trocar o e-mail troca o login na
hora e recomeça a validação; o link de senha por e-mail (sem mexer na senha de hoje e sem o aviso de
72 h); a validação reenviada; o registro dos e-mails; o PATCH com os dados pessoais e da empresa
(relido do banco, coluna a coluna); a lista sem os dados pessoais e o detalhe com eles; cortar o
acesso ou trocar a senha invalida os links de senha.

Dados fictícios (Tecnico Alfa, @exemplo.com, CPF 12345678909, CNPJ 12.345.678/0001-95).
"""

import uuid
from datetime import UTC, date, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import (
    AccountTokenPurpose,
    EmailStatus,
    EmailTemplate,
    PayoutMethodKind,
    PixKeyType,
)
from app.db.base import utcnow
from app.models import AccountToken, EmailOutbox, TechnicianPayoutMethod, User
from app.schemas import personal
from app.services import mail, user_history
from app.services import technicians as technicians_svc
from tests.conftest import MailBox, World, requires_db
from tests.test_b2_onboarding import cpf

pytestmark = requires_db

API = settings.API_PREFIX

PERSONAL = (
    "cpf",
    "rg_number",
    "rg_issuer",
    "rg_state",
    "birth_date",
    "phone_secondary",
    "bio",
    "address_number",
    "address_complement",
    "company_document",
    "company_name",
    "company_trade_name",
    "vehicle_model",
    "vehicle_plate",
)


async def deliver(engine: AsyncEngine) -> int:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        return await mail.deliver_pending(db)


async def set_user(engine: AsyncEngine, user_id: object, **values: object) -> None:
    async with engine.begin() as conn:
        await conn.execute(update(User).where(User.id == user_id).values(**values))


async def add_reset_link(engine: AsyncEngine, user_id: object, email: str) -> uuid.UUID:
    """Um link de senha ainda válido (como o que a boas-vindas ou "Esqueci minha senha" criam)."""
    token_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            AccountToken.__table__.insert().values(
                id=token_id,
                purpose=AccountTokenPurpose.RESET_PASSWORD.value,
                reason="self",
                token_hash=uuid.uuid4().hex * 2,
                user_id=user_id,
                email=email,
                expires_at=utcnow() + timedelta(hours=2),
                created_at=utcnow(),
            )
        )
    return token_id


async def revoked(engine: AsyncEngine, token_id: uuid.UUID) -> bool:
    async with engine.connect() as conn:
        at = await conn.scalar(select(AccountToken.revoked_at).where(AccountToken.id == token_id))
    return at is not None


async def history(client: AsyncClient, world: World, user_id: object) -> list[dict]:
    r = await client.get(f"{API}/technicians/{user_id}/changes", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    return r.json()


async def test_central_email_change_resets_verification(
    client: AsyncClient, world: World, engine: AsyncEngine, mail_box: MailBox
) -> None:
    """A central troca o login na hora: a validação recomeça, o pedido do app sai, os links de
    antes deixam de valer e o link de validação ("check") vai para o e-mail novo depois do commit.
    Em Usuários (técnico), o mesmo."""
    an = world.analyst.headers
    tech_id = world.tech.user.id
    now = datetime.now(UTC)
    await set_user(
        engine,
        tech_id,
        email_verified_at=now,
        email_pending="pedido.app@exemplo.com",
        email_pending_at=now,
    )
    old_link = await add_reset_link(engine, tech_id, "tecnico@teste.com.br")

    r = await client.patch(
        f"{API}/technicians/{tech_id}", json={"email": "Tecnico.Novo@Exemplo.com"}, headers=an
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["email"], body["email_verified_at"], body["email_pending"]) == (
        "tecnico.novo@exemplo.com",
        None,
        None,
    )
    assert await revoked(engine, old_link)
    # O login já é o novo.
    login = await client.post(
        f"{API}/auth/login",
        json={
            "email": "tecnico.novo@exemplo.com",
            "password": "senha-teste-123",
            "channel": "mobile",
        },
    )
    assert login.status_code == 200, login.text
    [line] = await history(client, world, tech_id)
    assert line["via"] == "central" and line["actor"]["name"] == "Analista"
    fields = {c["field"]: (c["from"], c["to"]) for c in line["changes"]}
    assert fields["email"] == ("tecnico@teste.com.br", "tecnico.novo@exemplo.com")
    assert fields["email_verified"] == ("validado", "pendente")
    assert "email_pending" in fields

    # O link de validação sai depois do commit, para o e-mail novo.
    assert len(mail_box.soon) == 1
    assert await deliver(engine) == 1
    [message] = mail_box.messages
    assert message["To"] == "tecnico.novo@exemplo.com"
    assert "Confirme que este e-mail é seu" in mail_box.texts()[0]

    # Em Usuários, a troca do e-mail de um técnico faz o mesmo.
    await set_user(engine, tech_id, email_verified_at=now)
    r = await client.patch(
        f"{API}/users/{tech_id}",
        json={"email": "tecnico.usuarios@exemplo.com"},
        headers=world.admin.headers,
    )
    assert r.status_code == 200, r.text
    one = (await client.get(f"{API}/technicians/{tech_id}", headers=an)).json()
    assert (one["email"], one["email_verified_at"]) == ("tecnico.usuarios@exemplo.com", None)
    assert len(mail_box.soon) == 2
    # O e-mail de outro usuário: recusado como antes.
    r = await client.patch(
        f"{API}/technicians/{tech_id}", json={"email": "redes@teste.com.br"}, headers=an
    )
    assert r.status_code == 422 and r.json()["detail"] == "E-mail já cadastrado"


async def test_password_link_records_history_without_72h_alert(
    client: AsyncClient, world: World, engine: AsyncEngine, mail_box: MailBox
) -> None:
    """O link de senha não mexe na senha nem nas sessões (isso acontece quando o técnico cria a
    senha pelo link), fica no histórico como "Link para nova senha" e não conta como redefinição
    da central para o aviso de 72 h. Cortar o acesso invalida o link."""
    an = world.analyst.headers
    tech_id = world.tech.user.id
    url = f"{API}/technicians/{tech_id}/password-reset-link"
    assert (await client.post(url, headers=world.tech.headers)).status_code == 403

    r = await client.post(url, headers=an)
    assert r.status_code == 202, r.text
    assert r.json() == {"status": "queued", "to": "tecnico@teste.com.br"}
    assert len(mail_box.soon) == 1
    assert (await client.get(f"{API}/auth/me", headers=world.tech.headers)).status_code == 200
    one = (await client.get(f"{API}/technicians/{tech_id}", headers=an)).json()
    assert one["must_change_password"] is False
    [line] = await history(client, world, tech_id)
    assert (line["via"], line["actor"]["name"], line["changes"]) == (
        "central",
        "Analista",
        [{"field": "password_link", "from": None, "to": "enviado para tecnico@teste.com.br"}],
    )
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, tech_id)
        assert user is not None
        change = [{"field": "email", "from": "a@exemplo.com", "to": "b@exemplo.com"}]
        assert await user_history.after_reset(db, user, change) is None

    assert await deliver(engine) == 1
    text = mail_box.texts()[0]
    assert "A central da" in text and "/definir-senha#token=" in text
    [token] = mail_box.tokens()
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": token})
    assert r.status_code == 200 and r.json()["kind"] == "reset", r.text

    r = await client.patch(f"{API}/technicians/{tech_id}", json={"is_active": False}, headers=an)
    assert r.status_code == 200, r.text
    r = await client.post(f"{API}/auth/password-reset/check", json={"token": token})
    assert r.status_code == 410, r.text


async def test_password_link_rules(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Sem acesso ao app: 409; sem endereço que recebe mensagens: 422; com o envio desligado,
    "not_configured" e nada no histórico (nada saiu); até 5 por hora."""
    an = world.analyst.headers
    tech_id = world.tech.user.id
    url = f"{API}/technicians/{tech_id}/password-reset-link"

    r = await client.post(url, headers=an)
    assert r.status_code == 202, r.text
    assert r.json() == {"status": "not_configured", "to": "tecnico@teste.com.br"}
    assert await history(client, world, tech_id) == []

    await set_user(engine, tech_id, is_active=False)
    r = await client.post(url, headers=an)
    assert r.status_code == 409
    assert r.json() == {
        "detail": "Libere o acesso ao app antes de enviar o link",
        "code": "APP_ACCESS_REQUIRED",
    }
    await set_user(engine, tech_id, is_active=True, email="fc-12@importado.invalid")
    r = await client.post(url, headers=an)
    assert r.status_code == 422 and r.json()["detail"] == technicians_svc.NO_VALID_EMAIL

    other = f"{API}/technicians/{world.tech_other.user.id}/password-reset-link"
    for _ in range(5):
        assert (await client.post(other, headers=an)).status_code == 202
    r = await client.post(other, headers=an)
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0


async def test_verification_rules(
    client: AsyncClient, world: World, engine: AsyncEngine, mail_box: MailBox
) -> None:
    """A validação vai para o e-mail novo pedido no app ("change") ou, sem ele, para o login ainda
    não validado ("check"). Já validado: 409; sem endereço que recebe: 422; até 5 por hora."""
    an = world.analyst.headers
    tech_id = world.tech.user.id
    url = f"{API}/technicians/{tech_id}/email-verification"
    assert (await client.post(url, headers=world.tech.headers)).status_code == 403

    r = await client.post(url, headers=an)
    assert r.status_code == 202 and r.json() == {"status": "queued", "to": "tecnico@teste.com.br"}
    await set_user(engine, tech_id, email_verified_at=datetime.now(UTC))
    r = await client.post(url, headers=an)
    assert r.status_code == 409 and r.json() == {
        "detail": "O e-mail deste técnico já está validado",
        "code": "EMAIL_ALREADY_VERIFIED",
    }
    await set_user(engine, tech_id, email_pending="novo.pedido@exemplo.com")
    r = await client.post(url, headers=an)
    assert r.status_code == 202 and r.json() == {"status": "queued", "to": "novo.pedido@exemplo.com"}
    assert await deliver(engine) == 2
    check, change = mail_box.texts()
    assert "Confirme que este e-mail é seu" in check
    assert "Você pediu para trocar o e-mail" in change
    assert [m["To"] for m in mail_box.messages] == [
        "tecnico@teste.com.br",
        "novo.pedido@exemplo.com",
    ]

    await set_user(
        engine,
        tech_id,
        email_pending=None,
        email_verified_at=None,
        email="fc-7@importado.invalid",
    )
    r = await client.post(url, headers=an)
    assert r.status_code == 422 and r.json()["detail"] == (
        "Este técnico não tem e-mail válido. Corrija em Contato ou use a senha provisória"
    )

    other = f"{API}/technicians/{world.tech_other.user.id}/email-verification"
    for _ in range(5):
        assert (await client.post(other, headers=an)).status_code == 202
    r = await client.post(other, headers=an)
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    # O link de verificação de um não-técnico: 404.
    r = await client.post(
        f"{API}/technicians/{world.analyst.user.id}/email-verification", headers=an
    )
    assert r.status_code == 404


async def test_emails_newest_first(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O registro dos e-mails do técnico, o mais novo primeiro, com quem pediu; o pendente que
    passou do prazo de envio sai como "expired" (não saiu)."""
    tech_id = world.tech.user.id
    now = utcnow()

    def row(template: EmailTemplate, status: EmailStatus, minutes: int, **extra: object) -> dict:
        return {
            "id": uuid.uuid4(),
            "template": template.value,
            "to_email": "tecnico@teste.com.br",
            "user_id": tech_id,
            "context": {},
            "status": status.value,
            "attempts": 1 if status == EmailStatus.SENT else 0,
            "next_attempt_at": now,
            "send_by": now + timedelta(hours=2),
            "sent_at": None,
            "created_by_id": None,
            "created_at": now - timedelta(minutes=minutes),
            **extra,
        }

    rows = [
        row(EmailTemplate.WELCOME, EmailStatus.SENT, 90, sent_at=now - timedelta(minutes=89)),
        row(EmailTemplate.VERIFY_EMAIL, EmailStatus.PENDING, 60, send_by=now - timedelta(minutes=1)),
        row(
            EmailTemplate.PASSWORD_RESET,
            EmailStatus.PENDING,
            5,
            created_by_id=world.analyst.user.id,
        ),
        {**row(EmailTemplate.WELCOME, EmailStatus.SENT, 1), "user_id": world.tech_other.user.id},
    ]
    async with engine.begin() as conn:
        await conn.execute(EmailOutbox.__table__.insert(), rows)

    url = f"{API}/technicians/{tech_id}/emails"
    assert (await client.get(url, headers=world.tech.headers)).status_code == 403
    r = await client.get(url, headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    listed = r.json()
    assert [(e["template"], e["status"]) for e in listed] == [
        ("password_reset", "pending"),
        ("verify_email", "expired"),
        ("welcome", "sent"),
    ]
    assert listed[0]["created_by"] == {"id": str(world.analyst.user.id), "name": "Analista"}
    assert listed[2]["sent_at"] is not None and listed[2]["attempts"] == 1
    assert set(listed[0]) == {
        "id",
        "template",
        "to_email",
        "status",
        "attempts",
        "created_at",
        "sent_at",
        "created_by",
    }
    r = await client.get(url, params={"limit": 2}, headers=world.analyst.headers)
    assert [e["template"] for e in r.json()] == ["password_reset", "verify_email"]
    for bad in (0, 51):
        r = await client.get(url, params={"limit": bad}, headers=world.analyst.headers)
        assert r.status_code == 422


async def test_central_patch_rereads_every_column(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Dados pessoais, endereço em partes e empresa pela central (sem senha), relidos do banco.
    RG e empresa em grupo com o gravado; o CPF a central muda e limpa (único); veículo e perfil
    profissional não mudam por aqui."""
    an = world.analyst.headers
    tech_id = world.tech.user.id
    url = f"{API}/technicians/{tech_id}"
    body = {
        "cpf": "123.456.789-09",
        "rg_number": "mg-12.345.678",
        "rg_issuer": "pc",
        "rg_state": "mg",
        "birth_date": "1985-03-10",
        "phone_secondary": "11 3333-4444",
        "bio": "  Técnico de   CFTV. ",
        "address_line": "Rua Exemplo",
        "address_number": "S/N",
        "address_complement": "Fundos",
        "address_district": "Centro",
        "address_zip": "01001000",
        "company_document": "12.345.678/0001-95",
        "company_name": "Alfa Servicos",
        "company_trade_name": "Alfa",
        "vehicle_model": "Não muda por aqui",
    }
    r = await client.patch(url, json=body, headers=an)
    assert r.status_code == 200, r.text
    expected = {
        "cpf": "12345678909",
        "rg_number": "MG-12.345.678",
        "rg_issuer": "PC",
        "rg_state": "MG",
        "birth_date": date(1985, 3, 10),
        "phone_secondary": "(11) 3333-4444",
        "bio": "Técnico de CFTV.",
        "address_line": "Rua Exemplo",
        "address_number": "S/N",
        "address_complement": "Fundos",
        "address_district": "Centro",
        "address_zip": "01001-000",
        "company_document": "12345678000195",
        "company_name": "Alfa Servicos",
        "company_trade_name": "Alfa",
        "vehicle_model": None,
    }

    async def stored() -> dict:
        async with engine.connect() as conn:
            row = (
                await conn.execute(
                    select(*(getattr(User, key) for key in expected)).where(User.id == tech_id)
                )
            ).one()
        return dict(zip(expected, row, strict=True))

    assert await stored() == expected
    out = r.json()
    assert {key: out[key] for key in expected if key != "birth_date"} == {
        key: value for key, value in expected.items() if key != "birth_date"
    }
    assert out["birth_date"] == "1985-03-10"
    [line] = await history(client, world, tech_id)
    fields = {c["field"]: c["to"] for c in line["changes"]}
    assert fields["cpf"] == "123.456.789-09"
    assert fields["rg"] == "MG-12.345.678 · PC/MG"
    assert fields["birth_date"] == "10/03/1985"
    assert fields["company_document"] == "12.345.678/0001-95"

    # Grupos: o enviado com o gravado.
    r = await client.patch(url, json={"rg_issuer": ""}, headers=an)
    assert r.status_code == 422 and r.json()["detail"] == personal.RG_INCOMPLETE
    r = await client.patch(url, json={"company_document": None}, headers=an)
    assert r.status_code == 422 and r.json()["detail"] == personal.COMPANY_WITHOUT_CNPJ
    r = await client.patch(url, json={"rg_number": None, "company_document": ""}, headers=an)
    assert r.status_code == 422  # a empresa ainda tem razão social e nome fantasia
    r = await client.patch(
        url,
        json={"rg_number": None, "company_document": None, "company_name": "", "company_trade_name": None},
        headers=an,
    )
    assert r.status_code == 200, r.text
    after = await stored()
    keys = ("rg_number", "rg_issuer", "rg_state", "company_document", "company_name")
    assert {key: after[key] for key in keys} == dict.fromkeys(keys)
    assert after["company_trade_name"] is None

    # CPF único entre os usuários: 409; a central também limpa.
    other_cpf = cpf("135792468")
    await set_user(engine, world.tech_other.user.id, cpf=other_cpf)
    r = await client.patch(url, json={"cpf": other_cpf}, headers=an)
    assert r.status_code == 409
    assert r.json() == {"detail": "Este CPF já está em outro cadastro", "code": "CPF_TAKEN"}
    r = await client.patch(url, json={"cpf": None}, headers=an)
    assert r.status_code == 200 and r.json()["cpf"] is None

    # Validações por campo, com o rótulo da tela.
    today = personal.local_today()
    cases = [
        ({"cpf": "111.111.111-11"}, "CPF", "CPF inválido"),
        (
            {"birth_date": date(today.year - 17, 1, 1).isoformat()},
            "Data de nascimento",
            personal.BIRTH_UNDERAGE,
        ),
        ({"birth_date": "2000-02-30"}, "Data de nascimento", personal.BIRTH_INVALID),
        ({"phone_secondary": "1234"}, "Telefone secundário", "Informe o telefone com DDD"),
        ({"bio": "x" * 501}, "Mini biografia", "No máximo 500 caracteres"),
        ({"address_number": "12345678901"}, "Número", "No máximo 10 caracteres"),
        ({"address_complement": "x" * 61}, "Complemento", "No máximo 60 caracteres"),
        ({"rg_number": "12"}, "RG", "Confira o número do RG"),
        ({"rg_state": "XX"}, "UF do RG", "UF inválida"),
        ({"company_document": "11.111.111/1111-11"}, "CNPJ", "CNPJ inválido"),
        ({"company_name": "x" * 161}, "Razão social", "No máximo 160 caracteres"),
    ]
    for payload, label, message in cases:
        r = await client.patch(url, json=payload, headers=an)
        assert r.status_code == 422, (payload, r.text)
        [issue] = r.json()["detail"]
        assert (issue["label"], issue["msg"]) == (label, message), payload


async def test_list_without_personal_data_and_detail_with_it(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    tech_id = world.tech.user.id
    await set_user(
        engine,
        tech_id,
        cpf="12345678909",
        birth_date=date(1990, 11, 25),
        bio="Mini biografia de exemplo",
        vehicle_model="Modelo Exemplo",
        vehicle_plate="ABC1D23",
        company_document="12345678000195",
        company_name="Alfa Servicos",
        service_areas=["redes"],
    )
    changed_at = utcnow() - timedelta(days=2)
    async with engine.begin() as conn:
        await conn.execute(
            TechnicianPayoutMethod.__table__.insert().values(
                id=uuid.uuid4(),
                user_id=tech_id,
                kind=PayoutMethodKind.PIX.value,
                pix_key_type=PixKeyType.CPF.value,
                pix_key="12345678909",
                holder_name="Tecnico",
                holder_document="12345678909",
                preferred=True,
                preferred_since=changed_at,
                changed_at=changed_at,
                created_at=changed_at,
                updated_at=changed_at,
            )
        )

    r = await client.get(f"{API}/technicians", headers=an)
    assert r.status_code == 200, r.text
    rows = {row["id"]: row for row in r.json()}
    listed = rows[str(tech_id)]
    assert {key: listed[key] for key in PERSONAL} == dict.fromkeys(PERSONAL)
    assert "has_pix" not in listed and "pix_updated_at" not in listed
    assert listed["service_areas"] == ["redes"]
    assert (listed["payout_methods_count"], listed["operational_status"]) == (1, "active")
    assert datetime.fromisoformat(listed["payout_changed_at"]) == changed_at
    assert (listed["unavailability"], listed["email_verified_at"], listed["email_pending"]) == (
        [],
        None,
        None,
    )
    empty = rows[str(world.tech_other.user.id)]
    assert (empty["payout_methods_count"], empty["payout_changed_at"]) == (0, None)

    one = (await client.get(f"{API}/technicians/{tech_id}", headers=an)).json()
    assert {key: one[key] for key in PERSONAL} == {
        **dict.fromkeys(PERSONAL),
        "cpf": "12345678909",
        "birth_date": "1990-11-25",
        "bio": "Mini biografia de exemplo",
        "vehicle_model": "Modelo Exemplo",
        "vehicle_plate": "ABC1D23",
        "company_document": "12345678000195",
        "company_name": "Alfa Servicos",
    }
    # A remoção da chave PIX pela central saiu (agora é por forma de recebimento, em Pagamentos).
    r = await client.delete(f"{API}/technicians/{tech_id}/pix", headers=world.admin.headers)
    assert r.status_code in (404, 405)


async def test_cutting_access_or_setting_a_password_revokes_password_links(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    tech_id, other_id = world.tech.user.id, world.tech_other.user.id

    link = await add_reset_link(engine, tech_id, "tecnico@teste.com.br")
    r = await client.post(f"{API}/technicians/{tech_id}/reset-password", headers=an)
    assert r.status_code == 200, r.text
    assert await revoked(engine, link)

    link = await add_reset_link(engine, tech_id, "tecnico@teste.com.br")
    r = await client.patch(f"{API}/technicians/{tech_id}", json={"is_active": False}, headers=an)
    assert r.status_code == 200, r.text
    assert await revoked(engine, link)

    admin = world.admin.headers
    link = await add_reset_link(engine, other_id, "redes@teste.com.br")
    r = await client.patch(f"{API}/users/{other_id}", json={"password": "nova-senha-123"}, headers=admin)
    assert r.status_code == 200, r.text
    assert await revoked(engine, link)
    link = await add_reset_link(engine, other_id, "redes@teste.com.br")
    r = await client.patch(f"{API}/users/{other_id}", json={"is_active": False}, headers=admin)
    assert r.status_code == 200, r.text
    assert await revoked(engine, link)
