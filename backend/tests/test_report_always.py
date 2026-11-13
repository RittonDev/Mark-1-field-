"""Toda OS tem relatório para o cliente (como no Field Control), desde a abertura."""

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


async def test_every_os_has_a_report_from_the_start(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Rack novo", assignee_id=str(world.tech.user.id))
    link = t["report_link"]
    assert link and "/relatorio/" in link["url"]

    # Antes de concluir, a página mostra o estado atual: situação, técnico, sem conclusão.
    page = await client.get(f"{API}/public/reports/{link['token']}")
    assert page.status_code == 200, page.text
    body = page.json()
    assert body["status"] == "assigned" and body["finished_at"] is None
    assert body["technician"]["name"] == world.tech.user.name

    # O técnico só manda o relatório depois de concluir (pelo app).
    assert (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()["report_link"] is None
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Rack organizado")
    assert t["report_link"]["token"] == link["token"]  # o mesmo link, agora com o resultado
    done = (await client.get(f"{API}/public/reports/{link['token']}")).json()
    assert done["status"] == "resolved" and done["finished_at"] is not None
    office = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert office["report_link"]["token"] == link["token"]
