"""Fixtures dos testes de integração (PostgreSQL real).

Os testes de API rodam só com TEST_DATABASE_URL definido (o docker-compose já define,
apontando para o banco `chamados_test`). Os testes unitários rodam sem banco.

E-mail: nenhum teste fala com a rede. Por padrão (`_mail_off`) o envio está desligado: a fila
recebe as linhas como "not_configured" e nada sai. Com a fixture `mail_box` o envio fica ligado num
provedor de mentira: `mail_box.soon` guarda os ids que as rotas mandaram para `mail.deliver_soon`
e, depois de `await mail.deliver_pending(session)`, `mail_box.messages` tem as mensagens
(`mail_box.texts()`, `mail_box.tokens()` para pegar o token do link).

Catálogos de Configurações › Técnicos: o banco dos testes nasce dos modelos (sem a migração que
grava as áreas e as aptidões iniciais). O `world` grava os de `technician_catalogs.seed_defaults` e
expõe `world.area_ids` (código antigo → id: "redes") e `world.skill_ids` (nome → id: "Linux"); o
teste sem `world` (a ficha pública) chama `seed_catalogs(session)`. O Ferramental começa vazio.
"""

import asyncio
import os
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from email.message import EmailMessage

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import make_url, select, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

import app.models  # noqa: F401
from app.core.config import settings
from app.core.enums import UserRole
from app.core.security import create_access_token, hash_password
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import Customer, Location, ServiceArea, Skill, Team, User
from app.services import login_guard, mail, technician_catalogs

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

requires_db = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL não definido")

# O token no fragmento dos links dos e-mails (…/validar-email#token=… e …/definir-senha#token=…).
_LINK_TOKEN = re.compile(r"#token=([A-Za-z0-9_-]+)")


@pytest.fixture(autouse=True)
def _fresh_login_guard() -> None:
    """Cada teste começa sem senhas erradas contadas (o controle de login fica na memória)."""
    login_guard.reset_memory()


@pytest.fixture(autouse=True)
def _mail_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """Envio de e-mail desligado em todo teste (settings.mail_enabled falso, a fila fica
    "not_configured" e nada sai). A fixture `mail_box` liga num provedor de mentira."""
    monkeypatch.setattr(settings, "SMTP_HOST", None)
    monkeypatch.setattr(mail, "get_provider", lambda: mail.DisabledProvider())


class FakeProvider:
    """Provedor de e-mail de mentira: guarda as mensagens. `fail` faz o próximo envio falhar com
    esse erro (mail.MailError(..., permanent=...)) e volta a None."""

    configured = True

    def __init__(self) -> None:
        self.messages: list[EmailMessage] = []
        self.fail: Exception | None = None

    async def send(self, message: EmailMessage) -> None:
        if self.fail is not None:
            error, self.fail = self.fail, None
            raise error
        self.messages.append(message)


@dataclass
class MailBox:
    provider: FakeProvider
    # Os ids que as rotas mandaram para mail.deliver_soon (depois do commit).
    soon: list[uuid.UUID] = field(default_factory=list)

    @property
    def messages(self) -> list[EmailMessage]:
        return self.provider.messages

    def texts(self) -> list[str]:
        """O texto simples de cada mensagem, na ordem do envio."""
        out: list[str] = []
        for message in self.messages:
            part = message.get_body(preferencelist=("plain",))
            out.append(part.get_content() if part is not None else "")
        return out

    def tokens(self) -> list[str]:
        """Os tokens crus dos links (#token=...), na ordem do envio."""
        return [m.group(1) for body in self.texts() for m in _LINK_TOKEN.finditer(body)]


@pytest.fixture
def mail_box(monkeypatch: pytest.MonkeyPatch) -> MailBox:
    """Envio de e-mail ligado (settings.mail_enabled verdadeiro) num provedor de mentira
    (`mail_box.messages`), `mail.deliver_soon` gravado em `mail_box.soon` (nada sai sozinho: o teste
    chama `await mail.deliver_pending(session)`) e um remetente de exemplo."""
    provider = FakeProvider()
    box = MailBox(provider=provider)
    monkeypatch.setattr(settings, "SMTP_HOST", "smtp.exemplo.com")
    monkeypatch.setattr(settings, "MAIL_FROM", "nao-responda@exemplo.com")
    monkeypatch.setattr(mail, "get_provider", lambda: provider)
    monkeypatch.setattr(mail, "deliver_soon", lambda ids: box.soon.extend(ids))
    return box


async def _ensure_database(url: str) -> None:
    """Cria o banco de testes se ainda não existir (conectando no banco `postgres`)."""
    target = make_url(url)
    admin = create_async_engine(
        target.set(database="postgres"), poolclass=NullPool, isolation_level="AUTOCOMMIT"
    )
    async with admin.connect() as conn:
        exists = await conn.scalar(
            text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": target.database}
        )
        if not exists:
            await conn.execute(text(f'CREATE DATABASE "{target.database}"'))
    await admin.dispose()


@pytest.fixture(scope="session")
def _schema() -> None:
    async def setup() -> None:
        await _ensure_database(TEST_DATABASE_URL)  # type: ignore[arg-type]
        engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)  # type: ignore[arg-type]
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        await engine.dispose()

    asyncio.run(setup())


@pytest.fixture
async def engine(_schema: None) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)  # type: ignore[arg-type]
    yield eng
    tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
    async with eng.begin() as conn:
        await conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    await eng.dispose()


@pytest.fixture
async def client(engine: AsyncEngine) -> AsyncIterator[AsyncClient]:
    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)

    async def override() -> AsyncIterator:
        async with maker() as session:
            yield session

    app.dependency_overrides[get_db] = override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@dataclass
class Actor:
    user: User
    headers: dict[str, str]


@dataclass
class World:
    admin: Actor
    supervisor: Actor
    analyst: Actor  # gestão completa na web, sem grupo
    tech: Actor  # técnico de campo, grupo campo
    tech_other: Actor  # grupo redes
    requester: Actor
    team_field_id: str
    team_net_id: str
    customer_id: str
    location_id: str
    # Os catálogos iniciais (seed_catalogs): código antigo da área → id e nome da aptidão → id.
    area_ids: dict[str, str] = field(default_factory=dict)
    skill_ids: dict[str, str] = field(default_factory=dict)


async def seed_catalogs(db: AsyncSession) -> tuple[dict[str, str], dict[str, str]]:
    """As 10 áreas e as 16 aptidões iniciais (technician_catalogs.seed_defaults; quem chama faz o
    commit) e os ids: ({código antigo: id}, {nome: id})."""
    await technician_catalogs.seed_defaults(db)
    areas = await db.execute(
        select(ServiceArea.code, ServiceArea.id).where(ServiceArea.code.is_not(None))
    )
    skills = await db.execute(select(Skill.name, Skill.id))
    return (
        {str(code): str(area_id) for code, area_id in areas.all()},
        {str(name): str(skill_id) for name, skill_id in skills.all()},
    )


@pytest.fixture
async def world(engine: AsyncEngine) -> World:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        area_ids, skill_ids = await seed_catalogs(db)
        field = Team(name="Campo", is_active=True)
        net = Team(name="Redes", is_active=True)
        db.add_all([field, net])
        await db.flush()
        pw = hash_password("senha-teste-123")

        def mk(name: str, role: UserRole, team: Team | None) -> User:
            return User(
                name=name,
                email=f"{name.lower()}@teste.com.br",
                password_hash=pw,
                role=role,
                team_id=team.id if team else None,
                is_active=True,
            )

        users = {
            "admin": mk("Admin", UserRole.ADMIN, None),
            "supervisor": mk("Super", UserRole.SUPERVISOR, None),
            "analyst": mk("Analista", UserRole.ANALYST, None),
            "tech": mk("Tecnico", UserRole.TECHNICIAN, field),
            "tech_other": mk("Redes", UserRole.TECHNICIAN, net),
            "requester": mk("Cliente", UserRole.REQUESTER, None),
        }
        db.add_all(users.values())
        customer = Customer(name="Cliente Teste", is_active=True)
        db.add(customer)
        await db.flush()
        location = Location(customer_id=customer.id, name="Matriz", is_active=True)
        db.add(location)
        # O usuário do cliente fica ligado à empresa (portal: solicitações de todas as lojas).
        users["requester"].customer_id = customer.id
        await db.commit()

    def actor(u: User) -> Actor:
        token = create_access_token(str(u.id), u.role.value)
        return Actor(user=u, headers={"Authorization": f"Bearer {token}"})

    return World(
        **{k: actor(u) for k, u in users.items()},
        team_field_id=str(field.id),
        team_net_id=str(net.id),
        customer_id=str(customer.id),
        location_id=str(location.id),
        area_ids=area_ids,
        skill_ids=skill_ids,
    )
