from pydantic import BaseModel, Field

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


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)
