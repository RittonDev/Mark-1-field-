"""Meu cadastro do técnico: o próprio cadastro no app, o e-mail e as formas de recebimento com a
senha, o histórico do cadastro e o aviso à central. (As regras das formas de recebimento ficam em
test_payout_methods.py; os dados pessoais novos e o e-mail pendente, em test_cadastro_v2_profile.py.)

Só dados fictícios: CPF 12345678909, "Tecnico Alfa", @exemplo.com.
"""

import asyncio
import base64
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import ApplicationStatus
from app.models import TechnicianApplication, User
from app.schemas.my_profile import NAME_LETTERS
from app.services import login_guard, my_profile, onboarding, realtime
from tests.conftest import MailBox, World, requires_db
from tests.test_access import restrict_analyst
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX
PASSWORD = "senha-teste-123"
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)
METHODS = f"{API}/me/profile/payout-methods"
# Formas de recebimento (POST /me/profile/payout-methods): a chave CPF é o documento do titular.
CPF_KEY = {
    "kind": "pix",
    "pix_key_type": "cpf",
    "pix_key": "123.456.789-09",
    "holder_name": "Tecnico Alfa",
}
PHONE_KEY = {
    "kind": "pix",
    "pix_key_type": "phone",
    "pix_key": "(11) 98888-7777",
    "holder_name": "Tecnico Alfa",
    "holder_document": "123.456.789-09",
}
PAYOUT_FIELDS = ["payout_methods", "payout_preferred"]


async def patch(client: AsyncClient, world: World, **body: object) -> Response:
    return await client.patch(f"{API}/me/profile", json=body, headers=world.tech.headers)


async def add_method(
    client: AsyncClient,
    headers: dict[str, str],
    body: dict,
    password: str | None = PASSWORD,
    **extra: object,
) -> Response:
    """POST /me/profile/payout-methods com a senha (None: sem a senha)."""
    payload = {**body, **extra}
    if password is not None:
        payload["current_password"] = password
    return await client.post(METHODS, json=payload, headers=headers)


async def history(client: AsyncClient, world: World) -> list[dict]:
    r = await client.get(
        f"{API}/technicians/{world.tech.user.id}/changes", headers=world.analyst.headers
    )
    assert r.status_code == 200, r.text
    return r.json()


async def stored(engine: AsyncEngine, user_id: uuid.UUID) -> User:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, user_id)
        assert user is not None
        return user


def messages(r: Response) -> list[str]:
    detail = r.json()["detail"]
    return [detail] if isinstance(detail, str) else [d["msg"] for d in detail]


def bearer(tokens: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def login_mobile(client: AsyncClient, email: str, password: str) -> dict[str, str]:
    r = await client.post(
        f"{API}/auth/login", json={"email": email, "password": password, "channel": "mobile"}
    )
    assert r.status_code == 200, r.text
    return bearer(r.json())


async def reset_by_central(client: AsyncClient, world: World) -> str:
    """Técnicos › Redefinir senha (pelo analista): devolve a provisória."""
    r = await client.post(
        f"{API}/technicians/{world.tech.user.id}/reset-password", headers=world.analyst.headers
    )
    assert r.status_code == 200, r.text
    return r.json()["temporary_password"]


async def change_password(
    client: AsyncClient, headers: dict[str, str], current: str, new: str
) -> dict[str, str]:
    r = await client.post(
        f"{API}/auth/change-password",
        json={"current_password": current, "new_password": new},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return bearer(r.json())


def capture_events(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """O `data` de cada profile.changed publicado (na ordem)."""
    published: list[dict] = []

    async def capture(event: dict) -> None:
        if event["type"] == "profile.changed":
            published.append(event["data"])

    monkeypatch.setattr(realtime.bus, "publish", capture)
    return published


async def test_only_technicians_have_my_profile(client: AsyncClient, world: World) -> None:
    for actor in (world.analyst, world.requester, world.admin):
        assert (await client.get(f"{API}/me/profile", headers=actor.headers)).status_code == 403
        r = await client.patch(f"{API}/me/profile", json={"name": "X"}, headers=actor.headers)
        assert r.status_code == 403
    r = await client.get(f"{API}/me/profile", headers=world.tech.headers)
    assert r.status_code == 200, r.text
    me = r.json()
    assert (me["id"], me["name"], me["email"]) == (
        str(world.tech.user.id),
        "Tecnico",
        "tecnico@teste.com.br",
    )
    assert me["team"]["name"] == "Campo" and me["pix"] is None and me["avatar_url"] is None
    # Endereço e PIX não vão para o /auth/me.
    auth_me = (await client.get(f"{API}/auth/me", headers=world.tech.headers)).json()
    assert "pix" not in auth_me and "address_line" not in auth_me


async def test_basic_fields_without_password(client: AsyncClient, world: World) -> None:
    r = await patch(
        client,
        world,
        name="  Tecnico   Alfa ",
        phone="11988887777",
        home_city="guaruja",
        home_state="sp",
        address_zip="11410000",
        coverage_area=" Baixada Santista ",
        address_line="Rua Exemplo, 100",
    )
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["name"] == "Tecnico Alfa"
    assert me["phone"] == "(11) 98888-7777"
    assert (me["home_city"], me["home_state"]) == ("Guaruja", "SP")
    assert me["address_zip"] == "11410-000"
    assert me["coverage_area"] == "Baixada Santista"

    rows = await history(client, world)
    assert len(rows) == 1
    row = rows[0]
    assert row["via"] == "app" and row["actor"] == {
        "id": str(world.tech.user.id),
        "name": "Tecnico Alfa",
    }
    changes = {c["field"]: (c["from"], c["to"]) for c in row["changes"]}
    assert changes["name"] == ("Tecnico", "Tecnico Alfa")
    assert changes["phone"] == (None, "(11) 98888-7777")
    assert changes["address_zip"] == (None, "11410-000")

    # O mesmo de novo (o celular escrito de outro jeito): nada muda, sem histórico.
    again = await patch(client, world, name="Tecnico Alfa", phone="+55 (11) 98888-7777")
    assert again.status_code == 200 and again.json() == me
    assert len(await history(client, world)) == 1

    # O que é da central não passa por aqui; obrigatórios não ficam vazios.
    bad = await patch(client, world, team_id=world.team_net_id)
    assert bad.status_code == 422 and bad.json()["detail"][0]["type"] == "extra_forbidden"
    bad = await patch(client, world, phone=None)
    assert bad.status_code == 422 and messages(bad) == ["Informe o celular com DDD"]
    bad = await patch(client, world, home_state="XX")
    assert bad.status_code == 422 and messages(bad) == ["UF inválida"]
    assert bad.json()["detail"][0]["label"] == "UF"
    bad = await patch(client, world, name=None)
    assert bad.status_code == 422 and messages(bad) == ["Informe seu nome completo"]
    bad = await patch(client, world, address_zip="1234")
    assert bad.status_code == 422 and messages(bad) == ["CEP com 8 dígitos"]


async def test_moving_city_clears_home_coordinates(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        user.home_city, user.home_state = "Santos", "SP"
        user.home_latitude, user.home_longitude = -23.96, -46.33
        await db.commit()

    r = await patch(client, world, address_line="Rua Exemplo, 200")
    assert r.status_code == 200, r.text
    user = await stored(engine, world.tech.user.id)
    assert (user.home_latitude, user.home_longitude) == (-23.96, -46.33)
    # A mesma cidade escrita de outro jeito não é mudança.
    r = await patch(client, world, home_city="SANTOS", home_state="sp")
    assert r.status_code == 200 and r.json()["home_city"] == "Santos"
    assert (await stored(engine, world.tech.user.id)).home_latitude == -23.96

    r = await patch(client, world, home_city="Guarujá")
    assert r.status_code == 200 and r.json()["home_city"] == "Guarujá"
    user = await stored(engine, world.tech.user.id)
    assert (user.home_latitude, user.home_longitude) == (None, None)

    # A central também: mudou a cidade em Técnicos, as coordenadas saem.
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        user.home_latitude, user.home_longitude = -23.99, -46.25
        await db.commit()
    r = await client.patch(
        f"{API}/technicians/{world.tech.user.id}",
        json={"home_city": "Santos"},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    assert (await stored(engine, world.tech.user.id)).home_latitude is None


async def test_email_change_needs_password(
    client: AsyncClient, world: World, mail_box: MailBox
) -> None:
    """O e-mail novo pede a senha e fica pendente até o link: o login continua o de antes."""
    new_email = "Tecnico.Alfa@Exemplo.com"
    r = await patch(client, world, email=new_email)
    assert r.status_code == 422 and messages(r) == [my_profile.PASSWORD_REQUIRED]
    r = await patch(client, world, email=new_email, current_password="errada")
    assert r.status_code == 422 and messages(r) == ["Senha atual incorreta"]
    r = await patch(client, world, email="analista@teste.com.br", current_password=PASSWORD)
    assert r.status_code == 422 and messages(r) == ["E-mail já cadastrado"]
    assert mail_box.soon == []

    r = await patch(client, world, email=new_email, current_password=PASSWORD)
    assert r.status_code == 200, r.text
    me = r.json()
    assert (me["email"], me["email_pending"]) == (
        "tecnico@teste.com.br",
        "tecnico.alfa@exemplo.com",
    )
    assert len(mail_box.soon) == 1

    def login(email: str) -> dict:
        return {"email": email, "password": PASSWORD, "channel": "mobile"}

    # Até o link, o login é o de antes; a sessão aberta continua valendo.
    assert (await client.post(f"{API}/auth/login", json=login(new_email))).status_code == 401
    old = await client.post(f"{API}/auth/login", json=login("tecnico@teste.com.br"))
    assert old.status_code == 200
    assert (await client.get(f"{API}/me/profile", headers=world.tech.headers)).status_code == 200

    rows = await history(client, world)
    assert rows[0]["changes"] == [
        {"field": "email_pending", "from": None, "to": "tecnico.alfa@exemplo.com"}
    ]


async def test_password_attempts_are_shared_with_change_password(
    client: AsyncClient, world: World
) -> None:
    for _ in range(login_guard.MAX_PASSWORD_CHANGE):
        r = await add_method(client, world.tech.headers, CPF_KEY, password="errada")
        assert r.status_code == 422 and messages(r) == ["Senha atual incorreta"]
    blocked = await add_method(client, world.tech.headers, CPF_KEY)
    assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) > 0
    assert "confirmar a senha" in blocked.json()["detail"]
    # O contador é o mesmo da troca de senha (5 erros, não 5 + 5).
    change = await client.post(
        f"{API}/auth/change-password",
        json={"current_password": PASSWORD, "new_password": "nova-senha-forte"},
        headers=world.tech.headers,
    )
    assert change.status_code == 429 and "trocar a senha" in change.json()["detail"]
    me = (await client.get(f"{API}/me/profile", headers=world.tech.headers)).json()
    assert (me["payout_methods"], me["pix"]) == ([], None)


async def test_payout_change_warns_the_central(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    published: list[dict] = []

    async def capture(event: dict) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", capture)
    r = await add_method(client, world.tech.headers, CPF_KEY)
    assert r.status_code == 200, r.text
    events = [e for e in published if e["type"] == "profile.changed"]
    assert len(events) == 1
    event = events[0]
    assert event["user_id"] == str(world.tech.user.id) and event["name"] == "Tecnico"
    assert event["actor_id"] == str(world.tech.user.id)
    assert event["data"] == {"fields": PAYOUT_FIELDS, "via": "app"}
    assert event["audience"] == {"managers_only": True}
    assert "12345678909" not in str(event)

    # Sem mudança, nenhum aviso (a mesma chave de novo é repetida).
    published.clear()
    again = await add_method(client, world.tech.headers, CPF_KEY)
    assert again.status_code == 409 and again.json()["code"] == "PAYOUT_METHOD_DUPLICATE"
    assert (await patch(client, world, name="Tecnico")).status_code == 200
    assert published == []

    # A central removendo também avisa (via central, sem virar alerta na web).
    method_id = r.json()["payout_methods"][0]["id"]
    r = await client.delete(
        f"{API}/technicians/{world.tech.user.id}/payout-methods/{method_id}",
        headers=world.analyst.headers,
    )
    assert r.status_code == 204
    assert [(e["data"], e["actor_id"]) for e in published] == [
        ({"fields": PAYOUT_FIELDS, "via": "central"}, str(world.analyst.user.id))
    ]


async def test_payout_methods_visibility(client: AsyncClient, world: World) -> None:
    an, tech_id = world.analyst.headers, str(world.tech.user.id)
    r = await add_method(client, world.tech.headers, CPF_KEY)
    assert r.status_code == 200, r.text

    listed = await client.get(f"{API}/technicians", headers=an)
    row = next(t for t in listed.json() if t["id"] == tech_id)
    assert row["payout_methods_count"] == 1 and row["payout_changed_at"] is not None
    other = next(t for t in listed.json() if t["id"] == str(world.tech_other.user.id))
    assert other["payout_methods_count"] == 0 and other["payout_changed_at"] is None
    assert "12345678909" not in listed.text and "has_pix" not in row

    plain = await client.get(f"{API}/payouts", params={"technician_id": tech_id}, headers=an)
    assert plain.status_code == 200 and plain.json()["payout_methods"] == {}
    assert "pix" not in plain.json()
    board = await client.get(
        f"{API}/payouts",
        params={"technician_id": tech_id, "with_payout_methods": "true"},
        headers=an,
    )
    assert board.status_code == 200, board.text
    summary = board.json()["payout_methods"][tech_id]
    preferred = summary["preferred"]
    assert (preferred["pix_key_type"], preferred["pix_key"], preferred["holder_name"]) == (
        "cpf",
        "12345678909",
        "Tecnico Alfa",
    )
    assert summary["total"] == 1

    # Meus ganhos do técnico não trazem a forma de recebimento.
    mine = await client.get(f"{API}/me/earnings", headers=world.tech.headers)
    assert mine.status_code == 200
    assert "pix" not in mine.json() and "payout_methods" not in mine.json()


async def test_paid_payout_records_the_payout_method(client: AsyncClient, world: World) -> None:
    an, tech_id = world.analyst.headers, str(world.tech.user.id)
    assert (await add_method(client, world.tech.headers, CPF_KEY)).status_code == 200
    t = await create(client, world, title="Rack", assignee_id=tech_id)
    r = await client.put(
        f"{API}/tickets/{t['id']}/payouts/{tech_id}", json={"amount": 90}, headers=an
    )
    assert r.status_code == 200, r.text
    payout_id = r.json()[0]["id"]
    paid = await client.post(f"{API}/payouts/pay", json={"ids": [payout_id]}, headers=an)
    assert paid.json() == {"changed": 1}
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    payment = next(e for e in events if (e.get("data") or {}).get("action") == "paid")
    assert payment["data"]["payout_method"] == "PIX CPF ***.456.789-**"
    assert "pix" not in payment["data"]
    # Desfazer não leva a forma.
    await client.post(f"{API}/payouts/unpay", json={"ids": [payout_id]}, headers=an)
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    undone = next(e for e in events if (e.get("data") or {}).get("action") == "unpaid")
    assert "payout_method" not in undone["data"]


async def test_my_photo_upload_and_remove(
    client: AsyncClient,
    world: World,
    engine: AsyncEngine,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    # Entrou pela homologação: a foto da ficha aprovada virou a dele.
    ficha_key = "onboarding/ficha.png"
    (tmp_path / "onboarding").mkdir()
    (tmp_path / ficha_key).write_bytes(PNG_1PX)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        db.add(
            TechnicianApplication(
                status=ApplicationStatus.APPROVED,
                full_name="Tecnico Alfa",
                email="tecnico@teste.com.br",
                phone="(11) 98888-7777",
                document="12345678909",
                city="Santos",
                state="SP",
                coverage_area="Baixada Santista",
                photo_key=ficha_key,
                privacy_consent_at=datetime.now(UTC),
                privacy_version="2026-11",
                user_id=world.tech.user.id,
            )
        )
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        user.avatar_key = ficha_key
        await db.commit()

    url, th = f"{API}/me/profile/photo", world.tech.headers
    first = await client.post(url, files={"file": ("foto.png", PNG_1PX, "image/png")}, headers=th)
    assert first.status_code == 200, first.text
    assert (await client.get(first.json()["avatar_url"])).content == PNG_1PX
    # A ficha ainda usa a foto antiga: ela fica no disco.
    assert (tmp_path / ficha_key).exists()
    first_key = (await stored(engine, world.tech.user.id)).avatar_key
    assert first_key and first_key.startswith("avatars/") and (tmp_path / first_key).exists()

    second = await client.post(url, files={"file": ("foto.png", PNG_1PX, "image/png")}, headers=th)
    assert second.status_code == 200
    # A primeira foto enviada ninguém mais usa: saiu do disco.
    assert not (tmp_path / first_key).exists()
    second_key = (await stored(engine, world.tech.user.id)).avatar_key
    assert second_key and (tmp_path / second_key).exists()

    fake = await client.post(url, files={"file": ("nota.txt", b"texto", "text/plain")}, headers=th)
    assert fake.status_code == 422

    # Remover tira também a foto que veio do Field Control.
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        user.avatar_external_url = "https://fotos.exemplo.com/tecnico.png"
        await db.commit()
    gone = await client.delete(url, headers=th)
    assert gone.status_code == 200 and gone.json()["avatar_url"] is None
    user = await stored(engine, world.tech.user.id)
    assert (user.avatar_key, user.avatar_external_url) == (None, None)
    assert not (tmp_path / second_key).exists()

    rows = await history(client, world)
    assert [c for r in rows for c in r["changes"]] == [
        {"field": "avatar", "from": "anterior", "to": None},
        {"field": "avatar", "from": None, "to": "nova"},
        {"field": "avatar", "from": None, "to": "nova"},
    ]
    # Sem foto: nada muda, sem histórico.
    assert (await client.delete(url, headers=th)).status_code == 200
    assert len(await history(client, world)) == 3


async def test_central_changes_go_to_history(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    published: list[dict] = []

    async def capture(event: dict) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", capture)
    an, url = world.analyst.headers, f"{API}/technicians/{world.tech.user.id}"

    r = await client.post(f"{url}/reset-password", headers=an)
    assert r.status_code == 200, r.text
    r = await client.patch(
        f"{API}/users/{world.tech.user.id}",
        json={"phone": "(11) 97777-6666", "password": "nova-senha-123"},
        headers=world.admin.headers,
    )
    assert r.status_code == 200, r.text
    r = await client.patch(
        url,
        json={
            "email": "tecnico.alfa@exemplo.com",
            "team_id": world.team_net_id,
            "is_active": False,
        },
        headers=an,
    )
    assert r.status_code == 200, r.text

    rows = await history(client, world)
    assert [(row["via"], row["actor"]["name"]) for row in rows] == [
        ("central", "Analista"),
        ("central", "Admin"),
        ("central", "Analista"),
    ]
    assert rows[0]["changes"] == [
        {"field": "email", "from": "tecnico@teste.com.br", "to": "tecnico.alfa@exemplo.com"},
        {"field": "team", "from": "Campo", "to": "Redes"},
        {"field": "is_active", "from": "Liberado", "to": "Sem acesso"},
    ]
    assert rows[1]["changes"] == [
        {"field": "phone", "from": None, "to": "(11) 97777-6666"},
        {"field": "password", "from": None, "to": "definida pela central"},
    ]
    assert rows[2]["changes"] == [{"field": "password", "from": None, "to": "provisória"}]

    changed = [e for e in published if e["type"] == "profile.changed"]
    assert [e["data"] for e in changed] == [
        {"fields": ["password"], "via": "central"},
        {"fields": ["phone", "password"], "via": "central"},
        {"fields": ["email", "team", "is_active"], "via": "central"},
    ]

    # Cadastro de quem não é técnico não entra no histórico.
    r = await client.patch(
        f"{API}/users/{world.analyst.user.id}",
        json={"phone": "(11) 96666-5555"},
        headers=world.admin.headers,
    )
    assert r.status_code == 200, r.text
    assert len([e for e in published if e["type"] == "profile.changed"]) == 3


async def test_technician_by_id(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    r = await client.get(f"{API}/technicians/{world.tech.user.id}", headers=an)
    assert r.status_code == 200 and r.json()["name"] == "Tecnico"
    r = await client.get(f"{API}/technicians/{world.analyst.user.id}", headers=an)
    assert r.status_code == 404 and r.json()["detail"] == "Técnico não encontrado"
    assert (await client.get(f"{API}/technicians/{uuid.uuid4()}", headers=an)).status_code == 404
    # As rotas fixas continuam respondendo (o id é declarado depois delas).
    assert (await client.get(f"{API}/technicians/regions", headers=an)).status_code == 200
    r = await client.get(f"{API}/technicians/{world.tech.user.id}", headers=world.tech.headers)
    assert r.status_code == 403
    changes = f"{API}/technicians/{world.tech.user.id}/changes"
    assert (await client.get(changes, params={"limit": 0}, headers=an)).status_code == 422
    assert (await client.get(changes, params={"limit": 201}, headers=an)).status_code == 422
    assert (await client.get(changes, headers=an)).json() == []


# ---------------------------------------------------------- revisão de segurança (2026-11-19)


async def test_taken_email_is_told_only_after_the_password(
    client: AsyncClient, world: World, mail_box: MailBox
) -> None:
    """Sem a senha, ou com a errada, ninguém descobre se um e-mail já está cadastrado; com a certa,
    só algumas trocas por hora."""
    taken = "analista@teste.com.br"
    r = await patch(client, world, email=taken)
    assert r.status_code == 422 and messages(r) == [my_profile.PASSWORD_REQUIRED]
    r = await patch(client, world, email=taken, current_password="errada")
    assert r.status_code == 422 and messages(r) == [my_profile.WRONG_PASSWORD]

    for _ in range(my_profile.MAX_EMAIL_CHECKS_PER_HOUR):
        r = await patch(client, world, email=taken, current_password=PASSWORD)
        assert r.status_code == 422 and messages(r) == [my_profile.EMAIL_TAKEN]
    r = await patch(client, world, email="tecnico.alfa@exemplo.com", current_password=PASSWORD)
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    me = (await client.get(f"{API}/me/profile", headers=world.tech.headers)).json()
    assert me["email"] == "tecnico@teste.com.br"


async def test_temporary_password_cannot_change_email_company_or_payouts(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch, mail_box: MailBox
) -> None:
    """A provisória quem gerou foi a central: com ela, e-mail, empresa e formas de recebimento
    ficam fechados até o técnico criar a senha dele (o app já pede isso antes de abrir o Meu
    cadastro)."""
    events = capture_events(monkeypatch)
    url = f"{API}/me/profile"
    temp = await reset_by_central(client, world)
    h = await login_mobile(client, "tecnico@teste.com.br", temp)
    r = await add_method(client, h, CPF_KEY, password=temp)
    assert r.status_code == 422 and messages(r) == [my_profile.TEMPORARY_PASSWORD]
    body = {"email": "outro.login@exemplo.com", "current_password": temp}
    r = await client.patch(url, json=body, headers=h)
    assert r.status_code == 422 and messages(r) == [my_profile.TEMPORARY_PASSWORD]
    body = {"company_document": "12.345.678/0001-95", "current_password": temp}
    r = await client.patch(url, json=body, headers=h)
    assert r.status_code == 422 and messages(r) == [my_profile.TEMPORARY_PASSWORD]
    # O resto do cadastro continua aberto.
    r = await client.patch(url, json={"phone": "(11) 98888-7777"}, headers=h)
    assert r.status_code == 200 and r.json()["payout_methods"] == []
    assert (r.json()["email"], r.json()["email_pending"]) == ("tecnico@teste.com.br", None)
    assert r.json()["company_document"] is None

    # A senha definida pela central em Usuários também é provisória.
    r = await client.patch(
        f"{API}/users/{world.tech.user.id}",
        json={"password": "provisoria-456"},
        headers=world.admin.headers,
    )
    assert r.status_code == 200 and r.json()["must_change_password"] is True
    h = await login_mobile(client, "tecnico@teste.com.br", "provisoria-456")
    r = await add_method(client, h, CPF_KEY, password="provisoria-456")
    assert r.status_code == 422 and messages(r) == [my_profile.TEMPORARY_PASSWORD]

    # Com a senha dele, passa; o aviso diz quem redefiniu por último.
    h = await change_password(client, h, "provisoria-456", "senha-do-tecnico-1")
    r = await add_method(client, h, CPF_KEY, password="senha-do-tecnico-1")
    assert r.status_code == 200, r.text
    assert events[-1]["fields"] == PAYOUT_FIELDS and events[-1]["after_reset"]["by"] == "Admin"


async def test_password_lines_and_the_reset_warning(
    client: AsyncClient,
    world: World,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    mail_box: MailBox,
) -> None:
    """A senha criada ou trocada no app entra no histórico, e a troca de e-mail ou de forma de
    recebimento até 72 h depois de a central redefinir a senha avisa quem redefiniu (sem
    bloquear: o técnico novo recebe a senha da central e cadastra onde recebe)."""
    events = capture_events(monkeypatch)
    temp = await reset_by_central(client, world)
    h = await login_mobile(client, "tecnico@teste.com.br", temp)
    h = await change_password(client, h, temp, "senha-do-tecnico-1")
    rows = await history(client, world)
    assert [(row["via"], row["actor"]["name"], row["changes"]) for row in rows] == [
        ("app", "Tecnico", [{"field": "password", "from": None, "to": "criada no app"}]),
        ("central", "Analista", [{"field": "password", "from": None, "to": "provisória"}]),
    ]
    assert events == [
        {"fields": ["password"], "via": "central"},
        {"fields": ["password"], "via": "app"},
    ]
    reset_at = datetime.fromisoformat(rows[1]["created_at"])

    events.clear()
    r = await add_method(client, h, CPF_KEY, password="senha-do-tecnico-1")
    assert r.status_code == 200, r.text
    r = await client.patch(f"{API}/me/profile", json={"name": "Tecnico Alfa"}, headers=h)
    assert r.status_code == 200, r.text
    payout_event, name_event = events
    warning = payout_event.pop("after_reset")
    assert payout_event == {"fields": PAYOUT_FIELDS, "via": "app"}
    assert warning["by"] == "Analista" and datetime.fromisoformat(warning["at"]) == reset_at
    # Só e-mail, formas de recebimento e CNPJ levam o sinal.
    assert name_event == {"fields": ["name"], "via": "app"}

    # A senha dele trocada de novo.
    h = await change_password(client, h, "senha-do-tecnico-1", "senha-do-tecnico-2")
    assert (await history(client, world))[0]["changes"] == [
        {"field": "password", "from": None, "to": "trocada no app"}
    ]
    assert events[-1] == {"fields": ["password"], "via": "app"}

    # Passadas as 72 h da redefinição, a troca sai sem o sinal.
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE user_changes SET created_at = created_at - interval '73 hours' "
                "WHERE via = 'central'"
            )
        )
    events.clear()
    r = await client.patch(
        f"{API}/me/profile",
        json={"email": "tecnico.alfa@exemplo.com", "current_password": "senha-do-tecnico-2"},
        headers=h,
    )
    assert r.status_code == 200, r.text
    assert events == [{"fields": ["email_pending"], "via": "app"}]

    # Quem não é técnico troca a senha sem histórico de cadastro.
    events.clear()
    await change_password(client, world.analyst.headers, PASSWORD, "senha-do-analista-1")
    assert events == []
    async with engine.connect() as conn:
        count = await conn.scalar(
            text("SELECT count(*) FROM user_changes WHERE user_id = :u"),
            {"u": world.analyst.user.id},
        )
    assert count == 0


async def test_parallel_wrong_passwords_respect_the_limit(
    client: AsyncClient, world: World
) -> None:
    """A tentativa conta antes do bcrypt: uma rajada em paralelo não passa inteira pela checagem."""

    async def wrong_pix(i: int) -> Response:
        return await add_method(client, world.tech.headers, CPF_KEY, password=f"errada-{i}")

    async def wrong_change(i: int) -> Response:
        return await client.post(
            f"{API}/auth/change-password",
            json={"current_password": f"errada-{i}", "new_password": "nova-senha-forte"},
            headers=world.tech.headers,
        )

    burst = await asyncio.gather(*(wrong_pix(i) for i in range(15)))
    codes = [r.status_code for r in burst]
    assert codes.count(422) <= login_guard.MAX_PASSWORD_CHANGE
    assert codes.count(429) == len(codes) - codes.count(422)
    assert all(int(r.headers["retry-after"]) > 0 for r in burst if r.status_code == 429)
    # Bloqueado até a janela acabar, mesmo com a senha certa.
    r = await add_method(client, world.tech.headers, CPF_KEY)
    assert r.status_code == 429

    # O contador é o mesmo da troca de senha, também em paralelo.
    login_guard.reset_memory()
    burst = await asyncio.gather(
        *(wrong_pix(i) for i in range(8)), *(wrong_change(i) for i in range(8))
    )
    codes = [r.status_code for r in burst]
    assert codes.count(422) <= login_guard.MAX_PASSWORD_CHANGE
    assert codes.count(429) == len(codes) - codes.count(422)
    me = (await client.get(f"{API}/me/profile", headers=world.tech.headers)).json()
    assert me["payout_methods"] == []


async def test_name_takes_only_letters(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O nome vai para os textos do grupo do cliente, o relatório e o portal: sem contato nem
    link."""
    for bad in (
        "Tecnico Alfa chame wa.me/5500000000000",
        "Tecnico Alfa 2",
        "tecnico@exemplo",
        "Tecnico: Alfa",
        "Tecnico www Alfa",
        "Tecnico HTTP Alfa",
        "Tecnico Alfa exemplo.com",
        "Tecnico ｗｗｗ Alfa",  # "www" em letras largas
    ):
        r = await patch(client, world, name=bad)
        assert r.status_code == 422 and messages(r) == [NAME_LETTERS], bad
    r = await patch(client, world, name="Técnico Ômega D’Alfa-Beta Jr.")
    assert r.status_code == 200 and r.json()["name"] == "Técnico Ômega D’Alfa-Beta Jr."
    r = await patch(client, world, name="J.R. d'Alfa")
    assert r.status_code == 200, r.text
    # Acento digitado separado da letra: grava a letra acentuada.
    r = await patch(client, world, name="Técnico Alfa")
    assert r.status_code == 200 and r.json()["name"] == "Técnico Alfa"

    # O nome antigo fora da regra fica: só o que muda é conferido.
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        user.name = "Tecnico 01"
        await db.commit()
    r = await patch(client, world, phone="(11) 98888-7777")
    assert r.status_code == 200 and r.json()["name"] == "Tecnico 01"


async def test_history_without_payouts_hides_the_payout_methods(
    client: AsyncClient, world: World
) -> None:
    """Quem tem Técnicos sem Pagamentos não vê o titular nem a forma mascarada no histórico (as
    Formas de recebimento da ficha também ficam fechadas para ele)."""
    holder = {**CPF_KEY, "holder_name": "Conjuge Ficticia"}
    r = await add_method(client, world.tech.headers, holder)
    assert r.status_code == 200, r.text
    method_id = r.json()["payout_methods"][0]["id"]
    other = {**holder, "holder_name": "Outra Pessoa Ficticia", "current_password": PASSWORD}
    r = await client.put(f"{METHODS}/{method_id}", json=other, headers=world.tech.headers)
    assert r.status_code == 200, r.text
    r = await client.post(
        f"{METHODS}/{method_id}/remove",
        json={"current_password": PASSWORD},
        headers=world.tech.headers,
    )
    assert r.status_code == 200 and r.json()["payout_methods"] == []
    assert (await patch(client, world, name="Tecnico Alfa")).status_code == 200

    full = await history(client, world)
    assert full[2]["changes"] == [
        {
            "field": "payout_methods",
            "from": "PIX CPF ***.456.789-** · Conjuge Ficticia",
            "to": "PIX CPF ***.456.789-** · Outra Pessoa Ficticia",
        }
    ]
    await restrict_analyst(
        client, world, **{"base.technicians": "view", "commercial.payouts": "none"}
    )
    hidden = await history(client, world)
    assert [row["id"] for row in hidden] == [row["id"] for row in full]
    assert [row["changes"] for row in hidden] == [
        [{"field": "name", "from": "Tecnico", "to": "Tecnico Alfa"}],
        [
            {"field": "payout_methods", "from": "***", "to": None},
            {"field": "payout_preferred", "from": "***", "to": None},
        ],
        [{"field": "payout_methods", "from": "***", "to": "***"}],
        [
            {"field": "payout_methods", "from": None, "to": "***"},
            {"field": "payout_preferred", "from": None, "to": "***"},
        ],
    ]
    assert "Ficticia" not in str(hidden) and "456.789" not in str(hidden)
    # Quem tem Pagamentos continua vendo tudo: as linhas gravadas não mudaram.
    sup = await client.get(
        f"{API}/technicians/{world.tech.user.id}/changes", headers=world.supervisor.headers
    )
    assert sup.status_code == 200 and sup.json() == full


async def test_company_email_stays_with_the_central(
    client: AsyncClient,
    world: World,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    mail_box: MailBox,
) -> None:
    """E-mail do domínio da empresa (login Microsoft) não entra pelo app: travaria o login da pessoa
    contratada com ele. Quem já tem um (técnico interno) continua com ele."""
    monkeypatch.setattr(settings, "ENTRA_ALLOWED_DOMAINS", "empresa.exemplo.com")
    for email in ("novo.analista@empresa.exemplo.com", "Novo.Analista@Empresa.Exemplo.com"):
        r = await patch(client, world, email=email, current_password=PASSWORD)
        assert r.status_code == 422 and messages(r) == [onboarding.COMPANY_EMAIL]
    # Regra fixa: a resposta é a mesma sem a senha (não revela nada).
    r = await patch(client, world, email="novo.analista@empresa.exemplo.com")
    assert r.status_code == 422 and messages(r) == [onboarding.COMPANY_EMAIL]
    r = await patch(client, world, email="tecnico.alfa@exemplo.com", current_password=PASSWORD)
    assert r.status_code == 200 and r.json()["email_pending"] == "tecnico.alfa@exemplo.com"

    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        user.email = "tecnico.interno@empresa.exemplo.com"
        await db.commit()
    # O e-mail do login de novo (com o pedido aberto, cancela o pedido; sem senha).
    r = await patch(
        client, world, email="tecnico.interno@empresa.exemplo.com", phone="(11) 97777-6666"
    )
    assert r.status_code == 200, r.text
    assert (r.json()["email"], r.json()["email_pending"]) == (
        "tecnico.interno@empresa.exemplo.com",
        None,
    )
