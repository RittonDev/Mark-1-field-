"""Relatório da OS para o cliente: o link (gestão e técnico responsável) e a página pública."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials

from app.api.deps import DB, CurrentUser, TicketManagerUser, bearer
from app.core.security import InvalidToken, decode_token
from app.db.base import utcnow
from app.models import User
from app.schemas.client_report import PublicReport
from app.schemas.ticket import ReportLinkOut
from app.services import client_report as svc
from app.services import tickets as tickets_svc

router = APIRouter(tags=["client-report"])
public = APIRouter(prefix="/public/reports", tags=["client-report"])

LINK_GONE = "Link inválido ou expirado"
ONLY_ASSIGNEE = "Só a gestão ou o técnico responsável pela OS enviam o relatório"


@router.post("/tickets/{ticket_id}/report-link", response_model=ReportLinkOut)
async def create_report_link(ticket_id: uuid.UUID, db: DB, user: CurrentUser) -> ReportLinkOut:
    """Link do relatório para o cliente (cria se ainda não houver). Toda OS tem relatório.

    A gestão pega a qualquer momento; o técnico responsável, pelo app, depois de concluir.
    Trocar ou revogar: só a gestão.
    """
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    if not user.can_manage_tickets and ticket.assignee_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, ONLY_ASSIGNEE)
    if not user.can_manage_tickets and ticket.status not in svc.FINISHED:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, svc.NOT_FINISHED)
    out = await svc.ensure_link(db, ticket)
    await db.commit()
    return out


@router.post("/tickets/{ticket_id}/report-link/rotate", response_model=ReportLinkOut)
async def rotate_report_link(
    ticket_id: uuid.UUID, db: DB, user: TicketManagerUser
) -> ReportLinkOut:
    """Gera um link novo: o anterior para de funcionar (e as visualizações recomeçam)."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    out = await svc.rotate_link(db, ticket)
    await db.commit()
    return out


@router.delete("/tickets/{ticket_id}/report-link", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_report_link(ticket_id: uuid.UUID, db: DB, user: TicketManagerUser) -> Response:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    await svc.revoke_link(db, ticket)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _viewer(db: DB, creds: HTTPAuthorizationCredentials | None) -> User | None:
    """Quem abriu, se mandou a sessão (a página pública não exige login: sem ela, é o cliente)."""
    if creds is None:
        return None
    try:
        payload = decode_token(creds.credentials, "access")
        user = await db.get(User, uuid.UUID(payload["sub"]))
    except (InvalidToken, KeyError, ValueError):
        return None
    if user is None or not user.is_active or user.token_revoked(payload):
        return None
    return user


@public.get("/{token}", response_model=PublicReport)
async def view_report(
    token: str,
    request: Request,
    db: DB,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> PublicReport:
    """Página do cliente. Só a visita do cliente conta ("aberto N vezes"): a gestão e o técnico
    da OS conferindo ou baixando o PDF não contam, nem a mesma pessoa recarregando a página."""
    try:
        ticket = await svc.ticket_for_token(db, token)
    except svc.ReportUnavailable as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, LINK_GONE) from exc
    report = await svc.build(db, ticket, str(request.base_url))
    if svc.counts_as_client_view(ticket, await _viewer(db, creds)):
        await svc.register_view(db, ticket, utcnow())
        await db.commit()
    return report
