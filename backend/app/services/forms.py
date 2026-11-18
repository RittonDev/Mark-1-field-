"""Formulários da OS: modelos, anexar/remover, respostas, fotos por campo e assinatura.

Regras:
- Só a gestão (analistas, supervisores, admin) monta modelos e decide anexar à OS, como
  obrigatório ou opcional. O técnico responsável preenche no app.
- O modelo ligado a um tipo de OS ou a uma categoria (valendo as subcategorias) entra sozinho
  nas OS: na abertura sem lista explícita e, antes da visita, quando o tipo ou a categoria mudam.
  Sai sozinho só o que entrou sozinho, não casa mais e ninguém começou; o que uma pessoa tirou da
  OS (ou deixou de fora na abertura) não volta sozinho.
- Concluir o formulário valida os campos obrigatórios e o mínimo de fotos de cada campo, e grava
  a resposta automática (services/form_prefill.py) das perguntas que ficaram sem resposta.
- A assinatura do responsável no local só pode ser colhida com os obrigatórios concluídos.
- A OS só é concluída (Resolvido/Fechado) com os obrigatórios concluídos e, se exigida,
  com a assinatura. Depois da assinatura, o técnico não altera mais os formulários.
"""

import datetime as dt
import math
import uuid
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from fastapi import UploadFile
from sqlalchemy import and_, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import FormStatus, TicketEventType, TicketStatus
from app.db.base import utcnow
from app.models import (
    Category,
    FormTemplate,
    ServiceType,
    Ticket,
    TicketAttachment,
    TicketEvent,
    TicketForm,
    User,
)
from app.schemas.common import Ref
from app.schemas.forms import (
    FormField,
    FormTemplateIn,
    ServiceTypeUsage,
    TicketFormAdd,
    TicketFormAnswers,
    field_dump,
)
from app.services import storage
from app.services.errors import NotFound, PermissionDenied, WorkflowError
from app.services.form_prefill import prefill_for
from app.services.realtime import queue_event
from app.services.tickets import _touch, add_attachment, can_work, get_ticket, record_event

CLOSED_STATES = (TicketStatus.RESOLVED, TicketStatus.CLOSED, TicketStatus.CANCELLED)
FINISHED_STATES = (TicketStatus.RESOLVED, TicketStatus.CLOSED)
PHOTO_TYPES = "Envie uma foto JPG, PNG ou WebP"


async def _image_head(upload: UploadFile) -> bytes:
    """Primeiros bytes do arquivo (o tipo real), sem consumir o upload."""
    head = await upload.read(16)
    await upload.seek(0)
    return head


def _is_photo(head: bytes) -> bool:
    """Foto de verdade pelo conteúdo: JPG, PNG ou WebP, os formatos que a tela, o relatório do
    cliente e o PDF mostram. Arquivo qualquer enviado como "image/*" (ou HEIC, que o navegador
    não abre) não passa: a foto quebrada no relatório só seria notada pelo cliente."""
    return storage.image_extension(head) is not None


# ------------------------------------------------------------------ modelos


async def get_template(db: AsyncSession, template_id: uuid.UUID) -> FormTemplate:
    template = await db.get(FormTemplate, template_id)
    if template is None:
        raise NotFound("Modelo de formulário não encontrado")
    return template


def _id_list(values: Iterable[uuid.UUID]) -> list[str]:
    """Ids sem repetição, na ordem, como texto (o JSONB do modelo guarda texto)."""
    return [str(i) for i in dict.fromkeys(values)]


def _dump(data: FormTemplateIn) -> dict[str, Any]:
    values: dict[str, Any] = {
        "name": data.name.strip(),
        "description": (data.description or "").strip() or None,
        "fields": [field_dump(f) for f in data.fields],
        "service_type_ids": _id_list(data.service_type_ids),
        "requires_signature": data.requires_signature,
        "is_active": data.is_active,
    }
    # Sem informar, o PUT mantém o que o modelo tem: o desativar da lista, ou uma aba aberta antes
    # destes campos existirem, não apagam as categorias nem o padrão de obrigatório.
    if data.category_ids is not None:
        values["category_ids"] = _id_list(data.category_ids)
    if data.default_required is not None:
        values["default_required"] = data.default_required
    return values


async def create_template(db: AsyncSession, data: FormTemplateIn, actor: User) -> FormTemplate:
    values = {"category_ids": [], "default_required": True, **_dump(data)}
    template = FormTemplate(id=uuid.uuid4(), version=1, created_by_id=actor.id, **values)
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


async def apply_to_pending(db: AsyncSession, template: FormTemplate) -> int:
    """Leva o modelo corrigido às OS em que o formulário nem começou: pendente, sem resposta e
    sem foto, em OS não encerrada. As outras ficam com a versão que o técnico já está usando.
    Devolve quantas mudaram."""
    has_photos = exists().where(TicketAttachment.form_id == TicketForm.id)
    forms = list(
        await db.scalars(
            select(TicketForm)
            .join(Ticket, Ticket.id == TicketForm.ticket_id)
            .where(
                TicketForm.template_id == template.id,
                TicketForm.status == FormStatus.PENDING,
                Ticket.status.not_in(CLOSED_STATES),
                ~has_photos,
            )
        )
    )
    changed = [
        f
        for f in forms
        if not f.answers
        and (
            f.template_version != template.version
            or f.fields != template.fields
            or f.name != template.name
        )
    ]
    for form in changed:
        form.fields = template.fields
        form.name = template.name
        form.template_version = template.version
    ticket_ids = list({f.ticket_id for f in changed})
    if ticket_ids:
        now = utcnow()
        required_ids = [f.ticket_id for f in changed if f.required]
        if template.requires_signature and required_ids:
            # Modelo que passou a pedir assinatura: a OS (ainda sem assinatura) passa a exigir.
            await db.execute(
                update(Ticket)
                .where(Ticket.id.in_(required_ids), Ticket.signed_at.is_(None))
                .values(signature_required=True, updated_at=now)
                .execution_options(synchronize_session=False)
            )
        # O app baixa as OS de novo pelo "atualizado em" (sem mexer na versão).
        await db.execute(
            update(Ticket)
            .where(Ticket.id.in_(ticket_ids))
            .values(updated_at=now)
            .execution_options(synchronize_session=False)
        )
    await db.flush()
    return len(changed)


# --------------------------------------------- entram sozinhos (tipo de OS e categoria)

S = TicketStatus
# A OS muda sozinha só antes da visita: nova, triagem, atribuída, agendada ou a caminho, sem
# chegada. Em atendimento, pausada, reaberta, concluída ou cancelada, nada muda sem uma pessoa.
BEFORE_VISIT = frozenset({S.NEW, S.TRIAGE, S.ASSIGNED, S.SCHEDULED, S.EN_ROUTE})
# A categoria-mãe vale para as subcategorias até este nível (o limite da tela de Categorias).
CATEGORY_LEVELS = 10
TEMPLATE_UNLINKED = "O modelo não está mais ligado ao tipo nem à categoria desta OS"
# Histórico de uso do modelo ("Pelo histórico" no editor do formulário).
USAGE_DAYS = 365
USAGE_MIN = 3
USAGE_LIMIT = 10


def before_visit(ticket: Ticket) -> bool:
    return ticket.status in BEFORE_VISIT and ticket.arrived_at is None


@dataclass
class Linked:
    """Modelo que entra sozinho na OS e o motivo, que vai para o histórico."""

    template: FormTemplate
    reason: str


def _uuids(values: Iterable[Any] | None) -> list[uuid.UUID]:
    out: list[uuid.UUID] = []
    for value in values or []:
        try:
            out.append(uuid.UUID(str(value)))
        except ValueError:
            continue
    return out


async def category_line(db: AsyncSession, category_id: uuid.UUID) -> list[Category]:
    """A categoria e as de cima (pai, avô...), da mais próxima para a mais distante."""
    line: list[Category] = []
    node_id: uuid.UUID | None = category_id
    while node_id is not None and len(line) <= CATEGORY_LEVELS:
        if any(c.id == node_id for c in line):
            break  # ciclo (a API não deixa criar, mas não custa)
        node = await db.get(Category, node_id)
        if node is None:
            break
        line.append(node)
        node_id = node.parent_id
    return line


async def category_tree(db: AsyncSession, roots: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    """As categorias e todas as de baixo (filhas, netas...). Id de categoria apagada fica de
    fora. Carrega o id e o pai de todas as categorias de uma vez."""
    wanted = set(roots)
    if not wanted:
        return set()
    children: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    known: set[uuid.UUID] = set()
    for category_id, parent_id in await db.execute(select(Category.id, Category.parent_id)):
        known.add(category_id)
        if parent_id is not None:
            children[parent_id].append(category_id)
    found: set[uuid.UUID] = set()
    level = [c for c in wanted if c in known]
    depth = 0
    while level and depth <= CATEGORY_LEVELS:
        below: list[uuid.UUID] = []
        for category_id in level:
            if category_id not in found:
                found.add(category_id)
                below.extend(children.get(category_id, []))
        level = below
        depth += 1
    return found


def _reason(
    template: FormTemplate, service_type: ServiceType | None, line: Sequence[Category]
) -> str | None:
    """Por que o modelo entra: o tipo de OS vence; senão, a categoria ligada mais próxima."""
    if service_type is not None and str(service_type.id) in (template.service_type_ids or []):
        return f"Pelo tipo de OS “{service_type.name}”"
    linked = set(template.category_ids or [])
    for index, category in enumerate(line):
        if str(category.id) in linked:
            path = " > ".join(c.name for c in reversed(line[index:]))
            return f"Pela categoria “{path}”"
    return None


async def linked_templates(
    db: AsyncSession, *, service_type_id: uuid.UUID | None, category_id: uuid.UUID | None
) -> list[Linked]:
    """Modelos ativos que entram sozinhos numa OS com este tipo e esta categoria, em ordem de
    nome: o tipo está nos tipos do modelo, ou a categoria (ou uma acima dela) está nas categorias
    do modelo. Tipo e categoria somam. Recebe os ids: na edição da OS, a relação ainda aponta
    para o tipo antigo até gravar."""
    service_type = await db.get(ServiceType, service_type_id) if service_type_id else None
    line = await category_line(db, category_id) if category_id else []
    conditions = []
    if service_type is not None:
        conditions.append(FormTemplate.service_type_ids.contains([str(service_type.id)]))
    conditions.extend(FormTemplate.category_ids.contains([str(c.id)]) for c in line)
    if not conditions:
        return []
    rows = await db.scalars(
        select(FormTemplate)
        .where(FormTemplate.is_active.is_(True), or_(*conditions))
        .order_by(FormTemplate.name, FormTemplate.id)
    )
    out: list[Linked] = []
    for template in rows:
        reason = _reason(template, service_type, line)
        if reason is not None:
            out.append(Linked(template, reason))
    return out


async def left_out(db: AsyncSession, ticket_id: uuid.UUID) -> set[uuid.UUID]:
    """Modelos que uma pessoa decidiu tirar desta OS: removidos à mão (o evento tem autor) ou
    deixados de fora na abertura. Esses não voltam sozinhos."""
    rows = await db.execute(
        select(TicketEvent.event_type, TicketEvent.data).where(
            TicketEvent.ticket_id == ticket_id,
            or_(
                and_(
                    TicketEvent.event_type == TicketEventType.FORM_REMOVED,
                    TicketEvent.actor_id.is_not(None),
                ),
                TicketEvent.event_type == TicketEventType.CREATED,
            ),
        )
    )
    ids: list[Any] = []
    for event_type, data in rows:
        data = data if isinstance(data, dict) else {}
        if event_type == TicketEventType.FORM_REMOVED:
            ids.append(data.get("template_id"))
        else:
            ids.extend(data.get("forms_left_out") or [])
    return set(_uuids(i for i in ids if i))


async def untouched(db: AsyncSession, form: TicketForm) -> bool:
    """Ninguém começou o formulário: pendente, sem resposta e sem foto."""
    if form.status != FormStatus.PENDING or form.answers:
        return False
    return not await db.scalar(select(exists().where(TicketAttachment.form_id == form.id)))


async def resolve_create_list(
    db: AsyncSession, items: Sequence[TicketFormAdd] | None
) -> list[tuple[FormTemplate, bool]] | None:
    """A lista de formulários da abertura (modelo e obrigatório), validada antes de a OS ganhar
    número (a sequência do banco não volta): sem repetido, só modelos que existem e estão
    ativos. None: sem lista (entram os ligados ao tipo e à categoria)."""
    if items is None:
        return None
    ids = [item.template_id for item in items]
    if len(ids) != len(set(ids)):
        raise WorkflowError("Formulário repetido na lista")
    found: dict[uuid.UUID, FormTemplate] = {}
    if ids:
        found = {
            t.id: t for t in await db.scalars(select(FormTemplate).where(FormTemplate.id.in_(ids)))
        }
    chosen: list[tuple[FormTemplate, bool]] = []
    for item in items:
        template = found.get(item.template_id)
        if template is None:
            raise WorkflowError("Modelo de formulário não encontrado")
        if not template.is_active:
            raise WorkflowError(f"Modelo de formulário inativo: {template.name}")
        chosen.append((template, item.required))
    return chosen


def _opening(
    chosen: list[tuple[FormTemplate, bool]] | None, linked: list[Linked]
) -> list[tuple[FormTemplate, bool, bool, str | None]]:
    """(modelo, obrigatório, entrou sozinho, motivo) dos formulários da abertura. Sem lista, os
    ligados, como obrigatórios ou opcionais pelo padrão do modelo; com lista, exatamente ela, na
    ordem, e os que também são ligados ficam marcados como automáticos (saem sozinhos se o tipo
    ou a categoria mudarem antes da visita)."""
    if chosen is None:
        return [(i.template, i.template.default_required, True, i.reason) for i in linked]
    linked_ids = {i.template.id for i in linked}
    return [(t, required, t.id in linked_ids, None) for t, required in chosen]


def opening_asks_signature(
    chosen: list[tuple[FormTemplate, bool]] | None, linked: list[Linked]
) -> bool:
    """A OS nasce exigindo a assinatura (formulário obrigatório que pede)."""
    return any(
        required and template.requires_signature
        for template, required, _, _ in _opening(chosen, linked)
    )


def opening_left_out(
    chosen: list[tuple[FormTemplate, bool]] | None, linked: list[Linked]
) -> list[str]:
    """Os ligados que a Nova OS deixou de fora (vão para o evento da abertura)."""
    if chosen is None:
        return []
    ids = {t.id for t, _ in chosen}
    return [str(i.template.id) for i in linked if i.template.id not in ids]


def attach_on_create(
    db: AsyncSession,
    ticket: Ticket,
    chosen: list[tuple[FormTemplate, bool]] | None,
    linked: list[Linked],
    actor: User,
    now: dt.datetime,
) -> None:
    """Os formulários da abertura. Sem lista, o sistema anexa os ligados (o histórico mostra o
    motivo); com lista, quem abriu é o autor."""
    by_system = chosen is None
    for order, (template, required, auto, note) in enumerate(_opening(chosen, linked), 1):
        _attach(
            db,
            ticket,
            template,
            required=required,
            auto=auto,
            actor=None if by_system else actor,
            note=note,
            now=now,
            order=order,
        )


async def _signature_after_removal(
    db: AsyncSession, ticket: Ticket, kept: list[TicketForm], removed: list[TicketForm]
) -> None:
    """A exigência de assinatura vinha só dos formulários que saíram (e ninguém assinou): a OS
    deixa de exigir. Outro obrigatório que peça, ou a exigência sem formulário, mantém."""
    if ticket.signed_at is not None or not ticket.signature_required:
        return
    gone = [f.template_id for f in removed if f.required and f.template_id is not None]
    asking = select(func.count()).select_from(FormTemplate)
    asking = asking.where(FormTemplate.requires_signature.is_(True))
    if not gone or not await db.scalar(asking.where(FormTemplate.id.in_(gone))):
        return
    others = [f.template_id for f in kept if f.required and f.template_id is not None]
    if others and await db.scalar(asking.where(FormTemplate.id.in_(others))):
        return
    ticket.signature_required = False


async def reconcile_ticket(
    db: AsyncSession, ticket: Ticket, *, why: str, now: dt.datetime
) -> tuple[list[str], list[str]]:
    """Antes da visita, a OS fica com os formulários que uma OS nova com o mesmo tipo e a mesma
    categoria teria, respeitando o que uma pessoa decidiu: entram os ligados que faltam (menos os
    que alguém tirou da OS ou deixou de fora na abertura); saem só os que entraram sozinhos, não
    casam mais e ninguém começou (`why` vai para o histórico). Posto à mão ou respondido nunca
    sai. Devolve os nomes dos que entraram e dos que saíram."""
    if not before_visit(ticket):
        return [], []
    linked = await linked_templates(
        db, service_type_id=ticket.service_type_id, category_id=ticket.category_id
    )
    linked_ids = {item.template.id for item in linked}
    forms = list(
        await db.scalars(
            select(TicketForm)
            .where(TicketForm.ticket_id == ticket.id)
            .order_by(TicketForm.created_at)
        )
    )
    removed: list[TicketForm] = []
    for form in forms:
        if form.auto_attached and form.template_id not in linked_ids and await untouched(db, form):
            await _detach(db, ticket, form, actor=None, note=why, now=now, release=False)
            removed.append(form)
    present = {f.template_id for f in forms}
    skip = await left_out(db, ticket.id)
    added: list[TicketForm] = []
    for item in linked:
        if item.template.id in present or item.template.id in skip:
            continue
        added.append(
            _attach(
                db,
                ticket,
                item.template,
                required=item.template.default_required,
                auto=True,
                actor=None,
                note=item.reason,
                now=now,
                order=len(added) + 1,
            )
        )
    if removed:
        kept = [f for f in forms if f not in removed] + added
        await _signature_after_removal(db, ticket, kept, removed)
    return [f.name for f in added], [f.name for f in removed]


async def reconcile_template(
    db: AsyncSession, template: FormTemplate, actor: User | None = None
) -> tuple[int, int]:
    """Leva os vínculos do modelo (tipos de OS e categorias) às OS que ainda não começaram: entra
    onde casa e falta (menos onde uma pessoa tirou ou deixou de fora na abertura) e sai de onde
    entrou sozinho, não casa mais e ninguém começou. Uma OS por vez, com o histórico de cada uma.
    Devolve (em quantas OS entrou, de quantas saiu). Modelo inativo não entra nem sai."""
    if not template.is_active:
        return 0, 0
    type_ids = set(_uuids(template.service_type_ids))
    category_ids = await category_tree(db, _uuids(template.category_ids))
    pending = and_(Ticket.status.in_(list(BEFORE_VISIT)), Ticket.arrived_at.is_(None))
    matches = []
    if type_ids:
        matches.append(Ticket.service_type_id.in_(list(type_ids)))
    if category_ids:
        matches.append(Ticket.category_id.in_(list(category_ids)))
    copy = exists().where(TicketForm.ticket_id == Ticket.id, TicketForm.template_id == template.id)
    to_attach: list[uuid.UUID] = []
    if matches:
        to_attach = list(
            await db.scalars(
                select(Ticket.id).where(pending, or_(*matches), ~copy).order_by(Ticket.number)
            )
        )
    auto_copy = copy.where(TicketForm.auto_attached.is_(True))
    candidates = await db.execute(
        select(Ticket.id, Ticket.service_type_id, Ticket.category_id)
        .where(pending, auto_copy)
        .order_by(Ticket.number)
    )
    to_detach = [
        ticket_id
        for ticket_id, service_type_id, category_id in candidates
        if service_type_id not in type_ids and category_id not in category_ids
    ]
    now = utcnow()
    attached = detached = 0
    for ticket_id in to_attach:
        ticket = await get_ticket(db, ticket_id)
        if template.id in await left_out(db, ticket.id):
            continue
        line = await category_line(db, ticket.category_id) if ticket.category_id else []
        reason = _reason(template, ticket.service_type, line)
        _attach(
            db,
            ticket,
            template,
            required=template.default_required,
            auto=True,
            actor=None,
            note=reason,
            now=now,
        )
        await _touch(db, ticket, now)  # o app recebe a mudança no próximo sync
        queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
        await db.flush()
        attached += 1
    for ticket_id in to_detach:
        ticket = await get_ticket(db, ticket_id)
        gone = False
        for form in [f for f in ticket.forms if f.template_id == template.id and f.auto_attached]:
            if await untouched(db, form):
                await _detach(db, ticket, form, actor=None, note=TEMPLATE_UNLINKED, now=now)
                gone = True
        if gone:
            await _touch(db, ticket, now)
            queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
            await db.flush()
            detached += 1
    return attached, detached


async def usage(db: AsyncSession, template: FormTemplate) -> list[ServiceTypeUsage]:
    """Tipos de OS em que o modelo já é usado (para ligar com um clique): nos últimos 12 meses,
    só OS não canceladas, os tipos ativos em que ele está em pelo menos 3 OS e em pelo menos
    metade das OS do tipo; os 10 mais usados."""
    since = utcnow() - dt.timedelta(days=USAGE_DAYS)
    scope = (
        Ticket.service_type_id.is_not(None),
        Ticket.status != TicketStatus.CANCELLED,
        Ticket.created_at >= since,
    )
    with_form = func.count(func.distinct(Ticket.id))
    used: dict[uuid.UUID, int] = {
        service_type_id: count
        for service_type_id, count in await db.execute(
            select(Ticket.service_type_id, with_form)
            .join(TicketForm, TicketForm.ticket_id == Ticket.id)
            .where(TicketForm.template_id == template.id, *scope)
            .group_by(Ticket.service_type_id)
            .having(with_form >= USAGE_MIN)
        )
    }
    if not used:
        return []
    totals: dict[uuid.UUID, int] = {
        service_type_id: count
        for service_type_id, count in await db.execute(
            select(Ticket.service_type_id, func.count())
            .where(Ticket.service_type_id.in_(list(used)), *scope)
            .group_by(Ticket.service_type_id)
        )
    }
    items = [
        ServiceTypeUsage(
            id=st.id,
            name=st.name,
            customer=Ref.model_validate(st.customer) if st.customer else None,
            used=used[st.id],
            total=totals.get(st.id, used[st.id]),
        )
        for st in await db.scalars(
            select(ServiceType).where(
                ServiceType.id.in_(list(used)), ServiceType.is_active.is_(True)
            )
        )
        if used[st.id] * 2 >= totals.get(st.id, used[st.id])
    ]
    items.sort(key=lambda u: (-u.used, u.name.lower()))
    return items[:USAGE_LIMIT]


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
    """Modelos ativos ligados ao tipo de OS e à categoria da OS (ou a uma categoria acima dela)
    que ainda não estão na OS."""
    attached = {f.template_id for f in ticket.forms}
    linked = await linked_templates(
        db, service_type_id=ticket.service_type_id, category_id=ticket.category_id
    )
    return [item.template for item in linked if item.template.id not in attached]


def _attach(
    db: AsyncSession,
    ticket: Ticket,
    template: FormTemplate,
    *,
    required: bool,
    auto: bool,
    actor: User | None,
    note: str | None,
    now: dt.datetime,
    order: int = 0,
) -> TicketForm:
    """Põe o formulário na OS (cópia das perguntas do modelo), com o evento no histórico. Sem
    autor, o histórico mostra "Sistema" e o motivo (`note`). `order` desempata o horário dos que
    entram juntos (a OS lista os formulários pela ordem de entrada).

    Não lê `ticket.forms`: na abertura a relação ainda não foi carregada (e no AsyncSession o
    lazy load quebra)."""
    at = now + dt.timedelta(microseconds=order)
    form = TicketForm(
        id=uuid.uuid4(),
        ticket_id=ticket.id,
        template_id=template.id,
        template_version=template.version,
        name=template.name,
        fields=template.fields,
        required=required,
        status=FormStatus.PENDING,
        answers={},
        auto_attached=auto,
        added_by_id=actor.id if actor else None,
        created_at=at,
        updated_at=at,
    )
    db.add(form)
    if (
        required
        and template.requires_signature
        and not ticket.signature_required
        and ticket.signed_at is None
    ):
        ticket.signature_required = True
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.FORM_ADDED,
        to_value=template.name[:64],
        note=note,
        data={
            "form_id": str(form.id),
            "template_id": str(template.id),
            "required": required,
            "auto": auto,
        },
        now=at,
    )
    return form


async def _detach(
    db: AsyncSession,
    ticket: Ticket,
    form: TicketForm,
    *,
    actor: User | None,
    note: str | None = None,
    now: dt.datetime | None = None,
    release: bool = True,
) -> None:
    """Tira o formulário da OS (as fotos dele saem junto, em cascata), com o evento no histórico.
    O evento com autor marca a decisão de uma pessoa: o modelo não volta sozinho para esta OS.
    `release`: sem outro obrigatório que peça, a OS deixa de exigir a assinatura (a reconciliação
    recalcula no fim, depois de todas as mudanças)."""
    if release and form.required:
        await _release_signature(db, ticket, form, await _template_of(db, form))
    data = {"form_id": str(form.id)}
    if form.template_id is not None:
        data["template_id"] = str(form.template_id)
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.FORM_REMOVED,
        from_value=form.name[:64],
        note=note,
        data=data,
        now=now,
    )
    await db.delete(form)


async def add_to_ticket(
    db: AsyncSession, ticket: Ticket, data: TicketFormAdd, actor: User
) -> TicketForm:
    """Anexa o formulário. Na OS concluída a central ainda registra o checklist que chegou depois
    pelo WhatsApp, sempre como opcional; OS cancelada não recebe."""
    _require_manager(actor)
    if ticket.status == TicketStatus.CANCELLED:
        raise WorkflowError("OS cancelada não recebe formulário")
    template = await get_template(db, data.template_id)
    if not template.is_active:
        raise WorkflowError("Modelo de formulário inativo")
    if any(f.template_id == template.id for f in ticket.forms):
        raise WorkflowError("Este formulário já está na OS")
    required = data.required and ticket.status not in FINISHED_STATES
    now = utcnow()
    form = _attach(
        db, ticket, template, required=required, auto=False, actor=actor, note=None, now=now
    )
    await _touch(db, ticket, now)  # o app recebe a mudança no próximo sync
    queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
    await db.flush()
    return form


async def _template_of(db: AsyncSession, form: TicketForm) -> FormTemplate | None:
    return await db.get(FormTemplate, form.template_id) if form.template_id else None


async def _release_signature(
    db: AsyncSession, ticket: Ticket, form: TicketForm, template: FormTemplate | None
) -> None:
    """O formulário que pedia a assinatura deixou de ser obrigatório (ou saiu da OS): sem outro
    obrigatório que peça, a OS deixa de exigir a assinatura (o técnico consegue concluir)."""
    if ticket.signed_at is not None or not ticket.signature_required:
        return
    if template is None or not template.requires_signature:
        return  # a exigência não veio deste formulário
    others = [f.template_id for f in ticket.forms if f.required and f.id != form.id]
    others = [t for t in others if t is not None]
    if others and await db.scalar(
        select(func.count())
        .select_from(FormTemplate)
        .where(FormTemplate.id.in_(others), FormTemplate.requires_signature.is_(True))
    ):
        return
    ticket.signature_required = False


async def set_required(
    db: AsyncSession, ticket: Ticket, form: TicketForm, required: bool, actor: User
) -> TicketForm:
    """Torna obrigatório ou opcional, com a assinatura acompanhando o modelo e o registro no
    histórico (tornar opcional libera o fechamento: precisa ficar rastreado)."""
    _require_manager(actor)
    if form.required == required:
        return form
    form.required = required
    template = await _template_of(db, form)
    before = ticket.signature_required
    if required and template is not None and template.requires_signature:
        ticket.signature_required = True
    elif not required:
        await _release_signature(db, ticket, form, template)
    data: dict[str, Any] = {"form_id": str(form.id), "form": form.name, "required": required}
    if ticket.signature_required != before:
        data["changes"] = {"signature_required": [before, ticket.signature_required]}
    record_event(
        db,
        ticket,
        actor,
        TicketEventType.UPDATED,
        note=f'Formulário "{form.name}" agora é {"obrigatório" if required else "opcional"}',
        data=data,
    )
    await _touch(db, ticket, utcnow())  # o app recebe a mudança no próximo sync
    queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
    await db.flush()
    return form


async def remove_from_ticket(
    db: AsyncSession, ticket: Ticket, form: TicketForm, actor: User
) -> None:
    _require_manager(actor)
    await _detach(db, ticket, form, actor=actor)
    await _touch(db, ticket, utcnow())  # o app recebe a mudança no próximo sync
    queue_event(db, "updated", ticket, actor, {"fields": ["forms"]})
    await db.flush()


def locked_for(ticket: Ticket, actor: User) -> bool:
    """Depois da assinatura (ou da OS concluída) só a gestão mexe nos formulários."""
    if actor.can_manage_tickets:
        return False
    return ticket.signed_at is not None or ticket.status in CLOSED_STATES


def _ensure_can_fill(ticket: Ticket, actor: User) -> None:
    if not can_work(actor, ticket):
        raise PermissionDenied("Só o técnico responsável ou a gestão preenche o formulário")
    if locked_for(ticket, actor):
        raise WorkflowError("A assinatura já foi colhida: o formulário não pode mais ser alterado")


def _number(label: str, value: Any) -> float:
    """Número digitado do jeito brasileiro ("1.234,56", "2,5") ou com ponto ("2.5"). "NaN" e
    "1e999" não valem: o banco (JSON) não guarda e o relatório mostraria lixo."""
    if isinstance(value, bool):
        raise WorkflowError(f'"{label}": informe um número')
    if isinstance(value, int | float):
        number = float(value)
    else:
        text = str(value).strip().replace(" ", "")
        if "," in text:
            text = text.replace(".", "").replace(",", ".")
        try:
            number = float(text)
        except ValueError as exc:
            raise WorkflowError(f'"{label}": informe um número') from exc
    if not math.isfinite(number):
        raise WorkflowError(f'"{label}": informe um número')
    return number


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
        return _number(label, value)
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


async def _still_complete(db: AsyncSession, form: TicketForm, actor: User) -> bool:
    """Formulário concluído que a gestão corrigiu e em que nada obrigatório ficou faltando."""
    return (
        form.status == FormStatus.COMPLETED
        and actor.can_manage_tickets
        and not await missing_items(db, form)
    )


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
        # Correção da central num formulário concluído, sem faltar nada: continua concluído
        # (o relatório mantém a data da conclusão). Mudança do técnico: precisa concluir de novo.
        keep = await _still_complete(db, form, actor)
        if not keep:
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
    # A resposta automática congela na conclusão: o valor de agora vira resposta (trocar o técnico
    # ou remarcar depois não muda nada) e conta para os obrigatórios. Faltando algo, a exceção
    # desfaz a transação e nada fica congelado.
    auto = prefill_for(ticket, form.fields, form.answers, final=True)
    if auto:  # só as perguntas ainda sem resposta
        form.answers = {**(form.answers or {}), **auto}
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
    if not _is_photo(await _image_head(upload)):
        raise WorkflowError(PHOTO_TYPES)
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
    await db.flush()  # a contagem de fotos já sem a removida
    if (
        form is not None
        and form.status == FormStatus.COMPLETED
        and not await _still_complete(db, form, actor)
    ):
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
    if not can_work(actor, ticket):
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
    # Vale o conteúdo do arquivo, não o tipo que o aparelho declarou.
    if not _is_photo(await _image_head(upload)):
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
