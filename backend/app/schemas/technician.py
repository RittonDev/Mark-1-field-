import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from pydantic_core import PydanticCustomError

from app.core.enums import OperationalStatus
from app.schemas import personal
from app.schemas.common import Ref
from app.schemas.my_profile import ProfessionalProfileIn
from app.schemas.records import WorkSchedule, WorkScheduleOut
from app.schemas.tech_profile import (
    EducationOut,
    TechnicianSkillOut,
    TechProfileStamps,
    TransportOut,
)
from app.schemas.technician_document import CertificationDueOut
from app.schemas.technician_level import LevelSummary
from app.schemas.user import UnavailabilityPeriodOut

# Motivo da mudança de situação (POST /technicians/{id}/operational-status).
REASON_MIN, REASON_MAX = 3, 500
REASON_REQUIRED = "Informe o motivo"


class TechnicianOut(BaseModel):
    id: uuid.UUID
    name: str
    email: str
    phone: str | None
    job_title: str | None
    team: Ref | None
    home_city: str | None = None
    home_state: str | None = None
    coverage_area: str | None = None
    is_active: bool
    last_login_at: dt.datetime | None
    location_consent_at: dt.datetime | None
    must_change_password: bool
    created_at: dt.datetime
    avatar_url: str | None = None
    on_shift: bool = False
    open_tickets: int = 0
    # Aptidões do perfil técnico (users.skills): só as ativas do catálogo, com o id e o nome atual
    # dele, o "desde" mais novo primeiro.
    skills: list[TechnicianSkillOut] = []
    # Áreas de atuação (users.service_areas): as ativas do catálogo, na ordem do nome. Lista e
    # detalhe; `areas` (com o nome) só no detalhe, null na lista.
    area_ids: list[uuid.UUID] = []
    areas: list[Ref] | None = None
    # A certificação atual mais urgente: vencida ou vencendo em até 30 dias (null: nenhuma).
    certification_due: CertificationDueOut | None = None
    # Avaliações do cliente (só a central): a média com 1 casa (null sem avaliação) e quantas.
    rating_average: float | None = None
    rating_count: int = 0
    # A ficha da homologação aprovada (quando o técnico entrou por ela).
    application_id: uuid.UUID | None = None
    # Perfil técnico: o técnico mantém no app e a central também edita (Técnicos em Editar;
    # services/tech_profile.py). Na lista e no detalhe: as ferramentas ativas (ordem do nome; a web
    # dá o nome pelo catálogo), os turnos (ordem da grade), o transporte (null: nunca informou),
    # quantos cursos e a data da parte mudada por último.
    tool_ids: list[uuid.UUID] = []
    availability: list[str] = []
    transport: TransportOut | None = None
    education_count: int = 0
    tech_profile_updated_at: dt.datetime | None = None
    # Só no detalhe (GET /technicians/{id} e as respostas de um técnico); null na lista.
    tools: list[Ref] | None = None
    education: list[EducationOut] | None = None
    tech_profile_updated: TechProfileStamps | None = None
    # Região de atuação: a cidade onde mais atendeu (history) ou o endereço (home).
    base_city: str | None = None
    base_state: str | None = None
    base_source: Literal["history", "home"] | None = None
    base_visits: int = 0
    last_visit_at: dt.datetime | None = None
    # Ficha completa: endereço (address_line é o logradouro), jornada, serviços que faz e origem
    # (Field Control).
    address_line: str | None = None
    address_district: str | None = None
    address_zip: str | None = None
    work_schedule: WorkScheduleOut | None = None
    services: list[Ref] = []
    legacy: dict[str, Any] | None = None
    # Elo (o selo da lista): a conta guardada, de até 6 h atrás; sem conta ainda, Bronze.
    level: LevelSummary = Field(default_factory=LevelSummary)
    # Situação na operação (só a central vê; services/technician_status.py), com o motivo, quando e
    # quem mudou. Receber OS pede "active" e o acesso ao app liberado (is_active).
    operational_status: OperationalStatus = OperationalStatus.ACTIVE
    operational_reason: str | None = None
    operational_changed_at: dt.datetime | None = None
    operational_changed_by: Ref | None = None
    # Indisponibilidade: os períodos que não terminaram, pelo início (o técnico informa no app).
    unavailability: list[UnavailabilityPeriodOut] = []
    # E-mail de login validado pelo link (null: nunca) e o e-mail novo pedido no app, esperando o
    # link (o login continua `email` até lá).
    email_verified_at: dt.datetime | None = None
    email_pending: str | None = None
    # Formas de recebimento: quantas (0: "Sem forma de recebimento") e a última troca do destino do
    # pagamento ("Nova"); a lista fica com Pagamentos (GET /technicians/{id}/payout-methods).
    payout_methods_count: int = 0
    payout_changed_at: dt.datetime | None = None
    # Só no detalhe (GET /technicians/{id} e as respostas de um técnico); null na lista: dados
    # pessoais, endereço em partes, empresa e veículo.
    cpf: str | None = None
    rg_number: str | None = None
    rg_issuer: str | None = None
    rg_state: str | None = None
    birth_date: dt.date | None = None
    phone_secondary: str | None = None
    bio: str | None = None
    address_number: str | None = None
    address_complement: str | None = None
    company_document: str | None = None
    company_name: str | None = None
    company_trade_name: str | None = None
    vehicle_model: str | None = None
    vehicle_plate: str | None = None


class TechnicianCreate(BaseModel):
    name: str = Field(min_length=3, max_length=160)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=40)
    team_id: uuid.UUID | None = None
    job_title: str | None = Field(default=None, max_length=120)
    home_city: str | None = Field(default=None, max_length=120)
    home_state: str | None = Field(default=None, max_length=2)
    coverage_area: str | None = Field(default=None, max_length=1000)

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.strip().lower()


class TechnicianUpdate(ProfessionalProfileIn):
    """PATCH /technicians/{id}: só os campos enviados mudam (a web manda só o que mudou; null ou
    vazio limpa). Os dados pessoais e da empresa a central muda sem senha; o CPF ela muda e limpa
    (único entre os usuários). RG e empresa são conferidos em grupo com o que está gravado
    (services/technicians.update). O perfil profissional (ProfessionalProfileIn: veículo,
    indisponibilidade e as partes do perfil técnico) com as regras e as mensagens do app, carimbo
    "central" por parte. Campo desconhecido é ignorado (sem extra="forbid")."""

    name: str | None = Field(default=None, min_length=3, max_length=160)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=40)
    team_id: uuid.UUID | None = None
    job_title: str | None = Field(default=None, max_length=120)
    home_city: str | None = Field(default=None, max_length=120)
    home_state: str | None = Field(default=None, max_length=2)
    coverage_area: str | None = Field(default=None, max_length=1000)
    is_active: bool | None = None
    address_line: str | None = Field(default=None, max_length=255)
    address_number: str | None = None
    address_complement: str | None = None
    address_district: str | None = Field(default=None, max_length=120)
    address_zip: str | None = Field(default=None, max_length=10)
    work_schedule: WorkSchedule | None = None
    service_type_ids: list[uuid.UUID] | None = Field(default=None, max_length=300)
    cpf: str | None = None
    rg_number: str | None = None
    rg_issuer: str | None = None
    rg_state: str | None = None
    birth_date: dt.date | None = None
    phone_secondary: str | None = None
    bio: str | None = None
    company_document: str | None = None
    company_name: str | None = None
    company_trade_name: str | None = None

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str | None) -> str | None:
        return v.strip().lower() if v else v

    @field_validator("cpf")
    @classmethod
    def _cpf(cls, v: str | None) -> str | None:
        return personal.cpf(v)

    @field_validator("rg_number")
    @classmethod
    def _rg_number(cls, v: str | None) -> str | None:
        return personal.rg_number(v)

    @field_validator("rg_issuer")
    @classmethod
    def _rg_issuer(cls, v: str | None) -> str | None:
        return personal.rg_issuer(v)

    @field_validator("rg_state")
    @classmethod
    def _rg_state(cls, v: str | None) -> str | None:
        return personal.uf(v)

    @field_validator("birth_date", mode="before")
    @classmethod
    def _birth_date(cls, v: object) -> dt.date | None:
        # Antes do tipo: a data que não existe ("2026-02-30") dá a mensagem da tela. Só texto ou
        # data: o número viraria data (segundos desde 1970) sem passar pela regra dos 18 a 90 anos.
        if v is not None and not isinstance(v, str | dt.date):
            raise ValueError(personal.BIRTH_INVALID)
        return personal.birth_date(v)

    @field_validator("phone_secondary")
    @classmethod
    def _phone_secondary(cls, v: str | None) -> str | None:
        return personal.phone(v)

    @field_validator("bio")
    @classmethod
    def _bio(cls, v: str | None) -> str | None:
        return personal.bio(v)

    @field_validator("address_number")
    @classmethod
    def _address_number(cls, v: str | None) -> str | None:
        # Em maiúsculas ("s/n" vira "S/N"), como o app e a ficha: a mesma grafia nos três.
        return personal.address_number(v)

    @field_validator("address_complement")
    @classmethod
    def _address_complement(cls, v: str | None) -> str | None:
        return personal.clean_text(v, personal.ADDRESS_COMPLEMENT_MAX)

    @field_validator("company_document")
    @classmethod
    def _company_document(cls, v: str | None) -> str | None:
        return personal.cnpj(v)

    @field_validator("company_name", "company_trade_name")
    @classmethod
    def _company_names(cls, v: str | None) -> str | None:
        return personal.clean_text(v, personal.COMPANY_NAME_MAX)


class OperationalStatusIn(BaseModel):
    """POST /technicians/{id}/operational-status. Motivo de 3 a 500 caracteres; `cut_access` só
    vale fora de "active" e com o acesso ao app liberado (Bloquear sugere cortar)."""

    model_config = ConfigDict(extra="forbid")

    # Sem valor padrão de verdade: o None conferido (validate_default) cai no validador, que
    # responde com o rótulo da tela também quando a situação não vem.
    status: OperationalStatus = Field(default=None, validate_default=True)
    reason: str
    cut_access: bool = False

    @field_validator("status", mode="before")
    @classmethod
    def _status(cls, v: object) -> object:
        # O rótulo da tela ("Situação") vai no erro (ctx["label"]): o nome técnico "status" é
        # "Status" nas telas da OS (services/validation_messages), e lá ele continua assim.
        if not isinstance(v, str) or v not in {s.value for s in OperationalStatus}:
            raise PydanticCustomError("value_error", "Escolha a situação", {"label": "Situação"})
        return v

    @field_validator("reason")
    @classmethod
    def _reason(cls, v: str) -> str:
        text = personal.clean_text(v, REASON_MAX) or ""
        if len(text) < REASON_MIN:
            raise ValueError(REASON_REQUIRED)
        return text


class TemporaryPassword(BaseModel):
    technician: TechnicianOut
    # Mostrada uma única vez; o técnico troca no primeiro acesso ao app.
    temporary_password: str


class ImportRow(BaseModel):
    line: int
    name: str
    email: str
    phone: str | None
    team: str | None
    action: Literal["create", "update", "error"]
    errors: list[str] = []


class Credential(BaseModel):
    name: str
    email: str
    temporary_password: str


class ImportResult(BaseModel):
    dry_run: bool
    rows: list[ImportRow]
    created: int
    updated: int
    errors: int
    # Só na importação confirmada, e só nesta resposta: senhas provisórias dos novos.
    credentials: list[Credential] = []


class TechnicianSuggestion(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None
    home_city: str | None
    home_state: str | None
    team: Ref | None
    open_tickets: int
    on_shift: bool
    distance_km: float | None
    # Visitas a esta mesma loja (pelo histórico de OS).
    visits_at_location: int = 0
    last_visit_at_location: dt.datetime | None = None
    # Com horário informado: ocupado nele (outra OS) e quantas OS já tem no dia.
    busy: bool | None = None
    day_load: int | None = None
    score: float
    # Por que foi sugerido: "Mora em Santos", "A 4 km agora", "Livre no horário"...
    reasons: list[str]
    # Favorito na cidade da loja: pela regra ("auto") ou fixado pela central ("manual").
    favorite: Literal["auto", "manual"] | None = None
    favorite_note: str | None = None
    # Elo do técnico: só o selo (não muda a pontuação nem a ordem).
    level: LevelSummary = Field(default_factory=LevelSummary)
    # Disponibilidade informada no app × horário da visita: "inside" ou "outside"; null sem
    # horário ou sem disponibilidade informada (neutro). Sinal pequeno: nunca tira ninguém da lista.
    availability: Literal["inside", "outside"] | None = None
    # Com "outside": os turnos da visita fora da disponibilidade, na ordem da grade.
    availability_gaps: list[str] = []


class RegionCity(BaseModel):
    city: str
    total: int


class RegionState(BaseModel):
    state: str
    total: int
    cities: list[RegionCity]


class RegionRefresh(BaseModel):
    technicians: int
    history: int
    home: int
    none: int


class NearbyPoint(BaseModel):
    latitude: float
    longitude: float
    label: str


class NearbyTechnician(BaseModel):
    id: uuid.UUID
    name: str
    email: str
    phone: str | None
    is_active: bool
    # Situação na operação: Inativo e Bloqueado aparecem (com o selo e o motivo) e não recebem OS.
    operational_status: OperationalStatus = OperationalStatus.ACTIVE
    operational_reason: str | None = None
    avatar_url: str | None
    base_city: str | None
    base_state: str | None
    base_source: Literal["history", "home"] | None
    distance_km: float
    # De onde veio a menor distância: loja que já atendeu, endereço ou posição ao vivo.
    nearest_kind: Literal["store_history", "home", "live"]
    visits_at_location: int
    last_visit_at_location: dt.datetime | None
    visits_in_city: int
    total_visits: int
    last_visit_at: dt.datetime | None
    open_tickets: int
    on_shift: bool
    reasons: list[str]


class NearbyOut(BaseModel):
    point: NearbyPoint
    technicians: list[NearbyTechnician]
