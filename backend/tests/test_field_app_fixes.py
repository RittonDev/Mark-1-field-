"""Correções do app do técnico que dependem do servidor: o técnico desativado recebe o motivo ao
renovar a sessão (é com essa mensagem que o app apaga do aparelho as OS e os dados de clientes) e
o link do relatório que a gestão desativou não volta quando o técnico abre a OS concluída."""

import uuid

from httpx import AsyncClient

from app.api.routes.auth import INACTIVE, SESSION_EXPIRED
from app.core.config import settings
from app.core.security import create_refresh_token
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX
PASSWORD = "senha-teste-123"


async def mobile_login(client: AsyncClient, email: str) -> dict:
    r = await client.post(
        f"{API}/auth/login", json={"email": email, "password": PASSWORD, "channel": "mobile"}
    )
    assert r.status_code == 200, r.text
    return r.json()


async def test_disabled_technician_gets_the_reason_when_renewing(
    client: AsyncClient, world: World
) -> None:
    tokens = await mobile_login(client, "tecnico@teste.com.br")
    r = await client.patch(
        f"{API}/technicians/{world.tech.user.id}",
        json={"is_active": False},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text

    # "Sessão expirada" faria o app guardar tudo para quando ele entrasse de novo (o que não vai
    # acontecer): o refresh diz o motivo, e o app apaga os dados locais (LGPD).
    renew = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert renew.status_code == 401
    assert renew.json()["detail"] == INACTIVE
    # O login com a senha certa segue dizendo o mesmo motivo (o app também apaga por ele).
    login = await client.post(
        f"{API}/auth/login",
        json={"email": "tecnico@teste.com.br", "password": PASSWORD, "channel": "mobile"},
    )
    assert login.status_code == 403 and login.json()["detail"] == INACTIVE

    # Conta que não existe mais: a mensagem genérica de sempre.
    ghost = create_refresh_token(str(uuid.uuid4()), "mobile")
    r = await client.post(f"{API}/auth/refresh", json={"refresh_token": ghost})
    assert r.status_code == 401 and r.json()["detail"] == SESSION_EXPIRED

    # Reativado, o mesmo refresh volta a renovar.
    r = await client.patch(
        f"{API}/technicians/{world.tech.user.id}",
        json={"is_active": True},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    again = await mobile_login(client, "tecnico@teste.com.br")
    r = await client.post(f"{API}/auth/refresh", json={"refresh_token": again["refresh_token"]})
    assert r.status_code == 200, r.text


async def test_app_does_not_bring_back_a_report_link_the_office_disabled(
    client: AsyncClient, world: World
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Troca de switch", assignee_id=str(world.tech.user.id))
    t = await transition(client, th, t, "en_route")
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Switch trocado")
    tid, token = t["id"], t["report_link"]["token"]
    # Com o link no ar, o cartão do app recebe o mesmo link.
    mine = await client.post(f"{API}/tickets/{tid}/report-link", headers=th)
    assert mine.status_code == 200 and mine.json()["token"] == token

    # A gestão desativa (ex.: foi para o cliente errado). O app abre a OS concluída sem link e pede
    # um: o servidor recusa com o motivo, sem criar outro.
    assert (await client.delete(f"{API}/tickets/{tid}/report-link", headers=an)).status_code == 204
    assert (await client.get(f"{API}/tickets/{tid}", headers=th)).json()["report_link"] is None
    blocked = await client.post(f"{API}/tickets/{tid}/report-link", headers=th)
    # O app trata 409 e 422 do mesmo jeito: mostra o motivo, sem "Tentar de novo".
    assert blocked.status_code in (409, 422), blocked.text
    assert "desativado" in blocked.json()["detail"]
    assert (await client.get(f"{API}/tickets/{tid}", headers=an)).json()["report_link"] is None

    # Só a gestão gera outro; aí o técnico recebe esse.
    fresh = await client.post(f"{API}/tickets/{tid}/report-link", headers=an)
    assert fresh.status_code == 200 and fresh.json()["token"] != token
    again = await client.post(f"{API}/tickets/{tid}/report-link", headers=th)
    assert again.status_code == 200 and again.json()["token"] == fresh.json()["token"]
