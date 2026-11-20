from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

# hide_parameters: o erro do banco (e o DB_ECHO) mostra o SQL sem os valores, que levam dados
# pessoais (nome, contato, formação, chave PIX) para o log.
engine = create_async_engine(
    settings.DATABASE_URL, echo=settings.DB_ECHO, pool_pre_ping=True, hide_parameters=True
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
