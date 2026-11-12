import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.core.documents import is_valid_cnpj, is_valid_cpf, normalize_document
from app.core.enums import ApplicationStatus
from app.schemas.common import ORMModel, Ref

# ----------------------------------------------------------------- catálogo
# Fonte única dos rótulos: o formulário público e a tela de análise leem daqui.

SERVICE_AREAS: dict[str, str] = {
    "impressoras": "Impressoras e multifuncionais",
    "computadores": "Computadores e notebooks",
    "redes": "Redes e cabeamento estruturado",
    "wifi": "Wi-Fi e access points",
    "cftv": "CFTV e câmeras IP",
    "seguranca": "Alarmes e controle de acesso",
    "telefonia": "Telefonia e PABX",
    "servidores": "Servidores e storage",
    "energia": "Nobreaks e energia",
    "automacao": "Automação comercial (PDV)",
}

AVAILABILITY: dict[str, str] = {
    "dias_uteis_manha": "Dias úteis — manhã",
    "dias_uteis_tarde": "Dias úteis — tarde",
    "dias_uteis_noite": "Dias úteis — noite",
    "sabado": "Sábados",
    "domingo_feriado": "Domingos e feriados",
    "plantao": "Plantão / emergência 24h",
}

SKILL_LEVELS: dict[str, str] = {
    "basico": "Básico",
    "intermediario": "Intermediário",
    "avancado": "Avançado",
}

SKILL_SUGGESTIONS = [
    "Windows 10/11",
    "Linux",
    "Active Directory",
    "Impressoras HP",
    "Impressoras Brother",
    "Impressoras Ricoh / Kyocera",
    "Switches gerenciáveis",
    "Roteadores e firewall",
    "Fibra óptica (fusão)",
    "Certificação de cabeamento",
    "DVR/NVR Intelbras",
    "Câmeras Hikvision",
    "Controle de acesso",
    "PABX IP",
    "Nobreaks",
    "Montagem de rack",
]

VEHICLE_TYPES: dict[str, str] = {"carro": "Carro", "moto": "Moto", "outro": "Outro"}

UFS = frozenset(
    "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split()
)

# Versão do aviso de privacidade exibido no formulário (muda quando o texto mudar).
PRIVACY_VERSION = "2026-11"


class CatalogItem(BaseModel):
    key: str
    label: str


class OnboardingCatalog(BaseModel):
    service_areas: list[CatalogItem]
    availability: list[CatalogItem]
    skill_levels: list[CatalogItem]
    vehicle_types: list[CatalogItem]
    skill_suggestions: list[str]
    privacy_version: str


def catalog() -> OnboardingCatalog:
    def items(d: dict[str, str]) -> list[CatalogItem]:
        return [CatalogItem(key=k, label=v) for k, v in d.items()]

    return OnboardingCatalog(
        service_areas=items(SERVICE_AREAS),
        availability=items(AVAILABILITY),
        skill_levels=items(SKILL_LEVELS),
        vehicle_types=items(VEHICLE_TYPES),
        skill_suggestions=SKILL_SUGGESTIONS,
        privacy_version=PRIVACY_VERSION,
    )


# ------------------------------------------------------------------ convites


class InviteCreate(BaseModel):
    label: str | None = Field(default=None, max_length=160)
    # Reutilizável: vale para várias pessoas até expirar (ex.: grupo de técnicos parceiros).
    reusable: bool = False
    days_valid: int = Field(default=7, ge=1, le=90)


InviteState = Literal["active", "used", "expired", "revoked"]


class InviteOut(ORMModel):
    id: uuid.UUID
    label: str | None
    max_uses: int | None
    use_count: int
    expires_at: dt.datetime
    revoked_at: dt.datetime | None
    created_at: dt.datetime
    created_by: Ref | None
    state: InviteState = "active"


class InviteCreated(InviteOut):
    # Aparece só nesta resposta: o banco guarda apenas o hash.
    token: str


class InviteCheck(BaseModel):
    valid: bool
    expires_at: dt.datetime | None = None


# ---------------------------------------------------------------- ficha pública


class SkillIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    level: Literal["basico", "intermediario", "avancado"]


class ApplicationIn(BaseModel):
    full_name: str = Field(min_length=5, max_length=160)
    email: EmailStr
    phone: str = Field(min_length=10, max_length=40)
    document: str = Field(description="CPF")
    birth_date: dt.date | None = None
    postal_code: str | None = Field(default=None, max_length=12)
    address: str | None = Field(default=None, max_length=255)
    city: str = Field(min_length=2, max_length=120)
    state: str = Field(min_length=2, max_length=2)
    company_document: str | None = Field(default=None, description="CNPJ/MEI, se tiver")
    years_experience: int | None = Field(default=None, ge=0, le=60)
    service_areas: list[str] = Field(min_length=1, max_length=len(SERVICE_AREAS))
    skills: list[SkillIn] = Field(default_factory=list, max_length=30)
    certifications: str | None = Field(default=None, max_length=2000)
    tools: str | None = Field(default=None, max_length=2000)
    has_vehicle: bool = False
    vehicle_type: Literal["carro", "moto", "outro"] | None = None
    has_driver_license: bool = False
    coverage_area: str = Field(min_length=2, max_length=1000)
    availability: list[str] = Field(default_factory=list, max_length=len(AVAILABILITY))
    notes: str | None = Field(default=None, max_length=2000)
    # Foto do rosto (data URL JPEG/PNG/WebP), já reduzida no navegador.
    photo: str | None = Field(default=None, max_length=3_000_000)
    password: str = Field(min_length=8, max_length=128)
    privacy_consent: bool

    @field_validator("full_name", "city", "coverage_area")
    @classmethod
    def _strip(cls, v: str) -> str:
        return " ".join(v.split())

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("document")
    @classmethod
    def _cpf(cls, v: str) -> str:
        if not is_valid_cpf(v):
            raise ValueError("CPF inválido")
        return normalize_document(v) or v

    @field_validator("company_document")
    @classmethod
    def _cnpj(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        if not is_valid_cnpj(v):
            raise ValueError("CNPJ inválido")
        return normalize_document(v)

    @field_validator("state")
    @classmethod
    def _uf(cls, v: str) -> str:
        uf = v.strip().upper()
        if uf not in UFS:
            raise ValueError("UF inválida")
        return uf

    @field_validator("service_areas")
    @classmethod
    def _areas(cls, v: list[str]) -> list[str]:
        unknown = set(v) - SERVICE_AREAS.keys()
        if unknown:
            raise ValueError(f"Área desconhecida: {', '.join(sorted(unknown))}")
        return list(dict.fromkeys(v))

    @field_validator("availability")
    @classmethod
    def _availability(cls, v: list[str]) -> list[str]:
        unknown = set(v) - AVAILABILITY.keys()
        if unknown:
            raise ValueError(f"Disponibilidade desconhecida: {', '.join(sorted(unknown))}")
        return list(dict.fromkeys(v))

    @field_validator("privacy_consent")
    @classmethod
    def _consent(cls, v: bool) -> bool:
        if not v:
            raise ValueError("É preciso aceitar o aviso de privacidade para enviar a ficha")
        return v


class ApplicationReceived(BaseModel):
    protocol: str


# ---------------------------------------------------------------- análise


class ApplicationSummary(ORMModel):
    id: uuid.UUID
    status: ApplicationStatus
    full_name: str
    email: str
    phone: str
    city: str
    state: str
    service_areas: list[str]
    years_experience: int | None
    has_vehicle: bool
    created_at: dt.datetime
    reviewed_at: dt.datetime | None
    user_id: uuid.UUID | None


class SkillOut(BaseModel):
    name: str
    level: str


class ApplicationDetail(ApplicationSummary):
    document: str
    birth_date: dt.date | None
    postal_code: str | None
    address: str | None
    company_document: str | None
    skills: list[SkillOut]
    certifications: str | None
    tools: str | None
    vehicle_type: str | None
    has_driver_license: bool
    coverage_area: str
    availability: list[str]
    notes: str | None
    privacy_consent_at: dt.datetime
    privacy_version: str
    reviewed_by: Ref | None
    review_note: str | None
    invite_label: str | None = None
    photo_url: str | None = None


class ApplicationApprove(BaseModel):
    team_id: uuid.UUID | None = None
    job_title: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=2000)


class ApplicationReject(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)
