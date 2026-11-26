import uuid
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select

from app.api.deps import DB, MANAGER_ROLES, access_user
from app.api.files import stored_file
from app.core.config import settings
from app.core.enums import ApplicationStatus
from app.core.security import InvalidToken, create_token, decode_token
from app.db.base import utcnow
from app.models import OnboardingInvite, TechnicianApplication
from app.models.user_change import VIA_FICHA
from app.schemas.account import EmailQueued
from app.schemas.onboarding import (
    ApplicationApprove,
    ApplicationApproved,
    ApplicationDetail,
    ApplicationIn,
    ApplicationReceived,
    ApplicationReject,
    ApplicationReopen,
    ApplicationSummary,
    InviteCheck,
    InviteCreate,
    InviteCreated,
    InviteOut,
    OnboardingCatalog,
    catalog,
)
from app.schemas.user import UserOut
from app.services import account, login_guard, mail, user_history
from app.services import onboarding as svc

# Formulário que o técnico abre pelo link, sem login.
public = APIRouter(prefix="/public/onboarding", tags=["onboarding"])
# Análise das fichas pela gestão (analistas e gestores).
router = APIRouter(prefix="/onboarding", tags=["onboarding"])

OnboardingView = access_user("base.onboarding")
OnboardingEdit = access_user("base.onboarding", level="edit")
# Exclusão da ficha a pedido do titular (LGPD): também só admin e supervisor, como antes.
OnboardingDelete = access_user("base.onboarding", level="edit", roles=MANAGER_ROLES)

INVITE_GONE = "Este link de cadastro expirou ou já foi usado. Peça um novo link à Maxx Field."
TOO_MANY = "Muitas fichas enviadas por este link. Tente mais tarde."
# Fichas por IP (uma pessoa manda uma; um escritório com vários técnicos, poucas) e por link
# reutilizável (o que circula em grupo de WhatsApp) por dia.
MAX_PER_IP_HOUR = 5
MAX_PER_INVITE_DAY = 100
# Reenvio da validação do e-mail da ficha pela gestão, por hora.
MAX_RESENDS_HOUR = 5


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
async def submit_application(
    token: str, body: ApplicationIn, db: DB, request: Request
) -> ApplicationReceived:
    """Recebe a ficha e põe na fila o link de validação do e-mail (sai logo depois do commit):
    `email_verification` diz se foi para a fila, se o envio está desligado ou se o endereço não
    recebe mensagens."""
    try:
        # Trava a linha do convite: duas fichas juntas no link de uso único não passam as duas.
        invite = await svc.active_invite(db, token, lock=True)
    except svc.InviteUnavailable as exc:
        raise HTTPException(status.HTTP_410_GONE, INVITE_GONE) from exc
    ip = request.client.host if request.client else "sem-ip"
    try:
        await login_guard.hit("onboarding-ip", ip, MAX_PER_IP_HOUR, 3600)
        await login_guard.hit("onboarding-invite", str(invite.id), MAX_PER_INVITE_DAY, 86400)
    except login_guard.RateLimited as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            TOO_MANY,
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    application = await svc.submit(db, invite, body)
    row, verification = await svc.queue_verification(db, application)
    await db.commit()
    if row is not None and verification == "queued":
        mail.deliver_soon([row.id])
    await svc.publish_submitted(application)
    return ApplicationReceived(protocol=svc.protocol(application), email_verification=verification)


# ------------------------------------------------------------------ convites


def _invite_out(invite: OnboardingInvite) -> InviteOut:
    out = InviteOut.model_validate(invite)
    out.state = svc.invite_state(invite)
    out.url = svc.invite_url(invite) if out.state == "active" else None
    return out


@router.get("/invites", response_model=list[InviteOut])
async def list_invites(db: DB, _: OnboardingView) -> list[InviteOut]:
    rows = await db.scalars(
        select(OnboardingInvite).order_by(OnboardingInvite.created_at.desc()).limit(200)
    )
    return [_invite_out(i) for i in rows]


@router.post("/invites", response_model=InviteCreated, status_code=status.HTTP_201_CREATED)
async def create_invite(body: InviteCreate, db: DB, user: OnboardingEdit) -> InviteCreated:
    invite, token = await svc.create_invite(db, body, user)
    await db.commit()
    return InviteCreated(**_invite_out(invite).model_dump(), token=token)


@router.delete("/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(invite_id: uuid.UUID, db: DB, _: OnboardingEdit) -> Response:
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
    _: OnboardingView,
    status_: Annotated[ApplicationStatus | None, Query(alias="status")] = None,
) -> list[TechnicianApplication]:
    stmt = select(TechnicianApplication).order_by(TechnicianApplication.created_at.desc())
    if status_ is not None:
        stmt = stmt.where(TechnicianApplication.status == status_)
    return list(await db.scalars(stmt.limit(500)))


@router.get("/applications/pending-count")
async def pending_count(db: DB, _: OnboardingView) -> dict[str, int]:
    count = await db.scalar(
        select(func.count()).where(TechnicianApplication.status == ApplicationStatus.PENDING)
    )
    return {"pending": count or 0}


def _detail(application: TechnicianApplication) -> ApplicationDetail:
    out = ApplicationDetail.model_validate(application)
    out.invite_label = application.invite.label if application.invite else None
    out.has_password = application.password_hash is not None
    out.purge_at = svc.purge_at(application)
    if application.photo_key:
        token = create_token(f"application:{application.id}", "download", timedelta(minutes=30))
        out.photo_url = (
            f"{settings.API_PREFIX}/onboarding/applications/{application.id}/photo?token={token}"
        )
    return out


@router.get("/applications/{application_id}", response_model=ApplicationDetail)
async def get_application(
    application_id: uuid.UUID, db: DB, _: OnboardingView
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
    return stored_file(application.photo_key)


@router.delete("/applications/{application_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_application(application_id: uuid.UUID, db: DB, _: OnboardingDelete) -> Response:
    """Pedido de exclusão do titular (LGPD): apaga a ficha pendente ou reprovada e a foto."""
    application = await svc.get_application(db, application_id)
    photo = await svc.delete_application(db, application)
    await db.commit()
    svc.remove_photos([photo])  # só depois da exclusão gravada
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/applications/{application_id}/approve", response_model=ApplicationApproved)
async def approve_application(
    application_id: uuid.UUID,
    db: DB,
    user: OnboardingEdit,
    body: ApplicationApprove | None = None,
) -> ApplicationApproved:
    """Aprova num passo (corpo opcional): o técnico entra na base com tudo o que a ficha coletou e
    já acessa o app com o e-mail e a senha da ficha. Sem senha, a boas-vindas leva o link para
    criar só com o e-mail validado (`password_link`); sem a validação, a central gera a senha
    provisória. CPF já de outro usuário: 409. `welcome` diz se a boas-vindas foi para a fila."""
    application = await svc.get_application(db, application_id, lock=True)
    approval = await svc.approve(db, application, body or ApplicationApprove(), user)
    await db.commit()
    welcome = approval.welcome
    if welcome is not None and approval.welcome_status == "queued":
        mail.deliver_soon([welcome.id])
    technician = approval.user
    await user_history.publish_changed(technician, approval.changes, via=VIA_FICHA, actor=user)
    await account.publish_onboarding_updated(application, "approved")
    await db.refresh(technician, ["team"])
    return ApplicationApproved(
        technician=UserOut.model_validate(technician),
        welcome=mail.queued(welcome, approval.welcome_status),
        password_link=svc.welcome_password_link(technician),
    )


@router.post("/applications/{application_id}/reject", response_model=ApplicationDetail)
async def reject_application(
    application_id: uuid.UUID, body: ApplicationReject, db: DB, user: OnboardingEdit
) -> ApplicationDetail:
    """Reprova com o motivo (o candidato não vê): a senha da ficha sai e a exclusão automática
    conta daqui."""
    application = await svc.get_application(db, application_id, lock=True)
    await svc.reject(db, application, body.reason, user)
    await db.commit()
    await db.refresh(application, ["reviewed_by"])
    await account.publish_onboarding_updated(application, "rejected")
    return _detail(application)


@router.post("/applications/{application_id}/reopen", response_model=ApplicationDetail)
async def reopen_application(
    application_id: uuid.UUID, body: ApplicationReopen, db: DB, user: OnboardingEdit
) -> ApplicationDetail:
    """Reabre a ficha reprovada para uma nova análise, com o motivo (3 a 500). 409: não está
    reprovada, já há usuário com o e-mail ou o CPF dela, ou há outra ficha da pessoa em análise ou
    aprovada."""
    application = await svc.get_application(db, application_id, lock=True)
    await svc.reopen(db, application, body.reason, user)
    await db.commit()
    await db.refresh(application, ["reviewed_by", "reopened_by"])
    await account.publish_onboarding_updated(application, "reopened")
    return _detail(application)


@router.post(
    "/applications/{application_id}/email-verification",
    response_model=EmailQueued,
    status_code=status.HTTP_202_ACCEPTED,
)
async def resend_application_verification(
    application_id: uuid.UUID, db: DB, user: OnboardingEdit
) -> EmailQueued:
    """Reenvia o link de validação do e-mail da ficha: só a pendente e ainda não validada (409);
    até 5 por hora (429). Com o envio desligado, "not_configured" (nada sai)."""
    application = await svc.get_application(db, application_id)
    svc.check_resend(application)
    try:
        await login_guard.hit(
            "mail-resend-application", str(application.id), MAX_RESENDS_HOUR, 3600
        )
    except login_guard.RateLimited as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    row, queued = await svc.queue_verification(db, application, user)
    await db.commit()
    if row is not None and queued == "queued":
        mail.deliver_soon([row.id])
    return mail.queued(row, queued)
