from pydantic import BaseModel

from app.core.access import Channel
from app.schemas.user import UserOut


class LoginRequest(BaseModel):
    email: str
    password: str
    # "web" (analistas e gestores) ou "mobile" (técnicos de campo). Omitido = sem restrição.
    channel: Channel | None = None


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserOut
