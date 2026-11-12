"""Dados da empresa (nome, CNPJ, contato, endereço), editáveis em Configurações."""

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import SystemSetting, User
from app.schemas.company import CompanyProfile

PROFILE_KEY = "company.profile"


def default_profile() -> CompanyProfile:
    return CompanyProfile(name=settings.COMPANY_NAME)


async def profile(db: AsyncSession) -> CompanyProfile:
    setting = await db.get(SystemSetting, PROFILE_KEY)
    if setting is None or not isinstance(setting.value, dict):
        return default_profile()
    try:
        return CompanyProfile.model_validate(setting.value)
    except ValidationError:
        return default_profile()


async def save_profile(db: AsyncSession, data: CompanyProfile, actor: User) -> CompanyProfile:
    setting = await db.get(SystemSetting, PROFILE_KEY)
    if setting is None:
        setting = SystemSetting(key=PROFILE_KEY)
        db.add(setting)
    setting.value = data.model_dump()
    setting.updated_by_id = actor.id
    await db.flush()
    return data
