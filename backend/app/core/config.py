from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEV_SECRET = "dev-only-secret-troque-em-producao"


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
            raise ValueError("CORS_ORIGINS não pode ser '*' em produção: liste os endereços do site")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
