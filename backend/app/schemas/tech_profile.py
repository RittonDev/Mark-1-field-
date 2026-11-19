"""Perfil técnico: os tipos da API (GET/PATCH /me/profile, a ficha do técnico na central e o
catálogo de ferramentas em /technician-tools).

As cinco partes: tools (Ferramental), availability (Disponibilidade), transport (Transporte e CNH),
skills (Aptidões) e education (Formação). Cada item que o app manda se valida aqui, com as mensagens
do app, e recusa chave a mais ("campo não aceito": o servidor põe o "desde" da aptidão). A lista
inteira (repetidos, quantidade, turno desconhecido) se valida em schemas/my_profile.py, e a
normalização (ordem, "desde", ids da formação) é de services/tech_profile.py, que também guarda os
limites (os mesmos de TECH_PROFILE_LIMITS em lib/constants.ts; tests/test_tech_profile.py confere os
daqui).
"""

import re
import uuid
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.config import settings

Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DayPeriod = Literal["morning", "afternoon", "evening", "night"]
TransportMode = Literal["car", "motorcycle", "bicycle", "public_transport", "ride_app", "on_foot"]
SkillLevel = Literal["basico", "intermediario", "avancado"]
EducationLevel = Literal[
    "high_school", "technical", "undergraduate", "postgraduate", "certification", "free_course"
]
StampVia = Literal["app", "ficha"]

SKILL_NAME_REQUIRED = "Informe o nome da aptidão"
COURSE_REQUIRED = "Informe o curso"
INSTITUTION_REQUIRED = "Informe a instituição"
TOOL_NAME_REQUIRED = "Informe o nome da ferramenta"
MONTH_INVALID = "Mês inválido: use AAAA-MM"
MONTH_TOO_OLD = "Confira o ano"
MONTH_TOO_NEW = "Use um mês até o atual"
END_BEFORE_START = "O fim não pode ser antes do início"

_MONTH = re.compile(r"[0-9]{4}-(?:0[1-9]|1[0-2])")


def _clean(value: object) -> object:
    """Texto como se grava (NFC, espaços colapsados): o tamanho conta depois de limpo."""
    # Importado aqui: services/tech_profile importa este módulo.
    from app.services.tech_profile import clean

    return clean(value) if isinstance(value, str) else value


def _required(value: str, message: str) -> str:
    from app.services.tech_profile import TEXT_MIN

    if len(value) < TEXT_MIN:
        raise ValueError(message)
    return value


def _month(value: str) -> str:
    """Mês "AAAA-MM" da formação, de FIRST_MONTH até o mês atual em Brasília mais
    MONTH_TOLERANCE (o aparelho pode estar noutro fuso na virada do mês)."""
    from app.services.tech_profile import FIRST_MONTH, MONTH_TOLERANCE

    month = value.strip()
    if not _MONTH.fullmatch(month):
        raise ValueError(MONTH_INVALID)
    if month < FIRST_MONTH:
        raise ValueError(MONTH_TOO_OLD)
    now = datetime.now(ZoneInfo(settings.TIMEZONE))
    last = now.year * 12 + now.month - 1 + MONTH_TOLERANCE
    if month > f"{last // 12:04d}-{last % 12 + 1:02d}":
        raise ValueError(MONTH_TOO_NEW)
    return month


# ------------------------------------------------------------------- transporte


class TransportIn(BaseModel):
    """Meios de transporte e CNH, sempre juntos (a parte inteira). Repetidos contam uma vez."""

    model_config = ConfigDict(extra="forbid")

    modes: list[TransportMode] = Field(max_length=6)
    driver_license: bool


class TransportOut(BaseModel):
    modes: list[TransportMode]
    driver_license: bool


# --------------------------------------------------------------------- aptidões


class TechnicianSkillIn(BaseModel):
    """Aptidão no PATCH: o "desde" é do servidor (mandar `since` volta "campo não aceito")."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(max_length=80)
    level: SkillLevel

    @field_validator("name", mode="before")
    @classmethod
    def _clean_name(cls, value: object) -> object:
        return _clean(value)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return _required(value, SKILL_NAME_REQUIRED)


class TechnicianSkillOut(BaseModel):
    name: str
    level: SkillLevel
    # "AAAA-MM-DD": o dia (Brasília) em que a aptidão entrou no perfil; mantido pelo nome.
    since: str


# --------------------------------------------------------------------- formação


class EducationIn(BaseModel):
    """Curso no PATCH. Sem `id` (ou com um que não está gravado) é novo. `end` null: em andamento;
    início igual ao fim vale (curso de um mês)."""

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID | None = None
    course: str = Field(max_length=120)
    level: EducationLevel
    institution: str = Field(max_length=120)
    start: str
    end: str | None = None

    @field_validator("course", "institution", mode="before")
    @classmethod
    def _clean_text(cls, value: object) -> object:
        return _clean(value)

    @field_validator("course")
    @classmethod
    def _course(cls, value: str) -> str:
        return _required(value, COURSE_REQUIRED)

    @field_validator("institution")
    @classmethod
    def _institution(cls, value: str) -> str:
        return _required(value, INSTITUTION_REQUIRED)

    @field_validator("end", mode="before")
    @classmethod
    def _blank_end(cls, value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value

    @field_validator("start")
    @classmethod
    def _start(cls, value: str) -> str:
        return _month(value)

    @field_validator("end")
    @classmethod
    def _end(cls, value: str | None) -> str | None:
        return None if value is None else _month(value)

    @model_validator(mode="after")
    def _period(self) -> "EducationIn":
        if self.end is not None and self.end < self.start:
            raise ValueError(END_BEFORE_START)
        return self


class EducationOut(BaseModel):
    id: uuid.UUID
    course: str
    level: EducationLevel
    institution: str
    start: str
    end: str | None


# --------------------------------------------------------------------- carimbos


class TechProfileStamp(BaseModel):
    """Quando a parte mudou e por onde: o técnico no app ou a ficha da homologação."""

    at: datetime
    via: StampVia


class TechProfileStamps(BaseModel):
    """Uma data por parte; null: nunca informada."""

    tools: TechProfileStamp | None = None
    availability: TechProfileStamp | None = None
    transport: TechProfileStamp | None = None
    skills: TechProfileStamp | None = None
    education: TechProfileStamp | None = None


# ---------------------------------------------------- catálogo de ferramentas


class TechnicianToolOut(BaseModel):
    id: uuid.UUID
    name: str
    is_active: bool
    # Quantos técnicos marcaram: só a gestão; null para o técnico.
    technicians: int | None


class TechnicianToolCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(max_length=80)

    @field_validator("name", mode="before")
    @classmethod
    def _clean_name(cls, value: object) -> object:
        return _clean(value)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return _required(value, TOOL_NAME_REQUIRED)


class TechnicianToolUpdate(BaseModel):
    """Só o que vier muda; null é ignorado (não apaga o nome nem muda a situação)."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=80)
    is_active: bool | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _clean_name(cls, value: object) -> object:
        return _clean(value)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return None if value is None else _required(value, TOOL_NAME_REQUIRED)
