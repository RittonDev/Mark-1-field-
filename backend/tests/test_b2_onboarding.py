"""Ficha pública de técnico: limites de envio, link de uso único com uma ficha só, retenção e
exclusão a pedido (LGPD), validações da ficha e o link que pode ser copiado de novo."""

import asyncio
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.api.routes import onboarding as onboarding_routes
from app.core.config import settings
from app.main import app
from app.services import onboarding as onboarding_svc
from tests.conftest import World, requires_db
from tests.test_onboarding import ficha, new_invite

pytestmark = requires_db

API = settings.API_PREFIX


def cpf(base: str) -> str:
    """CPF válido (inventado) a partir dos 9 primeiros dígitos."""
    digits = [int(c) for c in base]
    for n in (9, 10):
        total = sum(d * (n + 1 - i) for i, d in enumerate(digits[:n]))
        digits.append(total * 10 % 11 % 10)
    return "".join(str(d) for d in digits)


async def test_public_form_has_send_limits(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = await new_invite(client, world, reusable=True, days_valid=30)
    url = f"{API}/public/onboarding/{token}"
    for n in range(onboarding_routes.MAX_PER_IP_HOUR):
        body = ficha(email=f"tecnico{n}@exemplo.com", document=cpf(f"12345678{n}"), photo=None)
        r = await client.post(url, json=body)
        assert r.status_code == 201, r.text
    r = await client.post(
        url, json=ficha(email="mais.um@exemplo.com", document=cpf("123456789"), photo=None)
    )
    assert r.status_code == 429
    assert r.json()["detail"] == "Muitas fichas enviadas por este link. Tente mais tarde."
    assert int(r.headers["retry-after"]) > 0

    # De outra origem segue aceitando, até o teto do link por dia (o link roda em grupos).
    monkeypatch.setattr(onboarding_routes, "MAX_PER_INVITE_DAY", 6)
    other = AsyncClient(
        transport=ASGITransport(app=app, client=("10.0.0.9", 5555)), base_url="http://test"
    )
    async with other:
        sixth = ficha(email="sexto@exemplo.com", document=cpf("123456788"), photo=None)
        assert (await other.post(url, json=sixth)).status_code == 201
        seventh = ficha(email="setimo@exemplo.com", document=cpf("123456787"), photo=None)
        assert (await other.post(url, json=seventh)).status_code == 429


async def test_single_use_link_takes_only_one_form(client: AsyncClient, world: World) -> None:
    token = await new_invite(client, world)
    url = f"{API}/public/onboarding/{token}"
    first, second = await asyncio.gather(
        client.post(url, json=ficha(email="um@exemplo.com", document=cpf("111222333"), photo=None)),
        client.post(
            url, json=ficha(email="dois@exemplo.com", document=cpf("111222334"), photo=None)
        ),
    )
    assert sorted([first.status_code, second.status_code]) == [201, 410]


async def test_lgpd_retention_and_deletion_on_request(
    client: AsyncClient,
    world: World,
    engine: AsyncEngine,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    an, sup = world.analyst.headers, world.supervisor.headers
    token = await new_invite(client, world, reusable=True, days_valid=30)
    url = f"{API}/public/onboarding/{token}"
    emails = ("reprovada@exemplo.com", "parada@exemplo.com", "aprovada@exemplo.com")
    for n, email in enumerate((*emails, "pedido@exemplo.com")):
        r = await client.post(url, json=ficha(email=email, document=cpf(f"98765432{n}")))
        assert r.status_code == 201, r.text
    apps = {
        a["email"]: a["id"]
        for a in (await client.get(f"{API}/onboarding/applications", headers=an)).json()
    }
    rejected, stale, approved = (apps[e] for e in emails)
    r = await client.post(
        f"{API}/onboarding/applications/{rejected}/reject",
        json={"reason": "Sem experiência comprovada"},
        headers=an,
    )
    assert r.status_code == 200, r.text
    r = await client.post(f"{API}/onboarding/applications/{approved}/approve", json={}, headers=an)
    assert r.status_code == 200, r.text

    # Pedido do titular: a gestão (supervisor ou admin) apaga a ficha e a foto na hora.
    asked = f"{API}/onboarding/applications/{apps['pedido@exemplo.com']}"
    assert (await client.delete(asked, headers=an)).status_code == 403
    assert (await client.delete(asked, headers=sup)).status_code == 204
    assert (await client.get(asked, headers=an)).status_code == 404
    kept = f"{API}/onboarding/applications/{approved}"
    assert (await client.delete(kept, headers=sup)).status_code == 422  # virou o cadastro

    old = datetime.now(UTC) - timedelta(days=settings.ONBOARDING_RETENTION_DAYS + 1)
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE technician_applications SET reviewed_at = :old WHERE id = :i"),
            {"old": old, "i": rejected},
        )
        await conn.execute(
            text("UPDATE technician_applications SET created_at = :old WHERE id = :i"),
            {"old": old, "i": stale},
        )
        keys = dict(
            (
                await conn.execute(
                    text("SELECT id::text, photo_key FROM technician_applications")
                )
            ).all()
        )
    assert (tmp_path / keys[rejected]).exists()

    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        changed = await onboarding_svc.purge_expired(db)
        await db.commit()
    assert changed == 2
    # Reprovada além do prazo: some, com a foto.
    gone = await client.get(f"{API}/onboarding/applications/{rejected}", headers=an)
    assert gone.status_code == 404
    assert not (tmp_path / keys[rejected]).exists()
    # Pendente sem análise além do prazo: vira reprovada, sem a senha escolhida.
    detail = (await client.get(f"{API}/onboarding/applications/{stale}", headers=an)).json()
    assert (detail["status"], detail["review_note"]) == ("rejected", "Expirada sem análise")
    async with engine.connect() as conn:
        left = await conn.scalar(
            text("SELECT password_hash FROM technician_applications WHERE id = :i"), {"i": stale}
        )
    assert left is None
    # Aprovada não é tocada (a foto é a do técnico).
    assert (await client.get(kept, headers=an)).json()["status"] == "approved"
    assert (tmp_path / keys[approved]).exists()


async def test_form_validations_and_approval_keeps_the_address(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    token = await new_invite(client, world, reusable=True)
    url = f"{API}/public/onboarding/{token}"
    young = (date.today() - timedelta(days=365 * 16)).isoformat()
    r = await client.post(
        url,
        json=ficha(email="jovem@exemplo.com", document=cpf("222333444"), birth_date=young),
    )
    assert r.status_code == 422 and "18 anos" in r.json()["detail"][0]["msg"]
    no_digits = ficha(email="tel@exemplo.com", document=cpf("222333445"), phone="(11) abcd-efgh")
    assert (await client.post(url, json=no_digits)).status_code == 422

    good = ficha(
        email="endereco@exemplo.com",
        document=cpf("222333446"),
        address="Rua das Flores, 10",
        postal_code="07010000",
        photo=None,
    )
    assert (await client.post(url, json=good)).status_code == 201
    # A mesma pessoa (CPF) não manda duas fichas.
    dup = await client.post(url, json={**good, "email": "outro.email@exemplo.com"})
    assert dup.status_code == 422 and "CPF" in dup.json()["detail"]

    app_id = (await client.get(f"{API}/onboarding/applications", headers=an)).json()[0]["id"]
    r = await client.post(f"{API}/onboarding/applications/{app_id}/approve", json={}, headers=an)
    assert r.status_code == 200, r.text
    found = (
        await client.get(f"{API}/technicians", params={"q": "endereco@exemplo.com"}, headers=an)
    ).json()
    assert [(t["address_line"], t["address_zip"]) for t in found] == [
        ("Rua das Flores, 10", "07010-000")
    ]


async def test_active_link_can_be_copied_again(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    r = await client.post(
        f"{API}/onboarding/invites",
        json={"label": "Grupo Zona Sul", "reusable": True, "max_uses": 50},
        headers=an,
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["url"].endswith(f"/cadastro-tecnico/{created['token']}")
    assert created["max_uses"] == 50
    listed = (await client.get(f"{API}/onboarding/invites", headers=an)).json()
    assert [i["url"] for i in listed] == [created["url"]]
    # O link copiado abre a ficha.
    assert (await client.get(f"{API}/public/onboarding/{created['token']}")).json()["valid"]

    assert (
        await client.delete(f"{API}/onboarding/invites/{created['id']}", headers=an)
    ).status_code == 204
    listed = (await client.get(f"{API}/onboarding/invites", headers=an)).json()
    assert (listed[0]["state"], listed[0]["url"]) == ("revoked", None)
