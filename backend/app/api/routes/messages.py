import uuid

from fastapi import APIRouter

from app.api.deps import DB, TicketManagerUser
from app.schemas.messages import (
    MessageTemplates,
    MessageTemplatesOut,
    MessageVariable,
    RenderedMessage,
)
from app.services import messages as svc
from app.services import tickets as tickets_svc

router = APIRouter(tags=["messages"])


def _out(items: list[dict[str, str]]) -> MessageTemplatesOut:
    return MessageTemplatesOut(
        templates=items,
        variables=[MessageVariable(key=k, description=d) for k, d in svc.VARIABLES.items()],
    )


@router.get("/tickets/{ticket_id}/messages", response_model=list[RenderedMessage])
async def ticket_messages(ticket_id: uuid.UUID, db: DB, user: TicketManagerUser) -> list[dict]:
    """Textos prontos para o grupo de WhatsApp, já preenchidos com os dados da OS."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    return await svc.for_ticket(db, ticket, user)


@router.get("/message-templates", response_model=MessageTemplatesOut)
async def get_templates(db: DB, _: TicketManagerUser) -> MessageTemplatesOut:
    return _out(await svc.templates(db))


@router.put("/message-templates", response_model=MessageTemplatesOut)
async def put_templates(body: MessageTemplates, db: DB, user: TicketManagerUser) -> MessageTemplatesOut:
    items = await svc.save_templates(db, [t.model_dump() for t in body.templates], user)
    await db.commit()
    return _out(items)


@router.post("/message-templates/reset", response_model=MessageTemplatesOut)
async def reset_templates(db: DB, _: TicketManagerUser) -> MessageTemplatesOut:
    items = await svc.reset_templates(db)
    await db.commit()
    return _out(items)
