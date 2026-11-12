"""Notificações push para os apps (FCM / APNs).

O provedor real ainda não está configurado: `LogPushProvider` só registra no log
o que seria enviado. Para produção, implemente `PushProvider` com Firebase Cloud
Messaging (cobre Android e iOS) e troque em `get_provider()`.
"""

import logging
import uuid
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sync import DeviceToken

log = logging.getLogger(__name__)


class PushProvider(Protocol):
    async def send(
        self, tokens: list[str], title: str, body: str, data: dict[str, str]
    ) -> None: ...


class LogPushProvider:
    async def send(self, tokens: list[str], title: str, body: str, data: dict[str, str]) -> None:
        log.info("push (simulado) para %d aparelho(s): %s — %s", len(tokens), title, body)


def get_provider() -> PushProvider:
    return LogPushProvider()


def _push_target(event: dict[str, Any]) -> tuple[str, str, str] | None:
    """Decide quem recebe push e o texto. Retorna (user_id, título, corpo)."""
    actor = event.get("actor_id")
    assignee = event.get("assignee_id")
    code = event["ticket_code"]
    if event["type"] == "ticket.assigned" and assignee and assignee != actor:
        return assignee, f"Nova OS atribuída: {code}", f"Atribuída por {event['actor_name']}"
    if event["type"] == "ticket.comment_added" and assignee and assignee != actor:
        return assignee, f"Novo acompanhamento em {code}", f"{event['actor_name']} comentou"
    data = event.get("data") or {}
    if event["type"] == "ticket.authorization" and assignee and data.get("status") == "authorized":
        return assignee, f"Visita autorizada: {code}", "O cliente autorizou. Pode sair para a loja."
    if event["type"] == "ticket.part_request_decided" and assignee:
        approved = data.get("status") == "approved"
        title = f"Peça {'aprovada' if approved else 'recusada'}: {code}"
        body = data.get("description") or ""
        if approved:
            body = f"{body} · orçamento aprovado pelo cliente, pode trocar".strip(" ·")
        return assignee, title, body
    return None


async def notify_for_events(db: AsyncSession, events: list[dict[str, Any]]) -> None:
    provider = get_provider()
    for event in events:
        target = _push_target(event)
        if target is None:
            continue
        user_id, title, body = target
        tokens = list(
            await db.scalars(
                select(DeviceToken.token).where(DeviceToken.user_id == uuid.UUID(user_id))
            )
        )
        if tokens:
            await provider.send(
                tokens, title, body, {"ticket_id": event["ticket_id"], "type": event["type"]}
            )
