"""Relatório da OS para o cliente: o link (gestão e técnico responsável) e a página pública."""

import uuid

from fastapi import APIRouter, HTTPException, Request, Response, status

from app.api.deps import DB, CurrentUser, TicketManagerUser
from app.db.base import utcnow
from app.schemas.client_report import PublicReport
from app.schemas.ticket import ReportLinkOut
from app.services import client_report as svc
from app.services import tickets as tickets_svc

router = APIRouter(tags=["client-report"])
public = APIRouter(prefix="/public/reports", tags=["client-report"])

LINK_GONE = "Link inválido ou expirado"
REOPENED = "Esta OS foi reaberta. O relatório volta quando ela for concluída."
ONLY_ASSIGNEE = "Só a gestão ou o técnico responsável pela OS enviam o relatório"


@router.post("/tickets/{ticket_id}/report-link", response_model=ReportLinkOut)
async def create_report_link(ticket_id: uuid.UUID, db: DB, user: CurrentUser) -> ReportLinkOut:
    """Link do relatório para o cliente (cria se ainda não houver; a OS precisa estar concluída).

    A gestão e o técnico responsável (que envia pelo app). Trocar ou revogar: só a gestão.
    """
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    if not user.can_manage_tickets and ticket.assignee_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, ONLY_ASSIGNEE)
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


@public.get("/{token}", response_model=PublicReport)
async def view_report(token: str, request: Request, db: DB) -> PublicReport:
    try:
        ticket = await svc.ticket_for_token(db, token)
    except svc.ReportUnavailable as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, LINK_GONE) from exc
    except svc.ReportReopened as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, REOPENED) from exc
    report = await svc.build(db, ticket, str(request.base_url))
    await svc.register_view(db, ticket, utcnow())
    await db.commit()
    return report
