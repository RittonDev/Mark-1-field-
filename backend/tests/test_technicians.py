"""Base técnica: analistas e gestores cuidam do acesso dos técnicos (e só dos técnicos)."""

import asyncio
import base64
import io

from httpx import AsyncClient
from openpyxl import Workbook

from app.core.config import settings
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


async def login(client: AsyncClient, email: str, password: str) -> dict:
    r = await client.post(
        f"{API}/auth/login", json={"email": email, "password": password, "channel": "mobile"}
    )
    return {"status": r.status_code, **(r.json() if r.status_code == 200 else {})}


async def test_access_management(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    assert (await client.get(f"{API}/technicians", headers=world.tech.headers)).status_code == 403

    r = await client.post(
        f"{API}/technicians",
        json={"name": "Paula Campos", "email": "Paula@Campo.com", "team_id": world.team_net_id},
        headers=an,
    )
    assert r.status_code == 201, r.text
    tech_id = r.json()["technician"]["id"]
    temp = r.json()["temporary_password"]
    first = await login(client, "paula@campo.com", temp)
    assert first["status"] == 200 and first["user"]["must_change_password"] is True

    # Só técnicos: o analista não edita outro analista por aqui.
    other = await client.patch(
        f"{API}/technicians/{world.analyst.user.id}", json={"name": "Xavier"}, headers=an
    )
    assert other.status_code == 404

    # Troca de e-mail e nome: o login passa a ser o e-mail novo.
    r = await client.patch(
        f"{API}/technicians/{tech_id}",
        json={"name": "Paula C. Campos", "email": "paula.campos@campo.com"},
        headers=an,
    )
    assert (r.json()["name"], r.json()["email"]) == ("Paula C. Campos", "paula.campos@campo.com")
    dup = await client.patch(
        f"{API}/technicians/{tech_id}", json={"email": "tecnico@teste.com.br"}, headers=an
    )
    assert dup.status_code == 422

    # Esqueceu a senha: provisória nova e as sessões abertas caem.
    old_headers = {"Authorization": f"Bearer {first['access_token']}"}
    await asyncio.sleep(1.05)  # o iat do token é em segundos inteiros
    r = await client.post(f"{API}/technicians/{tech_id}/reset-password", headers=an)
    new_temp = r.json()["temporary_password"]
    assert new_temp != temp
    assert (await client.get(f"{API}/auth/me", headers=old_headers)).status_code == 401
    assert (await login(client, "paula.campos@campo.com", new_temp))["status"] == 200

    # Foto: só imagem de verdade.
    r = await client.post(
        f"{API}/technicians/{tech_id}/photo",
        files={"file": ("foto.png", PNG_1PX, "image/png")},
        headers=an,
    )
    assert r.status_code == 200
    assert (await client.get(r.json()["avatar_url"])).content == PNG_1PX
    fake = await client.post(
        f"{API}/technicians/{tech_id}/photo",
        files={"file": ("foto.png", b"<script>", "image/png")},
        headers=an,
    )
    assert fake.status_code == 422

    # Desativado: não entra mais.
    await client.patch(f"{API}/technicians/{tech_id}", json={"is_active": False}, headers=an)
    assert (await login(client, "paula.campos@campo.com", new_temp))["status"] == 401


async def test_import_csv_and_xlsx(client: AsyncClient, world: World) -> None:
    an = world.analyst.headers
    csv_text = (
        "Nome;E-mail;Telefone;Grupo;Cargo\n"
        "João Araújo;joao@campo.com;11999990000;Campo;Técnico N2\n"
        "Técnico Atualizado;tecnico@teste.com.br;11988887777;Redes;\n"
        "Sem Email;nao-e-email;;;\n"
        "Grupo Errado;grupo@campo.com;;Inexistente;\n"
        "Analista;analista@teste.com.br;;;\n"
        "João de Novo;joao@campo.com;;;\n"
    )
    files = {"file": ("tecnicos.csv", csv_text.encode("cp1252"), "text/csv")}  # Excel BR

    preview = (await client.post(f"{API}/technicians/import", files=files, headers=an)).json()
    assert (preview["created"], preview["updated"], preview["errors"]) == (1, 1, 4)
    assert preview["rows"][0]["name"] == "João Araújo"  # acentos do cp1252 preservados
    assert preview["credentials"] == []
    before = (await client.get(f"{API}/technicians", headers=an)).json()
    assert "joao@campo.com" not in {t["email"] for t in before}  # prévia não grava

    done = (
        await client.post(
            f"{API}/technicians/import", params={"dry_run": False}, files=files, headers=an
        )
    ).json()
    assert [c["email"] for c in done["credentials"]] == ["joao@campo.com"]
    temp = done["credentials"][0]["temporary_password"]
    assert (await login(client, "joao@campo.com", temp))["status"] == 200
    techs = {t["email"]: t for t in (await client.get(f"{API}/technicians", headers=an)).json()}
    assert techs["tecnico@teste.com.br"]["name"] == "Técnico Atualizado"
    assert techs["tecnico@teste.com.br"]["team"]["name"] == "Redes"

    wb = Workbook()
    wb.active.append(["Nome completo", "EMAIL", "Celular"])
    wb.active.append(["Lia Souza", "lia@campo.com", 11977776666])  # número, como o Excel lê
    buf = io.BytesIO()
    wb.save(buf)
    xlsx = {"file": ("base.xlsx", buf.getvalue(), "application/octet-stream")}
    r = await client.post(
        f"{API}/technicians/import", params={"dry_run": False}, files=xlsx, headers=an
    )
    assert r.json()["created"] == 1
    assert r.json()["rows"][0]["phone"] == "11977776666"
