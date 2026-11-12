import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.exc import StaleDataError

from app.api.router import api_router
from app.core.config import settings
from app.db.session import SessionLocal
from app.services.errors import (
    DomainError,
    NotFound,
    PermissionDenied,
    VersionConflict,
    WorkflowError,
)
from app.services.realtime import bus, commit_and_publish, manager
from app.services.tickets import auto_close_resolved
from app.services.tracking import purge_old_pings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("maxxchamados")


async def _auto_close_loop() -> None:
    while True:
        await asyncio.sleep(settings.AUTO_CLOSE_INTERVAL_SECONDS)
        try:
            async with SessionLocal() as db:
                closed = await auto_close_resolved(db)
                purged = await purge_old_pings(db)
                await commit_and_publish(db)
            if purged:
                log.info("Retenção do rastreamento: %d posições antigas apagadas", purged)
            if closed:
                log.info("Fechamento automático: %d OS", closed)
        except Exception:
            log.exception("Falha no fechamento automático")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await bus.start()
    task = asyncio.create_task(_auto_close_loop())
    try:
        yield
    finally:
        task.cancel()
        await bus.stop()


app = FastAPI(
    title=f"{settings.APP_NAME} API",
    version="0.1.0",
    description="Gestão de chamados/OS de T.I. com sincronização em tempo real para apps mobile.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _error(status_code: int, detail: str, **extra: object) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": detail, **extra})


@app.exception_handler(NotFound)
async def _not_found(_: Request, exc: NotFound) -> JSONResponse:
    return _error(404, str(exc))


@app.exception_handler(PermissionDenied)
async def _forbidden(_: Request, exc: PermissionDenied) -> JSONResponse:
    return _error(403, str(exc))


@app.exception_handler(WorkflowError)
async def _workflow(_: Request, exc: WorkflowError) -> JSONResponse:
    return _error(422, str(exc))


@app.exception_handler(VersionConflict)
async def _conflict(_: Request, exc: VersionConflict) -> JSONResponse:
    return _error(409, str(exc), current_version=exc.current_version)


@app.exception_handler(StaleDataError)
async def _stale(_: Request, __: StaleDataError) -> JSONResponse:
    return _error(409, "A OS foi alterada por outra pessoa. Recarregue e tente de novo.")


@app.exception_handler(IntegrityError)
async def _integrity(_: Request, exc: IntegrityError) -> JSONResponse:
    log.warning("IntegrityError: %s", exc.orig)
    return _error(409, "Conflito de dados: registro duplicado ou referência inválida")


@app.exception_handler(DomainError)
async def _domain(_: Request, exc: DomainError) -> JSONResponse:
    return _error(400, str(exc))


app.include_router(api_router, prefix=settings.API_PREFIX)


@app.get("/health", tags=["infra"])
async def health() -> dict:
    db_ok = True
    try:
        async with SessionLocal() as db:
            await db.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    return {
        "status": "ok" if db_ok else "degraded",
        "database": db_ok,
        "realtime_connections": manager.count,
        "event_bus": "redis" if settings.REDIS_URL else "memory",
    }
