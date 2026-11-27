"""Perfil profissional pela central: PATCH /technicians/{id} (Técnicos em Editar) com as partes do
perfil técnico (Ferramental, Dias e horários com a indisponibilidade, Transporte com o veículo,
Formação, Aptidões e Áreas de atuação), as regras e as mensagens do app, o carimbo "central" por
parte, o histórico via central, o 1º uso dos itens do catálogo, a trava do técnico (a mesma do app)
e o me.profile_changed só para o técnico (o app relê o cadastro). E o que a ficha e a lista da
central leem: area_ids, areas só no detalhe, certification_due e a média das avaliações.

Dados fictícios (Tecnico Alfa, Escola Exemplo, Loja Exemplo, Cidade Exemplo, @exemplo.com).
"""

import asyncio
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import RatingSource, TechDocumentKind, TicketStatus, UserRole
from app.models import (
    Location,
    ServiceArea,
    Skill,
    TechnicianDocument,
    TechnicianRating,
    TechnicianTool,
    Ticket,
    User,
)
from app.schemas import personal
from app.services import my_profile, realtime, tech_profile, technicians, user_history
from tests.conftest import World, requires_db
from tests.test_access import restrict_analyst

pytestmark = requires_db

API = settings.API_PREFIX
COURSE: dict[str, Any] = {
    "course": "Técnico em redes",
    "level": "technical",
    "institution": "Escola Exemplo",
    "start": "2024-02",
    "end": None,
}


async def _patch(
    client: AsyncClient, world: World, headers: dict[str, str] | None = None, **body: Any
) -> Response:
    """O PATCH da ficha (por padrão, o analista: Técnicos em Editar)."""
    return await client.patch(
        f"{API}/technicians/{world.tech.user.id}",
        json=body,
        headers=headers or world.analyst.headers,
    )


async def _stored(engine: AsyncEngine, world: World) -> User:
    """O técnico relido do banco, numa sessão nova."""
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        return user


async def _history(client: AsyncClient, world: World) -> list[dict[str, Any]]:
    """O histórico do cadastro como a central lê (o mais novo primeiro)."""
    r = await client.get(
        f"{API}/technicians/{world.tech.user.id}/changes", headers=world.supervisor.headers
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _new_tools(engine: AsyncEngine, *names: str) -> list[str]:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        tools = [TechnicianTool(name=name) for name in names]
        db.add_all(tools)
        await db.commit()
        return [str(tool.id) for tool in tools]


async def _set_user(engine: AsyncEngine, user_id: uuid.UUID, **values: Any) -> None:
    async with engine.begin() as conn:
        await conn.execute(update(User).where(User.id == user_id).values(**values))


async def _deactivate(engine: AsyncEngine, model: Any, item_id: str) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            update(model).where(model.id == uuid.UUID(item_id)).values(is_active=False)
        )


def _capture(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Todos os eventos publicados, inteiros, na ordem."""
    published: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", capture)
    return published


def _types(events: list[dict[str, Any]]) -> list[str]:
    return [event["type"] for event in events]


async def _used(engine: AsyncEngine, model: Any, ids: list[str]) -> list[bool]:
    """Se cada item já tem o 1º uso gravado (used_at)."""
    async with engine.connect() as conn:
        rows = dict(
            (
                await conn.execute(
                    select(model.id, model.used_at).where(
                        model.id.in_([uuid.UUID(i) for i in ids])
                    )
                )
            ).all()
        )
    return [rows[uuid.UUID(i)] is not None for i in ids]


# ------------------------------------------------------------------ as partes, relidas


async def test_central_edits_each_part_and_rereads_the_columns(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Cada seção da ficha manda só a sua parte: a resposta (o detalhe) volta normalizada com o
    carimbo "central", o banco guardou cada coluna, o histórico tem uma linha por seção (via
    central, quem fez) e os itens do catálogo ganham o 1º uso. A lista traz as áreas sem os nomes."""
    trena, escada = await _new_tools(engine, "Trena", "Escada")
    linux, cameras = world.skill_ids["Linux"], world.skill_ids["Câmeras Hikvision"]
    redes, wifi = world.area_ids["redes"], world.area_ids["wifi"]
    today = personal.local_today()
    start, end = today + timedelta(days=5), today + timedelta(days=9)
    sections: list[tuple[str, dict[str, Any]]] = [
        ("tools", {"tool_ids": [trena, escada, trena]}),
        (
            "availability",
            {
                "availability": ["sat:afternoon", "mon:morning"],
                "unavailability": [{"start": start.isoformat(), "end": end.isoformat()}],
            },
        ),
        (
            "transport",
            {
                "transport": {"modes": ["motorcycle", "car"], "driver_license": True},
                "vehicle_model": "  Modelo   Exemplo ",
                "vehicle_plate": "abc-1d23",
            },
        ),
        ("education", {"education": [COURSE]}),
        (
            "skills",
            {
                "skills": [
                    {"skill_id": linux, "level": "basico"},
                    {"skill_id": cameras, "level": "avancado"},
                ]
            },
        ),
        ("areas", {"area_ids": [wifi, redes, wifi]}),
    ]
    for part, body in sections:
        r = await _patch(client, world, **body)
        assert r.status_code == 200, (part, r.text)
        stamp = r.json()["tech_profile_updated"][part]
        assert stamp is not None and stamp["via"] == "central", part
    one = r.json()
    day = today.isoformat()
    assert one["tool_ids"] == [escada, trena]
    assert [tool["name"] for tool in one["tools"]] == ["Escada", "Trena"]
    assert one["availability"] == ["mon:morning", "sat:afternoon"]
    [period] = one["unavailability"]
    assert (period["start"], period["end"]) == (start.isoformat(), end.isoformat())
    assert one["transport"] == {"modes": ["car", "motorcycle"], "driver_license": True}
    assert (one["vehicle_model"], one["vehicle_plate"]) == ("Modelo Exemplo", "ABC1D23")
    assert [course["course"] for course in one["education"]] == ["Técnico em redes"]
    assert one["skills"] == [
        {"skill_id": cameras, "name": "Câmeras Hikvision", "level": "avancado", "since": day},
        {"skill_id": linux, "name": "Linux", "level": "basico", "since": day},
    ]
    assert one["area_ids"] == [redes, wifi]
    assert one["areas"] == [
        {"id": redes, "name": "Redes e cabeamento estruturado"},
        {"id": wifi, "name": "Wi-Fi e access points"},
    ]
    assert "service_areas" not in one

    # Relido do banco, coluna a coluna.
    user = await _stored(engine, world)
    assert user.tool_ids == sorted([trena, escada])
    assert user.availability == ["mon:morning", "sat:afternoon"]
    assert [(p["start"], p["end"]) for p in user.unavailability] == [
        (start.isoformat(), end.isoformat())
    ]
    assert (user.transport_modes, user.has_driver_license) == (["car", "motorcycle"], True)
    assert (user.vehicle_model, user.vehicle_plate) == ("Modelo Exemplo", "ABC1D23")
    assert [course["course"] for course in user.education] == ["Técnico em redes"]
    assert user.skills == [
        {"skill_id": cameras, "level": "avancado", "since": day},
        {"skill_id": linux, "level": "basico", "since": day},
    ]
    assert user.service_areas == sorted([redes, wifi])
    stamps = {part: stamp["via"] for part, stamp in user.tech_profile_stamps.items()}
    assert stamps == dict.fromkeys(tech_profile.PARTS, "central")

    # Uma linha por seção, via central, com quem fez.
    rows = list(reversed(await _history(client, world)))
    assert [[c["field"] for c in row["changes"]] for row in rows] == [
        ["tools"],
        ["unavailability", "availability"],
        ["transport", "vehicle"],
        ["education"],
        ["skills"],
        ["areas"],
    ]
    assert {(row["via"], row["actor"]["name"]) for row in rows} == {("central", "Analista")}
    assert rows[4]["changes"][0]["to"] == "Câmeras Hikvision (Avançado), Linux (Básico)"
    assert rows[5]["changes"][0] == {
        "field": "areas",
        "from": None,
        "to": "Redes e cabeamento estruturado, Wi-Fi e access points",
    }

    # O 1º uso dos itens (excluir do catálogo passa a pedir desativar); o resto, não.
    assert await _used(engine, TechnicianTool, [trena, escada]) == [True, True]
    nobreaks = world.skill_ids["Nobreaks"]
    assert await _used(engine, Skill, [linux, cameras, nobreaks]) == [True, True, False]
    assert await _used(engine, ServiceArea, [redes, wifi, world.area_ids["cftv"]]) == [
        True,
        True,
        False,
    ]

    # A lista: as áreas sem os nomes (a web usa o catálogo).
    r = await client.get(f"{API}/technicians", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    row = next(t for t in r.json() if t["id"] == str(world.tech.user.id))
    assert (row["area_ids"], row["areas"]) == ([redes, wifi], None)
    assert row["skills"] == one["skills"] and "service_areas" not in row


async def test_same_body_again_changes_nothing(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O corpo de novo (reordenado, a aptidão pelo nome, a mesma placa escrita de outro jeito): 200
    sem histórico nem aviso, nem para a central nem para o técnico."""
    linux, redes = world.skill_ids["Linux"], world.area_ids["redes"]
    body = {
        "availability": ["sat:morning", "mon:morning"],
        "skills": [{"skill_id": linux, "level": "basico"}],
        "area_ids": [redes],
        "vehicle_plate": "ABC1234",
        "transport": {"modes": [], "driver_license": False},
    }
    assert (await _patch(client, world, **body)).status_code == 200
    rows = await _history(client, world)
    events = _capture(monkeypatch)
    again = {
        **body,
        "availability": ["mon:morning", "sat:morning"],
        "skills": [{"name": "LINUX", "level": "basico"}],
        "vehicle_plate": "abc-1234",
    }
    r = await _patch(client, world, **again)
    assert r.status_code == 200, r.text
    assert len(await _history(client, world)) == len(rows)
    assert events == []


# ------------------------------------------------------------------ o aviso para o app


async def test_central_edit_sends_me_profile_changed_only_to_the_technician(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A central mudou algo que o app mostra: a central recebe o profile.changed de sempre e o
    técnico, só ele, o me.profile_changed sem dados (o app relê GET /me/profile). Nada para o
    técnico pela situação, pelos favoritos, pelas avaliações, pelos anexos internos nem pelo que
    ele mesmo mudou no app."""
    tech_id = str(world.tech.user.id)
    events = _capture(monkeypatch)
    r = await _patch(client, world, availability=["sat:morning"])
    assert r.status_code == 200, r.text
    assert _types(events) == ["profile.changed", "me.profile_changed"]
    managers, mine = events
    assert managers["data"] == {"fields": ["availability"], "via": "central"}
    assert managers["audience"] == {"managers_only": True}
    assert set(mine) == {"type", "occurred_at", "data", "audience"}
    assert (mine["data"], mine["audience"]) == ({}, {"user_ids": [tech_id]})
    assert datetime.fromisoformat(mine["occurred_at"]).tzinfo is not None

    # Quem recebe: só o técnico (nem o colega, nem a central, nem o cliente).
    def delivered(user: User, role: UserRole) -> bool:
        return realtime.should_deliver(
            user_id=str(user.id), role=role, team_id=None, event=mine, access=None
        )

    assert delivered(world.tech.user, UserRole.TECHNICIAN)
    assert not delivered(world.tech_other.user, UserRole.TECHNICIAN)
    assert not delivered(world.analyst.user, UserRole.ANALYST)
    assert not delivered(world.admin.user, UserRole.ADMIN)
    assert not delivered(world.requester.user, UserRole.REQUESTER)
    # O que chega ao app: o tipo e quando (o resto do evento de OS vazio; nada de quem fez).
    public = {key: value for key, value in mine.items() if key != "audience"}
    sent = realtime.field_event(public)
    assert (sent["type"], sent["occurred_at"], sent["data"]) == (
        "me.profile_changed",
        mine["occurred_at"],
        {},
    )
    assert {key: value for key, value in sent.items() if value} == {
        "type": "me.profile_changed",
        "occurred_at": mine["occurred_at"],
    }

    # Situação na operação: só a central.
    events.clear()
    r = await client.post(
        f"{API}/technicians/{tech_id}/operational-status",
        json={"status": "inactive", "reason": "Férias de exemplo"},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    assert _types(events) == ["profile.changed"]

    # Favoritos: só a central.
    maker = async_sessionmaker(engine_of(client), expire_on_commit=False) if False else None
    assert maker is None
    events.clear()
    await _add_store(client, world)
    r = await client.put(
        f"{API}/technicians/favorites/{tech_id}",
        json={"state": "SP", "city": "Cidade Exemplo"},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    assert _types(events) == ["profile.changed"]
    assert events[0]["data"] == {"fields": ["favorites"], "via": "central"}

    # O que ele mesmo mudou no app: só a central.
    events.clear()
    r = await client.patch(
        f"{API}/me/profile", json={"availability": ["sun:night"]}, headers=world.tech.headers
    )
    assert r.status_code == 200, r.text
    assert _types(events) == ["profile.changed"]

    # Avaliações e anexos internos (gravados pelos serviços da gestão): só a central; os documentos
    # do técnico, também o app.
    user = world.tech.user
    for field, expected in (
        ("ratings", ["profile.changed"]),
        ("internal_attachments", ["profile.changed"]),
        ("favorites", ["profile.changed"]),
        ("operational_status", ["profile.changed"]),
        ("documents", ["profile.changed", "me.profile_changed"]),
    ):
        events.clear()
        change = [{"field": field, "from": None, "to": "texto de exemplo"}]
        await user_history.publish_changed(user, change, via="central", actor=world.analyst.user)
        assert _types(events) == expected, field
    # A aprovação da ficha e o link do e-mail também avisam o app; o app, nunca a si mesmo.
    for via, expected in (
        ("ficha", ["profile.changed", "me.profile_changed"]),
        ("link", ["profile.changed", "me.profile_changed"]),
        ("app", ["profile.changed"]),
    ):
        events.clear()
        change = [{"field": "email_verified", "from": "pendente", "to": "validado"}]
        await user_history.publish_changed(user, change, via=via, actor=user)
        assert _types(events) == expected, via
    hidden = {
        "operational_status",
        "is_active",
        "role",
        "password",
        "password_link",
        "application",
        "work_schedule",
        "services",
        "favorites",
        "ratings",
        "internal_attachments",
    }
    assert hidden.isdisjoint(user_history.APP_FIELDS)


def engine_of(_: AsyncClient) -> None:  # pragma: no cover - só para o tipo acima
    return None


async def _add_store(client: AsyncClient, world: World) -> None:
    """Uma loja em Cidade Exemplo-SP (os favoritos são por cidade de loja)."""
    r = await client.post(
        f"{API}/customers/{world.customer_id}/locations",
        json={"name": "Loja Exemplo", "city": "Cidade Exemplo", "state": "SP"},
        headers=world.admin.headers,
    )
    assert r.status_code in (200, 201), r.text


# ------------------------------------------------------------------ aptidões e mensagens


async def test_skill_since_is_kept_by_id(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Pela central também: o "desde" fica pelo id (outro nível), a nova ganha hoje, a desativada
    guardada fica (escondida) e a enviada é ignorada."""
    linux, printer = world.skill_ids["Linux"], world.skill_ids["Impressoras HP"]
    nobreaks = world.skill_ids["Nobreaks"]
    await _deactivate(engine, Skill, nobreaks)
    await _set_user(
        engine,
        world.tech.user.id,
        skills=[
            {"skill_id": linux, "level": "basico", "since": "2025-03-10"},
            {"skill_id": nobreaks, "level": "avancado", "since": "2024-01-02"},
        ],
    )
    today = personal.local_today().isoformat()
    r = await _patch(
        client,
        world,
        skills=[
            {"skill_id": linux, "level": "avancado"},
            {"skill_id": printer, "level": "basico"},
            {"skill_id": nobreaks, "level": "basico"},
        ],
    )
    assert r.status_code == 200, r.text
    assert r.json()["skills"] == [
        {"skill_id": printer, "name": "Impressoras HP", "level": "basico", "since": today},
        {"skill_id": linux, "name": "Linux", "level": "avancado", "since": "2025-03-10"},
    ]
    assert (await _stored(engine, world)).skills == [
        {"skill_id": printer, "level": "basico", "since": today},
        {"skill_id": linux, "level": "avancado", "since": "2025-03-10"},
        {"skill_id": nobreaks, "level": "avancado", "since": "2024-01-02"},
    ]
    [row] = await _history(client, world)
    assert (row["via"], row["changes"]) == (
        "central",
        [
            {
                "field": "skills",
                "from": "Linux (Básico)",
                "to": "Impressoras HP (Básico), Linux (Avançado)",
            }
        ],
    )


async def test_central_uses_the_app_messages(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """As recusas do app, iguais na central (sem gravar nada): área, aptidão e ferramenta fora do
    catálogo, aptidão repetida ou pelo nome desconhecido, limite de áreas, turno, transporte,
    placa, formação e os períodos de indisponibilidade."""
    linux = world.skill_ids["Linux"]
    today = personal.local_today()

    def day(offset: int) -> str:
        return (today + timedelta(days=offset)).isoformat()

    coded: list[tuple[dict[str, Any], dict[str, str]]] = [
        (
            {"area_ids": [str(uuid.uuid4())]},
            {"detail": "Área não encontrada. Atualize a lista", "code": "AREA_NOT_FOUND"},
        ),
        (
            {"skills": [{"skill_id": str(uuid.uuid4()), "level": "basico"}]},
            {"detail": "Aptidão não encontrada. Atualize a lista", "code": "SKILL_NOT_FOUND"},
        ),
        (
            {
                "skills": [
                    {"skill_id": linux, "level": "basico"},
                    {"name": " LINUX ", "level": "avancado"},
                ]
            },
            {"detail": "Aptidão repetida: Linux", "code": "SKILL_REPEATED"},
        ),
        (
            {"skills": [{"name": "Linux Debian", "level": "basico"}]},
            {
                "detail": "Atualize o app: as aptidões agora são escolhidas numa lista",
                "code": "SKILL_UNKNOWN_NAME",
            },
        ),
        ({"tool_ids": [str(uuid.uuid4())]}, {"detail": "Ferramenta não encontrada. Atualize a lista."}),
        (
            {"unavailability": [{"start": day(-3), "end": day(2)}]},
            {"detail": "O início não pode ser antes de hoje"},
        ),
        (
            {"unavailability": [{"start": day(5), "end": day(1)}]},
            {"detail": "O fim não pode ser antes do início"},
        ),
        (
            {
                "unavailability": [
                    {"start": day(1), "end": day(5)},
                    {"start": day(5), "end": day(8)},
                ]
            },
            {"detail": "Já há um período nessas datas"},
        ),
        (
            {"unavailability": [{"start": day(1), "end": day(400)}]},
            {"detail": "Até 365 dias a partir de hoje"},
        ),
    ]
    for body, expected in coded:
        r = await _patch(client, world, **body)
        assert (r.status_code, r.json()) == (422, expected), body

    labeled: list[tuple[dict[str, Any], tuple[str, str]]] = [
        ({"availability": ["sat:lunch"]}, ("Disponibilidade", "Turno desconhecido: sat:lunch")),
        ({"transport": None}, ("Transporte", "Informe os meios de transporte")),
        ({"vehicle_plate": "12"}, ("Placa", "Placa inválida: confira as letras e os números")),
        ({"vehicle_model": "x" * 61}, ("Modelo do veículo", "No máximo 60 caracteres")),
        ({"education": [{**COURSE, "course": "x"}]}, ("Curso", "Informe o curso")),
        ({"area_ids": ["redes"]}, ("Áreas de atuação", "Identificador inválido")),
        ({"skills": [{"skill_id": linux, "level": "expert"}]}, ("Nível", None)),
    ]
    for body, (label, message) in labeled:
        r = await _patch(client, world, **body)
        assert r.status_code == 422, (body, r.text)
        [issue] = r.json()["detail"]
        assert issue["label"] == label, body
        if message is not None:
            assert issue["msg"] == message, body

    # Limite: 21 áreas ativas (as 10 iniciais e 11 novas) não cabem.
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        extra = [ServiceArea(name=f"Área Exemplo {n:02d}") for n in range(11)]
        db.add_all(extra)
        await db.commit()
        everything = [str(area.id) for area in extra] + list(world.area_ids.values())
    r = await _patch(client, world, area_ids=everything)
    assert (r.status_code, r.json()) == (
        422,
        {"detail": "Até 20 áreas de atuação", "code": "AREAS_LIMIT"},
    )

    assert await _history(client, world) == []
    user = await _stored(engine, world)
    assert (user.tool_ids, user.skills, user.service_areas, user.unavailability) == ([], [], [], [])
    assert (user.vehicle_plate, user.tech_profile_stamps) == (None, {})


async def test_viewer_cannot_edit_the_profile(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Técnicos em Visualizar lê a ficha e não grava o perfil profissional (403); o técnico não
    entra na ficha da central."""
    await restrict_analyst(client, world, **{"base.technicians": "view"})
    r = await _patch(client, world, availability=["sat:morning"])
    assert r.status_code == 403, r.text
    assert r.json()["code"] == "MODULE_FORBIDDEN"
    r = await client.get(f"{API}/technicians/{world.tech.user.id}", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    r = await _patch(client, world, world.tech.headers, availability=["sat:morning"])
    assert r.status_code == 403
    assert await _history(client, world) == []
    assert (await _stored(engine, world)).availability == []


# ------------------------------------------------------------------ a trava


async def _until_blocked_by(engine: AsyncEngine, pid: int) -> None:
    """Espera (até 10 s) alguma sessão parar numa trava da sessão `pid`."""
    deadline = time.monotonic() + 10
    async with engine.connect() as conn:
        while True:
            waiting = await conn.scalar(
                text("SELECT count(*) FROM pg_stat_activity WHERE :pid = ANY(pg_blocking_pids(pid))"),
                {"pid": pid},
            )
            await conn.rollback()  # o pg_stat_activity fica fixo dentro de uma transação
            if waiting:
                return
            assert time.monotonic() < deadline, "a central não chegou a esperar o técnico"
            await asyncio.sleep(0.02)


async def test_central_and_app_writes_take_turns(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """A central e o app mexem na mesma parte ao mesmo tempo: a central espera a trava do técnico
    (a mesma do app), relê o que o app gravou e compara com isso; o histórico fecha com o valor
    final e o carimbo é de quem gravou por último."""
    assert my_profile.lock is technicians.lock_technician
    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    async with maker() as other:
        pid = int(await other.scalar(text("SELECT pg_backend_pid()")) or 0)
        me = await other.get(User, world.tech.user.id)
        assert me is not None
        await my_profile.lock(other, me)  # o app gravando
        task = asyncio.create_task(_patch(client, world, availability=["sat:morning"]))
        try:
            await _until_blocked_by(engine, pid)
            before = await user_history.snapshot(other, me)
            tech_profile.apply(me, {"availability": ["mon:morning"]}, via="app", at=datetime.now(UTC))
            await user_history.track(other, me, before, via="app", actor=me)
            await other.commit()
        finally:
            await other.rollback()
            r = await asyncio.wait_for(task, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json()["availability"] == ["sat:morning"]
    user = await _stored(engine, world)
    assert user.availability == ["sat:morning"]
    assert user.tech_profile_stamps["availability"]["via"] == "central"
    rows = await _history(client, world)
    assert [(row["via"], row["changes"]) for row in rows] == [
        ("central", [{"field": "availability", "from": "seg · manhã", "to": "sáb · manhã"}]),
        ("app", [{"field": "availability", "from": None, "to": "seg · manhã"}]),
    ]


# ------------------------------------------------------------------ o que a central lê


async def test_technician_out_brings_areas_certification_and_ratings(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """Lista e detalhe: `area_ids` (ativas, na ordem do nome), `areas` só no detalhe, as aptidões
    com o id, a certificação vencendo mais urgente com quantas e a média das avaliações (1 casa)
    com quantas; sem nada disso, null/0. Sai `service_areas`."""
    tech, other = world.tech.user.id, world.tech_other.user.id
    redes, cftv = world.area_ids["redes"], world.area_ids["cftv"]
    await _deactivate(engine, ServiceArea, cftv)
    await _set_user(engine, tech, service_areas=[cftv, redes])
    today = personal.local_today()
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:

        def certification(title: str, expires_on: Any) -> TechnicianDocument:
            return TechnicianDocument(
                user_id=tech,
                kind=TechDocumentKind.CERTIFICATION,
                title=title,
                expires_on=expires_on,
                file_name="certificado.pdf",
                content_type="application/pdf",
                size_bytes=1024,
                storage_key=f"documents/{tech}/{uuid.uuid4().hex}.pdf",
                uploaded_via="app",
            )

        expired = certification("NR10 Exemplo", today - timedelta(days=1))
        soon = certification("NR35 Exemplo", today + timedelta(days=10))
        later = certification("NR33 Exemplo", today + timedelta(days=90))
        db.add_all([expired, soon, later])
        location = await db.get(Location, uuid.UUID(world.location_id))
        assert location is not None
        tickets = [
            Ticket(
                title="Visita de exemplo",
                status=TicketStatus.CLOSED,
                customer_id=uuid.UUID(world.customer_id),
                location_id=location.id,
                assignee_id=tech,
            )
            for _ in range(4)
        ]
        db.add_all(tickets)
        await db.flush()
        db.add_all(
            TechnicianRating(
                ticket_id=ticket.id,
                technician_id=tech,
                score=score,
                source=RatingSource.CENTRAL,
                created_by_id=world.analyst.user.id,
            )
            for ticket, score in zip(tickets, (4, 5, 4, 4), strict=True)
        )
        await db.commit()

    r = await client.get(f"{API}/technicians", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    rows = {row["id"]: row for row in r.json()}
    mine, theirs = rows[str(tech)], rows[str(other)]
    assert (mine["area_ids"], mine["areas"]) == ([redes], None)
    assert mine["certification_due"] == {
        "document_id": str(expired.id),
        "title": "NR10 Exemplo",
        "expires_on": (today - timedelta(days=1)).isoformat(),
        "count": 2,
    }
    assert (mine["rating_average"], mine["rating_count"]) == (4.3, 4)
    assert (theirs["area_ids"], theirs["certification_due"]) == ([], None)
    assert (theirs["rating_average"], theirs["rating_count"]) == (None, 0)
    assert "service_areas" not in mine

    r = await client.get(f"{API}/technicians/{tech}", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    one = r.json()
    assert one["areas"] == [{"id": redes, "name": "Redes e cabeamento estruturado"}]
    assert one["certification_due"] == mine["certification_due"]
    assert (one["rating_average"], one["rating_count"]) == (4.3, 4)
    # A desativada continua guardada (volta quando a central reativa).
    assert set((await _stored(engine, world)).service_areas) == {redes, cftv}
