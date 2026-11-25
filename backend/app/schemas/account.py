"""E-mails transacionais e links da conta (validar o e-mail, criar uma senha nova).

Os nomes e os campos são os de lib/types.ts (EmailQueued, EmailLog, PasswordResetCheck,
PasswordResetDone, VerifyEmailResult): web e app leem estes formatos.
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.enums import EmailStatus, EmailTemplate
from app.schemas.common import ORMModel, Ref

# Pedido de e-mail agora: na fila; envio desligado (a linha entra e vence sem sair); sem endereço
# que recebe mensagens (nada entra).
EmailQueuedStatus = Literal["queued", "not_configured", "not_sendable"]

# O token do link (secrets.token_urlsafe(32): 43 caracteres); bem mais que isso não é nosso.
TOKEN_MAX = 128


class EmailQueued(BaseModel):
    status: EmailQueuedStatus
    # Para onde vai (null quando o endereço não recebe mensagens).
    to: str | None = None


class EmailLogOut(ORMModel):
    """GET /technicians/{id}/emails: o registro do que foi pedido e enviado, o mais novo
    primeiro."""

    id: uuid.UUID
    template: EmailTemplate
    to_email: str
    status: EmailStatus
    attempts: int
    created_at: datetime
    sent_at: datetime | None
    created_by: Ref | None


class TokenIn(BaseModel):
    """POST /auth/verify-email e /auth/password-reset/check: o token do link (#token=)."""

    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=TOKEN_MAX)

    @field_validator("token")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()


class PasswordResetIn(TokenIn):
    """POST /auth/password-reset: o token e a senha nova."""

    password: str = Field(min_length=8, max_length=128)


class ForgotPasswordIn(BaseModel):
    """POST /auth/forgot-password. Texto livre de propósito: a resposta é a mesma para qualquer
    e-mail (existe ou não, recebe mensagens ou não)."""

    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=1, max_length=255)

    @field_validator("email")
    @classmethod
    def _lower(cls, value: str) -> str:
        return value.strip().lower()


class PasswordResetCheck(BaseModel):
    """O link de senha, sem gastá-lo: a conta (e-mail mascarado, "t***@exemplo.com"), o primeiro
    nome e o tipo ("create": a primeira senha, pelo link da boas-vindas; "reset": senha nova)."""

    email: str
    name: str
    kind: Literal["reset", "create"]
    app_url: str | None = None


class PasswordResetDone(BaseModel):
    """Senha gravada: o login (e-mail) e o link do app, quando configurado."""

    email: str
    app_url: str | None = None


class VerifyEmailResult(BaseModel):
    """signup: a ficha; change: o login passou a ser `email`; check: o login de sempre."""

    email: str
    kind: Literal["signup", "change", "check"]
