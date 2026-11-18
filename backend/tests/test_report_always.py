"""Toda OS tem relatório para o cliente (como no Field Control), desde a abertura."""

from datetime import timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.db.base import utcnow
from app.services import tickets as tickets_svc
from app.services.client_report import LINK_DISABLED
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


async def test_link_disabled_by_the_office_stays_disabled(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Desativado pela central, o link não volta pelo app do técnico nem pelo fechamento
    automático; só a gestão gera outro."""
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Rack novo", assignee_id=str(world.tech.user.id))
    t = await transition(client, th, t, "in_progress")
    t = await transition(client, th, t, "resolved", resolution_notes="Rack organizado")
    url = f"{API}/tickets/{t['id']}/report-link"
    assert (await client.delete(url, headers=an)).status_code == 204

    r = await client.post(url, headers=th)
    assert (r.status_code, r.json()["detail"]) == (422, LINK_DISABLED)
    assert (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()["report_link"] is None
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        closed = await tickets_svc.auto_close_resolved(db, utcnow() + timedelta(days=4))
        await db.commit()
    assert closed == 1
    office = (await client.get(f"{API}/tickets/{t['id']}", headers=an)).json()
    assert (office["status"], office["report_link"]) == ("closed", None)

    fresh = await client.post(url, headers=an)  # a gestão gera um link novo
    assert fresh.status_code == 200, fresh.text
    mine = await client.post(url, headers=th)
    assert (mine.status_code, mine.json()["token"]) == (200, fresh.json()["token"])


async def test_solution_only_shows_when_finished(client: AsyncClient, world: World) -> None:
    """A descrição da conclusão que a central adianta numa OS aberta não aparece ao cliente como
    "Solução aplicada"; com a OS concluída, aparece."""
    an, th = world.analyst.headers, world.tech.headers
    t = await create(client, world, title="Nobreak", assignee_id=str(world.tech.user.id))
    page = f"{API}/public/reports/{t['report_link']['token']}"
    r = await client.patch(
        f"{API}/tickets/{t['id']}",
        json={"resolution_notes": "Rascunho da central", "expected_version": t["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert (await client.get(page)).json()["resolution_notes"] is None
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=th)).json()
    t = await transition(client, th, t, "in_progress")
    await transition(client, th, t, "resolved", resolution_notes="Bateria trocada")
    assert (await client.get(page)).json()["resolution_notes"] == "Bateria trocada"
