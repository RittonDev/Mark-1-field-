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

    # Lista separada por vírgula.
    CORS_ORIGINS: str = "http://localhost:3001"

    TIMEZONE: str = "America/Sao_Paulo"  # usado para "hoje" no dashboard
    TICKET_PREFIX: str = "OS"
    AUTO_CLOSE_RESOLVED_DAYS: int = 3
    AUTO_CLOSE_INTERVAL_SECONDS: int = 600
    # Retenção do histórico de posições dos técnicos (LGPD).
    TRACKING_RETENTION_DAYS: int = 90
    SLA_AT_RISK_RATIO: float = 0.75

    MEDIA_ROOT: str = "./media"
    MAX_UPLOAD_MB: int = 15

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"

    @model_validator(mode="after")
    def _check_secret(self) -> "Settings":
        if self.is_production and (self.JWT_SECRET == _DEV_SECRET or len(self.JWT_SECRET) < 32):
            raise ValueError("JWT_SECRET precisa ser definido (>= 32 caracteres) em produção")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
