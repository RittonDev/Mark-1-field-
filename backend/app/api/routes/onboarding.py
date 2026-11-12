import uuid
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select

from app.api.deps import DB, TicketManagerUser
from app.core.config import settings
from app.core.enums import ApplicationStatus
from app.core.security import InvalidToken, create_token, decode_token
from app.db.base import utcnow
from app.models import OnboardingInvite, TechnicianApplication
from app.schemas.onboarding import (
    ApplicationApprove,
    ApplicationDetail,
    ApplicationIn,
    ApplicationReceived,
    ApplicationReject,
    ApplicationSummary,
    InviteCheck,
    InviteCreate,
    InviteCreated,
    InviteOut,
    OnboardingCatalog,
    catalog,
)
from app.schemas.user import UserOut
from app.services import onboarding as svc
from app.services import storage

# Formulário que o técnico abre pelo link, sem login.
public = APIRouter(prefix="/public/onboarding", tags=["onboarding"])
# Análise das fichas pela gestão (analistas e gestores).
router = APIRouter(prefix="/onboarding", tags=["onboarding"])

INVITE_GONE = "Este link de cadastro expirou ou já foi usado. Peça um novo link à Maxx Field."


@public.get("/catalog", response_model=OnboardingCatalog)
async def onboarding_catalog() -> OnboardingCatalog:
    return catalog()


@public.get("/{token}", response_model=InviteCheck)
async def check_invite(token: str, db: DB) -> InviteCheck:
    try:
        invite = await svc.active_invite(db, token)
    except svc.InviteUnavailable:
        return InviteCheck(valid=False)
    return InviteCheck(valid=True, expires_at=invite.expires_at)


@public.post("/{token}", response_model=ApplicationReceived, status_code=status.HTTP_201_CREATED)
async def submit_application(token: str, body: ApplicationIn, db: DB) -> ApplicationReceived:
    try:
        invite = await svc.active_invite(db, token)
    except svc.InviteUnavailable as exc:
        raise HTTPException(status.HTTP_410_GONE, INVITE_GONE) from exc
    application = await svc.submit(db, invite, body)
    await db.commit()
    await svc.publish_submitted(application)
    return ApplicationReceived(protocol=svc.protocol(application))


# ------------------------------------------------------------------ convites


def _invite_out(invite: OnboardingInvite) -> InviteOut:
    out = InviteOut.model_validate(invite)
    out.state = svc.invite_state(invite)
    return out


@router.get("/invites", response_model=list[InviteOut])
async def list_invites(db: DB, _: TicketManagerUser) -> list[InviteOut]:
    rows = await db.scalars(
        select(OnboardingInvite).order_by(OnboardingInvite.created_at.desc()).limit(200)
    )
    return [_invite_out(i) for i in rows]


@router.post("/invites", response_model=InviteCreated, status_code=status.HTTP_201_CREATED)
async def create_invite(body: InviteCreate, db: DB, user: TicketManagerUser) -> InviteCreated:
    invite, token = await svc.create_invite(db, body, user)
    await db.commit()
    return InviteCreated(**_invite_out(invite).model_dump(), token=token)


@router.delete("/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(invite_id: uuid.UUID, db: DB, _: TicketManagerUser) -> Response:
    invite = await db.get(OnboardingInvite, invite_id)
    if invite is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Link não encontrado")
    if invite.revoked_at is None:
        invite.revoked_at = utcnow()
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------- fichas


@router.get("/applications", response_model=list[ApplicationSummary])
async def list_applications(
    db: DB,
    _: TicketManagerUser,
    status_: Annotated[ApplicationStatus | None, Query(alias="status")] = None,
) -> list[TechnicianApplication]:
    stmt = select(TechnicianApplication).order_by(TechnicianApplication.created_at.desc())
    if status_ is not None:
        stmt = stmt.where(TechnicianApplication.status == status_)
    return list(await db.scalars(stmt.limit(500)))


@router.get("/applications/pending-count")
async def pending_count(db: DB, _: TicketManagerUser) -> dict[str, int]:
    count = await db.scalar(
        select(func.count()).where(TechnicianApplication.status == ApplicationStatus.PENDING)
    )
    return {"pending": count or 0}


def _detail(application: TechnicianApplication) -> ApplicationDetail:
    out = ApplicationDetail.model_validate(application)
    out.invite_label = application.invite.label if application.invite else None
    if application.photo_key:
        token = create_token(f"application:{application.id}", "download", timedelta(minutes=30))
        out.photo_url = (
            f"{settings.API_PREFIX}/onboarding/applications/{application.id}/photo?token={token}"
        )
    return out


@router.get("/applications/{application_id}", response_model=ApplicationDetail)
async def get_application(
    application_id: uuid.UUID, db: DB, _: TicketManagerUser
) -> ApplicationDetail:
    return _detail(await svc.get_application(db, application_id))


@router.get("/applications/{application_id}/photo", include_in_schema=False)
async def application_photo(application_id: uuid.UUID, token: str, db: DB) -> FileResponse:
    """Foto da ficha por link assinado (a tag <img> não envia o token de acesso)."""
    try:
        payload = decode_token(token, "download")
    except InvalidToken as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Link expirado") from exc
    if payload.get("sub") != f"application:{application_id}":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Link inválido")
    application = await svc.get_application(db, application_id)
    if not application.photo_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Sem foto")
    return FileResponse(storage.open_path(application.photo_key))


@router.post("/applications/{application_id}/approve", response_model=UserOut)
async def approve_application(
    application_id: uuid.UUID, body: ApplicationApprove, db: DB, user: TicketManagerUser
) -> UserOut:
    """Aprova: o técnico entra na base e já acessa o app com o e-mail e a senha da ficha."""
    application = await svc.get_application(db, application_id)
    technician = await svc.approve(db, application, body, user)
    await db.commit()
    await db.refresh(technician, ["team"])
    return UserOut.model_validate(technician)


@router.post("/applications/{application_id}/reject", response_model=ApplicationDetail)
async def reject_application(
    application_id: uuid.UUID, body: ApplicationReject, db: DB, user: TicketManagerUser
) -> ApplicationDetail:
    application = await svc.get_application(db, application_id)
    await svc.reject(db, application, body.reason, user)
    await db.commit()
    return _detail(application)
