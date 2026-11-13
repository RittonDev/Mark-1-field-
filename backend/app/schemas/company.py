"""Dados da empresa: cabeçalho dos orçamentos e relatórios que o cliente recebe."""

import re

from pydantic import BaseModel, Field, field_validator

from app.core.documents import is_valid_cnpj, normalize_document

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class CompanyProfile(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    document: str | None = Field(default=None, max_length=20)  # CNPJ
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=40)
    address: str | None = Field(default=None, max_length=300)
    website: str | None = Field(default=None, max_length=200)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value: object) -> object:
        return " ".join(value.split()) if isinstance(value, str) else value

    @field_validator("document", "email", "phone", "address", "website", mode="before")
    @classmethod
    def _blank_is_none(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.strip()
            return value or None
        return value

    @field_validator("email")
    @classmethod
    def _email(cls, value: str | None) -> str | None:
        if value is not None and not EMAIL.match(value):
            raise ValueError("E-mail inválido")
        return value


class CompanyProfileIn(CompanyProfile):
    """O que a gestão salva em Configurações: o CNPJ (inclusive o alfanumérico) precisa ser
    válido e é guardado sem pontuação. A leitura (CompanyProfile) não valida de novo, para um
    cadastro antigo não sumir do cabeçalho."""

    @field_validator("document")
    @classmethod
    def _cnpj(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not is_valid_cnpj(value):
            raise ValueError("CNPJ inválido: confira os 14 caracteres e os dígitos verificadores")
        return normalize_document(value)
