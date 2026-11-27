"""Documentos do técnico: certificações (com validade opcional), documentos pessoais, o currículo e
os anexos internos da central (services/technician_documents.py; contrato da Entrega 2, §6.3 e §7).

O técnico (app e ficha da homologação) vê e envia os três primeiros; o anexo interno é só da central
(com Técnicos Editar) e nunca chega ao app. O arquivo sai por link assinado de 30 min: na central,
dentro de cada arquivo (`url`); no app, pedido na hora (GET /me/profile/documents/{id}/link).
"""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import TechDocumentKind
from app.schemas.common import Ref

# O que o técnico envia e vê (app e ficha): o anexo interno fica só com a central.
TechnicianDocumentKind = Literal["certification", "personal", "resume"]
# Quem mandou o arquivo: o técnico no app, a ficha da homologação ou a central.
TechDocumentVia = Literal["app", "central", "ficha"]


class MyDocumentOut(BaseModel):
    """MyProfile.documents: os documentos do técnico (de qualquer `via`), nunca o anexo interno.
    Sem link: o app pede o dele na hora."""

    id: uuid.UUID
    kind: TechnicianDocumentKind
    # 2 a 80; o currículo é "Currículo".
    title: str
    # Só na certificação ("AAAA-MM-DD").
    expires_on: date | None
    file_name: str
    # Pelo conteúdo: application/pdf, image/jpeg, image/png ou image/webp.
    content_type: str
    # Bytes.
    size: int
    # Quando o arquivo atual chegou.
    uploaded_at: datetime
    via: TechDocumentVia


class DocumentLinkOut(BaseModel):
    """Link assinado de 30 min, relativo à API (a foto abre na tela; o PDF baixa)."""

    url: str
    expires_at: datetime


class TechDocumentFileOut(BaseModel):
    """Um arquivo na central: o atual (`id` = o do documento) ou uma versão anterior."""

    id: uuid.UUID
    file_name: str
    content_type: str
    size: int
    uploaded_at: datetime
    # None: o candidato, pela ficha.
    uploaded_by: Ref | None
    via: TechDocumentVia
    # Link assinado de 30 min, relativo à API.
    url: str


class TechDocumentOut(BaseModel):
    """GET /technicians/{id}/documents e ApplicationDetail.documents."""

    id: uuid.UUID
    kind: TechDocumentKind
    title: str
    expires_on: date | None
    # O arquivo atual (file.id == id).
    file: TechDocumentFileOut
    # As versões substituídas, a mais nova primeiro (até 3).
    previous: list[TechDocumentFileOut]
    created_at: datetime
    updated_at: datetime


class TechDocumentUpdate(BaseModel):
    """PATCH …/documents/{id} (app e central): só o que vem muda; `expires_on` null (ou "") tira a
    validade; `title` null fica como está. O tipo nunca muda. As regras e as mensagens são as do
    envio (services/technician_documents.py): o título 2 a 80, a validade "AAAA-MM-DD" só na
    certificação."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    expires_on: str | None = None


class CertificationDueOut(BaseModel):
    """A certificação atual mais urgente do técnico: vencida ou vencendo em até 30 dias (a de menor
    validade); `count`: quantas estão assim."""

    document_id: uuid.UUID
    title: str
    expires_on: date
    count: int


class FichaDocumentOut(BaseModel):
    """POST /public/onboarding-documents: o arquivo recebido na ficha já enviada."""

    id: uuid.UUID
    kind: TechnicianDocumentKind
    title: str
    expires_on: date | None
    file_name: str
    size: int


class FichaDocumentRemove(BaseModel):
    """POST /public/onboarding-documents/{id}/remove: o `upload_token` da resposta do envio."""

    model_config = ConfigDict(extra="forbid")

    token: str = Field(max_length=4096)
