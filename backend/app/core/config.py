import re
from functools import lru_cache
from typing import Literal

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEV_SECRET = "dev-only-secret-troque-em-producao"
# Remetente dos e-mails: um endereço só (sem nome nem "<>"), conferido ao subir a API.
_MAIL_FROM = re.compile(r"[^@\s<>\"]+@[^@\s<>\"]+\.[^@\s<>\"]+")
# Desenvolvimento: localhost e a rede local (qualquer porta). Assim o app dos técnicos aberto no
# navegador do celular, pelo IP do notebook, fala com a API. Em produção vale só a CORS_ORIGINS.
_DEV_ORIGIN_REGEX = (
    r"^https?://(localhost|127\.0\.0\.1|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}"
    r"|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})(:\d{1,5})?$"
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    APP_NAME: str = "MaxxChamados"
    ENVIRONMENT: str = "development"  # development | test | production
    API_PREFIX: str = "/api/v1"

    DATABASE_URL: str = "postgresql+asyncpg://chamados:chamados@localhost:5433/chamados"
    DB_ECHO: bool = False
    # Sem REDIS_URL o barramento de eventos fica em memória (uma única instância da API).
    REDIS_URL: str | None = None

    JWT_SECRET: str = _DEV_SECRET
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_MINUTES: int = 60
    REFRESH_TOKEN_DAYS: int = 30
    DOWNLOAD_TOKEN_MINUTES: int = 15
    # Duração máxima de uma sessão, contada do login (as renovações não estendem): depois disso,
    # entra de novo. Na web (analistas, gestores, clientes) e no app dos técnicos.
    SESSION_MAX_DAYS: int = 30
    SESSION_MAX_DAYS_MOBILE: int = 90
    # Um refresh já usado que volta dentro deste prazo (resposta perdida, duas abas renovando
    # juntas) ganha um par novo da mesma sessão; depois dele, a sessão é encerrada (token copiado).
    REFRESH_REUSE_GRACE_SECONDS: int = 120
    REFRESH_REUSE_GRACE_MOBILE_SECONDS: int = 900

    # Lista separada por vírgula.
    CORS_ORIGINS: str = "http://localhost:3001"
    # Expressão regular extra para a origem. Vazio: em desenvolvimento, localhost e rede local.
    CORS_ORIGIN_REGEX: str | None = None

    TIMEZONE: str = "America/Sao_Paulo"  # usado para "hoje" no dashboard
    TICKET_PREFIX: str = "OS"
    AUTO_CLOSE_RESOLVED_DAYS: int = 3
    AUTO_CLOSE_INTERVAL_SECONDS: int = 600
    # Retenção do histórico de posições dos técnicos (LGPD).
    TRACKING_RETENTION_DAYS: int = 90
    # Fichas de técnico reprovadas (ou pendentes sem análise) são apagadas depois deste prazo,
    # com a foto (LGPD: o dado pessoal não fica guardado sem finalidade).
    ONBOARDING_RETENTION_DAYS: int = 180
    SLA_AT_RISK_RATIO: float = 0.75

    MEDIA_ROOT: str = "./media"
    MAX_UPLOAD_MB: int = 15

    # Endereço público do site (para onde o login Microsoft volta e base dos links do cliente).
    WEB_URL: str = "http://localhost:3001"
    # Endereço público da API (fotos do relatório do cliente). Vazio: o endereço da requisição.
    API_PUBLIC_URL: str | None = None
    # Nome exibido no relatório da OS enviado ao cliente.
    COMPANY_NAME: str = "Maxx Field"

    # Login Microsoft (Entra ID) para analistas e gestores. Ativo quando os três primeiros
    # estão preenchidos. Use o ID (GUID) do locatário, não "common"/"organizations": é ele
    # que garante que só contas da empresa entram.
    ENTRA_TENANT_ID: str | None = None
    ENTRA_CLIENT_ID: str | None = None
    ENTRA_CLIENT_SECRET: str | None = None
    # URL de retorno cadastrada no registro do app: <API>/api/v1/auth/microsoft/callback
    ENTRA_REDIRECT_URI: str = "http://localhost:8000/api/v1/auth/microsoft/callback"
    # Domínios aceitos (separados por vírgula).
    ENTRA_ALLOWED_DOMAINS: str = "maxxgroup.com.br"
    # Analistas e gestores desses domínios só entram pela Microsoft (sem senha local).
    ENTRA_ENFORCE_FOR_STAFF: bool = False
    # Vazio: só entra quem já está cadastrado em Usuários. "analyst": o primeiro login cria.
    ENTRA_AUTO_PROVISION_ROLE: str | None = None

    # E-mails do cadastro dos técnicos (validação do e-mail, boas-vindas e nova senha): fila no
    # banco e envio por SMTP (services/mail.py). Sem SMTP_HOST e MAIL_FROM o envio fica desligado:
    # os e-mails ficam "não enviados" e a central segue com o WhatsApp e a senha provisória.
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 587
    SMTP_USERNAME: str | None = None
    SMTP_PASSWORD: str | None = None
    # starttls (porta 587) | ssl (porta 465) | none (texto puro: só desenvolvimento, recusado em
    # produção).
    SMTP_SECURITY: Literal["starttls", "ssl", "none"] = "starttls"
    SMTP_TIMEOUT_SECONDS: int = 20
    # Remetente que não recebe resposta; o nome dele, vazio = COMPANY_NAME.
    MAIL_FROM: str | None = None
    MAIL_FROM_NAME: str | None = None
    # Intervalo da fila de e-mails: novas tentativas e o que venceu sem sair.
    MAIL_RETRY_SECONDS: int = 60
    # Link do app dos técnicos (a PWA da homologação) na boas-vindas e nas páginas dos links. Vazio:
    # a boas-vindas manda pedir o link à central.
    TECH_APP_URL: str | None = None

    @field_validator("SMTP_SECURITY", mode="before")
    @classmethod
    def _smtp_security(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower() or "starttls"
        return value

    @property
    def mail_enabled(self) -> bool:
        """Envio de e-mail ligado: servidor e remetente definidos."""
        return bool(self.SMTP_HOST and self.MAIL_FROM)

    @property
    def tech_app_url(self) -> str | None:
        return (self.TECH_APP_URL or "").strip() or None

    @property
    def entra_enabled(self) -> bool:
        return bool(self.ENTRA_TENANT_ID and self.ENTRA_CLIENT_ID and self.ENTRA_CLIENT_SECRET)

    @property
    def entra_domains(self) -> set[str]:
        return {d.strip().lower() for d in self.ENTRA_ALLOWED_DOMAINS.split(",") if d.strip()}

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def cors_origin_regex(self) -> str | None:
        if self.CORS_ORIGIN_REGEX:
            return self.CORS_ORIGIN_REGEX
        return None if self.is_production else _DEV_ORIGIN_REGEX

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"

    @property
    def max_body_bytes(self) -> int:
        """Maior corpo de requisição aceito: o maior anexo mais a folga do multipart."""
        return (self.MAX_UPLOAD_MB + 1) * 1024 * 1024

    @model_validator(mode="after")
    def _check_secret(self) -> "Settings":
        if self.is_production and (self.JWT_SECRET == _DEV_SECRET or len(self.JWT_SECRET) < 32):
            raise ValueError("JWT_SECRET precisa ser definido (>= 32 caracteres) em produção")
        if self.is_production and "*" in self.cors_origin_list:
            raise ValueError("CORS_ORIGINS não aceita '*' em produção: liste os endereços do site")
        if self.is_production and self.SMTP_SECURITY == "none":
            raise ValueError("SMTP_SECURITY=none não é aceito em produção: use starttls ou ssl")
        if self.MAIL_FROM and not _MAIL_FROM.fullmatch(self.MAIL_FROM.strip()):
            raise ValueError("MAIL_FROM precisa ser só um endereço de e-mail")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
