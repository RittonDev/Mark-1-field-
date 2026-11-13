import asyncio
import contextlib
import json
import time
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from app.core.enums import UserRole
from app.core.security import InvalidToken, decode_token
from app.db.session import SessionLocal
from app.models import User
from app.services.realtime import Connection, manager

router = APIRouter(tags=["realtime"])

AUTH_FAILED = 4401
# O token só é conferido na abertura; o socket fica aberto por horas. A cada minuto vê se o token
# venceu; a cada 5 minutos relê o usuário (desativado, senha trocada, papel ou equipe mudados).
EXPIRY_CHECK_S = 60
USER_CHECK_S = 300


def session_ok(
    user: User | None,
    payload: dict[str, Any],
    *,
    role: UserRole,
    team_id: uuid.UUID | None,
    now: float,
) -> bool:
    """A sessão do socket continua valendo: token no prazo, usuário ativo, sessões não revogadas
    e o mesmo papel e equipe da abertura (a regra de entrega dos eventos depende deles)."""
    if now >= int(payload.get("exp", 0)):
        return False
    if user is None or not user.is_active or user.token_revoked(payload):
        return False
    return user.role == role and user.team_id == team_id


async def _close(websocket: WebSocket, conn: Connection, reason: str) -> None:
    manager.remove(conn)  # para de entregar na hora, antes de o cliente confirmar o fechamento
    with contextlib.suppress(Exception):
        await websocket.close(code=AUTH_FAILED, reason=reason)


async def _watch_session(
    websocket: WebSocket,
    conn: Connection,
    payload: dict[str, Any],
    user_id: uuid.UUID,
    role: UserRole,
    team_id: uuid.UUID | None,
) -> None:
    """Fecha o socket com 4401 quando a sessão deixa de valer: os clientes renovam o token e
    reconectam sozinhos."""
    checked_user = time.monotonic()
    while True:
        await asyncio.sleep(EXPIRY_CHECK_S)
        if time.time() >= int(payload.get("exp", 0)):
            await _close(websocket, conn, "sessão expirada")
            return
        if time.monotonic() - checked_user < USER_CHECK_S:
            continue
        checked_user = time.monotonic()
        async with SessionLocal() as db:
            user = await db.get(User, user_id)
        if not session_ok(user, payload, role=role, team_id=team_id, now=time.time()):
            await _close(websocket, conn, "sessão encerrada")
            return


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str | None = None) -> None:
    """Canal de eventos em tempo real. Autentica com `?token=<access_token>`."""
    await websocket.accept()
    try:
        payload = decode_token(token or "", "access")
        user_id = uuid.UUID(payload["sub"])
        int(payload["exp"])
    except (InvalidToken, KeyError, ValueError, TypeError):
        await websocket.close(code=AUTH_FAILED, reason="token inválido")
        return

    async with SessionLocal() as db:
        user = await db.get(User, user_id)
    if user is None or not session_ok(
        user, payload, role=user.role, team_id=user.team_id, now=time.time()
    ):
        await websocket.close(code=AUTH_FAILED, reason="sessão encerrada")
        return

    conn = Connection(
        ws=websocket,
        user_id=str(user.id),
        role=user.role,
        team_id=str(user.team_id) if user.team_id else None,
    )
    manager.add(conn)
    watcher = asyncio.create_task(
        _watch_session(websocket, conn, payload, user.id, user.role, user.team_id)
    )
    try:
        await websocket.send_json({"type": "hello", "user_id": str(user.id)})
        while websocket.application_state == WebSocketState.CONNECTED:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except RuntimeError:
        # O vigia fechou o socket (sessão vencida) no meio de uma leitura ou de um "pong".
        if websocket.application_state == WebSocketState.CONNECTED:
            raise
    finally:
        watcher.cancel()
        manager.remove(conn)
