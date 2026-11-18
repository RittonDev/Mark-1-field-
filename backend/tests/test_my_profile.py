"""Meu cadastro do técnico: o próprio cadastro no app, a chave PIX com a senha, o histórico do
cadastro e o aviso à central.

Só dados fictícios: CPF 12345678909, "Tecnico Alfa", @exemplo.com.
"""

import base64
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import ApplicationStatus
from app.models import TechnicianApplication, User
from app.services import login_guard, my_profile, realtime
from tests.conftest import World, requires_db
from tests.test_access import restrict_analyst
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX
PASSWORD = "senha-teste-123"
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)
CPF_PIX = {"key_type": "cpf", "key": "123.456.789-09", "holder_name": "Tecnico Alfa"}
PHONE_PIX = {"key_type": "phone", "key": "(11) 98888-7777", "holder_name": "Tecnico Alfa"}


async def patch(client: AsyncClient, world: World, **body: object) -> Response:
    return await client.patch(f"{API}/me/profile", json=body, headers=world.tech.headers)


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


async def test_email_change_needs_password(client: AsyncClient, world: World) -> None:
    new_email = "Tecnico.Alfa@Exemplo.com"
    r = await patch(client, world, email=new_email)
    assert r.status_code == 422 and messages(r) == [my_profile.PASSWORD_REQUIRED]
    r = await patch(client, world, email=new_email, current_password="errada")
    assert r.status_code == 422 and messages(r) == ["Senha atual incorreta"]
    r = await patch(client, world, email="analista@teste.com.br", current_password=PASSWORD)
    assert r.status_code == 422 and messages(r) == ["E-mail já cadastrado"]

    r = await patch(client, world, email=new_email, current_password=PASSWORD)
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "tecnico.alfa@exemplo.com"

    def login(email: str) -> dict:
        return {"email": email, "password": PASSWORD, "channel": "mobile"}

    assert (await client.post(f"{API}/auth/login", json=login(new_email))).status_code == 200
    old = await client.post(f"{API}/auth/login", json=login("tecnico@teste.com.br"))
    assert old.status_code == 401
    # A senha é a mesma: a sessão aberta continua valendo.
    assert (await client.get(f"{API}/me/profile", headers=world.tech.headers)).status_code == 200

    rows = await history(client, world)
    assert [c for c in rows[0]["changes"] if c["field"] == "email"] == [
        {"field": "email", "from": "tecnico@teste.com.br", "to": "tecnico.alfa@exemplo.com"}
    ]


async def test_password_attempts_are_shared_with_change_password(
    client: AsyncClient, world: World
) -> None:
    for _ in range(login_guard.MAX_PASSWORD_CHANGE):
        r = await patch(client, world, pix=CPF_PIX, current_password="errada")
        assert r.status_code == 422 and messages(r) == ["Senha atual incorreta"]
    blocked = await patch(client, world, pix=CPF_PIX, current_password=PASSWORD)
    assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) > 0
    assert "confirmar a senha" in blocked.json()["detail"]
    # O contador é o mesmo da troca de senha (5 erros, não 5 + 5).
    change = await client.post(
        f"{API}/auth/change-password",
        json={"current_password": PASSWORD, "new_password": "nova-senha-forte"},
        headers=world.tech.headers,
    )
    assert change.status_code == 429 and "trocar a senha" in change.json()["detail"]
    assert (await client.get(f"{API}/me/profile", headers=world.tech.headers)).json()["pix"] is None


async def test_pix_set_change_and_remove(client: AsyncClient, world: World) -> None:
    r = await patch(client, world, pix=CPF_PIX)
    assert r.status_code == 422 and messages(r) == [my_profile.PASSWORD_REQUIRED]

    r = await patch(client, world, pix=CPF_PIX, current_password=PASSWORD)
    assert r.status_code == 200, r.text
    pix = r.json()["pix"]
    assert (pix["key_type"], pix["key"], pix["holder_name"]) == (
        "cpf",
        "12345678909",
        "Tecnico Alfa",
    )
    assert pix["updated_at"] is not None

    # A mesma chave de novo: nada muda (nem a data).
    r = await patch(client, world, pix=CPF_PIX, current_password=PASSWORD)
    assert r.status_code == 200 and r.json()["pix"] == pix
    assert len(await history(client, world)) == 1

    r = await patch(client, world, pix=PHONE_PIX, current_password=PASSWORD)
    assert r.status_code == 200, r.text
    assert r.json()["pix"]["key"] == "+5511988887777"
    rows = await history(client, world)
    assert rows[0]["changes"] == [
        {"field": "pix", "from": "CPF ***.456.789-**", "to": "Celular +55 (11) *****-7777"}
    ]
    assert rows[1]["changes"][0] == {"field": "pix", "from": None, "to": "CPF ***.456.789-**"}
    text = str(rows)
    assert "12345678909" not in text and "456.789-09" not in text and "98888" not in text

    # Trocar só o titular também pede a senha e fica no histórico.
    other_holder = {**PHONE_PIX, "holder_name": "Tecnico Alfa da Silva"}
    assert (await patch(client, world, pix=other_holder)).status_code == 422
    r = await patch(client, world, pix=other_holder, current_password=PASSWORD)
    assert r.status_code == 200 and r.json()["pix"]["holder_name"] == "Tecnico Alfa da Silva"
    assert (await history(client, world))[0]["changes"] == [
        {"field": "pix_holder", "from": "Tecnico Alfa", "to": "Tecnico Alfa da Silva"}
    ]

    bad = await patch(
        client, world, pix={**CPF_PIX, "key": "111.111.111-11"}, current_password=PASSWORD
    )
    assert bad.status_code == 422 and messages(bad) == ["CPF inválido: confira os números"]
    assert bad.json()["detail"][0]["label"] == "Chave PIX"
    bad = await patch(
        client, world, pix={**CPF_PIX, "holder_name": " "}, current_password=PASSWORD
    )
    assert messages(bad) == ["Informe o nome do titular da conta"]

    # null tira a chave (também com a senha).
    assert (await patch(client, world, pix=None)).status_code == 422
    r = await patch(client, world, pix=None, current_password=PASSWORD)
    assert r.status_code == 200 and r.json()["pix"] is None
    removed = (await history(client, world))[0]["changes"]
    assert {"field": "pix", "from": "Celular +55 (11) *****-7777", "to": None} in removed


async def test_pix_change_warns_the_central(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    published: list[dict] = []

    async def capture(event: dict) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", capture)
    r = await patch(client, world, pix=CPF_PIX, current_password=PASSWORD)
    assert r.status_code == 200, r.text
    events = [e for e in published if e["type"] == "profile.changed"]
    assert len(events) == 1
    event = events[0]
    assert event["user_id"] == str(world.tech.user.id) and event["name"] == "Tecnico"
    assert event["actor_id"] == str(world.tech.user.id)
    assert event["data"] == {"fields": ["pix"], "via": "app"}
    assert event["audience"] == {"managers_only": True}
    assert "12345678909" not in str(event)

    # Sem mudança, nenhum aviso.
    published.clear()
    assert (await patch(client, world, pix=CPF_PIX, current_password=PASSWORD)).status_code == 200
    assert (await patch(client, world, name="Tecnico")).status_code == 200
    assert published == []

    # A central removendo também avisa (via central, sem virar alerta na web).
    r = await client.delete(
        f"{API}/technicians/{world.tech.user.id}/pix", headers=world.analyst.headers
    )
    assert r.status_code == 204
    assert [(e["data"], e["actor_id"]) for e in published] == [
        ({"fields": ["pix"], "via": "central"}, str(world.analyst.user.id))
    ]


async def test_pix_visibility(client: AsyncClient, world: World) -> None:
    an, tech_id = world.analyst.headers, str(world.tech.user.id)
    r = await patch(client, world, pix=CPF_PIX, current_password=PASSWORD)
    assert r.status_code == 200, r.text

    listed = await client.get(f"{API}/technicians", headers=an)
    row = next(t for t in listed.json() if t["id"] == tech_id)
    assert row["has_pix"] is True and row["pix_updated_at"] is not None
    other = next(t for t in listed.json() if t["id"] == str(world.tech_other.user.id))
    assert other["has_pix"] is False and other["pix_updated_at"] is None
    assert "12345678909" not in listed.text
    one = await client.get(f"{API}/technicians/{tech_id}", headers=an)
    assert one.json()["has_pix"] is True and "12345678909" not in one.text

    plain = await client.get(f"{API}/payouts", params={"technician_id": tech_id}, headers=an)
    assert plain.status_code == 200 and plain.json()["pix"] == {}
    board = await client.get(
        f"{API}/payouts", params={"technician_id": tech_id, "with_pix": "true"}, headers=an
    )
    assert board.status_code == 200, board.text
    info = board.json()["pix"][tech_id]
    assert (info["key_type"], info["key"], info["holder_name"]) == (
        "cpf",
        "12345678909",
        "Tecnico Alfa",
    )

    # Meus ganhos do técnico não trazem a chave.
    mine = await client.get(f"{API}/me/earnings", headers=world.tech.headers)
    assert mine.status_code == 200 and "pix" not in mine.json()


async def test_central_removes_but_cannot_set_pix(client: AsyncClient, world: World) -> None:
    an, url = world.analyst.headers, f"{API}/technicians/{world.tech.user.id}"
    assert (await patch(client, world, pix=CPF_PIX, current_password=PASSWORD)).status_code == 200

    # A ficha em Técnicos não grava chave (o campo nem existe ali).
    r = await client.patch(url, json={"pix_key": "99999999999", "pix_key_type": "cpf"}, headers=an)
    assert r.status_code == 200, r.text
    me = (await client.get(f"{API}/me/profile", headers=world.tech.headers)).json()
    assert me["pix"]["key"] == "12345678909"

    # Técnico e quem só vê Pagamentos não removem.
    assert (await client.delete(f"{url}/pix", headers=world.tech.headers)).status_code == 403
    await restrict_analyst(client, world, **{"commercial.payouts": "view"})
    denied = await client.delete(f"{url}/pix", headers=an)
    assert denied.status_code == 403 and denied.json()["code"] == "MODULE_FORBIDDEN"

    sup = world.supervisor.headers
    assert (await client.delete(f"{url}/pix", headers=sup)).status_code == 204
    me = (await client.get(f"{API}/me/profile", headers=world.tech.headers)).json()
    assert me["pix"] is None
    rows = await client.get(f"{url}/changes", headers=sup)
    latest = rows.json()[0]
    assert latest["via"] == "central" and latest["actor"]["name"] == "Super"
    assert {"field": "pix", "from": "CPF ***.456.789-**", "to": None} in latest["changes"]
    # Sem chave: 204 sem histórico.
    assert (await client.delete(f"{url}/pix", headers=sup)).status_code == 204
    assert len((await client.get(f"{url}/changes", headers=sup)).json()) == len(rows.json())


async def test_paid_payout_records_the_pix_used(client: AsyncClient, world: World) -> None:
    an, tech_id = world.analyst.headers, str(world.tech.user.id)
    assert (await patch(client, world, pix=CPF_PIX, current_password=PASSWORD)).status_code == 200
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
    assert payment["data"]["pix"] == "CPF ***.456.789-**"
    # Desfazer não leva chave.
    await client.post(f"{API}/payouts/unpay", json={"ids": [payout_id]}, headers=an)
    events = (await client.get(f"{API}/tickets/{t['id']}/events", headers=an)).json()
    undone = next(e for e in events if (e.get("data") or {}).get("action") == "unpaid")
    assert "pix" not in undone["data"]


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
        json={"email": "tecnico.alfa@exemplo.com", "team_id": world.team_net_id, "is_active": False},
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
        {"field": "is_active", "from": "Liberado", "to": "Bloqueado"},
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
