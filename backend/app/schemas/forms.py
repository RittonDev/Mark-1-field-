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

# Resposta automática: a pergunta já vem preenchida com um dado da OS que o técnico já vê (ele
# corrige se precisar). Nada de nº do chamado do cliente, CNPJ, contato ou valores.
PrefillSource = Literal[
    "location_name",
    "location_code",
    "customer",
    "address",
    "city",
    "ticket_code",
    "technician",
    "service_type",
    "visit_date",
]

PREFILL_LABEL: dict[str, str] = {
    "location_name": "Nome da loja",
    "location_code": "Código da loja",
    "customer": "Cliente",
    "address": "Endereço do atendimento",
    "city": "Cidade e UF",
    "ticket_code": "Nº da OS",
    "technician": "Técnico responsável",
    "service_type": "Tipo de OS",
    "visit_date": "Data da visita",
}

TEXT_FIELD_TYPES: tuple[str, ...] = ("text", "textarea")


def prefill_types(source: str) -> tuple[str, ...]:
    """Tipos de pergunta que aceitam a fonte: texto aceita todas; data, só a data da visita."""
    return (*TEXT_FIELD_TYPES, "date") if source == "visit_date" else TEXT_FIELD_TYPES


class FormField(BaseModel):
    id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    type: FieldType
    label: str = Field(min_length=1, max_length=200)
    help: str | None = Field(default=None, max_length=500)
    required: bool = False
    options: list[str] = Field(default_factory=list, max_length=30)
    min_photos: int = Field(default=0, ge=0, le=20)
    max_photos: int = Field(default=10, ge=1, le=30)
    # Resposta automática (ver PrefillSource). Combinação que o tipo não aceita vira null.
    prefill: PrefillSource | None = None

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
        if self.prefill is not None and self.type not in prefill_types(self.prefill):
            self.prefill = None
        return self


def field_dump(field: FormField) -> dict[str, Any]:
    """O campo como fica gravado no JSON do modelo: sem `prefill` quando não há resposta
    automática. Assim o JSON dos modelos antigos não muda de forma e salvar um deles não sobe a
    versão à toa (nem faz o "levar às OS que não começaram" ver diferença onde não há)."""
    data = field.model_dump()
    if data.get("prefill") is None:
        data.pop("prefill", None)
    return data


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
    # Tipos de OS em que o formulário entra sozinho.
    service_type_ids: list[uuid.UUID] = Field(default_factory=list)
    # Categorias em que o formulário entra sozinho (valem também as subcategorias). Na criação,
    # sem informar = nenhuma; no PUT, sem informar (ou null) mantém as que o modelo já tem.
    category_ids: list[uuid.UUID] | None = None
    # Entra na OS como obrigatório. Na criação, sem informar = sim; no PUT, mantém.
    default_required: bool | None = None
    requires_signature: bool = True
    is_active: bool = True

    @model_validator(mode="after")
    def _ids(self) -> "FormTemplateIn":
        _unique_ids(self.fields)
        return self


class FormTemplateUpdate(FormTemplateIn):
    # O `updated_at` da versão de onde a tela partiu: se outra pessoa salvou depois, o PUT dá 409
    # em vez de desfazer a gravação dela em silêncio. Sem ele (ou nulo), grava por cima.
    base_updated_at: dt.datetime | None = None


class FormTemplateOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None
    fields: list[FormField]
    service_type_ids: list[uuid.UUID]
    category_ids: list[uuid.UUID] = []
    default_required: bool = True
    requires_signature: bool
    is_active: bool
    version: int
    created_at: dt.datetime
    updated_at: dt.datetime
    # Só ao salvar com "aplicar às OS que não começaram": quantas OS receberam a versão nova.
    applied_to: int | None = None
    # Também só com essa opção: em quantas OS que ainda não começaram o formulário entrou pelo
    # tipo de OS ou pela categoria, e de quantas saiu (entrou sozinho, não casa mais e ninguém
    # começou a responder).
    attached_to: int | None = None
    detached_from: int | None = None


class ServiceTypeUsage(BaseModel):
    """Tipo de OS em que o modelo foi usado nos últimos 12 meses (OS não canceladas): `used` OS
    com o formulário de `total` OS do tipo."""

    id: uuid.UUID
    name: str
    customer: Ref | None = None
    used: int
    total: int


class FormTemplateUsage(BaseModel):
    """Histórico de uso do modelo, para ligar aos tipos de OS em que ele já é usado."""

    service_types: list[ServiceTypeUsage]


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
    # Versão do modelo que a OS usa (o modelo pode ter sido corrigido depois de anexar).
    template_version: int = 1
    name: str
    fields: list[FormField]
    required: bool
    status: FormStatus
    answers: dict[str, Any]
    completed_at: dt.datetime | None
    completed_by: Ref | None
    created_at: dt.datetime
    updated_at: dt.datetime
    # Entrou sozinho, pelo tipo de OS ou pela categoria.
    auto_attached: bool = False
    # Resposta automática: {campo: valor} das perguntas ligadas a um dado da OS e ainda sem
    # resposta. Acompanha a OS até a conclusão do formulário, que grava o valor nas respostas
    # (concluído, vem vazio).
    prefill: dict[str, Any] = {}


class SignatureOut(BaseModel):
    signer_name: str
    signer_role: str | None
    signed_at: dt.datetime
    attachment_id: uuid.UUID | None


class PrefillSourceInfo(BaseModel):
    key: PrefillSource
    label: str
    # Tipos de pergunta que aceitam a fonte.
    types: list[FieldType]


class FormCatalog(BaseModel):
    field_types: list[dict[str, str]]
    prefill_sources: list[PrefillSourceInfo] = []


def field_type_catalog() -> FormCatalog:
    return FormCatalog(
        field_types=[{"key": k, "label": v} for k, v in FIELD_TYPE_LABEL.items()],
        prefill_sources=[
            PrefillSourceInfo.model_validate({"key": k, "label": v, "types": prefill_types(k)})
            for k, v in PREFILL_LABEL.items()
        ],
    )


SignatureState = Literal["not_required", "pending", "blocked", "collected"]
