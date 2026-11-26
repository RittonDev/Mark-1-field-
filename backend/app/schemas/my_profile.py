"""Meu cadastro do técnico (app) e o histórico do cadastro (central).

O técnico mantém no app a foto, o nome, o CPF (uma vez: depois, só a central muda), o RG, o
nascimento, o celular (WhatsApp) e o telefone secundário, o e-mail de login (o novo fica pendente
até o link), o endereço em partes (logradouro, número, complemento, bairro, CEP, cidade/UF) e a
região que atende, a mini biografia, os dados da empresa, o veículo, a indisponibilidade e o perfil
técnico (ferramental, disponibilidade, transporte e CNH, aptidões e formação: os itens em
schemas/tech_profile.py, as regras em services/tech_profile.py). As formas de recebimento têm rotas
próprias (schemas/payout_method.py). E-mail e empresa pedem a senha atual (services/my_profile.py);
o resto não. As validações dos dados pessoais são as de schemas/personal.py; as mensagens, as do
app.

O nome vai para os textos do grupo do cliente, o relatório e o portal: pelo app, só letras (com
acento), espaço, apóstrofo, hífen e ponto, sem "www", "http" nem endereço colado ("site.com")
(personal._letters_only, a mesma regra da ficha pública). Vale para o nome que o app manda (só
quando muda): os nomes antigos ficam como estão.
"""

import re
import unicodedata
import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.core.enums import PixKeyType
from app.schemas import personal
from app.schemas.common import ORMModel, Ref
from app.schemas.onboarding import UFS
from app.schemas.payout_method import PayoutMethodOut
from app.schemas.records import format_phone
from app.schemas.tech_profile import (
    EducationIn,
    EducationOut,
    TechnicianSkillIn,
    TechnicianSkillOut,
    TechProfileStamps,
    TransportIn,
    TransportOut,
)
from app.services import tech_profile

NAME_REQUIRED = "Informe seu nome completo"
NAME_LETTERS = personal.NAME_LETTERS
PHONE_REQUIRED = "Informe o celular com DDD"
EMAIL_REQUIRED = "Informe um e-mail válido"
CITY_REQUIRED = "Informe a cidade"
BAD_UF = "UF inválida"
BAD_ZIP = "CEP com 8 dígitos"
# O app de antes mandava a chave PIX no PATCH: agora ela é forma de recebimento, com rota própria.
PIX_MOVED = "Atualize o app: a chave PIX agora fica em Configurações › Formas de recebimento"
# Indisponibilidade: a lista vem inteira; o limite de verdade (10 que não acabaram) é do serviço.
UNAVAILABILITY_SENT_MAX = 50
# Perfil técnico: a lista inteira (os itens se validam em schemas/tech_profile.py).
SLOT_UNKNOWN = "Turno desconhecido: {}"
SLOT_MAX = 16  # caracteres por turno ("thu:afternoon", o maior, tem 13)
TRANSPORT_REQUIRED = "Informe os meios de transporte"
SKILL_REPEATED = "Aptidão repetida: {}"
EDUCATION_REPEATED = "Formação repetida: {}"


def _spaces(value: str | None) -> str:
    return " ".join((value or "").split())


class PixInfo(BaseModel):
    """A chave PIX como está gravada (normalizada). No MyProfile é só leitura, para o app de antes:
    a forma de recebimento preferencial quando ela é PIX."""

    key_type: PixKeyType
    key: str
    holder_name: str | None
    # Quando a chave mudou pela última vez (o changed_at da forma).
    updated_at: datetime | None


class UnavailabilityIn(BaseModel):
    """Um período de indisponibilidade no PATCH /me/profile ("AAAA-MM-DD", os dois dias inclusive).
    Sem id (ou com um que não está gravado) é novo; services/unavailability.normalize confere."""

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID | None = None
    start: date
    end: date


class UnavailabilityPeriod(BaseModel):
    """Um período que não acabou (fim >= hoje), sem motivo (LGPD)."""

    id: uuid.UUID
    start: date
    end: date


def _optional_text(value: str | None) -> str | None:
    return personal.clean_text(value)


class MyProfileUpdate(BaseModel):
    """PATCH /me/profile: só o que vier no corpo muda (e só o que muda de verdade conta).

    Quem muda o quê: o técnico muda aqui o nome, os dados pessoais, o contato, o e-mail de login, o
    endereço, a mini biografia, a empresa, o veículo, a indisponibilidade e o perfil técnico.
    E-mail e empresa pedem `current_password` (fechados com a senha provisória); o resto não. Os
    grupos vão juntos (RG: número, órgão e UF, os três ou nenhum; empresa: CNPJ, razão social e
    nome fantasia; o que não vier fica como está gravado). O CPF só entra com o gravado vazio. O
    e-mail novo fica pendente até o link (o login não muda). Perfil técnico: cada parte vem
    inteira, a lista substitui a gravada, [] ou null limpa (services/tech_profile.py normaliza e
    põe o "desde" das aptidões e o id dos cursos). Grupo, cargo, serviços, jornada, situação e
    acesso continuam com a central; as formas de recebimento têm rotas próprias (`pix` aqui: 422
    PIX_MOVED, para o app de antes).

    O e-mail só é validado quando vem: há logins de teste sem "@"."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=160)
    phone: str | None = Field(default=None, max_length=40)
    email: EmailStr | None = Field(default=None, max_length=255)
    home_city: str | None = Field(default=None, max_length=120)
    home_state: str | None = Field(default=None, max_length=10)
    coverage_area: str | None = Field(default=None, max_length=1000)
    # O logradouro. Sem `address_number` no corpo (o app de antes, campo único), número e
    # complemento ficam vazios.
    address_line: str | None = Field(default=None, max_length=255)
    address_number: str | None = Field(default=None, max_length=personal.ADDRESS_NUMBER_MAX)
    address_complement: str | None = Field(default=None, max_length=personal.ADDRESS_COMPLEMENT_MAX)
    address_district: str | None = Field(default=None, max_length=120)
    address_zip: str | None = Field(default=None, max_length=20)
    # Dados pessoais (schemas/personal.py).
    cpf: str | None = Field(default=None, max_length=20)
    rg_number: str | None = Field(default=None, max_length=40)
    rg_issuer: str | None = Field(default=None, max_length=40)
    rg_state: str | None = Field(default=None, max_length=10)
    birth_date: date | None = None
    phone_secondary: str | None = Field(default=None, max_length=40)
    bio: str | None = None
    # Empresa do técnico (pede a senha).
    company_document: str | None = Field(default=None, max_length=30)
    company_name: str | None = Field(default=None, max_length=personal.COMPANY_NAME_MAX)
    company_trade_name: str | None = Field(default=None, max_length=personal.COMPANY_NAME_MAX)
    # Veículo (Transporte): fora da parte `transport` (o app de antes grava `transport` sem ele).
    vehicle_model: str | None = Field(default=None, max_length=personal.VEHICLE_MODEL_MAX)
    vehicle_plate: str | None = Field(default=None, max_length=10)
    # Os períodos que não acabaram, inteiros (null ou [] limpa).
    unavailability: list[UnavailabilityIn] | None = Field(
        default=None, max_length=UNAVAILABILITY_SENT_MAX
    )
    # Só para responder ao app de antes (PIX_MOVED): a chave agora é forma de recebimento.
    pix: Any = None
    # Perfil técnico. Ferramental: ids de GET /technician-tools (desativado é ignorado; id que não
    # existe: "Ferramenta não encontrada. Atualize a lista.", WorkflowError do serviço).
    tool_ids: list[uuid.UUID] | None = Field(default=None, max_length=tech_profile.MAX_TOOLS)
    # "dia:turno" ("sat:afternoon"); repetidos contam uma vez. Até SLOT_MAX caracteres por item: o
    # turno desconhecido volta na mensagem, e o item enorme recusa antes, sem ecoar o valor.
    availability: list[Annotated[str, Field(max_length=SLOT_MAX)]] | None = Field(
        default=None, max_length=tech_profile.MAX_SLOTS
    )
    # Meios e CNH juntos; null não vale (TRANSPORT_REQUIRED).
    transport: TransportIn | None = None
    # Sem "desde": o servidor mantém o de quem já estava, pelo nome.
    skills: list[TechnicianSkillIn] | None = Field(default=None, max_length=tech_profile.MAX_SKILLS)
    education: list[EducationIn] | None = Field(default=None, max_length=tech_profile.MAX_EDUCATION)
    current_password: str | None = Field(default=None, max_length=256)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str:
        # NFC: o acento digitado separado da letra vira uma letra só.
        name = unicodedata.normalize("NFC", _spaces(value))
        if len(name) < 3:
            raise ValueError(NAME_REQUIRED)
        if not personal._letters_only(name):
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

    @field_validator("address_number")
    @classmethod
    def _address_number(cls, value: str | None) -> str | None:
        """O número da casa em maiúsculas ("100A"; "SN" e "S / N" viram "S/N"), como a ficha e a
        central."""
        return personal.address_number(value)

    @field_validator("address_complement", "company_name", "company_trade_name", "vehicle_model")
    @classmethod
    def _clean(cls, value: str | None) -> str | None:
        return _optional_text(value)

    @field_validator("cpf")
    @classmethod
    def _cpf(cls, value: str | None) -> str | None:
        return personal.cpf(value)

    @field_validator("rg_number")
    @classmethod
    def _rg_number(cls, value: str | None) -> str | None:
        return personal.rg_number(value)

    @field_validator("rg_issuer")
    @classmethod
    def _rg_issuer(cls, value: str | None) -> str | None:
        return personal.rg_issuer(value)

    @field_validator("rg_state")
    @classmethod
    def _rg_state(cls, value: str | None) -> str | None:
        return personal.uf(value)

    @field_validator("birth_date", mode="before")
    @classmethod
    def _birth_date(cls, value: Any) -> date | None:
        """De 18 a 90 anos no dia de Brasília, com as mensagens da ficha (não as do pydantic)."""
        if value is not None and not isinstance(value, str | date):
            raise ValueError(personal.BIRTH_INVALID)
        return personal.birth_date(value)

    @field_validator("phone_secondary")
    @classmethod
    def _phone_secondary(cls, value: str | None) -> str | None:
        return personal.phone(value)

    @field_validator("bio")
    @classmethod
    def _bio(cls, value: str | None) -> str | None:
        return personal.bio(value)

    @field_validator("company_document")
    @classmethod
    def _company_document(cls, value: str | None) -> str | None:
        return personal.cnpj(value)

    @field_validator("vehicle_plate")
    @classmethod
    def _vehicle_plate(cls, value: str | None) -> str | None:
        return personal.plate(value)

    @field_validator("pix")
    @classmethod
    def _pix(cls, value: Any) -> None:
        raise ValueError(PIX_MOVED)

    @field_validator("address_zip")
    @classmethod
    def _zip(cls, value: str | None) -> str | None:
        digits = re.sub(r"\D", "", value or "")
        if not digits:
            return None
        if len(digits) != 8:
            raise ValueError(BAD_ZIP)
        return f"{digits[:5]}-{digits[5:]}"

    @field_validator("availability")
    @classmethod
    def _availability(cls, value: list[str] | None) -> list[str] | None:
        for slot in value or []:
            if slot not in tech_profile.ALL_SLOTS:
                raise ValueError(SLOT_UNKNOWN.format(slot))
        return value

    @field_validator("transport")
    @classmethod
    def _transport(cls, value: TransportIn | None) -> TransportIn:
        if value is None:
            raise ValueError(TRANSPORT_REQUIRED)
        return value

    @field_validator("skills")
    @classmethod
    def _skills(cls, value: list[TechnicianSkillIn] | None) -> list[TechnicianSkillIn] | None:
        """O mesmo nome sem diferença de acento e maiúsculas (o nome do item que repete, limpo)."""
        seen: set[str] = set()
        for item in value or []:
            key = tech_profile.fold(item.name)
            if key in seen:
                raise ValueError(SKILL_REPEATED.format(item.name))
            seen.add(key)
        return value

    @field_validator("education")
    @classmethod
    def _education(cls, value: list[EducationIn] | None) -> list[EducationIn] | None:
        """O mesmo id duas vezes, ou o mesmo curso, instituição (sem acento e maiúsculas), nível e
        início."""
        ids: set[uuid.UUID] = set()
        seen: set[tuple[str, str, str, str]] = set()
        for item in value or []:
            key = (
                tech_profile.fold(item.course),
                tech_profile.fold(item.institution),
                item.level,
                item.start,
            )
            if key in seen or (item.id is not None and item.id in ids):
                raise ValueError(EDUCATION_REPEATED.format(item.course))
            seen.add(key)
            if item.id is not None:
                ids.add(item.id)
        return value


class MyProfile(BaseModel):
    """GET /me/profile (só o técnico) e a resposta das rotas do cadastro. Endereço, documentos e
    formas de recebimento não vão no /auth/me nem no UserOut. Nada de situação na operação, motivo
    ou histórico aqui (o técnico é terceiro: isso é só da central)."""

    id: uuid.UUID
    name: str
    # O login. Com `email_pending`, o e-mail novo espera o link (o login continua este).
    email: str
    email_pending: str | None
    email_verified_at: datetime | None
    # Quando saiu (ou entrou na fila) o último link de validação para o e-mail que falta validar.
    email_link_sent_at: datetime | None
    # Envio de e-mail ligado (sem ele, o app deixa o e-mail só leitura e não mostra a validação).
    mail_enabled: bool
    phone: str | None
    phone_secondary: str | None
    cpf: str | None
    rg_number: str | None
    rg_issuer: str | None
    rg_state: str | None
    birth_date: date | None
    job_title: str | None
    team: Ref | None
    home_city: str | None
    home_state: str | None
    coverage_area: str | None
    # O logradouro, o número ("S/N" vale) e o complemento.
    address_line: str | None
    address_number: str | None
    address_complement: str | None
    address_district: str | None
    address_zip: str | None
    bio: str | None
    company_document: str | None
    company_name: str | None
    company_trade_name: str | None
    vehicle_model: str | None
    vehicle_plate: str | None
    # Link assinado de 12 h (ou a foto que veio do Field Control).
    avatar_url: str | None
    # A preferencial primeiro, depois as mais novas.
    payout_methods: list[PayoutMethodOut]
    # Obsoleto (o app de antes): a forma preferencial quando ela é PIX.
    pix: PixInfo | None
    # Os períodos que não acabaram, pelo início.
    unavailability: list[UnavailabilityPeriod]
    # Perfil técnico (Configurações › Atendimento). Ferramentas: só as ativas do catálogo, na ordem
    # do nome. Disponibilidade na ordem da grade. transport null: nunca informou. Aptidões: o
    # "desde" mais novo primeiro, depois o nome. Formação: em andamento primeiro, depois o fim e o
    # início mais novos. tech_profile_updated: quando cada parte mudou e por onde (app ou ficha).
    tool_ids: list[uuid.UUID]
    availability: list[str]
    transport: TransportOut | None
    skills: list[TechnicianSkillOut]
    education: list[EducationOut]
    tech_profile_updated: TechProfileStamps


class UserChangeItem(BaseModel):
    """Uma mudança do cadastro, com o texto da tela (chave e conta só mascaradas). No JSON,
    "from"."""

    field: str
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None


class UserChangeOut(ORMModel):
    """Uma gravação no histórico do cadastro: quando, por onde (o técnico no app, a central, a
    aprovação da ficha ou o técnico pelo link do e-mail), quem, o motivo (`note`, quando a tela
    pede um) e o que mudou."""

    id: uuid.UUID
    created_at: datetime
    via: Literal["app", "central", "ficha", "link"]
    actor: Ref | None
    note: str | None = None
    changes: list[UserChangeItem]
