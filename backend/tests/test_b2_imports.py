"""Importações e cadastros: zeros à esquerda que o Excel come (CNPJ e CEP), limites das colunas
pegos já na prévia, uma grafia só por cidade e os formatos de planilha que chegam do escritório."""

import io

import pytest
from fastapi import UploadFile
from httpx import AsyncClient
from openpyxl import Workbook

from app.core.config import settings
from app.core.documents import cnpj_with_check_digits
from app.services import spreadsheet
from app.services.spreadsheet import MAX_BYTES, SpreadsheetError, read_table, read_upload
from tests.conftest import World, requires_db

API = settings.API_PREFIX
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def xlsx(rows: list[list[object]]) -> bytes:
    book = Workbook()
    sheet = book.active
    for row in rows:
        sheet.append(row)
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


@requires_db
async def test_xlsx_numbers_keep_the_leading_zeros(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    doc = cnpj_with_check_digits("012345670001")
    assert doc.startswith("0")
    # O Excel guarda CNPJ e CEP digitados como número: 01.234.567/... vira 1234567...
    data = xlsx(
        [
            ["Local", "CNPJ", "CEP", "Cidade", "UF"],
            ["Loja Zero", int(doc), 1310100, "São Paulo", "SP"],
        ]
    )
    files = {"file": ("lojas.xlsx", data, XLSX)}
    params = {"customer_id": world.customer_id}
    url = f"{API}/locations/import"
    preview = (await client.post(url, params=params, files=files, headers=an)).json()
    assert preview["errors"] == 0, preview
    done = await client.post(url, params={**params, "dry_run": False}, files=files, headers=an)
    assert done.status_code == 200, done.text
    stores = {
        loc["name"]: loc
        for loc in (
            await client.get(f"{API}/customers/{world.customer_id}/locations", headers=an)
        ).json()
    }
    assert (stores["Loja Zero"]["document"], stores["Loja Zero"]["zip_code"]) == (doc, "01310-100")


@requires_db
async def test_values_beyond_the_columns_are_caught_in_the_preview(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    csv = (
        "Local;Contato;Telefone\n"
        "Loja Boa;Ana;11 99999-0000\n"
        f"Loja Contato Longo;{'A' * 200};11 3333-0000\n"
    )
    files = {"file": ("lojas.csv", csv.encode(), "text/csv")}
    params = {"customer_id": world.customer_id}
    url = f"{API}/locations/import"
    preview = (await client.post(url, params=params, files=files, headers=an)).json()
    errors = {r["line"]: r["errors"] for r in preview["rows"] if r["errors"]}
    assert errors == {3: ["Contato: no máximo 160 caracteres"]}
    # Gravar não dá 500: grava as linhas boas e aponta a linha com problema.
    done = await client.post(url, params={**params, "dry_run": False}, files=files, headers=an)
    assert done.status_code == 200, done.text
    assert (done.json()["created"], done.json()["errors"]) == (1, 1)


@requires_db
async def test_new_records_use_the_city_spelling_already_in_use(
    client: AsyncClient, world: World
) -> None:
    an = world.analyst.headers
    url = f"{API}/customers/{world.customer_id}/locations"
    first = await client.post(
        url, json={"name": "Loja Paulista", "city": "São Paulo", "state": "SP"}, headers=an
    )
    assert first.status_code == 201, first.text
    shouted = {"name": "Loja Sé", "city": "SAO PAULO", "state": "sp"}
    r = await client.post(url, json=shouted, headers=an)
    assert r.status_code == 201, r.text
    assert (r.json()["city"], r.json()["state"]) == ("São Paulo", "SP")
    r = await client.patch(
        f"{API}/technicians/{world.tech.user.id}",
        json={"home_city": "sao paulo", "home_state": "SP"},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert r.json()["home_city"] == "São Paulo"
    # CEP, UF e e-mail do cadastro manual também passam pelas regras.
    bad = await client.post(url, json={"name": "Loja X", "zip_code": "123"}, headers=an)
    assert bad.status_code == 422
    bad = await client.post(url, json={"name": "Loja X", "state": "XX"}, headers=an)
    assert bad.status_code == 422
    no_at = {"name": "Rede", "email": "sem-arroba"}
    bad = await client.post(f"{API}/customers", json=no_at, headers=an)
    assert bad.status_code == 422


@requires_db
async def test_technician_import_creates_accounts_with_temporary_passwords(
    client: AsyncClient, world: World
) -> None:
    rows = "".join(f"Técnico {n};importado{n}@exemplo.com;1199999000{n}\n" for n in range(3))
    files = {"file": ("tecnicos.csv", f"Nome;E-mail;Telefone\n{rows}".encode(), "text/csv")}
    r = await client.post(
        f"{API}/technicians/import",
        params={"dry_run": False},
        files=files,
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 3
    first = r.json()["credentials"][0]
    login = await client.post(
        f"{API}/auth/login",
        json={
            "email": first["email"],
            "password": first["temporary_password"],
            "channel": "mobile",
        },
    )
    assert login.status_code == 200, login.text
    assert login.json()["user"]["must_change_password"] is True


def test_spreadsheet_formats_from_the_office() -> None:
    # TAB (copiado do Excel) e "Texto Unicode" (UTF-16) também são lidos.
    tsv = "Nome\tE-mail\nAna\tana@exemplo.com\n".encode()
    assert read_table("tecnicos.csv", tsv) == [{"nome": "Ana", "e_mail": "ana@exemplo.com"}]
    utf16 = "Nome;E-mail\nJoão;joao@exemplo.com\n".encode("utf-16")
    assert read_table("tecnicos.csv", utf16) == [{"nome": "João", "e_mail": "joao@exemplo.com"}]
    # O que não dá para ler vira aviso (e não erro 500).
    with pytest.raises(SpreadsheetError, match="xls antigo"):
        read_table("antigo.xls", b"\xd0\xcf\x11\xe0" + b"\x00" * 64)
    with pytest.raises(SpreadsheetError, match="CSV"):
        read_table("quebrado.csv", b"Nome;Obs\nAna;" + b"x" * 200_000 + b"\n")
    with pytest.raises(SpreadsheetError, match="CSV"):
        read_table("nulo.csv", b"Nome;Obs\nAna;\x00\n")


def test_xlsx_that_unzips_too_big_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(spreadsheet, "MAX_UNZIPPED_BYTES", 1000)
    with pytest.raises(SpreadsheetError, match="maior que 5 MB"):
        read_table("planilha.xlsx", xlsx([["Nome"], ["x" * 5000]]))


async def test_upload_is_read_only_up_to_the_limit() -> None:
    upload = UploadFile(io.BytesIO(b"x" * (MAX_BYTES + 10)), filename="grande.csv")
    with pytest.raises(SpreadsheetError, match="maior que 5 MB"):
        await read_upload(upload)
