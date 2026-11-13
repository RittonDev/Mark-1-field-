"""Tempo real sem banco: sessão do WebSocket, o que cada papel recebe, socket lento e push."""

import asyncio
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.api.routes import ws
from app.core.enums import UserRole
from app.models import User
from app.services import realtime
from app.services.push import _push_targets
from app.services.realtime import Connection, ConnectionManager


def _user(role: UserRole = UserRole.ANALYST, team_id: uuid.UUID | None = None) -> User:
    return User(
        id=uuid.uuid4(),
        name="Pessoa Teste",
        email="pessoa@teste.com.br",
        password_hash="x",
        role=role,
        team_id=team_id,
        is_active=True,
    )


def _payload(**extra: Any) -> dict[str, Any]:
    now = int(time.time())
    return {"sub": "x", "iat": now - 60, "exp": now + 600, "sid": "sessao-1", **extra}


# ------------------------------------------------------------------ sessão do socket


def test_session_rules() -> None:
    team = uuid.uuid4()
    user = _user(team_id=team)
    payload = _payload()
    now = time.time()

    def ok(u: User | None, p: dict[str, Any], **kw: Any) -> bool:
        args: dict[str, Any] = {"role": UserRole.ANALYST, "team_id": team, "now": now, **kw}
        return ws.session_ok(u, p, **args)

    assert ok(user, payload)
    assert not ok(user, _payload(exp=int(now) - 1))  # token vencido
    assert not ok(None, payload)  # usuário apagado
    assert not ok(user, payload, role=UserRole.TECHNICIAN)  # papel trocado
    assert not ok(user, payload, team_id=uuid.uuid4())  # mudou de equipe
    user.sessions_revoked_at = datetime.now(UTC) + timedelta(seconds=5)
    assert not ok(user, payload)  # senha trocada depois do token
    user.sessions_revoked_at = None
    user.is_active = False
    assert not ok(user, payload)  # desativado


async def test_logout_ends_the_socket_session(monkeypatch: pytest.MonkeyPatch) -> None:
    user = _user()
    revoked: set[str] = set()

    async def load(_: uuid.UUID) -> User:
        return user

    async def is_revoked(sid: str | None) -> bool:
        return sid in revoked

    monkeypatch.setattr(ws, "_load_user", load)
    monkeypatch.setattr(ws.sessions, "is_revoked", is_revoked)
    payload = _payload()
    assert await ws._session_alive(payload, user.id, UserRole.ANALYST, None)
    revoked.add("sessao-1")  # saiu (logout) ou o refresh foi copiado
    assert not await ws._session_alive(payload, user.id, UserRole.ANALYST, None)


# ------------------------------------------------------------------ entrega por papel


class FakeSocket:
    def __init__(self, *, stuck: bool = False) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed = False
        self.stuck = stuck

    async def send_json(self, data: dict[str, Any]) -> None:
        if self.stuck:
            await asyncio.sleep(3600)  # rede ruim: o envio não termina
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed = True


def _conn(socket: FakeSocket, user_id: str, role: UserRole) -> Connection:
    return Connection(ws=socket, user_id=user_id, role=role, team_id=None)  # type: ignore[arg-type]


def _event(**audience: Any) -> dict[str, Any]:
    base = {
        "assignee_id": "tecnico",
        "previous_assignee_id": None,
        "helper_ids": [],
        "previous_helper_ids": [],
        "team_id": "equipe",
        "requester_id": "cliente",
        "created_by_id": None,
        "internal": False,
        "managers_only": False,
    }
    base.update(audience)
    return {
        "type": "ticket.status_changed",
        "ticket_id": "os-1",
        "ticket_code": "OS-000001",
        "status": "in_progress",
        "priority": "high",
        "assignee_id": "tecnico",
        "team_id": "equipe",
        "actor_id": "tecnico",
        "actor_name": "Técnico Fulano",
        "version": 4,
        "occurred_at": "2026-11-13T13:00:00+00:00",
        "data": {"from": "en_route", "to": "in_progress", "latitude": -23.5, "longitude": -46.6},
        "audience": base,
    }


async def test_each_role_receives_its_own_view_of_the_event() -> None:
    manager = ConnectionManager()
    office, tech, client = FakeSocket(), FakeSocket(), FakeSocket()
    manager.add(_conn(office, "analista", UserRole.ANALYST))
    manager.add(_conn(tech, "tecnico", UserRole.TECHNICIAN))
    manager.add(_conn(client, "cliente", UserRole.REQUESTER))

    await manager.dispatch(_event())

    # A gestão recebe tudo (menos a audiência); o GPS do check-in vai junto.
    assert office.sent[0]["data"]["latitude"] == -23.5 and "audience" not in office.sent[0]
    # O técnico só fica sabendo que a OS mudou (dispara o sync).
    assert tech.sent[0]["data"] == {} and "actor_name" not in tech.sent[0]
    # O cliente: só que a solicitação dele mudou. Nada de GPS, técnico, equipe ou prioridade.
    assert client.sent == [
        {
            "type": "ticket.status_changed",
            "ticket_id": "os-1",
            "ticket_code": "OS-000001",
            "status": "in_progress",
            "version": 4,
            "occurred_at": "2026-11-13T13:00:00+00:00",
        }
    ]

    # Nota interna não chega ao cliente.
    await manager.dispatch(_event(internal=True))
    assert len(client.sent) == 1 and len(office.sent) == 2


async def test_slow_phone_does_not_hold_the_others(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(realtime, "SEND_TIMEOUT", 0.05)
    manager = ConnectionManager()
    slow, fast = FakeSocket(stuck=True), FakeSocket()
    manager.add(_conn(slow, "tecnico", UserRole.TECHNICIAN))
    manager.add(_conn(fast, "analista", UserRole.ANALYST))

    await asyncio.wait_for(manager.dispatch(_event()), timeout=2)

    assert len(fast.sent) == 1
    # O socket que travou sai da lista e é fechado (o app reconecta e sincroniza).
    assert slow.closed and manager.count == 1


# ------------------------------------------------------------------ push para o técnico


def _push(kind: str, data: dict[str, Any] | None = None, **audience: Any) -> dict[str, Any]:
    return {
        "type": kind,
        "ticket_code": "OS-000123",
        "assignee_id": audience.get("assignee_id"),
        "actor_id": "analista",
        "actor_name": "Analista",
        "data": data or {},
        "audience": {"helper_ids": [], **audience},
    }


def test_push_tells_the_technician_what_changed_in_his_visits() -> None:
    # Acompanhamento não vira aviso: o app não tem conversa (a central usa o WhatsApp).
    comment = _push("ticket.comment_added", {"preview": "nota"}, assignee_id="tec")
    assert _push_targets(comment) == []

    cancelled = _push(
        "ticket.status_changed", {"to": "cancelled"}, assignee_id="tec", helper_ids=["aux"]
    )
    assert _push_targets(cancelled) == [
        ("tec", "OS-000123 cancelada", "Cancelada por Analista"),
        ("aux", "OS-000123 cancelada", "Cancelada por Analista"),
    ]

    moved = _push("ticket.updated", {"fields": ["scheduled_start", "title"]}, assignee_id="tec")
    assert _push_targets(moved) == [
        ("tec", "Visita remarcada: OS-000123", "Confira o novo horário no app")
    ]
    assert _push_targets(_push("ticket.updated", {"fields": ["title"]}, assignee_id="tec")) == []

    scheduled = _push(
        "ticket.status_changed",
        {"to": "scheduled", "scheduled_start": "2026-11-14T13:00:00+00:00"},
        assignee_id="tec",
    )
    assert _push_targets(scheduled) == [
        ("tec", "Visita agendada: OS-000123", "Para 14/11 às 10:00")
    ]

    reassigned = _push("ticket.assigned", assignee_id="novo", previous_assignee_id="antigo")
    assert _push_targets(reassigned) == [
        ("novo", "Nova OS atribuída: OS-000123", "Atribuída por Analista"),
        ("antigo", "OS-000123 saiu da sua lista", "Reatribuída por Analista"),
    ]
