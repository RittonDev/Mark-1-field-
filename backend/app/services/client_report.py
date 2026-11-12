"""Relatório da OS para o cliente: link público com o resumo do atendimento.

Quando a OS é concluída (resolvida ou fechada), ganha um link que o analista envia ao cliente
(WhatsApp/e-mail). A página mostra o que foi feito, as evidências (fotos dos formulários e da
OS), a assinatura e a linha do tempo, e pode ser salva em PDF pelo navegador.

O token do link é `<id>.<assinatura>`: só o id fica no banco e a assinatura é um HMAC com o
segredo da API. Dá para copiar o link de novo a qualquer momento e trocar (revogar) quando
preciso, e um vazamento do banco não entrega links válidos.

Nada interno entra no relatório: acompanhamentos, apontamentos, custos, orçamentos, notas,
motivos de violação e eventos internos ficam de fora.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.core import links
from app.core.config import settings
from app.core.enums import TicketEventType, TicketStatus
from app.core.security import create_download_token
from app.db.base import utcnow
from app.models import Ticket, TicketAttachment, TicketEvent
from app.schemas.client_report import (
    PublicReport,
    PublicReportCustomer,
    PublicReportForm,
    PublicReportFormItem,
    PublicReportLocation,
    PublicReportMilestone,
    PublicReportPerson,
    PublicReportPhoto,
    PublicReportSignature,
)
from app.schemas.forms import FormField
from app.schemas.ticket import ReportLinkOut, format_ticket_code
from app.services import company as company_svc
from app.services import field as field_rules
from app.services.errors import WorkflowError
from app.services.workflow import STATUS_INFO

S = TicketStatus
FINISHED = (S.RESOLVED, S.CLOSED)
LINK_KIND = "report"
PHOTO_LINK_MINUTES = 24 * 60
NOT_FINISHED = "Disponível quando a OS for concluída"


class ReportUnavailable(Exception):
    """Link inválido, revogado ou adulterado."""


class ReportReopened(Exception):
    """A OS foi reaberta depois do link: o relatório volta quando ela for concluída."""


# --------------------------------------------------------------------------- token


def new_link_id() -> str:
    return links.new_link_id()


def token_for(link_id: str) -> str:
    return links.token_for(LINK_KIND, link_id)


def parse_token(token: str) -> str | None:
    """Id do link quando a assinatura confere; None para token inválido ou adulterado."""
    return links.parse_token(LINK_KIND, token)


def link_out(ticket: Ticket) -> ReportLinkOut | None:
    if not ticket.report_link_id:
        return None
    token = token_for(ticket.report_link_id)
    path = f"/relatorio/{token}"
    return ReportLinkOut(
        token=token,
        path=path,
        url=f"{settings.WEB_URL.rstrip('/')}{path}",
        created_at=ticket.report_link_created_at,
        views=ticket.report_views or 0,
        last_viewed_at=ticket.report_last_viewed_at,
    )


# --------------------------------------------------------------------------- gestão do link


def assign_on_finish(ticket: Ticket, now: datetime) -> None:
    """Na conclusão (dentro da mudança de status): cria o link se ainda não houver."""
    if ticket.report_link_id is None:
        ticket.report_link_id = new_link_id()
        ticket.report_link_created_at = now


async def _store(
    db: AsyncSession, ticket: Ticket, link_id: str | None, now: datetime | None
) -> None:
    """Grava o link sem mexer na versão nem no "atualizado em" da OS (não é edição da OS)."""
    await db.execute(
        update(Ticket)
        .where(Ticket.id == ticket.id)
        .values(
            report_link_id=link_id,
            report_link_created_at=now,
            report_views=0,
            report_last_viewed_at=None,
            updated_at=Ticket.updated_at,
        )
        .execution_options(synchronize_session=False)
    )
    for key, value in (
        ("report_link_id", link_id),
        ("report_link_created_at", now),
        ("report_views", 0),
        ("report_last_viewed_at", None),
    ):
        set_committed_value(ticket, key, value)


async def ensure_link(db: AsyncSession, ticket: Ticket) -> ReportLinkOut:
    if ticket.status not in FINISHED:
        raise WorkflowError(NOT_FINISHED)
    if ticket.report_link_id is None:
        await _store(db, ticket, new_link_id(), utcnow())
    out = link_out(ticket)
    assert out is not None
    return out


async def rotate_link(db: AsyncSession, ticket: Ticket) -> ReportLinkOut:
    """Novo link (o anterior para de funcionar)."""
    if ticket.status not in FINISHED:
        raise WorkflowError(NOT_FINISHED)
    await _store(db, ticket, new_link_id(), utcnow())
    out = link_out(ticket)
    assert out is not None
    return out


async def revoke_link(db: AsyncSession, ticket: Ticket) -> None:
    if ticket.report_link_id is not None:
        await _store(db, ticket, None, None)


async def url_if_finished(db: AsyncSession, ticket: Ticket) -> str | None:
    """Link do relatório para os textos do WhatsApp (cria na hora para OS antigas)."""
    if ticket.status not in FINISHED:
        return None
    return (await ensure_link(db, ticket)).url


# --------------------------------------------------------------------------- página pública


async def ticket_for_token(db: AsyncSession, token: str) -> Ticket:
    link_id = parse_token(token)
    if link_id is None:
        raise ReportUnavailable
    ticket = await db.scalar(select(Ticket).where(Ticket.report_link_id == link_id))
    if ticket is None:
        raise ReportUnavailable
    if ticket.status not in FINISHED:
        raise ReportReopened
    return ticket


async def register_view(db: AsyncSession, ticket: Ticket, now: datetime) -> None:
    await db.execute(
        update(Ticket)
        .where(Ticket.id == ticket.id)
        .values(
            report_views=Ticket.report_views + 1,
            report_last_viewed_at=now,
            updated_at=Ticket.updated_at,
        )
        .execution_options(synchronize_session=False)
    )


def _number(value: Any) -> str:
    number = float(value)
    if number.is_integer():
        return str(int(number))
    return f"{number:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def format_answer(field: FormField, value: Any) -> str | None:
    """Resposta legível para o cliente (Sim/Não, data no formato brasileiro...)."""
    if value is None or value == "" or value == []:
        return None
    if field.type == "yes_no":
        return "Sim" if value is True else "Não" if value is False else None
    if field.type == "confirm":
        return "Confirmado" if value is True else None
    if field.type == "number":
        try:
            return _number(value)
        except (TypeError, ValueError):
            return str(value)
    if field.type == "multi_choice":
        return ", ".join(str(v) for v in value) if isinstance(value, list) else str(value)
    if field.type == "date":
        text = str(value)
        if len(text) == 10 and text[4] == "-" and text[7] == "-":
            return f"{text[8:10]}/{text[5:7]}/{text[0:4]}"
        return text
    return str(value)


def _photo(att: TicketAttachment, base_url: str) -> PublicReportPhoto:
    if att.external_url:
        # Arquivo migrado (Field Control) que continua no armazenamento de origem.
        return PublicReportPhoto(
            url=att.external_url,
            filename=att.filename,
            taken_at=att.created_at,
            caption=att.description,
        )
    token = create_download_token(str(att.id), "client-report", minutes=PHOTO_LINK_MINUTES)
    return PublicReportPhoto(
        url=f"{base_url}{settings.API_PREFIX}/attachments/{att.id}/download?token={token}",
        filename=att.filename,
        taken_at=att.created_at,
        caption=att.description,
    )


def _last_before(
    events: list[TicketEvent], target: S, limit: datetime | None
) -> TicketEvent | None:
    found = None
    for ev in events:
        if limit is not None and ev.created_at > limit:
            break
        if ev.to_value == target.value:
            found = ev
    return found


def _arrival_minutes(ticket: Ticket) -> int | None:
    """Da solicitação (ou da autorização do cliente) até o técnico chegar."""
    start = field_rules.clock_start(ticket)
    if ticket.arrived_at is None or start is None:
        return None
    return max(0, int((ticket.arrived_at - start).total_seconds() // 60))


async def build(db: AsyncSession, ticket: Ticket, base_url: str) -> PublicReport:
    now = utcnow()
    company = await company_svc.profile(db)
    base_url = (settings.API_PUBLIC_URL or base_url).rstrip("/")

    attachments = list(
        await db.scalars(
            select(TicketAttachment)
            .where(TicketAttachment.ticket_id == ticket.id)
            .order_by(TicketAttachment.created_at)
        )
    )
    by_field: dict[tuple[uuid.UUID, str], list[TicketAttachment]] = {}
    loose: list[TicketAttachment] = []
    signature_att: TicketAttachment | None = None
    for att in attachments:
        if ticket.signature_attachment_id is not None and att.id == ticket.signature_attachment_id:
            signature_att = att
        elif att.form_id is not None and att.field_id:
            by_field.setdefault((att.form_id, att.field_id), []).append(att)
        elif att.kind == "photo" and att.form_id is None:
            loose.append(att)

    forms: list[PublicReportForm] = []
    for form in ticket.forms:
        items: list[PublicReportFormItem] = []
        has_content = False
        for raw in form.fields:
            field = FormField.model_validate(raw)
            if field.type == "section":
                items.append(PublicReportFormItem(label=field.label, type="section"))
                continue
            photos = [_photo(a, base_url) for a in by_field.get((form.id, field.id), [])]
            value = (
                None if field.type == "photo" else format_answer(field, form.answers.get(field.id))
            )
            has_content = has_content or bool(photos) or value is not None
            items.append(
                PublicReportFormItem(label=field.label, type=field.type, value=value, photos=photos)
            )
        if has_content:
            forms.append(
                PublicReportForm(name=form.name, completed_at=form.completed_at, items=items)
            )

    events = list(
        await db.scalars(
            select(TicketEvent)
            .where(
                TicketEvent.ticket_id == ticket.id,
                TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
            )
            .order_by(TicketEvent.created_at)
        )
    )
    # A última visita é a que concluiu a OS (antes dela pode ter havido improdutivas).
    finished_ev = _last_before(events, S.RESOLVED, None)
    finished_at = ticket.resolved_at or (finished_ev.created_at if finished_ev else None)
    arrive_ev = _last_before(events, S.IN_PROGRESS, finished_at)
    en_route_ev = _last_before(
        events, S.EN_ROUTE, arrive_ev.created_at if arrive_ev else finished_at
    )
    scheduled_ev = _last_before(
        events,
        S.SCHEDULED,
        (en_route_ev or arrive_ev).created_at if (en_route_ev or arrive_ev) else finished_at,
    )
    check_in_gps = any(
        ev is not None and "latitude" in (ev.data or {}) for ev in (arrive_ev, en_route_ev)
    )

    milestones = [PublicReportMilestone(at=ticket.created_at, label="Aberta")]
    for ev, label in (
        (scheduled_ev, "Agendada"),
        (en_route_ev, "Técnico a caminho"),
        (arrive_ev, "Chegada ao local"),
    ):
        if ev is not None:
            milestones.append(PublicReportMilestone(at=ev.created_at, label=label))
    if finished_at is not None:
        milestones.append(PublicReportMilestone(at=finished_at, label="Concluída"))
    if ticket.closed_at is not None:
        milestones.append(PublicReportMilestone(at=ticket.closed_at, label="Encerrada"))
    milestones.sort(key=lambda m: m.at)

    loc = ticket.location
    location = None
    if loc is not None:
        location = PublicReportLocation(
            name=loc.name,
            code=loc.code,
            address=", ".join(p for p in (loc.address_line, loc.district) if p) or None,
            city=loc.city,
            state=loc.state,
            zip_code=loc.zip_code,
            contact_name=loc.contact_name,
            contact_phone=loc.contact_phone,
        )
    signature = None
    if ticket.signed_at is not None:
        signature = PublicReportSignature(
            name=ticket.signer_name,
            role=ticket.signer_role,
            signed_at=ticket.signed_at,
            image_url=_photo(signature_att, base_url).url if signature_att else None,
        )

    return PublicReport(
        code=format_ticket_code(ticket.number),
        number=ticket.number,
        title=ticket.title,
        description=ticket.description or "",
        status=ticket.status,
        status_label=STATUS_INFO[ticket.status].label,
        company_name=company.name,
        company=company,
        customer=(
            PublicReportCustomer(
                name=ticket.customer.name,
                document=ticket.customer.document,
                email=ticket.customer.email,
                phone=ticket.customer.phone,
            )
            if ticket.customer
            else None
        ),
        location=location,
        service_address=ticket.service_address,
        requester_name=ticket.requester_name,
        service_type=ticket.service_type.name if ticket.service_type else None,
        technician=PublicReportPerson(name=ticket.assignee.name) if ticket.assignee else None,
        helpers=[PublicReportPerson(name=h.name) for h in ticket.helpers],
        opened_at=ticket.created_at,
        scheduled_start=ticket.scheduled_start,
        scheduled_end=ticket.scheduled_end,
        en_route_at=en_route_ev.created_at if en_route_ev else None,
        arrived_at=arrive_ev.created_at if arrive_ev else None,
        finished_at=finished_at,
        closed_at=ticket.closed_at,
        on_site_minutes=(ticket.work_seconds // 60) if ticket.work_seconds else None,
        arrival_due_at=ticket.arrival_due_at,
        arrival_minutes=_arrival_minutes(ticket),
        arrival_on_time=(
            ticket.arrived_at <= ticket.arrival_due_at
            if ticket.arrived_at and ticket.arrival_due_at
            else None
        ),
        check_in_gps=check_in_gps,
        resolution_notes=ticket.resolution_notes,
        forms=forms,
        photos=[_photo(a, base_url) for a in loose],
        signature=signature,
        timeline=milestones,
        generated_at=now,
    )
