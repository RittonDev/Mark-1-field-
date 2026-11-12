"""Homologação: link de convite, ficha pública do técnico e análise pela gestão."""

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX
PNG_1PX = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def ficha(**extra: object) -> dict:
    return {
        "full_name": "  Marcos   Pereira da Silva ",
        "email": "Marcos.Tecnico@Gmail.com",
        "phone": "(11) 98888-7777",
        "document": "529.982.247-25",
        "city": "Guarulhos",
        "state": "sp",
        "years_experience": 6,
        "service_areas": ["cftv", "redes"],
        "skills": [{"name": "DVR/NVR Intelbras", "level": "avancado"}],
        "has_vehicle": True,
        "vehicle_type": "moto",
        "coverage_area": "Guarulhos, Zona Leste de SP",
        "availability": ["dias_uteis_manha", "sabado"],
        "photo": PNG_1PX,
        "password": "minha-senha-forte",
        "privacy_consent": True,
        **extra,
    }


async def new_invite(client: AsyncClient, world: World, **body: object) -> str:
    r = await client.post(f"{API}/onboarding/invites", json=body, headers=world.analyst.headers)
    assert r.status_code == 201, r.text
    assert r.json()["state"] == "active"
    return r.json()["token"]


async def test_invite_form_and_approval(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    an = world.analyst.headers
    token = await new_invite(client, world, label="Marcos (indicação)")
    assert (await client.get(f"{API}/public/onboarding/{token}")).json()["valid"] is True
    catalog = (await client.get(f"{API}/public/onboarding/catalog")).json()
    assert {"cftv", "impressoras"} <= {a["key"] for a in catalog["service_areas"]}

    # Validações do lado do servidor (o formulário também valida, mas não basta).
    bad = await client.post(
        f"{API}/public/onboarding/{token}", json=ficha(document="111.111.111-11")
    )
    assert bad.status_code == 422
    bad = await client.post(f"{API}/public/onboarding/{token}", json=ficha(privacy_consent=False))
    assert bad.status_code == 422

    r = await client.post(f"{API}/public/onboarding/{token}", json=ficha())
    assert r.status_code == 201, r.text
    assert r.json()["protocol"].startswith("HOM-")

    # Link de uso único: depois de usado, não abre nem aceita outra ficha.
    assert (await client.get(f"{API}/public/onboarding/{token}")).json()["valid"] is False
    assert (await client.post(f"{API}/public/onboarding/{token}", json=ficha())).status_code == 410

    # Mesmo e-mail com ficha pendente, por outro link: recusado.
    other = await new_invite(client, world, reusable=True, days_valid=30)
    dup = await client.post(
        f"{API}/public/onboarding/{other}", json=ficha(email="marcos.tecnico@gmail.com")
    )
    assert dup.status_code == 422

    # Gestão vê a ficha em "Homologação" (o técnico não).
    assert (
        await client.get(f"{API}/onboarding/applications", headers=world.tech.headers)
    ).status_code == 403
    pending = (
        await client.get(f"{API}/onboarding/applications", params={"status": "pending"}, headers=an)
    ).json()
    assert len(pending) == 1
    app_id = pending[0]["id"]
    assert (
        await client.get(f"{API}/onboarding/applications/pending-count", headers=an)
    ).json() == {"pending": 1}
    detail = (await client.get(f"{API}/onboarding/applications/{app_id}", headers=an)).json()
    assert detail["full_name"] == "Marcos Pereira da Silva"
    assert (detail["email"], detail["state"], detail["document"]) == (
        "marcos.tecnico@gmail.com",
        "SP",
        "52998224725",
    )
    assert detail["invite_label"] == "Marcos (indicação)"
    assert "password" not in str(detail)
    photo = await client.get(detail["photo_url"])
    assert photo.status_code == 200 and photo.content.startswith(b"\x89PNG")
    forged = await client.get(
        f"{API}/onboarding/applications/{app_id}/photo", params={"token": "x"}
    )
    assert forged.status_code == 401

    # Aprovada: vira técnico e entra no app com o e-mail e a senha que ele cadastrou.
    r = await client.post(
        f"{API}/onboarding/applications/{app_id}/approve",
        json={"team_id": world.team_field_id},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert (r.json()["role"], r.json()["team"]["name"]) == ("technician", "Campo")
    login = await client.post(
        f"{API}/auth/login",
        json={
            "email": "marcos.tecnico@gmail.com",
            "password": "minha-senha-forte",
            "channel": "mobile",
        },
    )
    assert login.status_code == 200
    assert login.json()["user"]["must_change_password"] is False
    async with engine.connect() as conn:
        leftover = await conn.scalar(
            text("SELECT password_hash FROM technician_applications WHERE id = :i"), {"i": app_id}
        )
    assert leftover is None  # a senha fica só no usuário

    again = await client.post(
        f"{API}/onboarding/applications/{app_id}/reject", json={"reason": "x" * 5}, headers=an
    )
    assert again.status_code == 422  # já analisada


async def test_reject_and_revoke(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    token = await new_invite(client, world, reusable=True)
    r = await client.post(
        f"{API}/public/onboarding/{token}", json=ficha(email="outro@exemplo.com", photo=None)
    )
    assert r.status_code == 201
    app_id = (await client.get(f"{API}/onboarding/applications", headers=an)).json()[0]["id"]
    r = await client.post(
        f"{API}/onboarding/applications/{app_id}/reject",
        json={"reason": "Sem experiência em CFTV comprovada"},
        headers=an,
    )
    assert (r.json()["status"], r.json()["review_note"]) == (
        "rejected",
        "Sem experiência em CFTV comprovada",
    )
    # Reprovado não entra no app.
    login = await client.post(
        f"{API}/auth/login",
        json={"email": "outro@exemplo.com", "password": "minha-senha-forte", "channel": "mobile"},
    )
    assert login.status_code == 401

    invites = (await client.get(f"{API}/onboarding/invites", headers=an)).json()
    assert await client.delete(f"{API}/onboarding/invites/{invites[0]['id']}", headers=an)
    assert (await client.get(f"{API}/public/onboarding/{token}")).json()["valid"] is False
    states = {
        i["state"] for i in (await client.get(f"{API}/onboarding/invites", headers=an)).json()
    }
    assert states == {"revoked"}
