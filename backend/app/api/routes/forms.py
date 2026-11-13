import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, Response, UploadFile, status
from sqlalchemy import select

from app.api.deps import DB, CurrentUser, TicketManagerUser
from app.api.routes.tickets import _attachment_out, _detail
from app.models import FormTemplate, TicketAttachment
from app.schemas.forms import (
    FormCatalog,
    FormTemplateIn,
    FormTemplateOut,
    TicketFormAdd,
    TicketFormAnswers,
    TicketFormOut,
    TicketFormUpdate,
    field_type_catalog,
)
from app.schemas.ticket import AttachmentOut, TicketDetail
from app.services import forms as svc
from app.services import tickets as tickets_svc
from app.services.errors import NotFound
from app.services.realtime import commit_and_publish

router = APIRouter(tags=["forms"])


# ------------------------------------------------------------------ modelos


@router.get("/form-templates/catalog", response_model=FormCatalog)
async def catalog(_: TicketManagerUser) -> FormCatalog:
    return field_type_catalog()


@router.get("/form-templates", response_model=list[FormTemplateOut])
async def list_templates(
    db: DB, _: TicketManagerUser, active: bool | None = None
) -> list[FormTemplate]:
    stmt = select(FormTemplate).order_by(FormTemplate.name)
    if active is not None:
        stmt = stmt.where(FormTemplate.is_active.is_(active))
    return list(await db.scalars(stmt))


@router.post("/form-templates", response_model=FormTemplateOut, status_code=status.HTTP_201_CREATED)
async def create_template(body: FormTemplateIn, db: DB, user: TicketManagerUser) -> FormTemplate:
    template = await svc.create_template(db, body, user)
    await db.commit()
    return template


@router.get("/form-templates/{template_id}", response_model=FormTemplateOut)
async def get_template(template_id: uuid.UUID, db: DB, _: TicketManagerUser) -> FormTemplate:
    return await svc.get_template(db, template_id)


@router.put("/form-templates/{template_id}", response_model=FormTemplateOut)
async def update_template(
    template_id: uuid.UUID,
    body: FormTemplateIn,
    db: DB,
    _: TicketManagerUser,
    apply_to_pending: bool = False,
) -> FormTemplateOut:
    """Salva o modelo. Com `apply_to_pending`, a correção chega também às OS em que o formulário
    ainda não começou (`applied_to` diz quantas)."""
    template = await svc.update_template(db, await svc.get_template(db, template_id), body)
    applied = await svc.apply_to_pending(db, template) if apply_to_pending else None
    await db.commit()
    out = FormTemplateOut.model_validate(template)
    out.applied_to = applied
    return out


# ------------------------------------------------------------- formulário na OS


@router.get("/tickets/{ticket_id}/forms/suggestions", response_model=list[FormTemplateOut])
async def suggestions(ticket_id: uuid.UUID, db: DB, user: TicketManagerUser) -> list[FormTemplate]:
    """Modelos ligados ao tipo de serviço da OS (a gestão decide se anexa)."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    return await svc.suggestions(db, ticket)


@router.post(
    "/tickets/{ticket_id}/forms", response_model=TicketFormOut, status_code=status.HTTP_201_CREATED
)
async def add_form(
    ticket_id: uuid.UUID, body: TicketFormAdd, db: DB, user: TicketManagerUser
) -> TicketFormOut:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    form = await svc.add_to_ticket(db, ticket, body, user)
    await commit_and_publish(db)
    return TicketFormOut.model_validate(form)


@router.patch("/tickets/{ticket_id}/forms/{form_id}", response_model=TicketFormOut)
async def update_form(
    ticket_id: uuid.UUID,
    form_id: uuid.UUID,
    body: TicketFormUpdate,
    db: DB,
    user: TicketManagerUser,
) -> TicketFormOut:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    form = await svc.set_required(
        db, ticket, await svc.get_ticket_form(db, ticket, form_id), body.required, user
    )
    await commit_and_publish(db)
    return TicketFormOut.model_validate(form)


@router.delete("/tickets/{ticket_id}/forms/{form_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_form(
    ticket_id: uuid.UUID, form_id: uuid.UUID, db: DB, user: TicketManagerUser
) -> Response:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    await svc.remove_from_ticket(db, ticket, await svc.get_ticket_form(db, ticket, form_id), user)
    await commit_and_publish(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/tickets/{ticket_id}/forms/{form_id}/answers", response_model=TicketFormOut)
async def save_answers(
    ticket_id: uuid.UUID, form_id: uuid.UUID, body: TicketFormAnswers, db: DB, user: CurrentUser
) -> TicketFormOut:
    """Salvar respostas (parcial). Com `complete: true`, valida e conclui o formulário."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    form = await svc.get_ticket_form(db, ticket, form_id)
    # Grava as respostas primeiro: se faltar foto ou obrigatório para concluir, o que o
    # técnico já respondeu não se perde (a conclusão é que volta com o 422).
    await svc.save_partial(db, ticket, form, body.answers, user)
    await commit_and_publish(db)
    if body.complete:
        await svc.complete(db, ticket, form, user)
        await commit_and_publish(db)
    return TicketFormOut.model_validate(form)


@router.post(
    "/tickets/{ticket_id}/forms/{form_id}/photos",
    response_model=AttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_photo(
    ticket_id: uuid.UUID,
    form_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    file: Annotated[UploadFile, File()],
    field_id: Annotated[str, Form()],
) -> AttachmentOut:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    form = await svc.get_ticket_form(db, ticket, form_id)
    attachment = await svc.add_photo(db, ticket, form, field_id, file, user)
    await commit_and_publish(db)
    return _attachment_out(attachment, user)


@router.delete(
    "/tickets/{ticket_id}/forms/{form_id}/photos/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_photo(
    ticket_id: uuid.UUID, form_id: uuid.UUID, attachment_id: uuid.UUID, db: DB, user: CurrentUser
) -> Response:
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    attachment = await db.get(TicketAttachment, attachment_id)
    if attachment is None or attachment.ticket_id != ticket.id or attachment.form_id != form_id:
        raise NotFound("Foto não encontrada")
    await svc.remove_photo(db, ticket, attachment, user)
    await commit_and_publish(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/tickets/{ticket_id}/signature", response_model=TicketDetail)
async def collect_signature(
    ticket_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    file: Annotated[UploadFile, File()],
    signer_name: Annotated[str, Form(max_length=160)],
    signer_role: Annotated[str | None, Form(max_length=120)] = None,
    latitude: Annotated[float | None, Form(ge=-90, le=90)] = None,
    longitude: Annotated[float | None, Form(ge=-180, le=180)] = None,
) -> TicketDetail:
    """Assinatura do responsável no local (imagem). Exige os formulários obrigatórios concluídos."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    await svc.collect_signature(
        db, ticket, file, signer_name, signer_role, latitude, longitude, user
    )
    await commit_and_publish(db)
    return await _detail(db, ticket_id, user)
