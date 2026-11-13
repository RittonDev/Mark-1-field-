import asyncio
import logging
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api.router import api_router
from app.core.config import settings
from app.core.enums import QuoteStatus
from app.db.session import SessionLocal
from app.models import Quote
from app.services import onboarding as onboarding_svc
from app.services import technician_regions, validation_messages
from app.services.activities import local_today
from app.services.errors import (
    DomainError,
    NotFound,
    PermissionDenied,
    ScheduleConflict,
    VersionConflict,
    WorkflowError,
)
from app.services.realtime import bus, commit_and_publish, manager
from app.services.tickets import auto_close_resolved
from app.services.tracking import purge_old_pings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("maxxchamados")


class RedactTokens(logging.Filter):
    """Tira tokens dos logs: o WebSocket e os links de anexo levam o token na URL, e o log de
    acesso do uvicorn gravaria a sessão de quem acessou. Os links públicos (relatório, orçamento,
    ficha de técnico) levam o token no caminho: ele também sai do log."""

    _pattern = re.compile(r"((?:token|access_token|refresh_token)=)[^&\s\"']+")
    _public = re.compile(r"(/public/(?:reports|quotes|onboarding)/)(?!catalog\b)[^/?\s\"']+")

    def _clean(self, value: object) -> object:
        if not isinstance(value, str):
            return value
        return self._public.sub(r"\1***", self._pattern.sub(r"\1***", value))

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = self._clean(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(self._clean(a) for a in record.args)
        return True


for _name in ("uvicorn.access", "uvicorn.error"):
    logging.getLogger(_name).addFilter(RedactTokens())


# Trava do Postgres para as rotinas periódicas: com várias instâncias da API, só uma roda cada vez.
_MAINTENANCE_LOCK = 0x4D415846  # "MAXF"


async def _expire_quotes(db: AsyncSession) -> int:
    """Orçamento enviado e vencido sem resposta passa a "vencido" no banco (os filtros da lista
    e os totais leem o banco; antes só mudava quando alguém abria o orçamento)."""
    result = await db.execute(
        update(Quote)
        .where(Quote.status == QuoteStatus.SENT, Quote.valid_until < local_today())
        .values(status=QuoteStatus.EXPIRED)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0


async def _close_and_purge(db: AsyncSession) -> int:
    closed = await auto_close_resolved(db)
    purged = await purge_old_pings(db)
    if purged:
        log.info("Retenção do rastreamento: %d posições antigas apagadas", purged)
    return closed


async def _refresh_regions(db: AsyncSession) -> int:
    return 1 if await technician_regions.refresh_if_stale(db) else 0


_JOBS: tuple[tuple[str, Callable[[AsyncSession], Awaitable[int]]], ...] = (
    ("Fechamento automático", _close_and_purge),
    ("Orçamentos vencidos", _expire_quotes),
    ("Regiões dos técnicos", _refresh_regions),
    ("Retenção das fichas de técnico (LGPD)", onboarding_svc.purge_expired),
)


async def _run_job(name: str, job: Callable[[AsyncSession], Awaitable[int]]) -> None:
    """Cada rotina na própria transação (uma falha não segura as outras), sob a trava."""
    try:
        async with SessionLocal() as db:
            if not await db.scalar(select(func.pg_try_advisory_xact_lock(_MAINTENANCE_LOCK))):
                return  # outra instância está rodando as rotinas agora
            changed = await job(db)
            await commit_and_publish(db)
        if changed:
            log.info("%s: %d registro(s)", name, changed)
    except Exception:
        log.exception("Falha na rotina: %s", name)


async def _auto_close_loop() -> None:
    while True:
        await asyncio.sleep(settings.AUTO_CLOSE_INTERVAL_SECONDS)
        for name, job in _JOBS:
            await _run_job(name, job)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await bus.start()
    task = asyncio.create_task(_auto_close_loop())
    try:
        yield
    finally:
        task.cancel()
        await bus.stop()


# Em produção a documentação interativa (que lista a API inteira) não fica aberta.
_DOCS = not settings.is_production

app = FastAPI(
    title=f"{settings.APP_NAME} API",
    version="0.1.0",
    description="Gestão de chamados/OS de T.I. com sincronização em tempo real para apps mobile.",
    lifespan=lifespan,
    docs_url="/docs" if _DOCS else None,
    redoc_url="/redoc" if _DOCS else None,
    openapi_url="/openapi.json" if _DOCS else None,
)

INTERNAL_ERROR = "Erro interno. Tente de novo; se continuar, avise a central."


class _BodyTooLarge(Exception):
    pass


class RequestGuard:
    """Middleware ASGI por dentro do CORS: limita o tamanho do corpo e transforma erro não
    tratado em 500 com JSON. Como fica dentro do CORS, a resposta de erro sai com os cabeçalhos
    de CORS e a web mostra a mensagem (e não "sem conexão")."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = settings.max_body_bytes
        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            await self._too_large(scope, receive, send)
            return
        state: dict[str, Any] = {"received": 0, "too_large": False, "started": False}

        async def limited_receive() -> Message:
            message = await receive()
            if message["type"] == "http.request":
                state["received"] += len(message.get("body", b""))
                if state["received"] > limit:
                    state["too_large"] = True
                    raise _BodyTooLarge
            return message

        async def tracked_send(message: Message) -> None:
            if state["too_large"]:
                # O FastAPI transforma a falha de leitura do corpo num 400 genérico: troca pelo 413.
                if message["type"] == "http.response.start" and not state["started"]:
                    state["started"] = True
                    await self._too_large(scope, receive, send)
                return
            if message["type"] == "http.response.start":
                state["started"] = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except Exception as exc:
            if state["started"]:
                raise
            if state["too_large"] or isinstance(exc, _BodyTooLarge):
                await self._too_large(scope, receive, send)
                return
            log.exception("Erro não tratado em %s %s", scope.get("method"), scope.get("path"))
            response = JSONResponse(status_code=500, content={"detail": INTERNAL_ERROR})
            await response(scope, receive, send)

    @staticmethod
    async def _too_large(scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse(
            status_code=413,
            content={"detail": f"Arquivo ou envio maior que {settings.MAX_UPLOAD_MB} MB"},
        )
        await response(scope, receive, send)


# A ordem importa: o guarda fica por dentro do CORS (adicionado antes).
app.add_middleware(RequestGuard)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    # A web manda o token no cabeçalho Authorization: não há cookie de sessão para a API.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    # Lidos pela web: total das listas paginadas, espera do 429 e nome do arquivo baixado.
    expose_headers=["X-Total-Count", "Retry-After", "Content-Disposition"],
)


@app.middleware("http")
async def _security_headers(request: Request, call_next):  # noqa: ANN001, ANN202
    """Cabeçalhos básicos em toda resposta da API (sem sobrescrever os de quem já definiu)."""
    response = await call_next(request)
    headers = response.headers
    headers.setdefault("X-Content-Type-Options", "nosniff")
    headers.setdefault("X-Frame-Options", "DENY")
    headers.setdefault("Referrer-Policy", "no-referrer")
    # JSON leva tokens e dados pessoais: nada de cache no navegador nem em proxy.
    if headers.get("content-type", "").startswith("application/json"):
        headers.setdefault("Cache-Control", "no-store")
    # Links públicos (relatório, orçamento, ficha de técnico) não entram em buscadores.
    if request.url.path.startswith(f"{settings.API_PREFIX}/public/"):
        headers.setdefault("X-Robots-Tag", "noindex, nofollow")
    if settings.is_production:
        headers.setdefault("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
    return response


def _error(status_code: int, detail: str, **extra: object) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": detail, **extra})


def _plain(value: Any) -> Any:
    return value if value is None or isinstance(value, bool | int | float | str) else str(value)


def validation_issue(error: dict[str, Any]) -> dict[str, Any]:
    """Um erro do pydantic no formato de sempre ({loc, msg, type, ctx}), com o texto em
    português. O `loc` segue com o nome técnico do campo (as telas acham o rótulo por ele) e
    `label` traz o nome que a pessoa vê. O valor enviado (`input`) não volta: não ecoa senha
    nem arquivo."""
    loc = list(error.get("loc") or ())
    text = validation_messages.message(error)
    if text.startswith("value is not a valid email address"):
        text = "e-mail inválido"
    issue: dict[str, Any] = {
        "loc": loc,
        "msg": text[:1].upper() + text[1:],
        "type": str(error.get("type") or ""),
    }
    ctx = error.get("ctx")
    if isinstance(ctx, dict) and ctx:
        issue["ctx"] = {str(k): _plain(v) for k, v in ctx.items()}
    label = validation_messages.field_label(loc)
    if label and label not in loc:
        issue["label"] = label
    return issue


@app.exception_handler(RequestValidationError)
async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
    """422 de validação em português (a web e o app mostram o `msg`)."""
    return JSONResponse(
        status_code=422, content={"detail": [validation_issue(e) for e in exc.errors()]}
    )


@app.exception_handler(DataError)
async def _data_error(_: Request, exc: DataError) -> JSONResponse:
    log.warning("DataError: %s", exc.orig)
    return _error(422, "Algum valor está fora do tamanho ou do formato aceito. Confira os campos.")


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


@app.exception_handler(ScheduleConflict)
async def _schedule_conflict(_: Request, exc: ScheduleConflict) -> JSONResponse:
    return _error(409, str(exc), code="SCHEDULE_CONFLICT", conflicts=exc.conflicts)


@app.exception_handler(StaleDataError)
async def _stale(_: Request, __: StaleDataError) -> JSONResponse:
    return _error(409, "A OS foi alterada por outra pessoa. Recarregue e tente de novo.")


# Registro repetido: a mensagem diz o que repetiu (pelo nome da restrição no banco).
CONSTRAINT_MESSAGES: dict[str, str] = {
    "uq_customers_document": "Já existe um cliente com este CPF/CNPJ",
    "ix_users_email": "E-mail já cadastrado",
    "uq_teams_name": "Já existe um grupo com este nome",
    "uq_categories_parent_name": "Já existe uma categoria com este nome aqui",
    "uq_service_types_customer_name": "Já existe um tipo de serviço com este nome",
    "uq_violation_reasons_name": "Já existe um motivo com este nome",
    "uq_unproductive_reasons_name": "Já existe um motivo com este nome",
    "uq_quote_item_catalog_name": "Já existe um item com este nome no catálogo",
    "uq_ticket_payouts_ticket_tech": "O valor deste técnico já foi definido. Recarregue a OS.",
    "uq_users_entra_oid": "Esta conta Microsoft já está ligada a outro usuário",
}
CONFLICT = "Conflito de dados: registro duplicado ou referência inválida"


def integrity_message(exc: IntegrityError) -> str:
    orig = exc.orig
    cause = getattr(orig, "__cause__", None)
    name = getattr(cause, "constraint_name", None) or getattr(orig, "constraint_name", None)
    text_ = str(orig)
    if name is None:
        name = next((c for c in CONSTRAINT_MESSAGES if c in text_), None)
    if name in CONSTRAINT_MESSAGES:
        return CONSTRAINT_MESSAGES[name]
    sqlstate = getattr(cause, "sqlstate", None) or getattr(orig, "sqlstate", None)
    if sqlstate == "23503" or "foreign key" in text_.lower():
        return "Registro ligado a outro que não existe mais. Recarregue e tente de novo."
    return CONFLICT


@app.exception_handler(IntegrityError)
async def _integrity(_: Request, exc: IntegrityError) -> JSONResponse:
    log.warning("IntegrityError: %s", exc.orig)
    return _error(409, integrity_message(exc))


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
