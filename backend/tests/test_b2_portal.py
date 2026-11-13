"""Portal do cliente: empresa sem contrato não abre solicitação, busca que só lê número quando o
termo é o código da OS e os arquivos que o cliente manda (foto do problema ou PDF)."""

import base64
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db
from tests.test_api import transition
from tests.test_portal import _other_company

pytestmark = requires_db

API = settings.API_PREFIX
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)
PDF = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n"


async def open_request(client: AsyncClient, world: World, title: str = "Sem toner") -> dict:
    r = await client.post(
        f"{API}/portal/requests",
        json={"location_id": world.location_id, "title": title},
        headers=world.requester.headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def test_company_without_contract_keeps_history_but_cannot_open(
    client: AsyncClient, world: World
) -> None:
    req = world.requester.headers
    before = await open_request(client, world)
    r = await client.patch(
        f"{API}/customers/{world.customer_id}",
        json={"is_active": False},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    assert (await client.get(f"{API}/portal/me", headers=req)).json()["can_open_requests"] is False
    r = await client.post(
        f"{API}/portal/requests",
        json={"location_id": world.location_id, "title": "Mais uma"},
        headers=req,
    )
    assert r.status_code == 422 and "suspenso" in r.json()["detail"]
    listed = await client.get(f"{API}/portal/requests", params={"scope": "all"}, headers=req)
    assert listed.status_code == 200
    assert [i["id"] for i in listed.json()["items"]] == [before["id"]]


async def test_search_reads_a_number_only_from_a_ticket_code(
    client: AsyncClient, world: World
) -> None:
    first = await open_request(client, world, "PDV sem rede")
    number = int(first["code"].rsplit("-", 1)[-1])

    async def search(q: str) -> list[str]:
        r = await client.get(
            f"{API}/portal/requests",
            params={"scope": "all", "q": q},
            headers=world.requester.headers,
        )
        assert r.status_code == 200, r.text
        return [i["id"] for i in r.json()["items"]]

    # Nº do chamado no sistema do cliente (ou um CNPJ): não vira número de OS nem erro 500.
    assert await search("20261113000123") == []
    assert await search("INC20261113001") == []
    assert await search(first["code"]) == [first["id"]]
    assert await search(f"#{number}") == [first["id"]]
    # Dígitos soltos no meio do texto não viram o número da OS.
    assert await search(f"Loja {number} caixa") == []
    assert await search("%") == []  # o texto é procurado como está, não como padrão
    assert await search("sem rede") == [first["id"]]


async def test_client_sends_problem_photos_and_pdfs(
    client: AsyncClient, world: World, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    req, an = world.requester.headers, world.analyst.headers
    opened = await open_request(client, world)
    assert (opened["attachments"], opened["can_attach"]) == ([], True)
    url = f"{API}/portal/requests/{opened['id']}/attachments"

    r = await client.post(url, files={"file": ("tela-erro.png", PNG, "image/png")}, headers=req)
    assert r.status_code == 201, r.text
    assert [a["filename"] for a in r.json()["attachments"]] == ["tela-erro.png"]
    pdf = await client.post(url, files={"file": ("nota.pdf", PDF, "application/pdf")}, headers=req)
    assert pdf.status_code == 201, pdf.text
    # Só foto ou PDF de verdade (pelo conteúdo, não pelo nome nem pelo tipo declarado).
    fake = await client.post(
        url, files={"file": ("foto.png", b"<html>oi</html>", "image/png")}, headers=req
    )
    assert fake.status_code == 422
    assert fake.json()["detail"] == "Envie uma foto (JPG, PNG ou WebP) ou um PDF"

    # A central vê tudo na OS; o que a Maxx anexa não aparece para o cliente.
    office = await client.post(
        f"{API}/tickets/{opened['id']}/attachments",
        files={"file": ("orcamento.pdf", PDF, "application/pdf")},
        headers=an,
    )
    assert office.status_code == 201, office.text
    internal = (await client.get(f"{API}/tickets/{opened['id']}/attachments", headers=an)).json()
    assert {a["filename"] for a in internal} == {"tela-erro.png", "nota.pdf", "orcamento.pdf"}
    photo = next(a for a in internal if a["filename"] == "tela-erro.png")
    assert photo["kind"] == "photo"
    detail = (await client.get(f"{API}/portal/requests/{opened['id']}", headers=req)).json()
    assert [a["filename"] for a in detail["attachments"]] == ["tela-erro.png", "nota.pdf"]

    # A foto do problema não entra no relatório do cliente (as evidências são da visita).
    link = await client.post(f"{API}/tickets/{opened['id']}/report-link", headers=an)
    report = (await client.get(f"{API}/public/reports/{link.json()['token']}")).json()
    assert report["photos"] == []

    # Outra empresa não manda arquivo na solicitação dos outros; a equipe anexa pela OS.
    file = {"file": ("outra.png", PNG, "image/png")}
    _, _, other = await _other_company(client, world)
    assert (await client.post(url, files=file, headers=other)).status_code == 404
    assert (await client.post(url, files=file, headers=an)).status_code == 403

    # Encerrada: não recebe mais arquivos.
    t = (await client.get(f"{API}/tickets/{opened['id']}", headers=an)).json()
    await transition(client, an, t, "cancelled", note="Resolvido por telefone")
    closed = await client.post(url, files=file, headers=req)
    assert closed.status_code == 422
    detail = (await client.get(f"{API}/portal/requests/{opened['id']}", headers=req)).json()
    assert detail["can_attach"] is False
