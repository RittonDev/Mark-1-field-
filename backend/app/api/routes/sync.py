from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from app.api.deps import DB, CurrentUser, StaffUser
from app.db.base import utcnow
from app.models import DeviceToken
from app.schemas.sync import (
    DeviceRegister,
    DeviceRegistered,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
)
from app.services import sync as sync_service

# Pelo nome da função: `push` já é a rota /sync/push deste módulo.
from app.services.push import get_provider

# Sincronização e aparelhos são do app de campo (a equipe). O cliente usa só o portal.
router = APIRouter(tags=["mobile-sync"])


@router.get("/sync/pull", response_model=SyncPullResponse)
async def pull(db: DB, user: StaffUser, since: datetime | None = None) -> SyncPullResponse:
    if since is not None and since.tzinfo is None:
        since = since.replace(tzinfo=UTC)
    return await sync_service.pull(db, user, since)


@router.post("/sync/push", response_model=SyncPushResponse)
async def push(body: SyncPushRequest, db: DB, user: StaffUser) -> SyncPushResponse:
    return await sync_service.push(db, user, body)


@router.post("/devices", response_model=DeviceRegistered)
async def register_device(body: DeviceRegister, db: DB, user: StaffUser) -> DeviceRegistered:
    """Registra (ou reatribui) o token do aparelho e diz se o push chega de fato a ele: com
    "simulated", o app avisa sozinho as novidades; com "live", não repete o aviso do push."""
    device = await db.scalar(select(DeviceToken).where(DeviceToken.token == body.token))
    if device is None:
        device = DeviceToken(token=body.token, user_id=user.id, platform=body.platform)
        db.add(device)
    device.user_id = user.id
    device.platform = body.platform
    device.app_version = body.app_version
    device.last_seen_at = utcnow()
    await db.commit()
    return DeviceRegistered(push="live" if get_provider().delivers(body.platform) else "simulated")


@router.delete("/devices/{token}", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_device(token: str, db: DB, user: CurrentUser) -> Response:
    device = await db.scalar(select(DeviceToken).where(DeviceToken.token == token))
    if device is None or device.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Aparelho não encontrado")
    await db.delete(device)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
