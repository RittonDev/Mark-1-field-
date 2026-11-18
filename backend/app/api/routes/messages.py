import uuid

from fastapi import APIRouter

from app.api.deps import DB, TicketManagerUser, access_user
from app.schemas.messages import (
    MessageTemplates,
    MessageTemplatesOut,
    MessageVariable,
    RenderedMessage,
)
from app.services import messages as svc
from app.services import tickets as tickets_svc

router = APIRouter(tags=["messages"])

# Tela de Textos do WhatsApp (os textos já preenchidos de cada OS ficam com toda a gestão).
MessagesView = access_user("setup.messages")
MessagesEdit = access_user("setup.messages", level="edit")


def _out(items: list[dict[str, str]]) -> MessageTemplatesOut:
    return MessageTemplatesOut(
        templates=items,
        variables=[MessageVariable(key=k, description=d) for k, d in svc.VARIABLES.items()],
    )


@router.get("/tickets/{ticket_id}/messages", response_model=list[RenderedMessage])
async def ticket_messages(ticket_id: uuid.UUID, db: DB, user: TicketManagerUser) -> list[dict]:
    """Textos prontos para os grupos de WhatsApp, já preenchidos com os dados da OS. O da
    situação atual vem com `suggested` (no máximo um)."""
    ticket = await tickets_svc.get_visible_ticket(db, user, ticket_id)
    rendered = await svc.for_ticket(db, ticket, user)
    await db.commit()  # o link do relatório pode ter sido criado agora (OS sem link)
    return rendered


@router.get("/message-templates", response_model=MessageTemplatesOut)
async def get_templates(db: DB, _: MessagesView) -> MessageTemplatesOut:
    return _out(await svc.templates(db))


@router.put("/message-templates", response_model=MessageTemplatesOut)
async def put_templates(body: MessageTemplates, db: DB, user: MessagesEdit) -> MessageTemplatesOut:
    items = await svc.save_templates(db, [t.model_dump() for t in body.templates], user)
    await db.commit()
    return _out(items)


@router.post("/message-templates/reset", response_model=MessageTemplatesOut)
async def reset_templates(db: DB, _: MessagesEdit) -> MessageTemplatesOut:
    items = await svc.reset_templates(db)
    await db.commit()
    return _out(items)
