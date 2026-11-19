"""Meu cadastro do técnico (app) e o histórico do cadastro (central).

O técnico mantém no app a foto, o nome, o celular (WhatsApp), o e-mail de login, o endereço, a
cidade/UF, a região que atende e a chave PIX. E-mail e chave PIX pedem a senha atual
(services/my_profile.py). As mensagens são as mesmas do app (mobile/src/lib/pix.ts e a tela).

O nome vai para os textos do grupo do cliente, o relatório e o portal: pelo app, só letras (com
acento), espaço, apóstrofo, hífen e ponto, sem "www", "http" nem endereço colado ("site.com"). Vale
para o nome que o app manda (só quando muda): os nomes antigos ficam como estão.
"""

import re
import unicodedata
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.core import pix
from app.core.enums import PixKeyType
from app.schemas.common import ORMModel, Ref
from app.schemas.onboarding import UFS
from app.schemas.records import format_phone

NAME_REQUIRED = "Informe seu nome completo"
NAME_LETTERS = "Use só letras no nome"
PHONE_REQUIRED = "Informe o celular com DDD"
EMAIL_REQUIRED = "Informe um e-mail válido"
CITY_REQUIRED = "Informe a cidade"
BAD_UF = "UF inválida"
BAD_ZIP = "CEP com 8 dígitos"
PIX_KEY_REQUIRED = "Informe a chave PIX"
HOLDER_REQUIRED = "Informe o nome do titular da conta"


def _spaces(value: str | None) -> str:
    return " ".join((value or "").split())


# Além das letras: espaço, apóstrofo (o do teclado e os que o celular põe sozinho), hífen e ponto.
_NAME_MARKS = frozenset(" '’‘´`ʼ-.")
# Endereço colado ("site.com.br", "wa.me"): duas letras, ponto e letra. Iniciais ("J.R.") passam.
_NAME_ADDRESS = re.compile(r"[^\W\d_]{2}\.[^\W\d_]")


def _letters_only(name: str) -> bool:
    """Sem dígito, "@", "/", ":" nem link: o nome não leva contato para o cliente."""
    if not all(ch.isalpha() or ch in _NAME_MARKS for ch in name):
        return False
    # Letras de outra largura ("ｗｗｗ") contam como as comuns.
    folded = unicodedata.normalize("NFKC", name).casefold()
    return "www" not in folded and "http" not in folded and not _NAME_ADDRESS.search(folded)


class PixInfo(BaseModel):
    """A chave PIX como está gravada (normalizada): quem paga copia a chave crua."""

    key_type: PixKeyType
    key: str
    holder_name: str | None
    # Quando a chave mudou pela última vez (a central mostra "Chave nova" por 7 dias).
    updated_at: datetime | None


class PixIn(BaseModel):
    """Cadastrar ou trocar a chave PIX (tipo, chave ou titular): pede a senha atual."""

    model_config = ConfigDict(extra="forbid")

    key_type: PixKeyType
    key: str = Field(max_length=120)
    holder_name: str = Field(max_length=160)

    @field_validator("holder_name")
    @classmethod
    def _holder(cls, value: str) -> str:
        name = _spaces(value)
        if len(name) < 3:
            raise ValueError(HOLDER_REQUIRED)
        return name

    @model_validator(mode="after")
    def _normalize(self) -> "PixIn":
        if not self.key.strip():
            raise ValueError(PIX_KEY_REQUIRED)
        self.key = pix.normalize(self.key_type, self.key)
        return self


class MyProfileUpdate(BaseModel):
    """PATCH /me/profile: só o que vier no corpo muda. E-mail e PIX pedem `current_password`.

    O e-mail só é validado quando vem: há logins de teste sem "@"."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=160)
    phone: str | None = Field(default=None, max_length=40)
    email: EmailStr | None = Field(default=None, max_length=255)
    home_city: str | None = Field(default=None, max_length=120)
    home_state: str | None = Field(default=None, max_length=10)
    coverage_area: str | None = Field(default=None, max_length=1000)
    address_line: str | None = Field(default=None, max_length=255)
    address_district: str | None = Field(default=None, max_length=120)
    address_zip: str | None = Field(default=None, max_length=20)
    # null remove a chave.
    pix: PixIn | None = None
    current_password: str | None = Field(default=None, max_length=256)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str:
        # NFC: o acento digitado separado da letra vira uma letra só.
        name = unicodedata.normalize("NFC", _spaces(value))
        if len(name) < 3:
            raise ValueError(NAME_REQUIRED)
        if not _letters_only(name):
            raise ValueError(NAME_LETTERS)
        return name

    @field_validator("phone")
    @classmethod
    def _phone(cls, value: str | None) -> str:
        digits = re.sub(r"\D", "", value or "")
        if not 10 <= len(digits) <= 13:
            raise ValueError(PHONE_REQUIRED)
        return format_phone(digits) or digits

    @field_validator("email")
    @classmethod
    def _email(cls, value: str | None) -> str:
        if value is None:
            raise ValueError(EMAIL_REQUIRED)
        return value.strip().lower()

    @field_validator("home_city")
    @classmethod
    def _city(cls, value: str | None) -> str:
        city = _spaces(value)
        if len(city) < 2:
            raise ValueError(CITY_REQUIRED)
        return city

    @field_validator("home_state")
    @classmethod
    def _uf(cls, value: str | None) -> str:
        uf = (value or "").strip().upper()
        if uf not in UFS:
            raise ValueError(BAD_UF)
        return uf

    @field_validator("coverage_area", "address_line", "address_district")
    @classmethod
    def _optional(cls, value: str | None) -> str | None:
        return (value or "").strip() or None

    @field_validator("address_zip")
    @classmethod
    def _zip(cls, value: str | None) -> str | None:
        digits = re.sub(r"\D", "", value or "")
        if not digits:
            return None
        if len(digits) != 8:
            raise ValueError(BAD_ZIP)
        return f"{digits[:5]}-{digits[5:]}"


class MyProfile(BaseModel):
    """GET /me/profile (só o técnico). Endereço e PIX não vão no /auth/me nem no UserOut."""

    id: uuid.UUID
    name: str
    email: str
    phone: str | None
    job_title: str | None
    team: Ref | None
    home_city: str | None
    home_state: str | None
    coverage_area: str | None
    address_line: str | None
    address_district: str | None
    address_zip: str | None
    # Link assinado de 12 h (ou a foto que veio do Field Control).
    avatar_url: str | None
    pix: PixInfo | None


class UserChangeItem(BaseModel):
    """Uma mudança do cadastro, com o texto da tela (a chave PIX só mascarada). No JSON, "from"."""

    field: str
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None


class UserChangeOut(ORMModel):
    """Uma gravação no histórico do cadastro: quando, por onde, quem e o que mudou."""

    id: uuid.UUID
    created_at: datetime
    via: Literal["app", "central"]
    actor: Ref | None
    changes: list[UserChangeItem]
