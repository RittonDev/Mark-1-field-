"""Dados pessoais e da empresa do técnico: validação e formato (ficha pública, app e central).

Puro: cada função devolve o valor como se grava (None quando vazio) ou levanta ValueError com a
mensagem da tela (sem ponto final; os validadores do pydantic usam direto). As regras são as de
lib/constants.ts (normalizeRg, isValidRg, normalizeIssuer, splitIssuer, normalizeBio,
normalizePlate, isValidPlate, formatPlate, ageAt, PROFILE_LIMITS, BIRTH_AGE). Os tamanhos dos
campos livres ficam no pydantic (Field(max_length=...), com o rótulo de app.main.FIELD_LABELS): use
as constantes daqui.

O nome que a pessoa escreve (o app e a ficha pública) sai do sistema (os textos do grupo do
cliente, o relatório, o portal, os e-mails): só letras (com acento), espaço, apóstrofo, hífen e
ponto, sem "www", "http" nem endereço colado ("site.com"): `_letters_only`.

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
NAME_LETTERS = "Use só letras no nome"

_CPF_TEXT = re.compile(r"[\d.\-\s]+")
_RG_DROP = re.compile(r"[^0-9A-Z./ -]")
# Órgão emissor: letras, espaço, "/" e "-" (a UF pode vir no fim: "SSP/SP", "SSP-SP").
_ISSUER_DROP = re.compile(r"[^A-Z /-]")
_ISSUER_STATE = re.compile(r"(?P<issuer>.*?)\s*[/-]\s*(?P<state>[A-Z]{2})")
_ISSUER_SEPARATORS = re.compile(r"[/-]")
# Os acentos soltos depois do NFD (U+0300 a U+036F), o mesmo intervalo de normalizeIssuer.
_MARKS = re.compile(f"[{chr(0x300)}-{chr(0x36F)}]")
_PLATE = re.compile(r"[A-Z]{3}[0-9][A-Z0-9][0-9]{2}")
_OLD_PLATE = re.compile(r"[A-Z]{3}[0-9]{4}")
_ISO_DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
# O número sem número ("SN", "S/N", "S / N"), depois das maiúsculas.
_NO_NUMBER = re.compile(r"S\s*/\s*N|SN")
# Endereço numa linha ("Rua Exemplo, 123 - Apto 4"): a mesma regra da migração b7e2d4f6a8c1
# (split_address_line; ela tem a cópia dela, porque não importa app.*).
_LINE_NUMBER = r"(?:\d{1,6}[A-Za-z]?|[Ss]\s*/\s*[Nn]|[Ss][Nn])"
_ADDRESS_LINE = re.compile(
    r"^(?P<street>[^,]+?)\s*,\s*(?:n[º°o]?\.?\s*)?"
    rf"(?P<number>{_LINE_NUMBER})\s*(?:[-–,]\s*(?P<complement>.*?))?\s*$",
    re.IGNORECASE,
)
# Mini biografia: dos controles, a quebra de linha e o tab ficam; estes viram espaço.
_BIO_SPACES = frozenset("\v\f")
# Nome: além das letras, espaço, apóstrofo (o do teclado e os que o celular põe sozinho), hífen e
# ponto.
_NAME_MARKS = frozenset(" '’‘´`ʼ-.")
# Endereço colado ao nome ("site.com.br", "wa.me"): duas letras, ponto e letra. Iniciais ("J.R.")
# passam.
_NAME_ADDRESS = re.compile(r"[^\W\d_]{2}\.[^\W\d_]")


def too_long(max_len: int) -> str:
    return f"No máximo {max_len} caracteres"


def _letters_only(name: str) -> bool:
    """Sem dígito, "@", "/", ":" nem link: o nome não leva contato para o cliente nem para os
    e-mails (o nome da ficha pública entra na saudação do e-mail de validação)."""
    if not all(ch.isalpha() or ch in _NAME_MARKS for ch in name):
        return False
    # Letras de outra largura ("ｗｗｗ") contam como as comuns.
    folded = unicodedata.normalize("NFKC", name).casefold()
    return "www" not in folded and "http" not in folded and not _NAME_ADDRESS.search(folded)


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
    """= normalizeIssuer sem o corte: letras sem acento, espaço, "/" e "-", em maiúsculas
    ("SSP/SP")."""
    plain = _MARKS.sub("", unicodedata.normalize("NFD", text or ""))
    return re.sub(r"\s+", " ", _ISSUER_DROP.sub("", plain.upper()))


def _tidy_issuer(text: str) -> str:
    return " ".join(_ISSUER_SEPARATORS.sub(" ", text).split())


def split_issuer(value: str | None) -> tuple[str | None, str | None]:
    """= splitIssuer: o órgão emissor e a UF que veio no fim dele, depois de "/" ou "-" ("SSP/SP",
    "ssp-sp", "SSP / SP": ("SSP", "SP")). Sem UF válida no fim (ou sem o órgão antes dela), "/" e
    "-" viram espaço ("SSP/XX": ("SSP XX", None)). Quem junta com a UF do RG (rg_group) usa a do
    fim só quando a do campo está vazia."""
    from app.schemas.onboarding import UFS

    text = normalize_issuer(value).strip()
    match = _ISSUER_STATE.fullmatch(text)
    issuer = _tidy_issuer(match["issuer"]) if match else ""
    if match and issuer and match["state"] in UFS:
        return issuer, match["state"]
    return _tidy_issuer(text) or None, None


def rg_issuer(value: str | None) -> str | None:
    """Órgão emissor do RG: 2 a 20 letras ("SSP"). Com a UF no fim ("SSP/SP", "SSP-SP"), devolve
    "SSP/SP": quem grava separa com rg_group (ou split_issuer), onde a UF do campo vence."""
    if not (value or "").strip():
        return None
    issuer, state = split_issuer(value)
    if issuer is None or not ISSUER_MIN <= len(issuer) <= RG_ISSUER_MAX:
        raise ValueError(ISSUER_INVALID)
    return f"{issuer}/{state}" if state else issuer


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
    obrigatórios. Devolve (número, órgão, UF) normalizados, com o órgão e a UF separados: a UF que
    veio no fim do órgão ("SSP/SP") vale quando a do campo está vazia; com outra no campo, fica a do
    campo e o fim sai."""
    rg = rg_number(number)
    if rg is None:
        return None, None, None
    issuer_value, issuer_state = split_issuer(rg_issuer(issuer))
    state_value = uf(state) or issuer_state
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


# ------------------------------------------------------------------ endereço


def normalize_address_number(value: str | None) -> str:
    """O número do endereço como se grava, sem conferir o tamanho: texto limpo (clean_text), em
    maiúsculas ("100a" → "100A"); "SN" e "S / N" viram "S/N"."""
    from app.services.tech_profile import clean

    text = clean(value or "").upper()
    return "S/N" if _NO_NUMBER.fullmatch(text) else text


def address_number(value: str | None) -> str | None:
    """Número do endereço (ficha, app e central iguais): normalize_address_number, até 10."""
    text = normalize_address_number(value)
    if not text:
        return None
    if len(text) > ADDRESS_NUMBER_MAX:
        raise ValueError(too_long(ADDRESS_NUMBER_MAX))
    return text


def split_address_line(line: str | None) -> tuple[str, str, str | None] | None:
    """(logradouro, número, complemento) de "Rua Exemplo, 123 - Apto 4"; None quando não dá com
    segurança. = split_address_line da migração b7e2d4f6a8c1 (a ficha de antes, aprovada depois da
    publicação, tem o endereço numa linha)."""
    m = _ADDRESS_LINE.match((line or "").strip())
    if not m or len(m["street"].strip()) < 2:
        return None
    number = re.sub(r"\s", "", m["number"]).upper()
    number = "S/N" if number in ("S/N", "SN") else number
    complement = " ".join((m["complement"] or "").split()) or None
    if complement and len(complement) > ADDRESS_COMPLEMENT_MAX:
        return None
    return " ".join(m["street"].split())[:255], number, complement


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
    """Mini biografia com os parágrafos (= normalizeBio): "\\r\\n" (e "\\r" sozinho) vira "\\n",
    sem espaços no fim das linhas, três ou mais quebras viram duas (uma linha em branco entre os
    parágrafos) e sem quebras nem espaços nas pontas; os 500 caracteres contam depois disso. Os
    espaços do meio da linha ficam (como na tela). Como em clean_text, saem os controles e a
    formatação (menos a quebra e o tab; "\\v" e "\\f" viram espaço), antes do NFC."""
    text = (value or "").replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(
        " " if ch in _BIO_SPACES else ch
        for ch in text
        if ch in "\n\t" or ch in _BIO_SPACES or unicodedata.category(ch) not in ("Cc", "Cf")
    )
    lines = unicodedata.normalize("NFC", text).split("\n")
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(line.rstrip() for line in lines)).strip()
    if not text:
        return None
    if len(text) > BIO_MAX:
        raise ValueError(too_long(BIO_MAX))
    return text


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
