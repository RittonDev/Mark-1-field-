"""Homologação: link de convite, ficha pública do técnico e análise pela gestão.

As áreas de atuação e as aptidões da ficha são as dos catálogos de Configurações › Técnicos (os
iniciais vêm do `world`): a ficha nova manda os ids; `ficha()` manda os códigos e os nomes da ficha
de antes da Entrega 2, que continuam aceitos (trocados pelos ids no envio).
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from app.core.security import decode_token
from app.models import ServiceArea, Skill, TechnicianApplication
from app.schemas.onboarding import (
    AVAILABILITY,
    CODE_MAX,
    PRIVACY_VERSION,
    ApplicationIn,
)
from app.schemas.tech_profile import AREA_VALUE_MAX
from app.services import activities, onboarding, technician_catalogs
from tests.conftest import World, requires_db

pytestmark = requires_db

API = settings.API_PREFIX
PNG_1PX = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def ficha(**extra: object) -> dict:
    return {
        "full_name": "  Tecnico   Alfa da Silva ",
        "email": "Ficha.Tecnico@Exemplo.com",
        "phone": "(11) 98888-7777",
        "document": "111.444.777-35",
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
    token = await new_invite(client, world, label="Tecnico Alfa (indicação)")
    assert (await client.get(f"{API}/public/onboarding/{token}")).json()["valid"] is True
    catalog = (await client.get(f"{API}/public/onboarding/catalog")).json()
    # As listas vêm dos catálogos: a chave é o id.
    keys = {a["key"] for a in catalog["service_areas"]}
    assert {world.area_ids["cftv"], world.area_ids["impressoras"]} <= keys
    assert world.skill_ids["DVR/NVR Intelbras"] in {s["key"] for s in catalog["skills"]}

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
    # O token dos arquivos da ficha (2 h, só dela) vem na resposta.
    sent_at = datetime.now(UTC)
    upload = decode_token(r.json()["upload_token"], "ficha_upload")
    expires = datetime.fromisoformat(r.json()["upload_expires_at"])
    assert abs(expires - (sent_at + timedelta(hours=2))) < timedelta(minutes=1)
    assert upload["sub"].startswith("application:")

    # Link de uso único: depois de usado, não abre nem aceita outra ficha.
    assert (await client.get(f"{API}/public/onboarding/{token}")).json()["valid"] is False
    assert (await client.post(f"{API}/public/onboarding/{token}", json=ficha())).status_code == 410

    # Mesmo e-mail com ficha pendente, por outro link: recusado.
    other = await new_invite(client, world, reusable=True, days_valid=30)
    dup = await client.post(
        f"{API}/public/onboarding/{other}", json=ficha(email="ficha.tecnico@exemplo.com")
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
    assert upload["sub"] == f"application:{app_id}"
    assert (
        await client.get(f"{API}/onboarding/applications/pending-count", headers=an)
    ).json() == {"pending": 1}
    detail = (await client.get(f"{API}/onboarding/applications/{app_id}", headers=an)).json()
    assert detail["full_name"] == "Tecnico Alfa da Silva"
    assert (detail["email"], detail["state"], detail["document"]) == (
        "ficha.tecnico@exemplo.com",
        "SP",
        "11144477735",
    )
    assert detail["invite_label"] == "Tecnico Alfa (indicação)"
    # A ficha guarda a versão do aviso que o formulário mostrou.
    assert detail["privacy_version"] == catalog["privacy_version"] == PRIVACY_VERSION
    # Da senha, só se ela existe (o hash nunca sai).
    assert {key for key in detail if "password" in key} == {"has_password"}
    assert detail["has_password"] is True and "$2" not in str(detail)
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
    technician = r.json()["technician"]
    assert (technician["role"], technician["team"]["name"]) == ("technician", "Campo")
    # Sem envio de e-mail configurado, a boas-vindas entra na fila e vence sem sair.
    assert r.json()["welcome"] == {"status": "not_configured", "to": "ficha.tecnico@exemplo.com"}
    login = await client.post(
        f"{API}/auth/login",
        json={
            "email": "ficha.tecnico@exemplo.com",
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


async def test_approval_prefills_the_tech_profile(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Aprovada, a ficha já entra no perfil técnico (disponibilidade, transporte e CNH, aptidões e
    áreas de atuação, pelos ids do catálogo), marcada "ficha" com a data da ficha. O histórico do
    cadastro começa com a aprovação (via ficha, por quem aprovou). Ferramentas e certificações são
    texto livre e ficam só na ficha."""
    an = world.analyst.headers
    token = await new_invite(client, world)
    body = ficha(
        full_name="Tecnico Alfa",
        email="tecnico.alfa@exemplo.com",
        document="123.456.789-09",
        has_driver_license=True,
        tools="Multímetro e escada",
        photo=None,
    )
    r = await client.post(f"{API}/public/onboarding/{token}", json=body)
    assert r.status_code == 201, r.text
    protocol = r.json()["protocol"]
    [pending] = (await client.get(f"{API}/onboarding/applications", headers=an)).json()
    r = await client.post(
        f"{API}/onboarding/applications/{pending['id']}/approve", json={}, headers=an
    )
    assert r.status_code == 200, r.text
    technician_id = r.json()["technician"]["id"]
    async with engine.connect() as conn:
        created = await conn.scalar(
            text("SELECT created_at FROM technician_applications WHERE id = :i"),
            {"i": pending["id"]},
        )

    login = await client.post(
        f"{API}/auth/login",
        json={
            "email": "tecnico.alfa@exemplo.com",
            "password": "minha-senha-forte",
            "channel": "mobile",
        },
    )
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    me = (await client.get(f"{API}/me/profile", headers=headers)).json()
    # Dias úteis de manhã e o sábado (manhã, tarde e noite): 8 turnos, na ordem da grade.
    workdays = ("mon", "tue", "wed", "thu", "fri")
    assert me["availability"] == [f"{day}:morning" for day in workdays] + [
        "sat:morning",
        "sat:afternoon",
        "sat:evening",
    ]
    assert me["transport"] == {"modes": ["motorcycle"], "driver_license": True}
    since = created.astimezone(ZoneInfo(settings.TIMEZONE)).date().isoformat()
    dvr = world.skill_ids["DVR/NVR Intelbras"]
    assert me["skills"] == [
        {"skill_id": dvr, "name": "DVR/NVR Intelbras", "level": "avancado", "since": since}
    ]
    # Os códigos da ficha de antes viraram os ids (CFTV e câmeras IP, Redes e cabeamento).
    assert me["area_ids"] == [world.area_ids["cftv"], world.area_ids["redes"]]
    assert (me["tool_ids"], me["education"]) == ([], [])
    stamps = me["tech_profile_updated"]
    assert (stamps["tools"], stamps["education"]) == (None, None)
    for part in ("availability", "transport", "skills", "areas"):
        assert stamps[part]["via"] == "ficha", part
        assert datetime.fromisoformat(stamps[part]["at"]) == created, part
    async with engine.connect() as conn:
        stored = (
            await conn.execute(
                text("SELECT service_areas, skills FROM users WHERE id = :i"), {"i": technician_id}
            )
        ).one()
    assert sorted(stored.service_areas) == sorted([world.area_ids["cftv"], world.area_ids["redes"]])
    assert stored.skills == [{"skill_id": dvr, "level": "avancado", "since": since}]

    history = await client.get(f"{API}/technicians/{technician_id}/changes", headers=an)
    assert history.status_code == 200, history.text
    [line] = history.json()
    assert (line["via"], line["actor"]["id"], line["note"]) == (
        "ficha",
        str(world.analyst.user.id),
        None,
    )
    assert line["changes"] == [
        {"field": "application", "from": None, "to": f"Aprovado na homologação ({protocol})"}
    ]


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


async def test_long_codes_are_refused_without_echo(client: AsyncClient, world: World) -> None:
    """Código enorme nas áreas ou na disponibilidade da ficha pública: 422 sem o valor na resposta
    e o link não é gasto. A disponibilidade desconhecida curta continua dizendo qual é; a área
    desconhecida não ecoa nada (o id do catálogo ou o código antigo: "Área não encontrada")."""
    codes = [code for code, _ in technician_catalogs.DEFAULT_AREAS]
    assert max(len(code) for code in AVAILABILITY) <= CODE_MAX
    assert max(len(code) for code in codes) <= AREA_VALUE_MAX
    assert len(str(uuid.uuid4())) <= AREA_VALUE_MAX
    token = await new_invite(client, world)
    url = f"{API}/public/onboarding/{token}"
    for field, limit in (("service_areas", AREA_VALUE_MAX), ("availability", CODE_MAX)):
        r = await client.post(url, json=ficha(photo=None, **{field: ["x" * 200]}))
        assert r.status_code == 422, r.text
        assert "x" * (limit + 1) not in r.text
        [issue] = r.json()["detail"]
        assert (issue["loc"], issue["msg"]) == (["body", field, 0], f"No máximo {limit} caracteres")
    r = await client.post(url, json=ficha(photo=None, availability=["madrugada"]))
    assert r.status_code == 422
    assert r.json()["detail"][0]["msg"] == "Disponibilidade desconhecida: madrugada"
    r = await client.post(url, json=ficha(photo=None, service_areas=["madrugada"]))
    assert (r.status_code, r.json()) == (
        422,
        {"detail": "Área não encontrada. Atualize a lista", "code": "AREA_NOT_FOUND"},
    )
    assert (await client.get(url)).json()["valid"] is True


async def test_ficha_areas_and_skills_come_from_the_catalog(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """A ficha nova manda os ids; a de antes, os códigos e os nomes (sem acento e sem maiúsculas
    casam). A ficha guarda os ids (áreas) e {skill_id, level} (aptidões), marca o 1º uso e a
    Homologação mostra os nomes atuais, também dos desativados depois."""
    an = world.analyst.headers
    token = await new_invite(client, world, reusable=True, days_valid=30)
    url = f"{API}/public/onboarding/{token}"
    areas, skills = world.area_ids, world.skill_ids
    linux, rack = skills["Linux"], skills["Montagem de rack"]

    # A ficha nova: ids do catálogo (repetida conta uma vez).
    body = ficha(
        email="nova@exemplo.com",
        document="123.456.789-09",
        photo=None,
        service_areas=[areas["redes"], areas["wifi"], areas["redes"]],
        skills=[{"skill_id": linux, "level": "avancado"}, {"skill_id": rack, "level": "basico"}],
    )
    r = await client.post(url, json=body)
    assert r.status_code == 201, r.text
    # A de antes: códigos e nomes (em outra grafia).
    old = ficha(
        email="antiga@exemplo.com",
        photo=None,
        service_areas=["CFTV", "seguranca"],
        skills=[{"name": " câmeras hikvision ", "level": "intermediario"}],
    )
    r = await client.post(url, json=old)
    assert r.status_code == 201, r.text

    async with engine.connect() as conn:
        rows = {
            email: (sorted(areas_), skills_)
            for email, areas_, skills_ in await conn.execute(
                select(
                    TechnicianApplication.email,
                    TechnicianApplication.service_areas,
                    TechnicianApplication.skills,
                )
            )
        }
    assert rows["nova@exemplo.com"] == (
        sorted([areas["redes"], areas["wifi"]]),
        [{"skill_id": linux, "level": "avancado"}, {"skill_id": rack, "level": "basico"}],
    )
    assert rows["antiga@exemplo.com"] == (
        sorted([areas["cftv"], areas["seguranca"]]),
        [{"skill_id": skills["Câmeras Hikvision"], "level": "intermediario"}],
    )
    # O 1º uso ficou marcado (agora só desativa).
    async with engine.connect() as conn:
        used_areas = set(
            await conn.scalars(select(ServiceArea.code).where(ServiceArea.used_at.is_not(None)))
        )
        used_skills = set(await conn.scalars(select(Skill.name).where(Skill.used_at.is_not(None))))
    assert used_areas == {"redes", "wifi", "cftv", "seguranca"}
    assert used_skills == {"Linux", "Montagem de rack", "Câmeras Hikvision"}

    # Homologação: as áreas e as aptidões pelo nome atual, em ordem alfabética; renomeada sai com
    # o nome novo; desativada continua (é o que o candidato escolheu).
    sup = world.supervisor.headers
    r = await client.patch(
        f"{API}/technician-areas/{areas['wifi']}", json={"name": "Wi-Fi corporativo"}, headers=sup
    )
    assert r.status_code == 200, r.text
    await client.patch(f"{API}/technician-skills/{rack}", json={"is_active": False}, headers=sup)
    listed = {a["email"]: a for a in (await client.get(f"{API}/onboarding/applications", headers=an)).json()}
    new = listed["nova@exemplo.com"]
    assert new["areas"] == [
        {"id": areas["redes"], "name": "Redes e cabeamento estruturado"},
        {"id": areas["wifi"], "name": "Wi-Fi corporativo"},
    ]
    assert sorted(new["service_areas"]) == sorted([areas["redes"], areas["wifi"]])
    detail = (await client.get(f"{API}/onboarding/applications/{new['id']}", headers=an)).json()
    assert detail["areas"] == new["areas"]
    assert detail["skills"] == [
        {"skill_id": linux, "name": "Linux", "level": "avancado"},
        {"skill_id": rack, "name": "Montagem de rack", "level": "basico"},
    ]
    assert detail["documents"] == []


async def test_ficha_catalog_rules(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    """Área desconhecida ou desativada, aptidão desconhecida, fora do catálogo ou repetida e a
    ficha sem área (com o catálogo tendo alguma ativa) são recusadas, sem gastar o link; com o
    catálogo de áreas todo desativado, a ficha vai sem área."""
    token = await new_invite(client, world)
    url = f"{API}/public/onboarding/{token}"
    areas, skills = world.area_ids, world.skill_ids
    sup = world.supervisor.headers
    await client.patch(f"{API}/technician-areas/{areas['energia']}", json={"is_active": False}, headers=sup)
    linux = {"skill_id": skills["Linux"], "level": "basico"}

    def coded(detail: str, code: str) -> dict:
        return {"detail": detail, "code": code}

    not_found = coded("Área não encontrada. Atualize a lista", "AREA_NOT_FOUND")
    cases: list[tuple[dict, dict]] = [
        ({"service_areas": [str(uuid.uuid4())]}, not_found),
        ({"service_areas": [areas["energia"]]}, not_found),  # desativada: a lista está velha
        ({"service_areas": ["energia"]}, not_found),
        ({"service_areas": []}, coded("Escolha pelo menos uma área de atuação", "AREA_REQUIRED")),
        (
            {"skills": [{"skill_id": str(uuid.uuid4()), "level": "basico"}]},
            coded("Aptidão não encontrada. Atualize a lista", "SKILL_NOT_FOUND"),
        ),
        (
            {"skills": [{"name": "Solda Exemplo", "level": "basico"}]},
            coded(
                "Atualize o app: as aptidões agora são escolhidas numa lista", "SKILL_UNKNOWN_NAME"
            ),
        ),
        (
            {"skills": [linux, {"name": "LINUX", "level": "avancado"}]},
            coded("Aptidão repetida: Linux", "SKILL_REPEATED"),
        ),
    ]
    for extra, expected in cases:
        r = await client.post(url, json=ficha(photo=None, **extra))
        assert (r.status_code, r.json()) == (422, expected), extra
    # O formato da aptidão: o id ou o nome, um só; nada a mais.
    for skill, message in (
        ({**linux, "name": "Linux"}, "Escolha a aptidão"),
        ({"level": "basico"}, "Escolha a aptidão"),
        ({**linux, "since": "2026-01-01"}, "Campo não aceito"),
    ):
        r = await client.post(url, json=ficha(photo=None, skills=[skill]))
        assert r.status_code == 422 and r.json()["detail"][0]["msg"] == message, skill
    r = await client.post(url, json=ficha(photo=None, service_areas=list(areas.values()) * 3))
    assert r.status_code == 422 and r.json()["detail"][0]["msg"] == "No máximo 20 itens"
    assert (await client.get(url)).json()["valid"] is True

    # Sem área ativa no catálogo, a ficha vai sem área.
    async with engine.begin() as conn:
        await conn.execute(update(ServiceArea).values(is_active=False))
    r = await client.post(url, json=ficha(photo=None, service_areas=[]))
    assert r.status_code == 201, r.text
    async with engine.connect() as conn:
        stored = await conn.scalar(select(TechnicianApplication.service_areas))
    assert stored == []


async def test_company_email_is_refused_on_the_form(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """E-mail do domínio da empresa (login Microsoft) não vira login de técnico: travaria o login
    da pessoa contratada com ele."""
    monkeypatch.setattr(settings, "ENTRA_ALLOWED_DOMAINS", "empresa.exemplo.com")
    token = await new_invite(client, world)
    url = f"{API}/public/onboarding/{token}"
    r = await client.post(url, json=ficha(email="Candidato@Empresa.Exemplo.com", photo=None))
    assert r.status_code == 422 and r.json()["detail"] == onboarding.COMPANY_EMAIL
    # O link de uso único não foi gasto.
    assert (await client.get(url)).json()["valid"] is True
    r = await client.post(url, json=ficha(email="candidato@exemplo.com", photo=None))
    assert r.status_code == 201, r.text


def test_age_counts_on_the_operation_day(monkeypatch: pytest.MonkeyPatch) -> None:
    """A idade conta no dia da operação (Brasília), não no dia UTC do servidor: entre 21h e 24h o
    UTC já é o dia seguinte e o técnico que faz 18 anos amanhã passava."""
    monkeypatch.setattr(activities, "local_today", lambda: date(2030, 1, 10))
    ok = ApplicationIn.model_validate(ficha(birth_date="2012-01-10"))  # 18 anos hoje
    assert ok.birth_date == date(2012, 1, 10)
    with pytest.raises(ValidationError, match="maiores de 18 anos"):
        ApplicationIn.model_validate(ficha(birth_date="2012-01-11"))  # faz 18 amanhã
