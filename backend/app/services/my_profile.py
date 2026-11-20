"""Meu cadastro: o técnico mantém no app a foto, o nome, o celular, o e-mail, o endereço, a chave
PIX para receber por chamado e o perfil técnico.

Segurança (conta invadida desviando pagamento): e-mail e chave PIX, inclusive remover a chave, pedem
a senha atual, com o mesmo limite de tentativas da troca de senha (login_guard, "pwd:{id}": 5 erros
somando as duas telas, contados antes de conferir). Com a senha provisória (a que a central gerou e
conhece) os dois ficam fechados até o técnico criar a dele. A senha vem antes de "E-mail já
cadastrado": sem ela, ninguém descobre quais e-mails existem. E-mail de domínio da empresa não
entra (services/onboarding.company_email). Toda mudança fica no histórico do cadastro
(services/user_history.py) e a rota avisa a central depois do commit; a troca de e-mail ou PIX até
72 h depois de a central redefinir a senha vai com quem redefiniu (user_history.after_reset).
Trocar o e-mail não encerra as sessões (a senha é a mesma): o login passa a ser o e-mail novo.

Perfil técnico (ferramental, disponibilidade, transporte e CNH, aptidões e formação;
services/tech_profile.py): sem senha, nem a provisória trava; cada parte vem inteira e só grava
quando muda de verdade, com a data e "app" na parte (tech_profile_stamps). Entra no histórico do
cadastro e no aviso à central como as outras mudanças (sem aviso no sino da web).

Uma gravação por vez por técnico: `update` trava a linha do usuário (SELECT ... FOR UPDATE) até o
commit da rota e relê o cadastro do banco. Duas gravações juntas (o app que reenvia depois do tempo
esgotado, o técnico em dois aparelhos) não apagam o carimbo nem o histórico uma da outra.

Grupo, cargo, acesso ao app, papel, serviços, jornada e senha provisória continuam com a central;
CPF, CNPJ/MEI e nascimento continuam só na ficha da homologação.
"""

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import verify_password_async
from app.db.base import utcnow
from app.models import User
from app.models.user_change import VIA_APP
from app.schemas.common import Ref
from app.schemas.my_profile import MyProfile, MyProfileUpdate, PixIn, PixInfo
from app.services import login_guard, onboarding, tech_profile, technicians, user_history
from app.services.errors import WorkflowError

PASSWORD_REQUIRED = "Confirme com a sua senha atual para mudar o e-mail ou a chave PIX"
WRONG_PASSWORD = "Senha atual incorreta"
EMAIL_TAKEN = "E-mail já cadastrado"
TEMPORARY_PASSWORD = "Crie sua senha no app antes de mudar o e-mail ou a chave PIX"
# "Muitas tentativas de confirmar a senha. Tente de novo em N minutos."
CONFIRM_ACTION = "de confirmar a senha"
# Trocas de e-mail por hora, já com a senha certa: quem sabe a própria senha também não testa à
# vontade quais e-mails de outras pessoas estão cadastrados.
MAX_EMAIL_CHECKS_PER_HOUR = 10

# Campos de texto que só são copiados (a normalização é do schema).
_PLAIN = ("name", "email", "phone", "coverage_area", "address_line", "address_district")


def pix_info(user: User) -> PixInfo | None:
    key_type, key = user.pix_key_type, user.pix_key
    if key_type is None or not key:
        return None
    return PixInfo(
        key_type=key_type,
        key=key,
        holder_name=user.pix_holder_name,
        updated_at=user.pix_updated_at,
    )


async def profile(db: AsyncSession, user: User) -> MyProfile:
    """O cadastro como o app mostra (o grupo já vem carregado com o usuário). Uma consulta a mais
    só com ferramenta marcada: quais delas continuam ativas no catálogo."""
    team = user.team
    tools = await tech_profile.user_tools(db, user)
    return MyProfile(
        id=user.id,
        name=user.name,
        email=user.email,
        phone=user.phone,
        job_title=user.job_title,
        team=Ref(id=team.id, name=team.name) if team is not None else None,
        home_city=user.home_city,
        home_state=user.home_state,
        coverage_area=user.coverage_area,
        address_line=user.address_line,
        address_district=user.address_district,
        address_zip=user.address_zip,
        avatar_url=technicians.avatar_url(user),
        pix=pix_info(user),
        tool_ids=tech_profile.active_tool_ids(user, tools),
        availability=tech_profile.sort_slots(user.availability or []),
        transport=tech_profile.transport_of(user),
        skills=tech_profile.skills_of(user),
        education=tech_profile.education_of(user),
        tech_profile_updated=tech_profile.stamps_of(user),
    )


def _phone_digits(value: str | None) -> str:
    """O mesmo celular escrito de outro jeito ("(11) 98888-7777", "5511988887777") não é mudança."""
    digits = re.sub(r"\D", "", value or "")
    return digits[2:] if len(digits) in (12, 13) and digits.startswith("55") else digits


async def confirm_password(user: User, password: str | None) -> None:
    """Senha atual para e-mail e chave PIX: o contador de erros é o da troca de senha, e a
    tentativa conta antes do bcrypt (pedidos em paralelo não furam o limite)."""
    if not password:
        raise WorkflowError(PASSWORD_REQUIRED)
    await login_guard.password_attempt(str(user.id), action=CONFIRM_ACTION)
    if not await verify_password_async(password, user.password_hash):
        raise WorkflowError(WRONG_PASSWORD)
    await login_guard.password_change_succeeded(str(user.id))


async def _wanted(db: AsyncSession, user: User, data: MyProfileUpdate) -> dict[str, Any]:
    """Só o que muda de verdade (o mesmo valor escrito de outro jeito não conta). As partes do
    perfil técnico vêm de tech_profile.wanted, com as chaves de tech_profile.PARTS (levanta
    WorkflowError na ferramenta que não existe)."""
    sent = data.model_fields_set
    new: dict[str, Any] = {}
    for key in _PLAIN:
        if key not in sent:
            continue
        value = getattr(data, key)
        if key == "phone":
            changed = _phone_digits(value) != _phone_digits(user.phone)
        elif key == "email":
            changed = value != (user.email or "").lower()
        else:
            changed = value != getattr(user, key)
        if changed:
            new[key] = value
    if "address_zip" in sent and data.address_zip != technicians.normalize_zip(user.address_zip):
        new["address_zip"] = data.address_zip
    if "home_city" in sent or "home_state" in sent:
        home = await technicians.canonical_home(
            db,
            data.home_city if "home_city" in sent else user.home_city,
            data.home_state if "home_state" in sent else user.home_state,
        )
        if home != (user.home_city, user.home_state):
            new["home"] = home
    if "pix" in sent:
        wanted = data.pix
        if wanted is None:
            if technicians.has_pix(user):
                new["pix"] = None
        elif (wanted.key_type, wanted.key, wanted.holder_name) != (
            user.pix_key_type,
            user.pix_key,
            user.pix_holder_name,
        ):
            new["pix"] = wanted
    new.update(await tech_profile.wanted(db, user, data))
    return new


def _set_pix(user: User, wanted: PixIn | None) -> None:
    if wanted is None:
        technicians.clear_pix(user)
        return
    user.pix_key_type = wanted.key_type
    user.pix_key = wanted.key
    user.pix_holder_name = wanted.holder_name
    user.pix_updated_at = utcnow()


async def update(db: AsyncSession, user: User, data: MyProfileUpdate) -> list[dict[str, Any]]:
    """PATCH /me/profile: aplica e grava no histórico o que mudou; devolve as mudanças (vazio:
    nada mudou, sem histórico nem aviso). O commit e o aviso à central são da rota.

    Ordem, quando o e-mail ou a chave PIX mudam: senha provisória (TEMPORARY_PASSWORD), e-mail da
    empresa (onboarding.COMPANY_EMAIL), senha atual (PASSWORD_REQUIRED, WRONG_PASSWORD; conta a
    tentativa) e só então e-mail já cadastrado (EMAIL_TAKEN). Levanta WorkflowError (422) nesses
    casos e na ferramenta que não existe (tech_profile.TOOL_NOT_FOUND),
    login_guard.LoginBlocked (429) depois de muitas senhas erradas e login_guard.RateLimited
    (429) depois de MAX_EMAIL_CHECKS_PER_HOUR trocas de e-mail na hora. O perfil técnico grava
    com tech_profile.apply entre as duas fotos do histórico.

    Uma gravação por vez por técnico: antes de tudo, a linha do usuário fica travada (FOR UPDATE,
    até o commit ou o fim da sessão) e o cadastro é relido do banco (populate_existing). A segunda
    gravação espera a primeira e compara, carimba e monta o histórico sobre o que ela gravou."""
    await db.execute(
        select(User)
        .where(User.id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    new = await _wanted(db, user, data)
    if not new:
        return []
    guarded = "email" in new or "pix" in new
    if guarded and user.must_change_password:
        raise WorkflowError(TEMPORARY_PASSWORD)
    if "email" in new and onboarding.company_email(new["email"]):
        raise WorkflowError(onboarding.COMPANY_EMAIL)
    if guarded:
        await confirm_password(user, data.current_password)
    if "email" in new:
        await login_guard.hit("profile-email", str(user.id), MAX_EMAIL_CHECKS_PER_HOUR, 3600)
        if await onboarding.email_taken(db, new["email"]):
            raise WorkflowError(EMAIL_TAKEN)
    before = await user_history.snapshot(db, user)
    for key in (*_PLAIN, "address_zip"):
        if key in new:
            setattr(user, key, new[key])
    if "home" in new:
        technicians.set_home(user, *new["home"])
    if "pix" in new:
        _set_pix(user, new["pix"])
    tech_profile.apply(user, new, via=tech_profile.VIA_APP, at=utcnow())
    return await user_history.track(db, user, before, via=VIA_APP, actor=user)
