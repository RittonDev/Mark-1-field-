"""Formulários da OS: modelos, anexar/remover, respostas, fotos por campo e assinatura.

Regras:
- Só a gestão (analistas, supervisores, admin) monta modelos e decide anexar à OS, como
  obrigatório ou opcional. O técnico responsável preenche no app.
- Concluir o formulário valida os campos obrigatórios e o mínimo de fotos de cada campo.
- A assinatura do responsável no local só pode ser colhida com os obrigatórios concluídos.
- A OS só é concluída (Resolvido/Fechado) com os obrigatórios concluídos e, se exigida,
  com a assinatura. Depois da assinatura, o técnico não altera mais os formulários.
"""

import datetime as dt
import uuid
from typing import Any

from fastapi import UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import FormStatus, TicketEventType, TicketStatus
from app.db.base import utcnow
from app.models import FormTemplate, Ticket, TicketAttachment, TicketForm, User
from app.schemas.forms import FormField, FormTemplateIn, TicketFormAdd, TicketFormAnswers
from app.services.errors import NotFound, PermissionDenied, WorkflowError
from app.services.realtime import queue_event
from app.services.tickets import _touch, add_attachment, can_edit, record_event

CLOSED_STATES = (TicketStatus.RESOLVED, TicketStatus.CLOSED, TicketStatus.CANCELLED)


# ------------------------------------------------------------------ modelos


async def get_template(db: AsyncSession, template_id: uuid.UUID) -> FormTemplate:
    template = await db.get(FormTemplate, template_id)
    if template is None:
        raise NotFound("Modelo de formulário não encontrado")
    return template


def _dump(data: FormTemplateIn) -> dict[str, Any]:
    return {
        "name": data.name.strip(),
        "description": (data.description or "").strip() or None,
        "fields": [f.model_dump() for f in data.fields],
        "service_type_ids": [str(i) for i in data.service_type_ids],
        "requires_signature": data.requires_signature,
        "is_active": data.is_active,
    }


async def create_template(db: AsyncSession, data: FormTemplateIn, actor: User) -> FormTemplate:
    template = FormTemplate(id=uuid.uuid4(), version=1, created_by_id=actor.id, **_dump(data))
    db.add(template)
    await db.flush()
    return template


async def update_template(
    db: AsyncSession, template: FormTemplate, data: FormTemplateIn
) -> FormTemplate:
    values = _dump(data)
    if values["fields"] != template.fields:
        template.version += 1  # as OS já anexadas guardam a versão antiga
    for key, value in values.items():
        setattr(template, key, value)
    await db.flush()
    return template


# ------------------------------------------------------------- formulário na OS


def _require_manager(actor: User) -> None:
    if not actor.can_manage_tickets:
        raise PermissionDenied("Só analistas e gestores decidem os formulários da OS")


async def get_ticket_form(db: AsyncSession, ticket: Ticket, form_id: uuid.UUID) -> TicketForm:
    form = await db.get(TicketForm, form_id)
    if form is None or form.ticket_id != ticket.id:
        raise NotFound("Formulário não encontrado nesta OS")
    return form


async def suggestions(db: AsyncSession, ticket: Ticket) -> list[FormTemplate]:
    """Modelos ativos ligados ao tipo de serviço da OS que ainda não foram anexados."""
    if ticket.service_type_id is None:
        return []
    attached = {f.template_id for f in ticket.forms}
    rows = await db.scalars(
        select(FormTemplate).where(
            FormTemplate.is_active.is_(True),
            FormTemplate.service_type_ids.contains([str(ticket.service_type_id)]),
        )
    )
    return [t for t in rows if t.id not in attached]


async def add_to_ticket(
    db: AsyncSession, ticket: Ticket, data: TicketFormAdd, actor: User
) -> TicketForm:
    _require_manager(actor)
    if ticket.status in CLOSED_STATES:
        raise WorkflowError("OS concluída ou cancelada não recebe formulário")
    template = await get_template(db, data.template_id)
    if not template.is_active:
        raise WorkflowError("Modelo de formulário inativo")
    if any(f.template_id == template.id for f in ticket.forms):
        raise WorkflowError("Este formulário já está na OS")
    form = TicketForm(
        id=uuid.uuid4(),
        ticket_id=ticket.id,
        template_id=template.id,
        template_version=template.version,
        name=template.name,
        fields=template.fields,
        required=data.required,
        status=FormStatus.PENDING,
        answers={},
        added_by_id=actor.id,
    )
    db.add(form)
    if data.required and template.requires_signature:
        ticket.signature_required = True
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.FORM_ADDED,
        to_value=template.name[:64],
        data={"form_id": str(form.id), "required": data.required},
    )
    await _touch(db, ticket, utcnow())  # o app recebe a mudança no próximo sync
    queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
    await db.flush()
    return form


async def set_required(
    db: AsyncSession, ticket: Ticket, form: TicketForm, required: bool, actor: User
) -> TicketForm:
    _require_manager(actor)
    form.required = required
    await _touch(db, ticket, utcnow())  # o app recebe a mudança no próximo sync
    queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
    await db.flush()
    return form


async def remove_from_ticket(
    db: AsyncSession, ticket: Ticket, form: TicketForm, actor: User
) -> None:
    _require_manager(actor)
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.FORM_REMOVED,
        from_value=form.name[:64],
        data={"form_id": str(form.id)},
    )
    await db.delete(form)  # as fotos do formulário saem junto (cascade)
    await _touch(db, ticket, utcnow())  # o app recebe a mudança no próximo sync
    queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
    await db.flush()


def locked_for(ticket: Ticket, actor: User) -> bool:
    """Depois da assinatura (ou da OS concluída) só a gestão mexe nos formulários."""
    if actor.can_manage_tickets:
        return False
    return ticket.signed_at is not None or ticket.status in CLOSED_STATES


def _ensure_can_fill(ticket: Ticket, actor: User) -> None:
    if not can_edit(actor, ticket):
        raise PermissionDenied("Só o técnico responsável ou a gestão preenche o formulário")
    if locked_for(ticket, actor):
        raise WorkflowError("A assinatura já foi colhida: o formulário não pode mais ser alterado")


def _clean_value(field: FormField, value: Any) -> Any:
    """Valida o tipo da resposta; vazio volta None (remove a resposta)."""
    if value is None or value == "" or value == []:
        return None
    label = field.label
    if field.type in ("text", "textarea"):
        if not isinstance(value, str):
            raise WorkflowError(f'"{label}": resposta deve ser texto')
        text = value.strip()
        if len(text) > 5000:
            raise WorkflowError(f'"{label}": texto muito longo')
        return text or None
    if field.type == "number":
        try:
            return float(str(value).replace(",", "."))
        except ValueError as exc:
            raise WorkflowError(f'"{label}": informe um número') from exc
    if field.type in ("yes_no", "confirm"):
        if not isinstance(value, bool):
            raise WorkflowError(f'"{label}": resposta deve ser sim ou não')
        return value
    if field.type == "choice":
        if value not in field.options:
            raise WorkflowError(f'"{label}": opção inválida')
        return value
    if field.type == "multi_choice":
        if not isinstance(value, list) or any(v not in field.options for v in value):
            raise WorkflowError(f'"{label}": opção inválida')
        return [o for o in field.options if o in value]
    if field.type == "date":
        try:
            return dt.date.fromisoformat(str(value)).isoformat()
        except ValueError as exc:
            raise WorkflowError(f'"{label}": data inválida') from exc
    raise WorkflowError(f'"{label}" não recebe resposta escrita')


async def photo_counts(db: AsyncSession, form_id: uuid.UUID) -> dict[str, int]:
    rows = await db.execute(
        select(TicketAttachment.field_id, func.count())
        .where(TicketAttachment.form_id == form_id)
        .group_by(TicketAttachment.field_id)
    )
    return {field_id: count for field_id, count in rows if field_id}


def _answered(field: FormField, value: Any) -> bool:
    if field.type == "confirm":
        return value is True
    return value is not None and value != "" and value != []


async def missing_items(db: AsyncSession, form: TicketForm) -> list[str]:
    counts = await photo_counts(db, form.id)
    missing = []
    for raw in form.fields:
        field = FormField.model_validate(raw)
        if field.type == "section":
            continue
        if field.type == "photo":
            need = max(field.min_photos, 1 if field.required else 0)
            if counts.get(field.id, 0) < need:
                missing.append(f"{field.label} ({need} foto{'s' if need > 1 else ''})")
        elif field.required and not _answered(field, form.answers.get(field.id)):
            missing.append(field.label)
    return missing


async def save_answers(
    db: AsyncSession, ticket: Ticket, form: TicketForm, data: TicketFormAnswers, actor: User
) -> TicketForm:
    """Grava as respostas (parcial). Com `complete`, tenta concluir em seguida: se faltar algo,
    levanta FormIncomplete, mas quem chama pode gravar as respostas antes (ver a rota)."""
    await save_partial(db, ticket, form, data.answers, actor)
    if data.complete:
        await complete(db, ticket, form, actor)
    return form


class FormIncomplete(WorkflowError):
    """Faltam obrigatórios ou fotos para concluir (as respostas enviadas já foram aceitas)."""


async def save_partial(
    db: AsyncSession, ticket: Ticket, form: TicketForm, values: dict[str, Any], actor: User
) -> TicketForm:
    _ensure_can_fill(ticket, actor)
    fields = {f["id"]: FormField.model_validate(f) for f in form.fields}
    answers = dict(form.answers or {})
    for key, value in values.items():
        field = fields.get(key)
        if field is None or field.type in ("section", "photo"):
            continue  # campo que não existe (versão antiga do app) ou foto (vai como anexo)
        cleaned = _clean_value(field, value)
        if cleaned is None:
            answers.pop(key, None)
        else:
            answers[key] = cleaned
    changed = answers != (form.answers or {})
    form.answers = answers
    if changed or form.status != FormStatus.COMPLETED:
        # Mudou depois de concluído: precisa concluir de novo.
        has_photos = bool(await photo_counts(db, form.id))
        form.status = FormStatus.IN_PROGRESS if answers or has_photos else FormStatus.PENDING
        form.completed_at = None
        form.completed_by_id = None
    await _touch(db, ticket, utcnow())  # o app recebe a mudança no próximo sync
    queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
    await db.flush()
    return form


async def complete(db: AsyncSession, ticket: Ticket, form: TicketForm, actor: User) -> TicketForm:
    _ensure_can_fill(ticket, actor)
    missing = await missing_items(db, form)
    if missing:
        raise FormIncomplete("Falta preencher: " + "; ".join(missing))
    if form.status != FormStatus.COMPLETED:
        record_event(
            db,
            ticket,
            actor,
            TicketEventType.FORM_COMPLETED,
            to_value=form.name[:64],
            data={"form_id": str(form.id)},
        )
    form.status = FormStatus.COMPLETED
    form.completed_at = utcnow()
    form.completed_by_id = actor.id
    await _touch(db, ticket, utcnow())  # o app recebe a mudança no próximo sync
    queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
    await db.flush()
    return form


async def add_photo(
    db: AsyncSession,
    ticket: Ticket,
    form: TicketForm,
    field_id: str,
    upload: UploadFile,
    actor: User,
) -> TicketAttachment:
    _ensure_can_fill(ticket, actor)
    field = next(
        (FormField.model_validate(f) for f in form.fields if f.get("id") == field_id), None
    )
    if field is None or field.type != "photo":
        raise WorkflowError("Campo de foto não encontrado no formulário")
    if (await photo_counts(db, form.id)).get(field_id, 0) >= field.max_photos:
        raise WorkflowError(f'"{field.label}": no máximo {field.max_photos} foto(s)')
    if not (upload.content_type or "").startswith("image/"):
        raise WorkflowError("Envie uma imagem")
    attachment = await add_attachment(db, ticket, upload, "photo", actor)
    attachment.form_id = form.id
    attachment.field_id = field_id
    if form.status == FormStatus.PENDING:
        form.status = FormStatus.IN_PROGRESS
    elif form.status == FormStatus.COMPLETED and not actor.can_manage_tickets:
        form.status = FormStatus.IN_PROGRESS  # mudou depois de concluído: concluir de novo
        form.completed_at = None
    await db.flush()
    return attachment


async def remove_photo(
    db: AsyncSession, ticket: Ticket, attachment: TicketAttachment, actor: User
) -> None:
    if attachment.form_id is None:
        raise WorkflowError("Só fotos de formulário podem ser removidas por aqui")
    _ensure_can_fill(ticket, actor)
    if not actor.can_manage_tickets and attachment.uploaded_by_id != actor.id:
        raise PermissionDenied("Você só remove as fotos que enviou")
    form = await db.get(TicketForm, attachment.form_id)
    await db.delete(attachment)
    if form is not None and form.status == FormStatus.COMPLETED:
        form.status = FormStatus.IN_PROGRESS
        form.completed_at = None
    await _touch(db, ticket, utcnow())  # o app recebe a mudança no próximo sync
    queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
    await db.flush()


# ----------------------------------------------------------- conclusão e assinatura


def _pending_required(ticket: Ticket) -> list[str]:
    return [f.name for f in ticket.forms if f.required and f.status != FormStatus.COMPLETED]


async def collect_signature(
    db: AsyncSession,
    ticket: Ticket,
    upload: UploadFile,
    signer_name: str,
    signer_role: str | None,
    latitude: float | None,
    longitude: float | None,
    actor: User,
) -> Ticket:
    if not can_edit(actor, ticket):
        raise PermissionDenied("Só o técnico responsável ou a gestão colhe a assinatura")
    if ticket.status in CLOSED_STATES:
        raise WorkflowError("A OS já foi concluída")
    pending = _pending_required(ticket)
    if pending:
        raise WorkflowError(
            "Preencha o formulário antes de colher a assinatura: " + ", ".join(pending)
        )
    name = " ".join(signer_name.split())
    if len(name) < 3:
        raise WorkflowError("Informe o nome de quem assina")
    if (upload.content_type or "") not in ("image/png", "image/jpeg", "image/webp"):
        raise WorkflowError("A assinatura deve ser uma imagem PNG ou JPG")
    attachment = await add_attachment(db, ticket, upload, "signature", actor)
    ticket.signer_name = name[:160]
    ticket.signer_role = (signer_role or "").strip()[:120] or None
    ticket.signed_at = utcnow()
    ticket.signature_attachment_id = attachment.id
    data: dict[str, Any] = {"attachment_id": str(attachment.id)}
    if latitude is not None and longitude is not None:
        data.update(latitude=latitude, longitude=longitude)
    record_event(
        db, ticket, actor, TicketEventType.SIGNATURE_COLLECTED, to_value=name[:64], data=data
    )
    queue_event(db, "updated", ticket, actor, {"fields": ["signature"]})
    await db.flush()
    return ticket
