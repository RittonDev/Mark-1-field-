"""Compatibilidade da Entrega 2 com o app de antes (Compat E2: até o app novo estar em todos).

O app de antes grava as aptidões pelo nome ({name, level}, a lista inteira) e lê `skills[].name`;
não manda áreas nem lê documentos. Com a API nova: o nome casa com o catálogo sem acento e sem
maiúsculas (a desativada é ignorada; fora do catálogo, 422 pedindo para atualizar o app), o "desde"
continua do servidor (mandar `since` recusa), o PATCH sem áreas não mexe nas áreas e o GET traz o id
e o nome do catálogo, as áreas ativas e os documentos (nunca o anexo interno). O código antigo da
área vale só na ficha pública aberta antes da publicação (services/technician_catalogs.resolve_areas
com ficha=True, testes da ficha); no app e na central, `area_ids` são ids.

Dados fictícios (Tecnico Alfa, @exemplo.com).
"""

import uuid
from datetime import datetime
from typing import Any

from httpx import AsyncClient, Response
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import TechDocumentKind
from app.models import ServiceArea, Skill, TechnicianDocument, User
from app.schemas import personal
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX


async def _patch(client: AsyncClient, world: World, **body: Any) -> Response:
    return await client.patch(f"{API}/me/profile", json=body, headers=world.tech.headers)


async def _me(client: AsyncClient, world: World) -> dict[str, Any]:
    r = await client.get(f"{API}/me/profile", headers=world.tech.headers)
    assert r.status_code == 200, r.text
    return r.json()


async def _stored(engine: AsyncEngine, world: World) -> User:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        return user


async def _history(client: AsyncClient, world: World) -> list[dict[str, Any]]:
    r = await client.get(
        f"{API}/technicians/{world.tech.user.id}/changes", headers=world.supervisor.headers
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _deactivate(engine: AsyncEngine, model: Any, item_id: str) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            update(model).where(model.id == uuid.UUID(item_id)).values(is_active=False)
        )


async def test_old_app_skill_names_match_the_catalog(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Pelo nome (sem acento, maiúsculas e espaços a mais) casa com a aptidão do catálogo: grava o
    id; a resposta traz o nome do catálogo (o que o app de antes lê). A desativada mandada pelo
    nome é ignorada. A mesma lista de novo não muda nada."""
    linux, cameras = world.skill_ids["Linux"], world.skill_ids["Câmeras Hikvision"]
    nobreaks = world.skill_ids["Nobreaks"]
    await _deactivate(engine, Skill, nobreaks)
    today = personal.local_today().isoformat()
    body = [
        {"name": "  linux ", "level": "basico"},
        {"name": "CAMERAS  hikvision", "level": "avancado"},
        {"name": "nobreaks", "level": "basico"},
    ]
    r = await _patch(client, world, skills=body)
    assert r.status_code == 200, r.text
    assert r.json()["skills"] == [
        {"skill_id": cameras, "name": "Câmeras Hikvision", "level": "avancado", "since": today},
        {"skill_id": linux, "name": "Linux", "level": "basico", "since": today},
    ]
    assert (await _stored(engine, world)).skills == [
        {"skill_id": cameras, "level": "avancado", "since": today},
        {"skill_id": linux, "level": "basico", "since": today},
    ]
    rows = await _history(client, world)
    assert rows[0]["changes"] == [
        {"field": "skills", "from": None, "to": "Câmeras Hikvision (Avançado), Linux (Básico)"}
    ]
    r = await _patch(client, world, skills=list(reversed(body)))
    assert r.status_code == 200, r.text
    assert len(await _history(client, world)) == len(rows)


async def test_old_app_unknown_skill_is_refused(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Nome fora do catálogo: 422 pedindo para atualizar o app (com o código); `since` no corpo:
    "Campo não aceito" (o "desde" é do servidor). Nada grava."""
    r = await _patch(client, world, skills=[{"name": "Linux Debian", "level": "basico"}])
    assert (r.status_code, r.json()) == (
        422,
        {
            "detail": "Atualize o app: as aptidões agora são escolhidas numa lista",
            "code": "SKILL_UNKNOWN_NAME",
        },
    )
    r = await _patch(
        client, world, skills=[{"name": "Linux", "level": "basico", "since": "2026-01-01"}]
    )
    assert r.status_code == 422, r.text
    [issue] = r.json()["detail"]
    assert (issue["msg"], issue["type"]) == ("Campo não aceito", "extra_forbidden")
    assert (await _stored(engine, world)).skills == []
    assert await _history(client, world) == []


async def test_patch_without_areas_keeps_the_areas(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """O app de antes não manda `area_ids`: o PATCH dele (aptidões, nome) não mexe nas áreas nem
    no carimbo delas."""
    redes, wifi = world.area_ids["redes"], world.area_ids["wifi"]
    r = await _patch(client, world, area_ids=[wifi, redes])
    assert r.status_code == 200, r.text
    stamp = r.json()["tech_profile_updated"]["areas"]
    assert stamp["via"] == "app"
    for body in (
        {"skills": [{"name": "Linux", "level": "basico"}]},
        {"name": "Tecnico Alfa"},
        {"skills": None},
    ):
        r = await _patch(client, world, **body)
        assert r.status_code == 200, (body, r.text)
        assert r.json()["area_ids"] == [redes, wifi], body
        assert r.json()["tech_profile_updated"]["areas"] == stamp, body
    assert (await _stored(engine, world)).service_areas == sorted([redes, wifi])


async def test_area_codes_are_only_for_the_old_ficha(client: AsyncClient, world: World) -> None:
    """No app e na central, `area_ids` são ids do catálogo (o código antigo é só da ficha aberta
    antes da publicação)."""
    for r in (
        await _patch(client, world, area_ids=["redes"]),
        await client.patch(
            f"{API}/technicians/{world.tech.user.id}",
            json={"area_ids": ["redes"]},
            headers=world.analyst.headers,
        ),
    ):
        assert r.status_code == 422, r.text
        [issue] = r.json()["detail"]
        assert (issue["label"], issue["msg"]) == ("Áreas de atuação", "Identificador inválido")


async def test_my_profile_sends_skill_ids_names_and_areas(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """GET /me/profile: as aptidões ativas com o id, o nome do catálogo, o nível e o "desde"; as
    áreas ativas (ids, na ordem do nome); os documentos dele (de qualquer via; o anexo interno
    nunca). As desativadas ficam guardadas e escondidas."""
    linux, nobreaks = world.skill_ids["Linux"], world.skill_ids["Nobreaks"]
    redes, wifi, cftv = (world.area_ids[code] for code in ("redes", "wifi", "cftv"))
    await _deactivate(engine, Skill, nobreaks)
    await _deactivate(engine, ServiceArea, cftv)
    tech = world.tech.user.id
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, tech)
        assert user is not None
        user.skills = [
            {"skill_id": linux, "level": "intermediario", "since": "2025-03-10"},
            {"skill_id": nobreaks, "level": "basico", "since": "2025-05-01"},
        ]
        user.service_areas = [wifi, cftv, redes]

        def document(kind: TechDocumentKind, title: str, via: str) -> TechnicianDocument:
            return TechnicianDocument(
                user_id=tech,
                kind=kind,
                title=title,
                file_name="arquivo.pdf",
                content_type="application/pdf",
                size_bytes=2048,
                storage_key=f"documents/{tech}/{uuid.uuid4().hex}.pdf",
                uploaded_via=via,
            )

        personal_doc = document(TechDocumentKind.PERSONAL, "RG", "central")
        db.add_all([personal_doc, document(TechDocumentKind.INTERNAL, "Contrato", "central")])
        await db.commit()

    me = await _me(client, world)
    assert me["skills"] == [
        {"skill_id": linux, "name": "Linux", "level": "intermediario", "since": "2025-03-10"}
    ]
    assert me["area_ids"] == [redes, wifi]
    [doc] = me["documents"]
    assert doc["id"] == str(personal_doc.id)
    assert (doc["kind"], doc["title"], doc["via"], doc["size"]) == (
        "personal",
        "RG",
        "central",
        2048,
    )
    assert (doc["file_name"], doc["content_type"], doc["expires_on"]) == (
        "arquivo.pdf",
        "application/pdf",
        None,
    )
    assert datetime.fromisoformat(doc["uploaded_at"]).tzinfo is not None
    assert "Contrato" not in str(me) and "internal" not in str(me)
    # Nada de avaliação nem situação no cadastro do app.
    assert not {"rating_average", "rating_count", "operational_status"} & set(me)
    stored = await _stored(engine, world)
    assert {item["skill_id"] for item in stored.skills} == {linux, nobreaks}
    assert set(stored.service_areas) == {redes, wifi, cftv}
