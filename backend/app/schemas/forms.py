import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.core.enums import FormStatus
from app.schemas.common import ORMModel, Ref

FieldType = Literal[
    "section",  # título de seção (não é pergunta)
    "text",
    "textarea",
    "number",
    "yes_no",
    "choice",
    "multi_choice",
    "date",
    "confirm",  # caixa "Confirmo que ..."
    "photo",
]

FIELD_TYPE_LABEL: dict[str, str] = {
    "section": "Seção",
    "text": "Texto curto",
    "textarea": "Texto longo",
    "number": "Número",
    "yes_no": "Sim / Não",
    "choice": "Escolha única",
    "multi_choice": "Múltipla escolha",
    "date": "Data",
    "confirm": "Confirmação",
    "photo": "Fotos",
}


class FormField(BaseModel):
    id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    type: FieldType
    label: str = Field(min_length=1, max_length=200)
    help: str | None = Field(default=None, max_length=500)
    required: bool = False
    options: list[str] = Field(default_factory=list, max_length=30)
    min_photos: int = Field(default=0, ge=0, le=20)
    max_photos: int = Field(default=10, ge=1, le=30)

    @model_validator(mode="after")
    def _check(self) -> "FormField":
        if self.type in ("choice", "multi_choice"):
            self.options = [o.strip() for o in self.options if o.strip()]
            if len(self.options) < 2:
                raise ValueError(f'"{self.label}": informe pelo menos duas opções')
        else:
            self.options = []
        if self.type == "photo":
            if self.required and self.min_photos == 0:
                self.min_photos = 1
            if self.min_photos > self.max_photos:
                raise ValueError(f'"{self.label}": mínimo de fotos maior que o máximo')
        if self.type == "section":
            self.required = False
        return self


def _unique_ids(fields: list[FormField]) -> list[FormField]:
    ids = [f.id for f in fields]
    if len(ids) != len(set(ids)):
        raise ValueError("Há campos com o mesmo identificador")
    if not any(f.type != "section" for f in fields):
        raise ValueError("O formulário precisa de pelo menos uma pergunta")
    return fields


class FormTemplateIn(BaseModel):
    name: str = Field(min_length=3, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    fields: list[FormField] = Field(min_length=1, max_length=100)
    service_type_ids: list[uuid.UUID] = Field(default_factory=list)
    requires_signature: bool = True
    is_active: bool = True

    @model_validator(mode="after")
    def _ids(self) -> "FormTemplateIn":
        _unique_ids(self.fields)
        return self


class FormTemplateOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None
    fields: list[FormField]
    service_type_ids: list[uuid.UUID]
    requires_signature: bool
    is_active: bool
    version: int
    created_at: dt.datetime
    updated_at: dt.datetime


class TicketFormAdd(BaseModel):
    template_id: uuid.UUID
    required: bool = True


class TicketFormUpdate(BaseModel):
    """Só a gestão: tornar obrigatório ou opcional."""

    required: bool


class TicketFormAnswers(BaseModel):
    """Salvar respostas. `complete` valida e conclui (obrigatórios e fotos mínimas)."""

    answers: dict[str, Any] = Field(default_factory=dict)
    complete: bool = False


class TicketFormOut(ORMModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    template_id: uuid.UUID | None
    name: str
    fields: list[FormField]
    required: bool
    status: FormStatus
    answers: dict[str, Any]
    completed_at: dt.datetime | None
    completed_by: Ref | None
    created_at: dt.datetime
    updated_at: dt.datetime


class SignatureOut(BaseModel):
    signer_name: str
    signer_role: str | None
    signed_at: dt.datetime
    attachment_id: uuid.UUID | None


class FormCatalog(BaseModel):
    field_types: list[dict[str, str]]


def field_type_catalog() -> FormCatalog:
    return FormCatalog(
        field_types=[{"key": k, "label": v} for k, v in FIELD_TYPE_LABEL.items()]
    )


SignatureState = Literal["not_required", "pending", "blocked", "collected"]
