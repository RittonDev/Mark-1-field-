"""Notificações push para os apps (FCM / APNs).

O provedor real ainda não está configurado: `LogPushProvider` só registra no log
o que seria enviado. Para produção, implemente `PushProvider` com Firebase Cloud
Messaging (cobre Android e iOS) e troque em `get_provider()`.

O que avisa o técnico (o app é dele): OS nova, entrar ou sair de uma visita, visita
agendada ou remarcada, OS cancelada e a decisão do pedido de peça. Acompanhamento não
gera aviso: o app não tem conversa (a central fala com ele pelo grupo de WhatsApp).
"""

import logging
import uuid
from datetime import datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
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


def _visit_people(event: dict[str, Any]) -> list[str]:
    """Quem vai à visita: o responsável e os outros técnicos (sem repetir)."""
    aud = event.get("audience") or {}
    people = [aud.get("assignee_id") or event.get("assignee_id"), *(aud.get("helper_ids") or [])]
    return [p for p in dict.fromkeys(people) if p]


def _when(value: Any) -> str | None:
    """Data ISO do evento na hora da operação: "2026-11-14T13:00:00+00:00" -> "14/11 às 10:00"."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment.astimezone(ZoneInfo(settings.TIMEZONE)).strftime("%d/%m às %H:%M")


def _push_targets(event: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Quem recebe push pelo evento e o texto: [(user_id, título, corpo)]. Quem fez a ação não
    recebe aviso dela."""
    kind = event["type"]
    actor = event.get("actor_id")
    code = event["ticket_code"]
    by = event.get("actor_name") or "Sistema"
    data = event.get("data") or {}
    aud = event.get("audience") or {}
    out: list[tuple[str, str, str]] = []

    def notify(user_ids: list[str], title: str, body: str) -> None:
        out.extend((u, title, body) for u in user_ids if u and u != actor)

    if kind == "ticket.assigned":
        assignee = event.get("assignee_id")
        notify([assignee] if assignee else [], f"Nova OS atribuída: {code}", f"Atribuída por {by}")
        previous = aud.get("previous_assignee_id")
        if previous and previous != assignee:
            notify([previous], f"{code} saiu da sua lista", f"Reatribuída por {by}")
    elif kind == "ticket.helpers_changed":
        notify(data.get("added_ids") or [], f"Você vai na visita da {code}", f"Incluído por {by}")
        removed = aud.get("previous_helper_ids") or []
        notify(removed, f"{code} saiu da sua lista", f"Tirado por {by}")
    elif kind == "ticket.status_changed" and data.get("to") == "cancelled":
        notify(_visit_people(event), f"{code} cancelada", f"Cancelada por {by}")
    elif kind == "ticket.status_changed" and data.get("to") == "scheduled":
        when = _when(data.get("scheduled_start"))
        notify(_visit_people(event), f"Visita agendada: {code}", f"Para {when}" if when else "")
    elif kind == "ticket.updated" and {"scheduled_start", "scheduled_end"} & set(
        data.get("fields") or []
    ):
        notify(_visit_people(event), f"Visita remarcada: {code}", "Confira o novo horário no app")
    elif kind == "ticket.part_request_decided":
        assignee = event.get("assignee_id")
        approved = data.get("status") == "approved"
        title = f"Peça {'aprovada' if approved else 'recusada'}: {code}"
        body = data.get("description") or ""
        if approved:
            body = f"{body} · orçamento aprovado pelo cliente, pode trocar".strip(" ·")
        if assignee:
            out.append((assignee, title, body))
    return out


async def notify_for_events(db: AsyncSession, events: list[dict[str, Any]]) -> None:
    provider = get_provider()
    for event in events:
        for user_id, title, body in _push_targets(event):
            tokens = list(
                await db.scalars(
                    select(DeviceToken.token).where(DeviceToken.user_id == uuid.UUID(user_id))
                )
            )
            if tokens:
                await provider.send(
                    tokens, title, body, {"ticket_id": event["ticket_id"], "type": event["type"]}
                )
