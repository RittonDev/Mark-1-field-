import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.core.enums import DevicePlatform
from app.schemas.ticket import CommentOut, TicketDetail, WorklogOut


class SyncPullResponse(BaseModel):
    """Delta para o app mobile. Guarde `server_time` e envie como `since` na próxima chamada."""

    server_time: datetime
    # Mais de 500 OS mudaram: chame de novo com since=server_time até has_more = false.
    has_more: bool = False
    tickets: list[TicketDetail]
    comments: list[CommentOut]
    worklogs: list[WorklogOut]
    # OS que saíram do escopo do usuário (reatribuídas a outro analista) desde `since`.
    revoked_ticket_ids: list[uuid.UUID]


# form_answers: {form_id, answers, complete} (respostas do formulário, offline no app).
# unproductive: {reason_id, note?, latitude?, longitude?, expected_version?} (visita improdutiva).
# part_request: {description, quantity?, unit?, note?, attachment_ids?, client_id?} (peça).
SyncOpType = Literal[
    "transition", "comment", "worklog", "update", "form_answers", "unproductive", "part_request"
]


class SyncOperationIn(BaseModel):
    client_op_id: str = Field(min_length=8, max_length=64)
    type: SyncOpType
    ticket_id: uuid.UUID
    payload: dict[str, Any]
    client_timestamp: datetime | None = None


class SyncPushRequest(BaseModel):
    operations: list[SyncOperationIn] = Field(max_length=200)


class SyncOperationResult(BaseModel):
    client_op_id: str
    status: Literal["applied", "duplicate", "rejected", "conflict"]
    error: str | None = None
    ticket: TicketDetail | None = None


class SyncPushResponse(BaseModel):
    server_time: datetime
    results: list[SyncOperationResult]


class DeviceRegister(BaseModel):
    platform: DevicePlatform
    token: str = Field(min_length=10, max_length=512)
    app_version: str | None = Field(default=None, max_length=40)
