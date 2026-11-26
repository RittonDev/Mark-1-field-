"""Formas de recebimento do técnico: chaves PIX e contas bancárias (services/payout_methods.py).

O técnico cadastra e muda no app, com a senha (POST/PUT /me/profile/payout-methods...); a central vê
em Pagamentos (PayoutMethodAdmin, com "Titular diferente" e o "Nova") e remove. Os nomes e os
campos são os de lib/types.ts (PayoutMethod, PayoutMethodAdmin, PayoutMethodSummary,
PayoutMethodCreate, PayoutMethodUpdate, PasswordConfirm); as mensagens são as do app
(mobile/src/lib/payoutForm.ts), sem o ponto final.

Entrada: um corpo só para os dois tipos (`kind`). Os campos do outro tipo são ignorados (gravam
null). Cada campo se valida com o rótulo dele (app.main.FIELD_LABELS):
- PIX: `pix_key_type` e `pix_key` normalizada por core/pix (as mensagens de lá; vazia "Informe a
  chave PIX");
- conta: `bank_code` com 3 números, `bank_name` (2 a 80), `branch` (1 a 4 números, gravada com 4),
  `account_number` (1 a 20 números), `account_digit` (um número ou X) e `account_type`;
- titular: `holder_name` (3 a 160, espaços juntados) e `holder_document`, CPF ou CNPJ válido sem
  pontuação; na chave CPF ou CNPJ, a própria chave (o que vier é ignorado).
"""

import re
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

from app.core import pix
from app.core.documents import is_valid_cnpj, is_valid_cpf
from app.core.enums import BankAccountType, PayoutMethodKind, PixKeyType
from app.schemas.common import ORMModel
from app.schemas.personal import clean_text

# = PAYOUT_LIMITS de lib/constants.ts.
METHODS_MAX = 10
HOLDER_NAME_MIN, HOLDER_NAME_MAX = 3, 160
BANK_NAME_MIN, BANK_NAME_MAX = 2, 80
BRANCH_DIGITS = 4
ACCOUNT_NUMBER_MAX = 20
PIX_KEY_MAX = 120
PASSWORD_MAX = 256

PIX_KEY_REQUIRED = "Informe a chave PIX"
BANK_CODE_INVALID = "Código do banco com 3 números"
BANK_NAME_REQUIRED = "Informe o banco"
BRANCH_INVALID = "Agência inválida: use até 4 números"
ACCOUNT_NUMBER_INVALID = "Conta inválida: use só números"
ACCOUNT_DIGIT_INVALID = "Dígito da conta inválido"
ACCOUNT_TYPE_REQUIRED = "Escolha o tipo de conta"
HOLDER_NAME_REQUIRED = "Informe o nome do titular"
HOLDER_DOCUMENT_REQUIRED = "Informe o CPF ou CNPJ do titular"
HOLDER_DOCUMENT_INVALID = "CPF ou CNPJ do titular inválido"

_BANK_CODE = re.compile(r"[0-9]{3}")
_BRANCH = re.compile(r"[0-9]{1,4}")
_ACCOUNT_NUMBER = re.compile(r"[0-9]{1,20}")
_ACCOUNT_DIGIT = re.compile(r"[0-9X]")
# Chaves que já são o documento do titular.
DOCUMENT_KEYS = frozenset({PixKeyType.CPF, PixKeyType.CNPJ})


class PayoutMethodOut(ORMModel):
    """Uma forma de recebimento como o app mostra (PayoutMethod): os campos dos dois tipos, null nos
    do outro. A lista vem com a preferencial primeiro, depois as mais novas."""

    id: uuid.UUID
    kind: PayoutMethodKind
    # Uma só no conjunto (com a lista não vazia, sempre uma): onde a central paga.
    preferred: bool
    holder_name: str
    # CPF (11) ou CNPJ (14, pode ter letras), sem pontuação; null só nas chaves de antes que não
    # são CPF nem CNPJ.
    holder_document: str | None
    created_at: datetime
    # Última troca da chave, da conta ou do titular.
    changed_at: datetime
    pix_key_type: PixKeyType | None
    pix_key: str | None
    bank_code: str | None
    bank_name: str | None
    branch: str | None
    account_number: str | None
    account_digit: str | None
    account_type: BankAccountType | None


class PayoutMethodAdmin(PayoutMethodOut):
    """Na central (Pagamentos Ver): quem paga confere o titular e o destino novo."""

    # O titular não é o técnico nem a empresa dele (services/payout_methods.holder_differs).
    holder_differs: bool
    # max(changed_at, quando virou a preferencial): "Nova" por PAYOUT_RECENT_DAYS.
    destination_changed_at: datetime


class PayoutMethodSummary(BaseModel):
    """GET /payouts?with_payout_methods=true: a preferencial de cada técnico e quantas ele tem."""

    preferred: PayoutMethodAdmin
    total: int


def _spaces(value: str | None) -> str:
    """Sem controles, NFC e espaços juntados (schemas/personal.clean_text); vazio vira ""."""
    return clean_text(value) or ""


class PayoutMethodIn(BaseModel):
    """Chave PIX ou conta bancária, como o app manda (PayoutMethodIn). Os campos ficam nesta ordem:
    cada validador lê os anteriores (`kind`, o tipo da chave)."""

    model_config = ConfigDict(extra="forbid")

    kind: PayoutMethodKind
    pix_key_type: str | None = Field(default=None, max_length=32, validate_default=True)
    pix_key: str | None = Field(default=None, max_length=PIX_KEY_MAX, validate_default=True)
    bank_code: str | None = Field(default=None, max_length=10, validate_default=True)
    bank_name: str | None = Field(default=None, max_length=BANK_NAME_MAX, validate_default=True)
    branch: str | None = Field(default=None, max_length=10, validate_default=True)
    account_number: str | None = Field(default=None, max_length=40, validate_default=True)
    account_digit: str | None = Field(default=None, max_length=4, validate_default=True)
    account_type: str | None = Field(default=None, max_length=32, validate_default=True)
    holder_name: str | None = Field(default=None, max_length=HOLDER_NAME_MAX, validate_default=True)
    holder_document: str | None = Field(default=None, max_length=40, validate_default=True)

    # ------------------------------------------------------------------ PIX

    @field_validator("pix_key_type")
    @classmethod
    def _pix_key_type(cls, value: str | None, info: ValidationInfo) -> PixKeyType | None:
        if info.data.get("kind") != PayoutMethodKind.PIX:
            return None
        return pix.key_type(value or "")

    @field_validator("pix_key")
    @classmethod
    def _pix_key(cls, value: str | None, info: ValidationInfo) -> str | None:
        if info.data.get("kind") != PayoutMethodKind.PIX:
            return None
        if not (value or "").strip():
            raise ValueError(PIX_KEY_REQUIRED)
        key_type = info.data.get("pix_key_type")
        if key_type is None:  # o tipo já deu erro
            return None
        return pix.normalize(key_type, value or "")

    # ------------------------------------------------------------------ conta

    @field_validator("bank_code")
    @classmethod
    def _bank_code(cls, value: str | None, info: ValidationInfo) -> str | None:
        if info.data.get("kind") != PayoutMethodKind.BANK:
            return None
        code = (value or "").strip()
        if not _BANK_CODE.fullmatch(code):
            raise ValueError(BANK_CODE_INVALID)
        return code

    @field_validator("bank_name")
    @classmethod
    def _bank_name(cls, value: str | None, info: ValidationInfo) -> str | None:
        if info.data.get("kind") != PayoutMethodKind.BANK:
            return None
        name = _spaces(value)
        if len(name) < BANK_NAME_MIN:
            raise ValueError(BANK_NAME_REQUIRED)
        return name

    @field_validator("branch")
    @classmethod
    def _branch(cls, value: str | None, info: ValidationInfo) -> str | None:
        if info.data.get("kind") != PayoutMethodKind.BANK:
            return None
        branch = (value or "").strip()
        if not _BRANCH.fullmatch(branch):
            raise ValueError(BRANCH_INVALID)
        return branch.zfill(BRANCH_DIGITS)

    @field_validator("account_number")
    @classmethod
    def _account_number(cls, value: str | None, info: ValidationInfo) -> str | None:
        if info.data.get("kind") != PayoutMethodKind.BANK:
            return None
        number = (value or "").strip()
        if not _ACCOUNT_NUMBER.fullmatch(number):
            raise ValueError(ACCOUNT_NUMBER_INVALID)
        return number

    @field_validator("account_digit")
    @classmethod
    def _account_digit(cls, value: str | None, info: ValidationInfo) -> str | None:
        if info.data.get("kind") != PayoutMethodKind.BANK:
            return None
        digit = (value or "").strip().upper()
        if not _ACCOUNT_DIGIT.fullmatch(digit):
            raise ValueError(ACCOUNT_DIGIT_INVALID)
        return digit

    @field_validator("account_type")
    @classmethod
    def _account_type(cls, value: str | None, info: ValidationInfo) -> BankAccountType | None:
        if info.data.get("kind") != PayoutMethodKind.BANK:
            return None
        try:
            return BankAccountType(value or "")
        except ValueError:
            raise ValueError(ACCOUNT_TYPE_REQUIRED) from None

    # ------------------------------------------------------------------ titular

    @field_validator("holder_name")
    @classmethod
    def _holder_name(cls, value: str | None, info: ValidationInfo) -> str | None:
        if "kind" not in info.data:  # o tipo já deu erro
            return None
        name = _spaces(value)
        if len(name) < HOLDER_NAME_MIN:
            raise ValueError(HOLDER_NAME_REQUIRED)
        return name

    @field_validator("holder_document")
    @classmethod
    def _holder_document(cls, value: str | None, info: ValidationInfo) -> str | None:
        kind = info.data.get("kind")
        if kind is None:
            return None
        if kind == PayoutMethodKind.PIX:
            if "pix_key_type" not in info.data:  # o tipo da chave já deu erro
                return None
            if info.data["pix_key_type"] in DOCUMENT_KEYS:
                # A chave CPF/CNPJ é o documento do titular (a chave errada já deu erro).
                return info.data.get("pix_key")
        document = re.sub(r"[^0-9A-Za-z]", "", value or "").upper()
        if not document:
            raise ValueError(HOLDER_DOCUMENT_REQUIRED)
        valid = (len(document) == 11 and is_valid_cpf(document)) or (
            len(document) == 14 and is_valid_cnpj(document)
        )
        if not valid:
            raise ValueError(HOLDER_DOCUMENT_INVALID)
        return document

    def values(self) -> dict[str, Any]:
        """Os campos da forma como se gravam (os do outro tipo, null)."""
        return {
            "kind": self.kind,
            "pix_key_type": self.pix_key_type,
            "pix_key": self.pix_key,
            "bank_code": self.bank_code,
            "bank_name": self.bank_name,
            "branch": self.branch,
            "account_number": self.account_number,
            "account_digit": self.account_digit,
            "account_type": self.account_type,
            "holder_name": self.holder_name,
            "holder_document": self.holder_document,
        }


class PayoutMethodCreate(PayoutMethodIn):
    """POST /me/profile/payout-methods. A 1ª é a preferencial (o `preferred` não conta); depois,
    `preferred: true` faz desta a preferencial."""

    preferred: bool = False
    current_password: str | None = Field(default=None, max_length=PASSWORD_MAX)


class PayoutMethodUpdate(PayoutMethodIn):
    """PUT /me/profile/payout-methods/{id}: a forma inteira (o tipo não muda)."""

    current_password: str | None = Field(default=None, max_length=PASSWORD_MAX)


class PasswordConfirm(BaseModel):
    """Tornar preferencial e excluir: só a senha atual."""

    model_config = ConfigDict(extra="forbid")

    current_password: str | None = Field(default=None, max_length=PASSWORD_MAX)
