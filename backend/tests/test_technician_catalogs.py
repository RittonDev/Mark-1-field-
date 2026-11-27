"""Catálogos de Configurações › Técnicos: Áreas de atuação e Aptidões, com a regra do Ferramental.

GET/POST/PATCH/DELETE /technician-areas e /technician-skills (e DELETE /technician-tools): a central
inclui, renomeia, desativa e reativa (Configurações em Editar) e exclui só o que nunca foi usado; o
técnico lê só os ativos, sem as contagens; a ficha pública lê os ativos em GET
/public/onboarding/catalog. Os catálogos iniciais (as 10 áreas e as 16 aptidões) vêm do `world`.
Dados fictícios.
"""

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import UserRole
from app.core.text import fold
from app.models import ServiceArea, Skill, TechnicianApplication, TechnicianTool, User
from app.schemas.onboarding import PRIVACY_VERSION
from app.services import technician_catalogs
from tests.conftest import World, requires_db
from tests.test_access import restrict_analyst

pytestmark = requires_db

API = settings.API_PREFIX
# kind -> (rota, o nome na mensagem, o plural, o modelo, a mensagem do 404)
CATALOGS: dict[str, tuple[str, str, str, Any, str]] = {
    "area": (f"{API}/technician-areas", "área", "áreas", ServiceArea, "Área não encontrada"),
    "skill": (f"{API}/technician-skills", "aptidão", "aptidões", Skill, "Aptidão não encontrada"),
    "tool": (
        f"{API}/technician-tools",
        "ferramenta",
        "ferramentas",
        TechnicianTool,
        "Ferramenta não encontrada",
    ),
}


def _maker(engine: AsyncEngine) -> async_sessionmaker:
    return async_sessionmaker(engine, expire_on_commit=False)


async def _row(engine: AsyncEngine, kind: str, item_id: str) -> Any:
    """O item relido do banco (name, name_key, is_active, used_at) ou None."""
    model = CATALOGS[kind][3]
    async with engine.connect() as conn:
        found = await conn.execute(
            select(model.name, model.name_key, model.is_active, model.used_at).where(
                model.id == uuid.UUID(item_id)
            )
        )
        return found.one_or_none()


async def _total(engine: AsyncEngine, kind: str) -> int:
    model = CATALOGS[kind][3]
    async with engine.connect() as conn:
        return len((await conn.execute(select(model.id))).all())


def _stored(kind: str, item_id: str) -> dict[str, Any]:
    """A coluna do técnico com o item guardado (o formato de cada catálogo)."""
    if kind == "tool":
        return {"tool_ids": [item_id]}
    if kind == "area":
        return {"service_areas": [item_id]}
    return {"skills": [{"skill_id": item_id, "level": "basico", "since": "2026-11-20"}]}


async def _ficha(engine: AsyncEngine, **fields: Any) -> str:
    """Uma ficha pendente gravada direto (o envio pela ficha pública fica em test_onboarding)."""
    async with _maker(engine)() as db:
        application = TechnicianApplication(
            full_name="Tecnico Alfa",
            email=f"ficha.{uuid.uuid4().hex[:6]}@exemplo.com",
            phone="(11) 99999-0000",
            document="12345678909",
            city="Cidade Exemplo",
            state="SP",
            coverage_area="Cidade Exemplo",
            availability=[],
            privacy_consent_at=datetime(2026, 11, 26, tzinfo=UTC),
            privacy_version=PRIVACY_VERSION,
            **{"service_areas": [], "skills": [], **fields},
        )
        db.add(application)
        await db.commit()
        return str(application.id)


# ----------------------------------------------------------------- incluir, renomear, desativar


@pytest.mark.parametrize("kind", ["area", "skill"])
async def test_central_keeps_areas_and_skills(
    client: AsyncClient, engine: AsyncEngine, world: World, kind: str
) -> None:
    url, noun, plural, _, missing = CATALOGS[kind]
    an = world.analyst.headers
    await restrict_analyst(client, world, **{"setup.settings": "edit"})
    taken = f"Já existe uma {noun} com este nome"

    r = await client.post(url, json={"name": "  Fibra   óptica  "}, headers=an)
    assert r.status_code == 201, r.text
    created = r.json()
    assert {k: created[k] for k in ("name", "is_active", "technicians", "applications")} == {
        "name": "Fibra óptica",
        "is_active": True,
        "technicians": 0,
        "applications": 0,
    }
    assert created["in_use"] is False
    item_id = created["id"]
    # Relido do banco: o nome limpo e a chave sem acento e sem maiúsculas.
    assert tuple(await _row(engine, kind, item_id)) == ("Fibra óptica", "fibra optica", True, None)

    # Nome: limpo, de 2 a 80 (a mensagem diz qual catálogo); campo a mais recusa.
    r = await client.post(url, json={"name": " a "}, headers=an)
    assert (r.status_code, r.json()["detail"]) == (422, f"Informe o nome da {noun}")
    r = await client.post(url, json={"name": "x" * 81}, headers=an)
    assert r.status_code == 422 and r.json()["detail"][0]["msg"] == "No máximo 80 caracteres"
    r = await client.post(url, json={"name": "Solda", "ativa": True}, headers=an)
    assert r.status_code == 422 and r.json()["detail"][0]["msg"] == "Campo não aceito"
    # Repetido sem acento e sem maiúsculas (também um dos iniciais).
    initial = "Redes e cabeamento estruturado" if kind == "area" else "Montagem de rack"
    for name in ("FIBRA OPTICA", "fibra  óptica", initial.upper()):
        r = await client.post(url, json={"name": name}, headers=an)
        assert (r.status_code, r.json()) == (409, {"detail": taken, "code": "CATALOG_NAME_TAKEN"})

    # Renomear: o mesmo id, relido do banco; o próprio nome em outra grafia vale.
    r = await client.patch(f"{url}/{item_id}", json={"name": "Fusão de fibra"}, headers=an)
    assert r.status_code == 200, r.text
    assert (r.json()["id"], r.json()["name"]) == (item_id, "Fusão de fibra")
    assert tuple(await _row(engine, kind, item_id))[:2] == ("Fusão de fibra", "fusao de fibra")
    r = await client.patch(f"{url}/{item_id}", json={"name": "FUSÃO DE FIBRA"}, headers=an)
    assert r.status_code == 200 and r.json()["name"] == "FUSÃO DE FIBRA"
    r = await client.patch(f"{url}/{item_id}", json={"name": initial.lower()}, headers=an)
    assert (r.status_code, r.json()["code"]) == (409, "CATALOG_NAME_TAKEN")
    r = await client.patch(f"{url}/{item_id}", json={"name": "x"}, headers=an)
    assert (r.status_code, r.json()["detail"]) == (422, f"Informe o nome da {noun}")
    r = await client.patch(f"{url}/{item_id}", json={"ordem": 1}, headers=an)
    assert r.status_code == 422 and r.json()["detail"][0]["msg"] == "Campo não aceito"

    # Desativar e reativar (null não muda nada), relido do banco.
    r = await client.patch(f"{url}/{item_id}", json={"is_active": False}, headers=an)
    assert r.status_code == 200 and r.json()["is_active"] is False
    assert tuple(await _row(engine, kind, item_id))[2] is False
    r = await client.patch(f"{url}/{item_id}", json={"name": None, "is_active": None}, headers=an)
    assert (r.json()["name"], r.json()["is_active"]) == ("FUSÃO DE FIBRA", False)
    # O desativado também segura o nome.
    r = await client.post(url, json={"name": "fusao de fibra"}, headers=an)
    assert r.status_code == 409
    r = await client.patch(f"{url}/{item_id}", json={"is_active": True}, headers=an)
    assert r.status_code == 200 and r.json()["is_active"] is True
    assert tuple(await _row(engine, kind, item_id)) == (
        "FUSÃO DE FIBRA",
        "fusao de fibra",
        True,
        None,
    )
    r = await client.patch(f"{url}/{uuid.uuid4()}", json={"is_active": True}, headers=an)
    assert (r.status_code, r.json()["detail"]) == (404, missing)

    # A lista da gestão: ordem alfabética sem acento, filtro por `active`, com as contagens.
    r = await client.patch(f"{url}/{item_id}", json={"is_active": False}, headers=an)
    listed = (await client.get(url, headers=an)).json()
    names = [item["name"] for item in listed]
    assert names == sorted(names, key=lambda n: (fold(n), n))
    assert all(item["technicians"] == 0 and item["in_use"] is False for item in listed)
    off = (await client.get(url, params={"active": False}, headers=an)).json()
    assert [item["id"] for item in off] == [item_id]
    on = (await client.get(url, params={"active": True}, headers=an)).json()
    assert item_id not in {item["id"] for item in on} and len(on) == len(listed) - 1

    # Limite do catálogo: conta ativos e desativados.
    total = await _total(engine, kind)
    limits = technician_catalogs.MAX_ITEMS
    assert limits == {"tool": 200, "area": 100, "skill": 300}
    with pytest.MonkeyPatch.context() as patch:
        patch.setitem(limits, kind, total)
        r = await client.post(url, json={"name": "Mais um exemplo"}, headers=an)
        assert (r.status_code, r.json()["detail"]) == (
            422,
            f"O catálogo aceita até {total} {plural}",
        )
        patch.setitem(limits, kind, total + 1)
        r = await client.post(url, json={"name": "Mais um exemplo"}, headers=an)
        assert r.status_code == 201, r.text
    assert await _total(engine, kind) == total + 1


async def test_name_key_ignores_accents_case_and_spaces(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """O caso comum do contrato (§11): " Multímetro " tem a chave "multimetro" (e "multimetro"
    repete)."""
    an = world.supervisor.headers
    url = CATALOGS["tool"][0]
    r = await client.post(url, json={"name": " Multímetro "}, headers=an)
    assert r.status_code == 201, r.text
    assert tuple(await _row(engine, "tool", r.json()["id"]))[:2] == ("Multímetro", "multimetro")
    assert fold(" Multímetro ") == "multimetro"
    r = await client.post(url, json={"name": "multimetro"}, headers=an)
    assert (r.status_code, r.json()["code"]) == (409, "CATALOG_NAME_TAKEN")


# --------------------------------------------------------------------- excluir só sem uso


@pytest.mark.parametrize("kind", ["area", "skill", "tool"])
async def test_delete_only_what_was_never_used(
    client: AsyncClient, engine: AsyncEngine, world: World, kind: str
) -> None:
    url, noun, _, model, missing = CATALOGS[kind]
    sup = world.supervisor.headers
    in_use = {
        "detail": f"Esta {noun} já foi usada: desative para tirar das escolhas",
        "code": "CATALOG_IN_USE",
    }

    async def new(name: str) -> str:
        r = await client.post(url, json={"name": name}, headers=sup)
        assert r.status_code == 201, r.text
        return r.json()["id"]

    async def listed(item_id: str) -> dict:
        return next(i for i in (await client.get(url, headers=sup)).json() if i["id"] == item_id)

    # Nunca usado (também desativado): sai, e de novo é 404.
    unused = await new("Item Exemplo Livre")
    await client.patch(f"{url}/{unused}", json={"is_active": False}, headers=sup)
    assert (await client.delete(f"{url}/{unused}", headers=sup)).status_code == 204
    assert await _row(engine, kind, unused) is None
    r = await client.delete(f"{url}/{unused}", headers=sup)
    assert (r.status_code, r.json()["detail"]) == (404, missing)

    # Guardado num técnico (sem acesso também conta); quem não é técnico não conta.
    held = await new("Item Exemplo do Tecnico")
    async with _maker(engine)() as db:
        retired = User(
            name="Tecnico Bravo",
            email="tecnico.bravo@exemplo.com",
            password_hash="x",
            role=UserRole.TECHNICIAN,
            is_active=False,
            **_stored(kind, held),
        )
        db.add(retired)
        await db.commit()
    async with engine.begin() as conn:
        await conn.execute(
            update(User).where(User.id == world.supervisor.user.id).values(**_stored(kind, held))
        )
    item = await listed(held)
    assert (item["technicians"], item["applications"], item["in_use"]) == (1, 0, True)
    r = await client.delete(f"{url}/{held}", headers=sup)
    assert (r.status_code, r.json()) == (409, in_use)
    assert await _row(engine, kind, held) is not None
    # Saiu do técnico (e nunca teve o 1º uso gravado): agora sai.
    async with engine.begin() as conn:
        await conn.execute(update(User).where(User.id == retired.id).values(**_stored(kind, "x")))
    assert (await listed(held))["in_use"] is False
    assert (await client.delete(f"{url}/{held}", headers=sup)).status_code == 204

    # Só o 1º uso gravado (ninguém tem agora): continua em uso.
    marked = await new("Item Exemplo Marcado")
    async with _maker(engine)() as db:
        await technician_catalogs.mark_used(db, kind, [marked])
        await db.commit()
    assert tuple(await _row(engine, kind, marked))[3] is not None
    item = await listed(marked)
    assert (item["technicians"], item["applications"], item["in_use"]) == (0, 0, True)
    r = await client.delete(f"{url}/{marked}", headers=sup)
    assert (r.status_code, r.json()) == (409, in_use)

    if kind == "tool":
        return
    # Numa ficha da homologação (qualquer situação).
    cited = await new("Item Exemplo da Ficha")
    if kind == "area":
        await _ficha(engine, service_areas=[cited])
    else:
        await _ficha(engine, skills=[{"skill_id": cited, "level": "avancado"}])
    item = await listed(cited)
    assert (item["technicians"], item["applications"], item["in_use"]) == (0, 1, True)
    r = await client.delete(f"{url}/{cited}", headers=sup)
    assert (r.status_code, r.json()) == (409, in_use)
    async with engine.connect() as conn:
        assert (await conn.execute(select(model.id).where(model.id == uuid.UUID(cited)))).one()


# ------------------------------------------------------------------ dois pedidos juntos


@pytest.mark.parametrize("kind", ["area", "skill"])
async def test_catalog_name_holds_when_two_arrive_together(
    client: AsyncClient, engine: AsyncEngine, world: World, kind: str
) -> None:
    """Dois pedidos ao mesmo tempo: a trava do catálogo deixa um passar por vez, e o nome repetido
    em outra grafia e o limite valem também aí."""
    url, noun, plural, model, _ = CATALOGS[kind]
    sup = world.supervisor.headers
    taken = f"Já existe uma {noun} com este nome"

    async def post(name: str) -> tuple[int, str | None]:
        r = await client.post(url, json={"name": name}, headers=sup)
        return r.status_code, r.json().get("detail")

    async def rename(item_id: str, name: str) -> tuple[int, str | None]:
        r = await client.patch(f"{url}/{item_id}", json={"name": name}, headers=sup)
        return r.status_code, r.json().get("detail")

    async def same(name: str) -> list[str]:
        async with engine.connect() as conn:
            rows = await conn.execute(select(model.name))
            return [n for (n,) in rows if fold(n) == fold(name)]

    both = await asyncio.gather(post("Energia solar"), post("ENERGIA SOLAR"))
    assert sorted(both) == [(201, None), (409, taken)]
    assert len(await same("Energia solar")) == 1

    total = await _total(engine, kind)
    with pytest.MonkeyPatch.context() as patch:
        patch.setitem(technician_catalogs.MAX_ITEMS, kind, total + 1)
        both = await asyncio.gather(post("Câmeras analógicas"), post("Interfones"))
        assert sorted(both) == [(201, None), (422, f"O catálogo aceita até {total + 1} {plural}")]
    assert await _total(engine, kind) == total + 1

    first = (await client.post(url, json={"name": "Exemplo Um"}, headers=sup)).json()["id"]
    second = (await client.post(url, json={"name": "Exemplo Dois"}, headers=sup)).json()["id"]
    both = await asyncio.gather(rename(first, "Exemplo Três"), rename(second, "EXEMPLO TRES"))
    assert sorted(both) == [(200, None), (409, taken)]
    assert len(await same("Exemplo Três")) == 1
    created, renamed = await asyncio.gather(post("Exemplo Quatro"), rename(first, "exemplo quatro"))
    assert (created, renamed) in (((201, None), (409, taken)), ((409, taken), (200, None)))
    assert len(await same("Exemplo Quatro")) == 1


# ----------------------------------------------------------------- técnico e ficha pública


async def test_technician_reads_only_active_without_counts(
    client: AsyncClient, world: World
) -> None:
    sup, th = world.supervisor.headers, world.tech.headers
    for kind in ("area", "skill"):
        url = CATALOGS[kind][0]
        off = (await client.post(url, json={"name": "Desativada Exemplo"}, headers=sup)).json()
        await client.patch(f"{url}/{off['id']}", json={"is_active": False}, headers=sup)
        managed = (await client.get(url, headers=sup)).json()
        expected = [
            {**item, "technicians": None, "applications": None, "in_use": None}
            for item in managed
            if item["is_active"]
        ]
        for params in ({}, {"active": False}, {"active": True}):
            r = await client.get(url, params=params, headers=th)
            assert r.status_code == 200, r.text
            assert r.json() == expected
        assert len(expected) == (10 if kind == "area" else 16)
        assert (await client.get(url, headers=world.requester.headers)).status_code == 403


async def test_public_catalog_lists_active_areas_and_skills(
    client: AsyncClient, world: World
) -> None:
    sup = world.supervisor.headers
    url = f"{API}/public/onboarding/catalog"
    catalog = (await client.get(url)).json()
    areas = {item["key"]: item["label"] for item in catalog["service_areas"]}
    assert areas == {
        world.area_ids[code]: label for code, label in technician_catalogs.DEFAULT_AREAS
    }
    labels = [item["label"] for item in catalog["service_areas"]]
    assert labels == sorted(labels, key=lambda n: (fold(n), n))
    assert labels[0] == "Alarmes e controle de acesso"
    skills = {item["key"]: item["label"] for item in catalog["skills"]}
    assert skills == {world.skill_ids[name]: name for name in technician_catalogs.DEFAULT_SKILLS}
    # O app e a ficha de antes: os nomes das aptidões ativas, na mesma ordem.
    assert catalog["skill_suggestions"] == [item["label"] for item in catalog["skills"]]
    assert catalog["privacy_version"] == PRIVACY_VERSION == "2026-11-26.2"
    assert [item["key"] for item in catalog["skill_levels"]] == [
        "basico",
        "intermediario",
        "avancado",
    ]
    assert {"availability", "vehicle_types"} <= set(catalog)

    # Desativada some; a nova entra; renomeada sai com o nome novo.
    cftv, linux = world.area_ids["cftv"], world.skill_ids["Linux"]
    await client.patch(f"{CATALOGS['area'][0]}/{cftv}", json={"is_active": False}, headers=sup)
    await client.patch(
        f"{CATALOGS['skill'][0]}/{linux}", json={"name": "Linux (servidores)"}, headers=sup
    )
    new = await client.post(CATALOGS["area"][0], json={"name": "Fibra óptica"}, headers=sup)
    catalog = (await client.get(url)).json()
    keys = [item["key"] for item in catalog["service_areas"]]
    assert cftv not in keys and new.json()["id"] in keys
    assert {"key": linux, "label": "Linux (servidores)"} in catalog["skills"]
    assert "Linux (servidores)" in catalog["skill_suggestions"]


async def test_deactivated_items_stay_with_the_technician_and_come_back(
    client: AsyncClient, engine: AsyncEngine, world: World
) -> None:
    """Desativar não mexe em quem tem: o item fica guardado, some das leituras (só as ativas) e
    volta quando reativado; ao gravar o perfil, o desativado guardado fica."""
    sup = world.supervisor.headers
    redes, cftv = world.area_ids["redes"], world.area_ids["cftv"]
    linux, rack = world.skill_ids["Linux"], world.skill_ids["Montagem de rack"]
    skills = [
        {"skill_id": linux, "level": "avancado", "since": "2026-10-01"},
        {"skill_id": rack, "level": "basico", "since": "2026-11-01"},
    ]
    async with engine.begin() as conn:
        await conn.execute(
            update(User)
            .where(User.id == world.tech.user.id)
            .values(service_areas=sorted([redes, cftv]), skills=skills)
        )
    await client.patch(f"{CATALOGS['area'][0]}/{cftv}", json={"is_active": False}, headers=sup)
    await client.patch(f"{CATALOGS['skill'][0]}/{rack}", json={"is_active": False}, headers=sup)

    async with _maker(engine)() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        assert sorted(user.service_areas) == sorted([redes, cftv]) and user.skills == skills
        areas = await technician_catalogs.catalog(db, "area")
        catalog_skills = await technician_catalogs.catalog(db, "skill")
        assert technician_catalogs.active_ids(user.service_areas, areas) == [uuid.UUID(redes)]
        assert [s.name for s in technician_catalogs.skills_out(user.skills, catalog_skills)] == [
            "Linux"
        ]
        # Gravando o perfil sem elas, as desativadas guardadas ficam (e a enviada é ignorada).
        assert await technician_catalogs.resolve_areas(db, [redes, cftv], user.service_areas) == (
            sorted([redes, cftv])
        )
        assert await technician_catalogs.resolve_areas(db, [], user.service_areas) == [cftv]
    in_use = {i["id"]: i for i in (await client.get(CATALOGS["area"][0], headers=sup)).json()}
    assert (in_use[cftv]["technicians"], in_use[cftv]["is_active"]) == (1, False)

    await client.patch(f"{CATALOGS['area'][0]}/{cftv}", json={"is_active": True}, headers=sup)
    await client.patch(f"{CATALOGS['skill'][0]}/{rack}", json={"is_active": True}, headers=sup)
    async with _maker(engine)() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        areas = await technician_catalogs.catalog(db, "area")
        catalog_skills = await technician_catalogs.catalog(db, "skill")
        assert technician_catalogs.active_ids(user.service_areas, areas) == [
            uuid.UUID(cftv),
            uuid.UUID(redes),
        ]
        shown = technician_catalogs.skills_out(user.skills, catalog_skills)
        assert [(s.name, s.since) for s in shown] == [
            ("Montagem de rack", "2026-11-01"),
            ("Linux", "2026-10-01"),
        ]


# --------------------------------------------------------------------------- guardas


@pytest.mark.parametrize("kind", ["area", "skill", "tool"])
async def test_catalog_permissions(
    client: AsyncClient, engine: AsyncEngine, world: World, kind: str
) -> None:
    url = CATALOGS[kind][0]
    an, th = world.analyst.headers, world.tech.headers
    sup = world.supervisor.headers
    item_id = (await client.post(url, json={"name": "Item Exemplo"}, headers=sup)).json()["id"]

    async def writes(headers: dict[str, str]) -> list[tuple[int, str | None]]:
        out = []
        for method, path, body in (
            ("POST", url, {"name": "Outro Exemplo"}),
            ("PATCH", f"{url}/{item_id}", {"is_active": False}),
            ("DELETE", f"{url}/{item_id}", None),
        ):
            r = await client.request(method, path, json=body, headers=headers)
            out.append((r.status_code, r.json().get("code") if r.content else None))
        return out

    # O técnico lê (só os ativos) e não grava; o cliente do portal não lê.
    assert (await client.get(url, headers=th)).status_code == 200
    assert [status for status, _ in await writes(th)] == [403, 403, 403]
    assert (await client.get(url, headers=world.requester.headers)).status_code == 403
    # O analista sem Configurações (o padrão) e com Configurações em Visualizar lê com as
    # contagens e não grava.
    for level in (None, "view"):
        if level:
            await restrict_analyst(client, world, **{"setup.settings": level})
        r = await client.get(url, headers=an)
        assert r.status_code == 200 and all(i["technicians"] is not None for i in r.json())
        assert await writes(an) == [(403, "MODULE_FORBIDDEN")] * 3
    assert tuple(await _row(engine, kind, item_id))[2] is True
    # Com Configurações em Editar, grava (o item nunca foi usado: sai).
    await restrict_analyst(client, world, **{"setup.settings": "edit"})
    assert [status for status, _ in await writes(an)] == [201, 200, 204]
    assert await _row(engine, kind, item_id) is None
