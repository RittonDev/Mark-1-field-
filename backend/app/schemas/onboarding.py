import datetime as dt
import re
import unicodedata
import uuid
from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)

from app.core.documents import is_valid_cnpj, is_valid_cpf, normalize_document
from app.core.enums import ApplicationStatus
from app.schemas import personal
from app.schemas.account import EmailQueued, EmailQueuedStatus
from app.schemas.common import ORMModel, Ref
from app.schemas.records import format_phone
from app.schemas.user import UserOut

# ----------------------------------------------------------------- catálogo
# Fonte única dos rótulos: o formulário público e a tela de análise leem daqui. As áreas de atuação
# e as aptidões são os catálogos de Configurações › Técnicos (services/technician_catalogs.py; os
# iniciais, DEFAULT_AREAS e DEFAULT_SKILLS, eram SERVICE_AREAS e SKILL_SUGGESTIONS daqui).

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

VEHICLE_TYPES: dict[str, str] = {"carro": "Carro", "moto": "Moto", "outro": "Outro"}

UFS = frozenset(
    {
        "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
        "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
    }
)  # fmt: skip

# Versão do aviso de privacidade exibido no formulário: muda quando o texto mudar. O texto
# (PRIVACY_NOTICE) fica em frontend/src/lib/constants.ts e em mobile/src/lib/constants.ts, cópias
# idênticas, cada uma com o próprio PRIVACY_VERSION: mude os três no mesmo dia e publique a web
# antes da API (ou junto): com a API na frente, a ficha da web pede para recarregar e não envia até
# a web nova entrar. 2026-11-18: o aviso passa a citar a chave PIX que o técnico cadastra no app
# para receber pelos chamados. 2026-11-19: texto revisto na revisão de segurança.
# 2026-11-20: o aviso passa a citar o perfil técnico (ferramental, disponibilidade por turno,
# transporte e CNH, aptidões e formação) e os registros das ofertas de OS no app (quando o técnico
# vê a oferta, abre o escopo e responde). 2026-11-25: RG, nascimento e CPF no cadastro, veículo,
# dados da empresa, formas de recebimento, biografia, e-mail validado, indisponibilidade, situação
# na operação, e-mails do cadastro e a reabertura da ficha reprovada. 2026-11-26: o dia da
# publicação do cadastro V2 (a versão é a data do dia em que sai, igual na web e no app). Versões
# "AAAA-MM-DD" ou "AAAA-MM-DD.N" (a segunda do mesmo dia), comparadas como texto.
# 2026-11-26.2 (a Entrega 2; publicada noutro dia, vira a data do dia, nos três lugares):
# documentos, certificações e currículo; avaliações e anexos internos; perfil técnico também pela
# central.
PRIVACY_VERSION = "2026-11-26.2"


class CatalogItem(BaseModel):
    key: str
    label: str


class OnboardingCatalog(BaseModel):
    # As áreas de atuação e as aptidões ativas dos catálogos, em ordem alfabética (`key` = o id).
    service_areas: list[CatalogItem]
    skills: list[CatalogItem]
    availability: list[CatalogItem]
    skill_levels: list[CatalogItem]
    vehicle_types: list[CatalogItem]
    # Compat E2: tirar quando o app novo estiver em todos. Os nomes de `skills`, para o app e a
    # ficha aberta de antes da Entrega 2 (sugerem pelo nome e mandam {name, level}).
    skill_suggestions: list[str]
    privacy_version: str


def catalog(service_areas: list[CatalogItem], skills: list[CatalogItem]) -> OnboardingCatalog:
    """O catálogo da ficha pública, com as áreas e as aptidões ativas
    (technician_catalogs.public_lists)."""

    def items(d: dict[str, str]) -> list[CatalogItem]:
        return [CatalogItem(key=k, label=v) for k, v in d.items()]

    return OnboardingCatalog(
        service_areas=service_areas,
        skills=skills,
        availability=items(AVAILABILITY),
        skill_levels=items(SKILL_LEVELS),
        vehicle_types=items(VEHICLE_TYPES),
        skill_suggestions=[item.label for item in skills],
        privacy_version=PRIVACY_VERSION,
    )


# ------------------------------------------------------------------ convites


class InviteCreate(BaseModel):
    label: str | None = Field(default=None, max_length=160)
    # Reutilizável: vale para várias pessoas até expirar (ex.: grupo de técnicos parceiros).
    reusable: bool = False
    days_valid: int = Field(default=7, ge=1, le=90)
    # Só no reutilizável: quantas fichas o link aceita no máximo (vazio: até expirar).
    max_uses: int | None = Field(default=None, ge=1, le=5000)


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
    # Link para copiar de novo (só links ativos criados depois desta versão).
    url: str | None = None


class InviteCreated(InviteOut):
    # Aparece só nesta resposta: o banco guarda apenas o hash.
    token: str


class InviteCheck(BaseModel):
    valid: bool
    expires_at: dt.datetime | None = None


# ---------------------------------------------------------------- ficha pública

# Um código da disponibilidade da ficha. O código desconhecido volta na mensagem ("Disponibilidade
# desconhecida: ..."): o item enorme recusa antes, sem ecoar o valor. Os de hoje têm até 16
# caracteres.
CODE_MAX = 32
Code = Annotated[str, Field(max_length=CODE_MAX)]
# Bairro (o tamanho da coluna).
DISTRICT_MAX = 120
# Aptidões na ficha (= TECH_PROFILE_LIMITS.skills).
MAX_SKILLS = 30


class ApplicationIn(BaseModel):
    """A ficha pública. Os campos do cadastro V2 são opcionais e usam as regras de
    schemas/personal.py (as mesmas do app e da central). A ordem dos campos importa para os grupos:
    o RG (número, órgão emissor e UF) vem junto ou nada, e a UF que veio no fim do órgão ("SSP/SP")
    vale quando a do RG está vazia; razão social e nome fantasia pedem o CNPJ. O nome sai no e-mail
    de validação (que vai para qualquer endereço digitado): só letras, como no app."""

    full_name: str = Field(min_length=5, max_length=160)
    email: EmailStr
    phone: str = Field(min_length=10, max_length=40)
    phone_secondary: str | None = None
    document: str = Field(description="CPF")
    rg_number: str | None = None
    # Conferidos também quando não vêm (o grupo do RG).
    rg_issuer: str | None = Field(default=None, validate_default=True)
    rg_state: str | None = Field(default=None, validate_default=True)
    birth_date: dt.date | None = None
    postal_code: str | None = Field(default=None, max_length=12)
    # O logradouro (sem o número), o número ("S/N" vale), o complemento e o bairro.
    address: str | None = Field(default=None, max_length=255)
    address_number: str | None = None
    address_complement: str | None = None
    address_district: str | None = None
    city: str = Field(min_length=2, max_length=120)
    state: str = Field(min_length=2, max_length=2)
    bio: str | None = None
    company_name: str | None = None
    company_trade_name: str | None = None
    company_document: str | None = Field(
        default=None, description="CNPJ/MEI, se tiver", validate_default=True
    )
    years_experience: int | None = Field(default=None, ge=0, le=60)
    # Áreas de atuação: o id do catálogo ou, na ficha aberta antes da Entrega 2, o código antigo
    # ("redes"). Desconhecida ou desativada, e nenhuma com o catálogo tendo alguma ativa: o envio
    # recusa (technician_catalogs.resolve_areas, ficha=True).
    service_areas: list[AreaValue] = Field(default_factory=list, max_length=MAX_AREAS)
    # Aptidões do catálogo ({skill_id, level}) ou, na ficha de antes, pelo nome ({name, level}):
    # technician_catalogs.resolve_skills.
    skills: list[TechnicianSkillIn] = Field(default_factory=list, max_length=MAX_SKILLS)
    certifications: str | None = Field(default=None, max_length=2000)
    tools: str | None = Field(default=None, max_length=2000)
    has_vehicle: bool = False
    vehicle_type: Literal["carro", "moto", "outro"] | None = None
    # Com veículo próprio: modelo e placa (antiga ou Mercosul), opcionais.
    vehicle_model: str | None = None
    vehicle_plate: str | None = None
    has_driver_license: bool = False
    coverage_area: str = Field(min_length=2, max_length=1000)
    availability: list[Code] = Field(default_factory=list, max_length=len(AVAILABILITY))
    notes: str | None = Field(default=None, max_length=2000)
    # Foto do rosto (data URL JPEG/PNG/WebP), já reduzida no navegador.
    photo: str | None = Field(default=None, max_length=3_000_000)
    password: str = Field(min_length=8, max_length=128)
    privacy_consent: bool

    @field_validator("full_name", "city", "coverage_area")
    @classmethod
    def _strip(cls, v: str) -> str:
        return " ".join(v.split())

    @field_validator("full_name")
    @classmethod
    def _name_letters(cls, v: str) -> str:
        # NFC: o acento digitado separado da letra vira uma letra só (depois do _strip).
        name = unicodedata.normalize("NFC", v)
        if not personal._letters_only(name):
            raise ValueError(personal.NAME_LETTERS)
        return name

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        digits = re.sub(r"\D", "", v)
        if not 10 <= len(digits) <= 13:
            raise ValueError("Informe o celular com DDD")
        return format_phone(digits) or digits

    @field_validator("phone_secondary")
    @classmethod
    def _phone_secondary(cls, v: str | None) -> str | None:
        return personal.phone(v)

    @field_validator("rg_number")
    @classmethod
    def _rg_number(cls, v: str | None) -> str | None:
        return personal.rg_number(v)

    @field_validator("rg_issuer", "rg_state")
    @classmethod
    def _rg_rest(cls, v: str | None, info: ValidationInfo) -> str | None:
        """Sem o número do RG, órgão e UF ficam vazios; com ele, são obrigatórios. A UF vazia
        aceita a que veio no fim do órgão ("SSP/SP"); com outra UF, vale a do campo."""
        if not info.data.get("rg_number"):
            return None
        if info.field_name == "rg_issuer":
            value = personal.rg_issuer(v)
        else:
            _, issuer_state = personal.split_issuer(info.data.get("rg_issuer"))
            value = personal.uf(v) or issuer_state
        if value is None:
            raise ValueError(personal.RG_INCOMPLETE)
        return value

    @model_validator(mode="after")
    def _issuer_without_state(self) -> Self:
        """O órgão emissor gravado sem a UF do fim ("SSP/SP" fica "SSP"; a UF já foi para
        rg_state quando ela estava vazia)."""
        if self.rg_issuer:
            self.rg_issuer, _ = personal.split_issuer(self.rg_issuer)
        return self

    @field_validator("birth_date", mode="before")
    @classmethod
    def _age(cls, v: object) -> dt.date | None:
        """De 18 a 90 anos no dia da operação (Brasília): o servidor roda em UTC, e entre 21h e 24h
        o dia UTC já é o seguinte. A data que não existe: "Confira a data de nascimento". Só texto
        ou data: o número viraria data (segundos desde 1970) sem passar pela regra da idade."""
        if v is None:
            return None
        if not isinstance(v, str | dt.date):
            raise ValueError(personal.BIRTH_INVALID)
        # Importado aqui para o schema não depender dos serviços ao carregar (ciclo).
        from app.services.activities import local_today

        return personal.birth_date(v, today=local_today())

    @field_validator("address_number")
    @classmethod
    def _address_number(cls, v: str | None) -> str | None:
        # Em maiúsculas ("s/n" vira "S/N"): a aprovação copia como o app e a central gravam.
        return personal.address_number(v)

    @field_validator("address_complement")
    @classmethod
    def _address_complement(cls, v: str | None) -> str | None:
        return personal.clean_text(v, personal.ADDRESS_COMPLEMENT_MAX)

    @field_validator("address_district")
    @classmethod
    def _address_district(cls, v: str | None) -> str | None:
        return personal.clean_text(v, DISTRICT_MAX)

    @field_validator("bio")
    @classmethod
    def _bio(cls, v: str | None) -> str | None:
        return personal.bio(v)

    @field_validator("company_name", "company_trade_name")
    @classmethod
    def _company_names(cls, v: str | None) -> str | None:
        return personal.clean_text(v, personal.COMPANY_NAME_MAX)

    @field_validator("vehicle_model")
    @classmethod
    def _vehicle_model(cls, v: str | None) -> str | None:
        return personal.clean_text(v, personal.VEHICLE_MODEL_MAX)

    @field_validator("vehicle_plate")
    @classmethod
    def _vehicle_plate(cls, v: str | None) -> str | None:
        return personal.plate(v)

    @field_validator("postal_code")
    @classmethod
    def _cep(cls, v: str | None) -> str | None:
        digits = re.sub(r"\D", "", v or "")
        if not digits:
            return None
        if len(digits) != 8:
            raise ValueError("CEP com 8 dígitos")
        return f"{digits[:5]}-{digits[5:]}"

    @field_validator("document")
    @classmethod
    def _cpf(cls, v: str) -> str:
        if not is_valid_cpf(v):
            raise ValueError("CPF inválido")
        return normalize_document(v) or v

    @field_validator("company_document")
    @classmethod
    def _cnpj(cls, v: str | None, info: ValidationInfo) -> str | None:
        if v is None or not v.strip():
            # Razão social ou nome fantasia sem o CNPJ (os dois vêm antes na ordem dos campos).
            if info.data.get("company_name") or info.data.get("company_trade_name"):
                raise ValueError(personal.COMPANY_WITHOUT_CNPJ)
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
    # O link de validação do e-mail que vai no envio: na fila, envio desligado (nada sai) ou o
    # endereço não recebe mensagens.
    email_verification: EmailQueuedStatus


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
    # null: o candidato ainda não abriu o link de validação.
    email_verified_at: dt.datetime | None = None
    # Reprovada que voltou para análise (a retenção da pendente conta daqui).
    reopened_at: dt.datetime | None = None


class SkillOut(BaseModel):
    name: str
    level: str


class ApplicationReview(BaseModel):
    """Uma análise da ficha (a mais antiga primeiro): aprovada, reprovada, reaberta ou expirada
    sem análise (a rotina, sem autor)."""

    action: Literal["approved", "rejected", "reopened", "expired"]
    at: dt.datetime
    by: Ref | None = None
    note: str | None = None


class ApplicationDetail(ApplicationSummary):
    document: str
    birth_date: dt.date | None
    postal_code: str | None
    # O logradouro (fichas antigas: a linha inteira do endereço).
    address: str | None
    address_number: str | None = None
    address_complement: str | None = None
    address_district: str | None = None
    phone_secondary: str | None = None
    rg_number: str | None = None
    rg_issuer: str | None = None
    rg_state: str | None = None
    bio: str | None = None
    company_document: str | None
    company_name: str | None = None
    company_trade_name: str | None = None
    skills: list[SkillOut]
    certifications: str | None
    tools: str | None
    vehicle_type: str | None
    vehicle_model: str | None = None
    vehicle_plate: str | None = None
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
    # O candidato criou a senha na ficha. Sem ela, a boas-vindas leva o link para criar só com o
    # e-mail validado; sem a validação, a central manda a senha provisória (password_link).
    has_password: bool = False
    reviews: list[ApplicationReview] = []
    reopened_by: Ref | None = None
    # Reprovada: quando a rotina apaga a ficha (180 dias da última análise).
    purge_at: dt.datetime | None = None


class ApplicationApprove(BaseModel):
    """Aprovar num passo: tudo opcional (a tela manda {})."""

    team_id: uuid.UUID | None = None
    job_title: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=2000)


class ApplicationApproved(BaseModel):
    """O técnico criado e a boas-vindas: na fila, envio desligado ou sem endereço que recebe."""

    technician: UserOut
    welcome: EmailQueued
    # A boas-vindas leva o link para criar a senha: o técnico está sem senha (a ficha não tinha) e o
    # e-mail dele está validado. Sem senha e sem a validação, ela diz que a central manda uma senha
    # provisória pelo WhatsApp (e a central gera a provisória). Com `welcome.status` diferente de
    # "queued", nada sai.
    password_link: bool = False


class ApplicationReject(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


# Motivo para reabrir a ficha reprovada.
REOPEN_REASON_MIN, REOPEN_REASON_MAX = 3, 500


class ApplicationReopen(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str

    @field_validator("reason")
    @classmethod
    def _reason(cls, v: str) -> str:
        text = personal.clean_text(v, REOPEN_REASON_MAX) or ""
        if len(text) < REOPEN_REASON_MIN:
            raise ValueError("Informe o motivo")
        return text
