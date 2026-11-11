from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from app.api.deps import DB, CurrentUser
from app.db.base import utcnow
from app.models import DeviceToken
from app.schemas.sync import (
    DeviceRegister,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
)
from app.services import sync as sync_service

router = APIRouter(tags=["mobile-sync"])


@router.get("/sync/pull", response_model=SyncPullResponse)
async def pull(db: DB, user: CurrentUser, since: datetime | None = None) -> SyncPullResponse:
    if since is not None and since.tzinfo is None:
        since = since.replace(tzinfo=UTC)
    return await sync_service.pull(db, user, since)


@router.post("/sync/push", response_model=SyncPushResponse)
async def push(body: SyncPushRequest, db: DB, user: CurrentUser) -> SyncPushResponse:
    return await sync_service.push(db, user, body)


@router.post("/devices", status_code=status.HTTP_204_NO_CONTENT)
async def register_device(body: DeviceRegister, db: DB, user: CurrentUser) -> Response:
    device = await db.scalar(select(DeviceToken).where(DeviceToken.token == body.token))
    if device is None:
        device = DeviceToken(token=body.token, user_id=user.id, platform=body.platform)
        db.add(device)
    device.user_id = user.id
    device.platform = body.platform
    device.app_version = body.app_version
    device.last_seen_at = utcnow()
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/devices/{token}", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_device(token: str, db: DB, user: CurrentUser) -> Response:
    device = await db.scalar(select(DeviceToken).where(DeviceToken.token == token))
    if device is None or device.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Aparelho não encontrado")
    await db.delete(device)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
