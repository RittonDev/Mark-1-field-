"""Fixtures dos testes de integração (PostgreSQL real).

Os testes de API rodam só com TEST_DATABASE_URL definido (o docker-compose já define,
apontando para o banco `chamados_test`). Os testes unitários rodam sem banco.
"""

import asyncio
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

import app.models  # noqa: F401
from app.core.enums import UserRole
from app.core.security import create_access_token, hash_password
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import Customer, Location, Team, User

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

requires_db = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL não definido")


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
    tech: Actor  # grupo campo
    tech_other: Actor  # grupo redes
    requester: Actor
    team_field_id: str
    team_net_id: str
    customer_id: str
    location_id: str


@pytest.fixture
async def world(engine: AsyncEngine) -> World:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
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
            "tech": mk("Tecnico", UserRole.ANALYST, field),
            "tech_other": mk("Redes", UserRole.ANALYST, net),
            "requester": mk("Cliente", UserRole.REQUESTER, None),
        }
        db.add_all(users.values())
        customer = Customer(name="Cliente Teste", is_active=True)
        db.add(customer)
        await db.flush()
        location = Location(customer_id=customer.id, name="Matriz", is_active=True)
        db.add(location)
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
    )
