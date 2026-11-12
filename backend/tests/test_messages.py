"""Textos prontos da OS para o grupo de WhatsApp: variáveis preenchidas com os dados da OS."""

from datetime import UTC, datetime

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import create, transition

pytestmark = requires_db

API = settings.API_PREFIX


async def test_ticket_messages(client: AsyncClient, world: World) -> None:
    an, th = world.analyst.headers, world.tech.headers
    loc = (
        await client.post(
            f"{API}/customers/{world.customer_id}/locations",
            json={"name": "Loja 27", "city": "São Paulo", "state": "SP", "latitude": -23.62, "longitude": -46.70},
            headers=an,
        )
    ).json()
    t = await create(
        client, world, title="PDV parado", location_id=loc["id"], assignee_id=str(world.tech.user.id)
    )

    # Técnico em jornada, a ~5 km do local: a chegada prevista sai da posição ao vivo.
    assert (await client.post(f"{API}/tracking/consent", headers=th)).status_code == 204
    await client.post(f"{API}/tracking/shift/start", json={}, headers=th)
    now = datetime.now(UTC).isoformat()
    await client.post(
        f"{API}/tracking/pings",
        json={"pings": [{"recorded_at": now, "latitude": -23.58, "longitude": -46.68}]},
        headers=th,
    )
    await transition(client, th, t, "en_route")

    msgs = {m["key"]: m["text"] for m in (await client.get(f"{API}/tickets/{t['id']}/messages", headers=an)).json()}
    trip = msgs["deslocamento"]
    assert "Técnico Tecnico em deslocamento para Loja 27 (São Paulo)" in trip
    assert t["code"] in trip and "Cliente Teste" in trip
    assert "__:__" not in trip  # tem posição ao vivo: horário calculado
    assert (await client.get(f"{API}/tickets/{t['id']}/messages", headers=th)).status_code == 403

    # A gestão edita os modelos; variável que não existe fica visível para corrigir.
    custom = {"templates": [{"name": "Saída da base", "body": "{tecnico} saiu para {local} {inexistente}"}]}
    r = await client.put(f"{API}/message-templates", json=custom, headers=an)
    assert r.json()["templates"] == [
        {"key": "saida_da_base", "name": "Saída da base", "body": "{tecnico} saiu para {local} {inexistente}"}
    ]
    assert any(v["key"] == "chegada_prevista" for v in r.json()["variables"])
    msgs = (await client.get(f"{API}/tickets/{t['id']}/messages", headers=an)).json()
    assert msgs == [{"key": "saida_da_base", "name": "Saída da base", "text": "Tecnico saiu para Loja 27 {inexistente}"}]

    defaults = (await client.post(f"{API}/message-templates/reset", headers=an)).json()["templates"]
    assert [d["key"] for d in defaults][:3] == ["deslocamento", "chegada", "atraso"]
