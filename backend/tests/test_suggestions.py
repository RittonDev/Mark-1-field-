"""Sugestão de técnicos pela localização da OS (ex.: OS em Santos -> quem mora em Santos)."""

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create

pytestmark = requires_db

API = settings.API_PREFIX


async def test_suggests_technicians_by_city(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    tech, other = str(world.tech.user.id), str(world.tech_other.user.id)
    await client.patch(
        f"{API}/technicians/{tech}", json={"home_city": "Santos", "home_state": "sp"}, headers=an
    )
    await client.patch(
        f"{API}/technicians/{other}",
        json={"home_city": "São Paulo", "home_state": "SP", "coverage_area": "Capital e Baixada"},
        headers=an,
    )
    loc = (
        await client.post(
            f"{API}/customers/{world.customer_id}/locations",
            json={"name": "Loja Gonzaga", "city": "Santos", "state": "SP"},
            headers=an,
        )
    ).json()
    t = await create(client, world, title="Impressora parada", location_id=loc["id"])

    r = await client.get(f"{API}/tickets/{t['id']}/technician-suggestions", headers=an)
    assert r.status_code == 200, r.text
    first, second = r.json()[0], r.json()[1]
    assert first["id"] == tech and "Mora em Santos" in first["reasons"]
    assert second["id"] == other and "Mesmo estado (SP)" in second["reasons"]
    assert any("OS em aberto" in reason for reason in first["reasons"])

    # Acentos e maiúsculas não atrapalham; serve também antes de a OS existir.
    r = await client.get(f"{API}/technicians/suggest", params={"city": "sao paulo"}, headers=an)
    assert r.json()[0]["id"] == other
    assert (
        await client.get(f"{API}/tickets/{t['id']}/technician-suggestions", headers=world.tech.headers)
    ).status_code == 403
