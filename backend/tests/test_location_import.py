"""Importação da base de locais: cliente por CNPJ/nome, local por código/CNPJ/nome, prévia."""

from httpx import AsyncClient

from app.core.config import settings
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX

CSV = (
    "Cliente;CNPJ Cliente;Código;Local;Endereço;Bairro;Cidade;UF;CEP;Latitude;Longitude;Contato\n"
    "Cliente Teste;;L01;Loja Centro;Rua A, 10;Sé;São Paulo;sp;01001-000;-23,5505;-46,6333;Ana\n"
    "Cliente Teste;;;Matriz;;;Campinas;SP;;;;\n"
    "Rede Nova;11.222.333/0001-81;U1;Unidade 1;;;Guarulhos;SP;;;;\n"
    ";11222333000181;U2;Unidade 2;;;Osasco;SP;;;;\n"
    "Cliente Teste;;L02;Loja UF Errada;;;Santos;SPX;;;;\n"
    "Cliente Teste;;L01;Loja Centro de novo;;;;;;;;\n"
    ";;;Sem Cliente;;;;;;;;\n"
    "Cliente Teste;;L03;Loja Coordenada;;;;;;abc;-46;\n"
)


async def test_import_locations(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    files = {"file": ("locais.csv", CSV.encode("cp1252"), "text/csv")}
    assert (
        await client.post(f"{API}/locations/import", files=files, headers=world.tech.headers)
    ).status_code == 403

    preview = (await client.post(f"{API}/locations/import", files=files, headers=an)).json()
    summary = {k: preview[k] for k in ("created", "updated", "errors", "customers_created")}
    assert summary == {"created": 3, "updated": 1, "errors": 4, "customers_created": 1}
    errors = {r["line"]: r["errors"] for r in preview["rows"] if r["errors"]}
    assert set(errors) == {6, 7, 8, 9}
    assert any("UF" in e for e in errors[6])
    assert errors[7] == ["Local repetido na planilha"]
    customers = (await client.get(f"{API}/customers", headers=an)).json()
    assert "Rede Nova" not in {c["name"] for c in customers}  # prévia não grava

    done = await client.post(
        f"{API}/locations/import", params={"dry_run": False}, files=files, headers=an
    )
    assert done.status_code == 200, done.text
    mine = {
        loc["name"]: loc
        for loc in (
            await client.get(f"{API}/customers/{world.customer_id}/locations", headers=an)
        ).json()
    }
    assert mine["Loja Centro"]["latitude"] == -23.5505  # vírgula decimal do Excel
    assert mine["Loja Centro"]["state"] == "SP"
    assert mine["Matriz"]["city"] == "Campinas"  # atualizou o local que já existia
    nova = next(c for c in (await client.get(f"{API}/customers", headers=an)).json() if c["name"] == "Rede Nova")
    assert nova["locations_count"] == 2  # o mesmo cliente novo nas duas linhas

    # Importando direto para um cliente: a planilha nem precisa das colunas de cliente.
    only = "Local;Cidade;UF\nFilial Norte;Manaus;AM\n"
    r = await client.post(
        f"{API}/locations/import",
        params={"dry_run": False, "customer_id": world.customer_id},
        files={"file": ("filiais.csv", only.encode(), "text/csv")},
        headers=an,
    )
    assert (r.json()["created"], r.json()["rows"][0]["customer"]) == (1, "Cliente Teste")
