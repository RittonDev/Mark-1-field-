"""Chave PIX do técnico: normalização, validação, exibição e máscara.

O técnico cadastra a chave no app (Meu cadastro, com a senha) para receber por chamado; a central vê
em Pagamentos e no cadastro em Técnicos. A chave fica gravada normalizada:
- CPF: 11 dígitos; CNPJ: 14 caracteres em maiúsculas (aceita o alfanumérico, core/documents.py);
- e-mail: em minúsculas; celular: "+55" e 11 dígitos; chave aleatória: 8-4-4-4-12 em minúsculas.

O histórico do cadastro e o registro do pagamento guardam só a chave mascarada (`describe`). Os
mesmos formatos estão em constants.ts (formatPixKey) e as mesmas mensagens em mobile/src/lib/pix.ts.
"""

import re

from app.core.documents import is_valid_cnpj, is_valid_cpf
from app.core.enums import PixKeyType

LABELS: dict[str, str] = {
    PixKeyType.CPF: "CPF",
    PixKeyType.CNPJ: "CNPJ",
    PixKeyType.EMAIL: "E-mail",
    PixKeyType.PHONE: "Celular",
    PixKeyType.RANDOM: "Chave aleatória",
}

# Tamanho máximo da chave por e-mail no PIX.
EMAIL_MAX = 77

INVALID_TYPE = "Escolha o tipo da chave PIX"
INVALID_CPF = "CPF inválido: confira os números"
INVALID_CNPJ = "CNPJ inválido: confira os números"
INVALID_EMAIL = "E-mail inválido"
INVALID_PHONE = "Celular inválido: use DDD e número, com o 9"
INVALID_RANDOM = "Chave aleatória inválida: copie a chave do app do seu banco"

_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
# DDD de dois dígitos sem zero e o número do celular, que começa com 9.
_MOBILE = re.compile(r"[1-9]{2}9\d{8}")
_RANDOM = re.compile(r"[0-9a-f]{32}")


def key_type(value: PixKeyType | str) -> PixKeyType:
    try:
        return PixKeyType(value)
    except ValueError:
        raise ValueError(INVALID_TYPE) from None


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text)


def normalize(kind: PixKeyType | str, text: str) -> str:
    """A chave como fica gravada; ValueError com a mensagem para a pessoa quando não vale."""
    kind = key_type(kind)
    raw = (text or "").strip()
    if kind == PixKeyType.CPF:
        digits = _digits(raw)
        if not is_valid_cpf(digits):
            raise ValueError(INVALID_CPF)
        return digits
    if kind == PixKeyType.CNPJ:
        clean = re.sub(r"[^0-9A-Za-z]", "", raw).upper()
        if not is_valid_cnpj(clean):
            raise ValueError(INVALID_CNPJ)
        return clean
    if kind == PixKeyType.EMAIL:
        email = raw.lower()
        if len(email) > EMAIL_MAX or not _EMAIL.fullmatch(email):
            raise ValueError(INVALID_EMAIL)
        return email
    if kind == PixKeyType.PHONE:
        digits = _digits(raw)
        if len(digits) in (12, 13) and digits.startswith("55"):
            digits = digits[2:]
        if not _MOBILE.fullmatch(digits):
            raise ValueError(INVALID_PHONE)
        return f"+55{digits}"
    hexa = re.sub(r"[\s-]", "", raw).lower()
    if not _RANDOM.fullmatch(hexa):
        raise ValueError(INVALID_RANDOM)
    return f"{hexa[:8]}-{hexa[8:12]}-{hexa[12:16]}-{hexa[16:20]}-{hexa[20:]}"


def _phone_digits(key: str) -> str:
    digits = _digits(key)
    return digits[2:] if len(digits) == 13 and digits.startswith("55") else digits


def display(kind: PixKeyType | str, key: str) -> str:
    """Para ler e conferir: "123.456.789-09", "11.222.333/0001-81", "+55 (11) 98888-7777"; e-mail
    e chave aleatória como estão."""
    kind = key_type(kind)
    if kind == PixKeyType.CPF and len(key) == 11:
        return f"{key[:3]}.{key[3:6]}.{key[6:9]}-{key[9:]}"
    if kind == PixKeyType.CNPJ and len(key) == 14:
        return f"{key[:2]}.{key[2:5]}.{key[5:8]}/{key[8:12]}-{key[12:]}"
    if kind == PixKeyType.PHONE:
        digits = _phone_digits(key)
        if len(digits) == 11:
            return f"+55 ({digits[:2]}) {digits[2:7]}-{digits[7:]}"
    return key


def mask(kind: PixKeyType | str, key: str) -> str:
    """Só o bastante para reconhecer a chave: "***.456.789-**", "11.222.333/****-**",
    "t***@exemplo.com", "+55 (11) *****-7777", "…4000"."""
    kind = key_type(kind)
    if kind == PixKeyType.CPF and len(key) == 11:
        return f"***.{key[3:6]}.{key[6:9]}-**"
    if kind == PixKeyType.CNPJ and len(key) == 14:
        return f"{key[:2]}.{key[2:5]}.{key[5:8]}/****-**"
    if kind == PixKeyType.EMAIL and "@" in key:
        local, _, domain = key.partition("@")
        return f"{local[:1]}***@{domain}"
    if kind == PixKeyType.PHONE:
        digits = _phone_digits(key)
        if len(digits) == 11:
            return f"+55 ({digits[:2]}) *****-{digits[7:]}"
    return f"…{key[-4:]}"


def describe(kind: PixKeyType | str, key: str, masked: bool = True) -> str:
    """Tipo e chave numa linha: "CPF ***.456.789-**" (ou a chave inteira com masked=False)."""
    kind = key_type(kind)
    shown = mask(kind, key) if masked else display(kind, key)
    return f"{LABELS[kind]} {shown}"
