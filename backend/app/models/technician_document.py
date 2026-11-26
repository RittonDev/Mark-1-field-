"""Documentos do técnico: certificações (com validade opcional), documentos pessoais, o currículo e
os anexos internos da central (services/technician_documents.py).

O técnico envia no app e na ficha da homologação (depois do envio dela, com o token de 2 h); a
central vê, anexa os quatro tipos e só ela vê os anexos internos (com Técnicos Editar). O arquivo
segue o pipeline da nota fiscal (PDF, JPG, PNG ou WebP pelo conteúdo, até 10 MB) e mora em
MEDIA_ROOT/documents/{user_id}/ ou documents/fichas/{application_id}/ (a aprovação não move).

Versões com id estável: substituir copia o arquivo de antes para uma linha de versão
(`version_of_id` = o documento, `replaced_at` = quando saiu) e grava o novo no próprio documento,
que mantém o id; ficam as 3 versões mais novas. A versão copia `user_id`/`application_id`. Excluir
o documento leva as versões (FK em cascata).

Dono: `user_id` (o técnico) ou, antes da aprovação, só `application_id` (a ficha); a aprovação põe
o `user_id`. A ficha apagada leva antes os documentos só dela (a FK SET NULL deixaria o documento
sem dono, e o check recusa).
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import TechDocumentKind
from app.db.base import Base, Timestamps, UUIDPrimaryKey, utcnow
from app.models._types import str_enum
from app.models.user import User


class TechnicianDocument(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "technician_documents"
    __table_args__ = (
        # O mesmo envio repetido (o app e a ficha reenviam quando a resposta se perde) devolve o
        # mesmo documento; o índice é a reserva para os dois pedidos juntos.
        UniqueConstraint("client_upload_id", name="uq_technician_documents_client_upload_id"),
        # Um currículo atual por técnico (enviar outro substitui).
        Index(
            "uq_technician_documents_user_resume",
            "user_id",
            unique=True,
            postgresql_where=text(
                "kind = 'resume' AND version_of_id IS NULL AND user_id IS NOT NULL"
            ),
        ),
        # O aviso de vencimento (lista, ficha e Início): só as certificações atuais com validade.
        Index(
            "ix_technician_documents_expiry",
            "expires_on",
            postgresql_where=text(
                "kind = 'certification' AND version_of_id IS NULL AND expires_on IS NOT NULL"
            ),
        ),
        CheckConstraint("user_id IS NOT NULL OR application_id IS NOT NULL", name="owner"),
        # Validade só na certificação.
        CheckConstraint("expires_on IS NULL OR kind = 'certification'", name="expiry"),
        # O anexo interno é da central: nunca da ficha.
        CheckConstraint("kind <> 'internal' OR application_id IS NULL", name="internal"),
        # Versão (linha com o arquivo substituído) se e só se tem a data da troca.
        CheckConstraint("(version_of_id IS NULL) = (replaced_at IS NULL)", name="version"),
    )

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    application_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("technician_applications.id", ondelete="SET NULL"), index=True
    )
    # Linha de versão: o documento atual de quem ela é a versão anterior.
    version_of_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("technician_documents.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[TechDocumentKind] = mapped_column(str_enum(TechDocumentKind))
    # 2 a 80, limpo; o currículo é sempre "Currículo".
    title: Mapped[str] = mapped_column(String(80))
    # Só na certificação (o dia, no fuso da operação).
    expires_on: Mapped[date | None] = mapped_column(Date)
    # O arquivo: nome limpo, o tipo real pelo conteúdo (storage.sniff_document), o tamanho e a
    # chave dentro de MEDIA_ROOT.
    file_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str] = mapped_column(String(500))
    # Quando o arquivo atual chegou, quem mandou (null: o candidato, pela ficha) e por onde ("app",
    # "central" ou "ficha").
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    uploaded_via: Mapped[str] = mapped_column(String(10))
    # Na linha de versão: quando o arquivo dela foi substituído.
    replaced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Chave de idempotência do envio (o app e a ficha geram uma por arquivo).
    client_upload_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)

    uploaded_by: Mapped[User | None] = relationship(foreign_keys=[uploaded_by_id], lazy="selectin")
