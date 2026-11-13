"""Portal do cliente: solicitações abertas pelo próprio cliente, e o contador para a central."""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Query, status

from app.api.deps import DB, CurrentUser, TicketManagerUser
from app.schemas.common import Page
from app.schemas.portal import (
    PortalCancel,
    PortalInboxCount,
    PortalLocation,
    PortalMe,
    PortalRequestCreate,
    PortalRequestDetail,
    PortalRequestItem,
)
from app.services import portal as svc
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["portal"])


@router.get("/portal/me", response_model=PortalMe)
async def portal_me(db: DB, user: CurrentUser) -> PortalMe:
    return await svc.me(db, user)


@router.get("/portal/locations", response_model=list[PortalLocation])
async def portal_locations(db: DB, user: CurrentUser, q: str | None = None) -> list[PortalLocation]:
    return await svc.locations(db, user, q)


@router.get("/portal/requests", response_model=Page[PortalRequestItem])
async def list_requests(
    db: DB,
    user: CurrentUser,
    scope: Literal["open", "done", "all"] = "open",
    location_id: uuid.UUID | None = None,
    q: str | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> Page[PortalRequestItem]:
    items, total = await svc.list_requests(
        db, user, scope=scope, location_id=location_id, q=q, page=page, page_size=page_size
    )
    return Page(items=[svc.to_item(t) for t in items], total=total, page=page, page_size=page_size)


@router.post(
    "/portal/requests", response_model=PortalRequestDetail, status_code=status.HTTP_201_CREATED
)
async def create_request(
    body: PortalRequestCreate, db: DB, user: CurrentUser
) -> PortalRequestDetail:
    ticket = await svc.create_request(db, user, body)
    await commit_and_publish(db)
    return await svc.to_detail(db, await svc.get_request(db, user, ticket.id))


@router.get("/portal/requests/{request_id}", response_model=PortalRequestDetail)
async def get_request(request_id: uuid.UUID, db: DB, user: CurrentUser) -> PortalRequestDetail:
    return await svc.to_detail(db, await svc.get_request(db, user, request_id))


@router.post("/portal/requests/{request_id}/cancel", response_model=PortalRequestDetail)
async def cancel_request(
    request_id: uuid.UUID, body: PortalCancel, db: DB, user: CurrentUser
) -> PortalRequestDetail:
    ticket = await svc.get_request(db, user, request_id)
    await svc.cancel_request(db, user, ticket, body.reason)
    await commit_and_publish(db)
    return await svc.to_detail(db, await svc.get_request(db, user, request_id))


@router.get("/portal/inbox-count", response_model=PortalInboxCount)
async def inbox_count(db: DB, _: TicketManagerUser) -> PortalInboxCount:
    """Solicitações do portal esperando a central (menu "Solicitações")."""
    return PortalInboxCount(pending=await svc.inbox_count(db))
