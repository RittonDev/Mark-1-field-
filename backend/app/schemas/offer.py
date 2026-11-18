"""Oferta de OS com preço: a central oferta a OS sem técnico; o técnico aceita pelo valor ou recusa.

Dois recortes: o da central (TicketOfferOut, só com Pagamentos, porque leva o valor) e o do técnico
(FieldOfferOut), que vê a OS antes de estar nela e por isso recebe só o que o convite pelo WhatsApp
diz: serviço, escopo, formulários, bairro e cidade, data e valor. Cliente, loja, endereço, contato,
CNPJ, SLA, analista, etiquetas e projeto ficam de fora.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator
from pydantic_core import PydanticCustomError

from app.core.enums import OfferCancelReason
from app.schemas.common import Ref
from app.schemas.expense import Money
from app.schemas.ticket import LocalDatetime

# Estado que a API mostra: o gravado, e "expired" para a pendente com o prazo vencido.
OfferState = Literal["pending", "expired", "accepted", "declined", "cancelled"]

# Até quantos técnicos uma oferta vai de uma vez.
MAX_TECHNICIANS = 10
NOTE_MAX = 500
DECLINE_REASON_MAX = 300


class OfferCreate(BaseModel):
    """A central manda a OS (sem técnico, em aberto) para 1 a 10 técnicos ativos."""

    technician_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_TECHNICIANS)
    # Quanto o técnico recebe pela OS (R$, 2 casas): vira o valor dele na OS no aceite.
    amount: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    # Prazo para responder (no futuro). Sem prazo: vale até alguém aceitar ou a central cancelar.
    expires_at: LocalDatetime | None = None
    # Recado para o técnico (até NOTE_MAX caracteres, conferido em _note_size).
    note: str | None = Field(default=None, json_schema_extra={"maxLength": NOTE_MAX})

    @field_validator("note", mode="before")
    @classmethod
    def _note(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("note")
    @classmethod
    def _note_size(cls, value: str | None) -> str | None:
        """O 422 de sempre (string_too_long), com o nome do campo na tela: o recado (o rótulo
        geral de "note" é "Motivo")."""
        if value is not None and len(value) > NOTE_MAX:
            raise PydanticCustomError(
                "string_too_long",
                "String should have at most {max_length} characters",
                {"max_length": NOTE_MAX, "label": "Recado"},
            )
        return value


class OfferDecline(BaseModel):
    """Recusa do técnico (o motivo é opcional)."""

    reason: str | None = Field(default=None, max_length=DECLINE_REASON_MAX)


class TicketOfferOut(BaseModel):
    """A oferta para a central (GET /tickets/{id}/offers)."""

    id: uuid.UUID
    ticket_id: uuid.UUID
    technician: Ref
    amount: Money
    state: OfferState
    expires_at: datetime | None
    note: str | None
    decline_reason: str | None
    cancel_reason: OfferCancelReason | None
    viewed_at: datetime | None
    responded_at: datetime | None
    created_by: Ref | None
    created_at: datetime


class OfferForm(BaseModel):
    """Formulário da OS que o técnico vai preencher (só o nome e se é obrigatório)."""

    name: str
    required: bool


class FieldOfferTicket(BaseModel):
    """O recorte da OS na oferta (o técnico ainda não está nela). Na oferta que já fechou, vem o
    mínimo: sem escopo, formulários e bairro."""

    id: uuid.UUID
    code: str
    title: str
    # Escopo: o que deve ser feito.
    description: str | None
    service_type: Ref | None
    forms: list[OfferForm]
    # Bairro, cidade e UF da loja (nunca o nome nem o endereço).
    district: str | None
    city: str | None
    state: str | None
    # Janela da visita, se a central já agendou (sem ela, "data a combinar").
    scheduled_start: datetime | None
    scheduled_end: datetime | None


class FieldOfferOut(BaseModel):
    """A oferta no app do técnico (GET /me/offers)."""

    id: uuid.UUID
    state: OfferState
    amount: Money
    expires_at: datetime | None
    note: str | None
    viewed_at: datetime | None
    responded_at: datetime | None
    created_at: datetime
    ticket: FieldOfferTicket
