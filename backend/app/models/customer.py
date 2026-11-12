import uuid
from typing import Any

from sqlalchemy import Boolean, Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Timestamps, UUIDPrimaryKey


class Customer(UUIDPrimaryKey, Timestamps, Base):
    """Cliente / entidade atendida (empresa ou unidade de negócio)."""

    __tablename__ = "customers"

    name: Mapped[str] = mapped_column(String(200), index=True)
    document: Mapped[str | None] = mapped_column(String(20), unique=True)  # CNPJ / CPF
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(40))
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # Etiquetas (ex.: "Avulso", "Faturamento Matriz"): [{name, color}].
    tags: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default="[]")
    # Todos os contatos: [{kind: email|phone, value, name, label, primary}] (o principal também
    # fica em email/phone).
    contacts: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default="[]")
    # Endereço da matriz.
    address_line: Mapped[str | None] = mapped_column(String(255))
    district: Mapped[str | None] = mapped_column(String(120))
    city: Mapped[str | None] = mapped_column(String(120))
    state: Mapped[str | None] = mapped_column(String(2))
    zip_code: Mapped[str | None] = mapped_column(String(10))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    logo_url: Mapped[str | None] = mapped_column(String(1000))
    # Origem (Field Control): id, data de cadastro, avaliação, totais de atendimento, anexos.
    legacy: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


class Location(UUIDPrimaryKey, Timestamps, Base):
    """Local de atendimento (site / filial / andar) com coordenadas para o técnico de campo."""

    __tablename__ = "locations"

    customer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("customers.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200), index=True)
    # Código interno do cliente para a filial (ex.: "Loja 41", "CD-02").
    code: Mapped[str | None] = mapped_column(String(40), index=True)
    # Filial é entidade fiscal: CNPJ próprio (pode repetir entre andares/salas do mesmo prédio).
    document: Mapped[str | None] = mapped_column(String(20), index=True)
    address_line: Mapped[str | None] = mapped_column(String(255))
    district: Mapped[str | None] = mapped_column(String(120))
    city: Mapped[str | None] = mapped_column(String(120))
    state: Mapped[str | None] = mapped_column(String(2))
    zip_code: Mapped[str | None] = mapped_column(String(10))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    contact_name: Mapped[str | None] = mapped_column(String(160))
    contact_phone: Mapped[str | None] = mapped_column(String(40))
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # Todos os contatos da filial (o principal também fica em contact_name/contact_phone).
    contacts: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default="[]")
    # Origem (Field Control): id, data de cadastro, territórios.
    legacy: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    customer: Mapped[Customer] = relationship(lazy="selectin")
