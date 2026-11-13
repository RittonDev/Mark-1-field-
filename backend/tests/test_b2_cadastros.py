"""Cadastros: técnicos em páginas com o total, foto que sumiu do disco, seletores de clientes e
lojas (ativos, busca, limite), CNPJ alfanumérico, categorias sem ciclo e sem nome repetido, SLA
fora do alcance do técnico e o CNPJ da empresa validado."""

import base64
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.core.config import settings
from app.core.documents import cnpj_with_check_digits
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def formatted(doc: str) -> str:
    return f"{doc[:2]}.{doc[2:5]}.{doc[5:8]}/{doc[8:12]}-{doc[12:]}"


async def test_technician_list_is_paged_with_the_total(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    r = await client.post(
        f"{API}/technicians",
        json={"name": "Técnico Extra", "email": "extra@teste.com.br"},
        headers=an,
    )
    assert r.status_code == 201, r.text
    page = await client.get(f"{API}/technicians", params={"limit": 2}, headers=an)
    assert len(page.json()) == 2 and page.headers["x-total-count"] == "3"
    rest = await client.get(f"{API}/technicians", params={"limit": 2, "offset": 2}, headers=an)
    assert len(rest.json()) == 1
    ids = {t["id"] for t in page.json() + rest.json()}
    created = r.json()["technician"]["id"]
    assert ids == {str(world.tech.user.id), str(world.tech_other.user.id), created}

    # Sugestão para quem ainda está abrindo a OS: horário sem fuso ou fim antes do início não vale.
    url = f"{API}/technicians/suggest"
    no_tz = {"start": "2026-11-20T10:00:00-03:00", "end": "2026-11-20T11:00:00"}
    assert (await client.get(url, params=no_tz, headers=an)).status_code == 422
    backwards = {"start": "2026-11-20T11:00:00-03:00", "end": "2026-11-20T10:00:00-03:00"}
    r = await client.get(url, params=backwards, headers=an)
    assert r.status_code == 422 and "depois do início" in r.json()["detail"]


async def test_missing_avatar_file_is_404(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    r = await client.post(
        f"{API}/technicians/{world.tech.user.id}/photo",
        files={"file": ("rosto.png", PNG, "image/png")},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    url = r.json()["avatar_url"]
    assert (await client.get(url)).status_code == 200
    for stored in (tmp_path / "avatars").iterdir():
        stored.unlink()
    missing = await client.get(url)
    assert missing.status_code == 404 and missing.json()["detail"] == "Arquivo não encontrado"


async def test_customer_and_store_pickers(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    # CNPJ alfanumérico (julho de 2026) digitado com pontuação acha o cliente.
    doc = cnpj_with_check_digits("12ABC34501DE")
    r = await client.post(
        f"{API}/customers", json={"name": "Rede Alfa", "document": formatted(doc)}, headers=an
    )
    assert r.status_code == 201, r.text
    assert r.json()["document"] == doc
    found = (await client.get(f"{API}/customers", params={"q": formatted(doc)}, headers=an)).json()
    assert [c["name"] for c in found] == ["Rede Alfa"]

    # Seletores: sem os clientes inativos (sem contrato) e com limite.
    gone = (await client.post(f"{API}/customers", json={"name": "Rede Antiga"}, headers=an)).json()
    r = await client.patch(f"{API}/customers/{gone['id']}", json={"is_active": False}, headers=an)
    assert r.status_code == 200, r.text
    active = (await client.get(f"{API}/customers", params={"active": True}, headers=an)).json()
    assert "Rede Antiga" not in {c["name"] for c in active}
    assert len((await client.get(f"{API}/customers", params={"limit": 1}, headers=an)).json()) == 1

    # Lojas do cliente: só as ativas, busca por nome ou código e limite (há cliente com mil lojas).
    url = f"{API}/customers/{world.customer_id}/locations"
    closed = (await client.post(url, json={"name": "Loja Fechada"}, headers=an)).json()
    r = await client.patch(f"{API}/locations/{closed['id']}", json={"is_active": False}, headers=an)
    assert r.status_code == 200, r.text
    r = await client.post(url, json={"name": "Loja Shopping Norte", "code": "LJ-77"}, headers=an)
    assert r.status_code == 201, r.text
    names = {s["name"] for s in (await client.get(url, params={"active": True}, headers=an)).json()}
    assert names == {"Matriz", "Loja Shopping Norte"}
    by_code = (await client.get(url, params={"q": "lj-77"}, headers=an)).json()
    assert [s["name"] for s in by_code] == ["Loja Shopping Norte"]
    assert len((await client.get(url, params={"limit": 1}, headers=an)).json()) == 1


async def test_categories_and_service_types_without_cycles_or_repeats(
    client: AsyncClient, world: World
) -> None:
    sup, an = world.supervisor.headers, world.analyst.headers
    top = (await client.post(f"{API}/categories", json={"name": "Impressoras"}, headers=sup)).json()
    laser = await client.post(
        f"{API}/categories", json={"name": "Laser", "parent_id": top["id"]}, headers=sup
    )
    assert laser.status_code == 201, laser.text
    cycle = await client.patch(
        f"{API}/categories/{top['id']}", json={"parent_id": laser.json()["id"]}, headers=sup
    )
    assert cycle.status_code == 422
    assert "subcategoria dela mesma" in cycle.json()["detail"]
    # Nome repetido na raiz (o banco não pega: pai nulo), sem diferença de maiúscula e espaço.
    dup = await client.post(f"{API}/categories", json={"name": "  impressoras "}, headers=sup)
    assert dup.status_code == 409
    inside = await client.post(
        f"{API}/categories", json={"name": "Impressoras", "parent_id": top["id"]}, headers=sup
    )
    assert inside.status_code == 201  # outro nível: outra categoria

    body = {"name": "Troca de PDV", "estimated_minutes": 60}
    assert (await client.post(f"{API}/service-types", json=body, headers=an)).status_code == 201
    again = await client.post(
        f"{API}/service-types", json={**body, "name": "troca de pdv"}, headers=an
    )
    assert again.status_code == 409
    own = await client.post(
        f"{API}/service-types", json={**body, "customer_id": world.customer_id}, headers=an
    )
    assert own.status_code == 201  # o catálogo do cliente pode ter o mesmo nome


async def test_sla_stays_with_the_office_and_meta_labels(client: AsyncClient, world: World) -> None:
    # O técnico é terceiro: nada de SLA, nem a lista de motivos de violação.
    assert (
        await client.get(f"{API}/violation-reasons", headers=world.tech.headers)
    ).status_code == 403
    assert (
        await client.get(f"{API}/violation-reasons", headers=world.analyst.headers)
    ).status_code == 200
    meta = (await client.get(f"{API}/meta")).json()
    assert {"value": "portal", "label": "Portal do cliente"} in meta["sources"]


async def test_company_document_must_be_a_valid_cnpj(client: AsyncClient, world: World) -> None:
    sup = world.supervisor.headers
    doc = cnpj_with_check_digits("12ABC34501DE")
    url = f"{API}/settings/company"
    body = {"name": "Maxx Field", "document": formatted(doc)}
    saved = await client.put(url, json=body, headers=sup)
    assert saved.status_code == 200, saved.text
    assert saved.json()["document"] == doc  # guardado sem pontuação
    cpf = await client.put(url, json={**body, "document": "529.982.247-25"}, headers=sup)
    assert cpf.status_code == 422  # CPF não é CNPJ da empresa
    blank = await client.put(url, json={"name": "Maxx Field", "document": "  "}, headers=sup)
    assert blank.status_code == 200 and blank.json()["document"] is None
