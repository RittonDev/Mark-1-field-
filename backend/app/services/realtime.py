"""Tempo real: WebSocket para web e mobile, com fan-out via Redis Pub/Sub.

Fluxo: o serviço de OS enfileira eventos na sessão (`queue_event`), a rota chama
`commit_and_publish`, que confirma a transação e só então publica. Assim nenhum
cliente recebe evento de algo que não foi gravado.

Com REDIS_URL definido, cada instância da API publica no canal e todas as
instâncias entregam aos seus sockets (escala horizontal). Sem Redis, entrega local.
"""

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.base import NO_VALUE

from app.core.config import settings
from app.core.enums import UserRole
from app.db.base import utcnow
from app.models.ticket import Ticket
from app.models.user import User
from app.schemas.ticket import format_ticket_code

log = logging.getLogger(__name__)

CHANNEL = "maxxchamados:events"
_PENDING_KEY = "pending_realtime_events"


@dataclass
class PendingEvent:
    kind: str
    ticket: Ticket
    actor: User | None
    data: dict[str, Any] = field(default_factory=dict)
    internal: bool = False
    previous_assignee_id: uuid.UUID | None = None
    # Tipo completo do evento (ex.: "part_request.created"); padrão: "ticket.<kind>".
    event_type: str | None = None
    managers_only: bool = False
    # Técnicos que saíram da visita (para o app deles tirar a OS da lista).
    previous_helper_ids: list[uuid.UUID] = field(default_factory=list)


def queue_event(
    db: AsyncSession,
    kind: str,
    ticket: Ticket,
    actor: User | None,
    data: dict[str, Any] | None = None,
    *,
    internal: bool = False,
    previous_assignee_id: uuid.UUID | None = None,
    event_type: str | None = None,
    managers_only: bool = False,
    previous_helper_ids: list[uuid.UUID] | None = None,
) -> None:
    db.info.setdefault(_PENDING_KEY, []).append(
        PendingEvent(
            kind,
            ticket,
            actor,
            data or {},
            internal,
            previous_assignee_id,
            event_type,
            managers_only,
            list(previous_helper_ids or []),
        )
    )


def pending_count(db: AsyncSession) -> int:
    return len(db.info.get(_PENDING_KEY, []))


def discard_pending(db: AsyncSession, keep: int = 0) -> None:
    events = db.info.get(_PENDING_KEY, [])
    del events[keep:]


def _s(value: uuid.UUID | None) -> str | None:
    return str(value) if value is not None else None


def _helper_ids(ticket: Ticket) -> list[str]:
    """Outros técnicos da visita, sem ir ao banco (o evento é renderizado depois do commit)."""
    value = sa_inspect(ticket).attrs.helpers.loaded_value
    if value is NO_VALUE or not value:
        return []
    return [str(u.id) for u in value]


def render_event(ev: PendingEvent) -> dict[str, Any]:
    """Renderiza após o commit (a `version` da OS já está atualizada)."""
    t = ev.ticket
    return {
        "type": ev.event_type or f"ticket.{ev.kind}",
        "ticket_id": str(t.id),
        "ticket_code": format_ticket_code(t.number),
        "status": t.status.value,
        "priority": t.priority.value,
        "assignee_id": _s(t.assignee_id),
        "team_id": _s(t.team_id),
        "actor_id": _s(ev.actor.id) if ev.actor else None,
        "actor_name": ev.actor.name if ev.actor else "Sistema",
        "version": t.version,
        "occurred_at": utcnow().isoformat(),
        "data": ev.data,
        "audience": {
            "assignee_id": _s(t.assignee_id),
            "previous_assignee_id": _s(ev.previous_assignee_id),
            "helper_ids": _helper_ids(t),
            "previous_helper_ids": [str(i) for i in ev.previous_helper_ids],
            "team_id": _s(t.team_id),
            "requester_id": _s(t.requester_id),
            "created_by_id": _s(t.created_by_id),
            "internal": ev.internal,
            "managers_only": ev.managers_only,
        },
    }


def should_deliver(
    *, user_id: str, role: UserRole, team_id: str | None, event: dict[str, Any]
) -> bool:
    """Mesma regra de visibilidade da listagem de OS (services.tickets.can_view)."""
    aud = event.get("audience") or {}
    if role in (UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.ANALYST):
        return True
    if aud.get("managers_only"):
        return False
    if role == UserRole.TECHNICIAN:
        # Só as OS dele, como responsável ou outro técnico da visita (e a que acabou de sair
        # dele, para o app tirá-la da lista).
        return (
            user_id in (aud.get("assignee_id"), aud.get("previous_assignee_id"))
            or user_id in (aud.get("helper_ids") or [])
            or user_id in (aud.get("previous_helper_ids") or [])
        )
    if aud.get("internal"):
        return False
    return user_id in (aud.get("requester_id"), aud.get("created_by_id"))


# Técnico é terceiro: o app só precisa saber que a OS mudou (e dispara o sync); o conteúdo do
# evento (quem fez, dados internos, prioridade, equipe) fica com a gestão.
_FIELD_EVENT_KEYS = (
    "type",
    "ticket_id",
    "ticket_code",
    "status",
    "assignee_id",
    "actor_id",
    "version",
    "occurred_at",
)


def field_event(event: dict[str, Any]) -> dict[str, Any]:
    out = {k: event.get(k) for k in _FIELD_EVENT_KEYS}
    data = event.get("data") or {}
    # Mudança na equipe da visita: o app confere se entrou ou saiu dela.
    out["data"] = {"added_ids": data["added_ids"]} if "added_ids" in data else {}
    return out


@dataclass(eq=False)
class Connection:
    ws: WebSocket
    user_id: str
    role: UserRole
    team_id: str | None


class ConnectionManager:
    def __init__(self) -> None:
        self._conns: set[Connection] = set()

    @property
    def count(self) -> int:
        return len(self._conns)

    def add(self, conn: Connection) -> None:
        self._conns.add(conn)

    def remove(self, conn: Connection) -> None:
        self._conns.discard(conn)

    async def dispatch(self, event: dict[str, Any]) -> None:
        public = {k: v for k, v in event.items() if k != "audience"}
        field = field_event(public)
        for conn in list(self._conns):
            if not should_deliver(
                user_id=conn.user_id, role=conn.role, team_id=conn.team_id, event=event
            ):
                continue
            try:
                await conn.ws.send_json(field if conn.role == UserRole.TECHNICIAN else public)
            except Exception:  # socket fechado no meio do envio
                self.remove(conn)


class EventBus:
    def __init__(self, manager: ConnectionManager) -> None:
        self.manager = manager
        self._redis: Any = None
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if not settings.REDIS_URL:
            log.info("Barramento de eventos em memória (REDIS_URL não definido)")
            return
        from redis import asyncio as aioredis

        self._redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        self._task = asyncio.create_task(self._listen())
        log.info("Barramento de eventos via Redis Pub/Sub")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        if self._redis is not None:
            await self._redis.aclose()

    async def _listen(self) -> None:
        while True:
            try:
                pubsub = self._redis.pubsub()
                await pubsub.subscribe(CHANNEL)
                async for msg in pubsub.listen():
                    if msg.get("type") == "message":
                        await self.manager.dispatch(json.loads(msg["data"]))
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Falha na assinatura Redis; tentando de novo em 2s")
                await asyncio.sleep(2)

    async def publish(self, event: dict[str, Any]) -> None:
        if self._redis is not None:
            try:
                await self._redis.publish(CHANNEL, json.dumps(event, default=str))
                return
            except Exception:
                log.exception("Falha ao publicar no Redis; entregando só nesta instância")
        await self.manager.dispatch(event)


manager = ConnectionManager()
bus = EventBus(manager)


async def commit_and_publish(db: AsyncSession) -> None:
    """Confirma a transação e publica os eventos enfileirados (WebSocket + push)."""
    from app.services.push import notify_for_events

    await db.commit()
    pending: list[PendingEvent] = db.info.pop(_PENDING_KEY, [])
    rendered = [render_event(ev) for ev in pending]
    for event in rendered:
        await bus.publish(event)
    if rendered:
        try:
            await notify_for_events(db, rendered)
        except Exception:
            log.exception("Falha ao enviar push")
