"""Dados pessoais e da empresa do técnico: validação e formato (ficha pública, app e central).

Puro: cada função devolve o valor como se grava (None quando vazio) ou levanta ValueError com a
mensagem da tela (sem ponto final; os validadores do pydantic usam direto). As regras são as de
lib/constants.ts (normalizeRg, isValidRg, normalizeIssuer, normalizePlate, isValidPlate,
formatPlate, ageAt, PROFILE_LIMITS, BIRTH_AGE). Os tamanhos dos campos livres ficam no pydantic
(Field(max_length=...), com o rótulo de app.main.FIELD_LABELS): use as constantes daqui.

Sem importar services.* nem schemas.onboarding no topo (ciclo onboarding → personal → tech_profile
→ onboarding): `clean` e `UFS` por import tardio, dentro das funções.
"""

import re
import unicodedata
from datetime import date, datetime
from zoneinfo import ZoneInfo

from app.core.config import settings
from app.core.documents import is_valid_cnpj, is_valid_cpf, normalize_document
from app.schemas.records import format_phone

# Tamanhos (= PROFILE_LIMITS e BIRTH_AGE de lib/constants.ts).
BIO_MAX = 500
RG_NUMBER_MAX = 20
RG_ISSUER_MAX = 20
ADDRESS_NUMBER_MAX = 10
ADDRESS_COMPLEMENT_MAX = 60
COMPANY_NAME_MAX = 160
VEHICLE_MODEL_MAX = 60
BIRTH_AGE_MIN = 18
BIRTH_AGE_MAX = 90
RG_MIN = 5
RG_DIGITS_MIN = 4
ISSUER_MIN = 2
PHONE_DIGITS_MIN, PHONE_DIGITS_MAX = 10, 13

CPF_INVALID = "CPF inválido"
CNPJ_INVALID = "CNPJ inválido"
RG_INVALID = "Confira o número do RG"
ISSUER_INVALID = "Confira o órgão emissor"
UF_INVALID = "UF inválida"
RG_INCOMPLETE = "Informe o número, o órgão emissor e a UF do RG"
PLATE_INVALID = "Placa inválida: confira as letras e os números"
PHONE_INVALID = "Informe o telefone com DDD"
BIRTH_UNDERAGE = "O cadastro é para maiores de 18 anos: confira a data de nascimento"
BIRTH_INVALID = "Confira a data de nascimento"
COMPANY_WITHOUT_CNPJ = "Informe o CNPJ"

_CPF_TEXT = re.compile(r"[\d.\-\s]+")
_RG_DROP = re.compile(r"[^0-9A-Z./ -]")
_ISSUER_DROP = re.compile(r"[^A-Z ]")
_MARKS = re.compile(r"[̀-ͯ]")
_PLATE = re.compile(r"[A-Z]{3}[0-9][A-Z0-9][0-9]{2}")
_OLD_PLATE = re.compile(r"[A-Z]{3}[0-9]{4}")
_ISO_DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def too_long(max_len: int) -> str:
    return f"No máximo {max_len} caracteres"


def clean_text(value: str | None, max_len: int | None = None) -> str | None:
    """Sem controles nem formatação, NFC e espaços juntados (services/tech_profile.clean); vazio
    vira None; passou de `max_len`: "No máximo N caracteres"."""
    from app.services.tech_profile import clean

    text = clean(value or "")
    if not text:
        return None
    if max_len is not None and len(text) > max_len:
        raise ValueError(too_long(max_len))
    return text


# ------------------------------------------------------------------ documentos


def cpf(value: str | None) -> str | None:
    """CPF com os 11 números ("123.456.789-09" vale)."""
    text = (value or "").strip()
    if not text:
        return None
    digits = re.sub(r"\D", "", text)
    if not _CPF_TEXT.fullmatch(text) or not is_valid_cpf(digits):
        raise ValueError(CPF_INVALID)
    return digits


def cnpj(value: str | None) -> str | None:
    """CNPJ sem pontuação, em maiúsculas (aceita o alfanumérico)."""
    text = (value or "").strip()
    if not text:
        return None
    if not is_valid_cnpj(text):
        raise ValueError(CNPJ_INVALID)
    return normalize_document(text)


def normalize_rg(text: str | None) -> str:
    """= normalizeRg sem o corte: maiúsculas, só números, letras, ".", "/", "-" e espaço."""
    return re.sub(r"\s+", " ", _RG_DROP.sub("", (text or "").upper()))


def rg_number(value: str | None) -> str | None:
    """Número do RG: 5 a 20 caracteres com pelo menos 4 números ("12.345.678-X",
    "MG-12.345.678")."""
    if not (value or "").strip():
        return None
    rg = normalize_rg(value).strip()
    if not RG_MIN <= len(rg) <= RG_NUMBER_MAX or len(re.findall(r"[0-9]", rg)) < RG_DIGITS_MIN:
        raise ValueError(RG_INVALID)
    return rg


def normalize_issuer(text: str | None) -> str:
    """= normalizeIssuer sem o corte: letras sem acento e espaço, em maiúsculas ("SSP")."""
    plain = _MARKS.sub("", unicodedata.normalize("NFD", text or ""))
    return re.sub(r"\s+", " ", _ISSUER_DROP.sub("", plain.upper()))


def rg_issuer(value: str | None) -> str | None:
    """Órgão emissor do RG: 2 a 20 letras."""
    if not (value or "").strip():
        return None
    issuer = normalize_issuer(value).strip()
    if not ISSUER_MIN <= len(issuer) <= RG_ISSUER_MAX:
        raise ValueError(ISSUER_INVALID)
    return issuer


def uf(value: str | None) -> str | None:
    """Uma das 27 UFs, em maiúsculas."""
    from app.schemas.onboarding import UFS

    text = (value or "").strip().upper()
    if not text:
        return None
    if text not in UFS:
        raise ValueError(UF_INVALID)
    return text


def rg_group(
    number: str | None, issuer: str | None, state: str | None
) -> tuple[str | None, str | None, str | None]:
    """O RG vai com os três ou nenhum: sem o número, os três ficam vazios; com ele, órgão e UF são
    obrigatórios. Devolve (número, órgão, UF) normalizados."""
    rg = rg_number(number)
    if rg is None:
        return None, None, None
    issuer_value, state_value = rg_issuer(issuer), uf(state)
    if issuer_value is None or state_value is None:
        raise ValueError(RG_INCOMPLETE)
    return rg, issuer_value, state_value


def company_group(
    document: str | None, name: str | None, trade: str | None
) -> tuple[str | None, str | None, str | None]:
    """Empresa: razão social ou nome fantasia pedem o CNPJ. Devolve (CNPJ, razão social, nome
    fantasia) normalizados."""
    document_value = cnpj(document)
    name_value = clean_text(name, COMPANY_NAME_MAX)
    trade_value = clean_text(trade, COMPANY_NAME_MAX)
    if (name_value or trade_value) and document_value is None:
        raise ValueError(COMPANY_WITHOUT_CNPJ)
    return document_value, name_value, trade_value


# ------------------------------------------------------------------ contato e veículo


def normalize_plate(text: str | None) -> str:
    """= normalizePlate sem o corte: letras e números, em maiúsculas."""
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def plate(value: str | None) -> str | None:
    """Placa antiga (ABC1234) ou Mercosul (ABC1D23), gravada sem hífen ("abc-1234" → "ABC1234")."""
    if not (value or "").strip():
        return None
    normalized = normalize_plate(value)
    if not _PLATE.fullmatch(normalized):
        raise ValueError(PLATE_INVALID)
    return normalized


def phone(value: str | None) -> str | None:
    """Telefone com DDD (10 a 13 números), gravado como o celular: "(11) 98888-7777"."""
    text = (value or "").strip()
    if not text:
        return None
    digits = re.sub(r"\D", "", text)
    if not PHONE_DIGITS_MIN <= len(digits) <= PHONE_DIGITS_MAX:
        raise ValueError(PHONE_INVALID)
    return format_phone(digits) or digits


def local_today() -> date:
    """Hoje no fuso da operação (Brasília): o servidor roda em UTC."""
    return datetime.now(ZoneInfo(settings.TIMEZONE)).date()


def age_at(birth: date, today: date) -> int:
    """Idade completa em `today` (= ageAt)."""
    return today.year - birth.year - ((today.month, today.day) < (birth.month, birth.day))


def birth_date(value: date | str | None, today: date | None = None) -> date | None:
    """Nascimento: de 18 a 90 anos completos no dia de Brasília (`today`, para os testes). Aceita a
    data ou "AAAA-MM-DD"; data que não existe: "Confira a data de nascimento"."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, str):
        text = value.strip()
        try:
            if not _ISO_DAY.fullmatch(text):
                raise ValueError(text)
            value = date.fromisoformat(text)
        except ValueError:
            raise ValueError(BIRTH_INVALID) from None
    age = age_at(value, today or local_today())
    if age < BIRTH_AGE_MIN:
        raise ValueError(BIRTH_UNDERAGE)
    if age > BIRTH_AGE_MAX:
        raise ValueError(BIRTH_INVALID)
    return value


def bio(value: str | None) -> str | None:
    """Mini biografia: texto limpo, até 500 caracteres."""
    return clean_text(value, BIO_MAX)


# ------------------------------------------------------------------ exibição (histórico)


def format_cpf(value: str | None) -> str | None:
    """CPF para ler: "123.456.789-09" (como está quando não tem 11 números)."""
    if not value:
        return None
    return f"{value[:3]}.{value[3:6]}.{value[6:9]}-{value[9:]}" if len(value) == 11 else value


def format_cnpj(value: str | None) -> str | None:
    """CNPJ para ler: "12.345.678/0001-95" (como está quando não tem 14 caracteres)."""
    if not value:
        return None
    if len(value) != 14:
        return value
    return f"{value[:2]}.{value[2:5]}.{value[5:8]}/{value[8:12]}-{value[12:]}"


def format_plate(value: str | None) -> str | None:
    """Placa para ler: "ABC-1234" na antiga; a Mercosul como está ("ABC1D23")."""
    if not value:
        return None
    normalized = normalize_plate(value)
    if _OLD_PLATE.fullmatch(normalized):
        return f"{normalized[:3]}-{normalized[3:]}"
    return normalized


def format_rg(number: str | None, issuer: str | None, state: str | None) -> str | None:
    """RG para ler: "12.345.678-9 · SSP/SP" (só o número quando falta o resto)."""
    if not number:
        return None
    rest = "/".join(part for part in (issuer, state) if part)
    return f"{number} · {rest}" if rest else number


def format_date(value: date | str | None) -> str | None:
    """Data para ler: "25/11/1990"."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        value = date.fromisoformat(value[:10])
    return value.strftime("%d/%m/%Y")
