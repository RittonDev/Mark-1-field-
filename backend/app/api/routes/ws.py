import json
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.security import InvalidToken, decode_token
from app.db.session import SessionLocal
from app.models import User
from app.services.realtime import Connection, manager

router = APIRouter(tags=["realtime"])

AUTH_FAILED = 4401


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str | None = None) -> None:
    """Canal de eventos em tempo real. Autentica com `?token=<access_token>`."""
    await websocket.accept()
    try:
        payload = decode_token(token or "", "access")
        user_id = uuid.UUID(payload["sub"])
    except (InvalidToken, KeyError, ValueError):
        await websocket.close(code=AUTH_FAILED, reason="token inválido")
        return

    async with SessionLocal() as db:
        user = await db.get(User, user_id)
    if user is None or not user.is_active:
        await websocket.close(code=AUTH_FAILED, reason="usuário inativo")
        return

    conn = Connection(
        ws=websocket,
        user_id=str(user.id),
        role=user.role,
        team_id=str(user.team_id) if user.team_id else None,
    )
    manager.add(conn)
    try:
        await websocket.send_json({"type": "hello", "user_id": str(user.id)})
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        manager.remove(conn)
