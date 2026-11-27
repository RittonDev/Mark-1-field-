"""Meu cadastro: o técnico mantém no app a foto, o nome, os dados pessoais (CPF uma vez, RG,
nascimento), o contato (celular, telefone secundário, e-mail), o endereço em partes, a mini
biografia, os dados da empresa, o veículo, a indisponibilidade, as formas de recebimento (chaves PIX
e contas) e o perfil técnico.

Segurança (conta invadida desviando pagamento): e-mail, dados da empresa (o CNPJ decide se o titular
da conta é "diferente") e formas de recebimento, inclusive excluir, pedem a senha atual, com o mesmo
limite de tentativas da troca de senha (login_guard, "pwd:{id}": 5 erros somando as telas, contados
antes de conferir). Com a senha provisória (a que a central gerou e conhece) eles ficam fechados até
o técnico criar a dele. A senha vem antes de "E-mail já cadastrado": sem ela, ninguém descobre quais
e-mails existem. E-mail de domínio da empresa não entra (services/onboarding.company_email). Toda
mudança fica no histórico do cadastro (services/user_history.py) e a rota avisa a central depois do
commit; a troca de e-mail, de forma de recebimento ou do CNPJ até 72 h depois de a central redefinir
a senha vai com quem redefiniu (user_history.after_reset).

E-mail: o novo fica em `email_pending` até o link de validação (services/account.py; o login só
muda quando o link é aberto, e as sessões continuam). Pedir o mesmo de novo não reenvia; voltar ao
do login cancela o pedido (sem senha). Com o envio de e-mail desligado, a troca fica com a central.

CPF: o técnico informa enquanto está vazio (único entre os usuários); depois, só a central muda.
Grupos que vão juntos: RG (número, órgão emissor e UF: os três ou nenhum) e empresa (razão social ou
nome fantasia pedem o CNPJ); o que não vier no corpo fica como está gravado, e o gravado não é
conferido de novo (dado antigo não trava outra mudança). Endereço: o app de antes manda uma linha só
(`address_line` sem `address_number`): ela vira o logradouro e número e complemento ficam vazios.

Perfil técnico (ferramental, disponibilidade, transporte e CNH, aptidões, formação e áreas de
atuação; services/tech_profile.py): sem senha, nem a provisória trava; cada parte vem inteira e só
grava quando muda de verdade, com a data e "app" na parte (tech_profile_stamps). Aptidões por
`{skill_id, level}` ou, do app de antes, `{name, level}` (casado com o catálogo); áreas por
`area_ids`. Entra no histórico do cadastro e no aviso à central como as outras mudanças (sem aviso
no sino da web). A central edita o mesmo perfil (services/technicians.update, via "central"); o app
recebe me.profile_changed e relê o cadastro.

Uma gravação por vez por técnico: cada escrita trava a linha do usuário
(technicians.lock_technician: SELECT ... FOR UPDATE, até o fim da transação; a mesma trava da
central) e relê o cadastro do banco. Duas gravações juntas (o app que reenvia depois do tempo
esgotado, o técnico em dois aparelhos, a central e o app) não apagam o carimbo nem o histórico uma
da outra.

Grupo, cargo, acesso ao app, situação na operação, papel, serviços, jornada e senha provisória
continuam com a central.
"""

import re
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import AccountTokenPurpose, EmailStatus, EmailTemplate
from app.core.security import verify_password_async
from app.db.base import utcnow
from app.models import EmailOutbox, User
from app.models.user_change import VIA_APP
from app.schemas import personal
from app.schemas.common import Ref
from app.schemas.my_profile import MyProfile, MyProfileUpdate, UnavailabilityPeriod
from app.schemas.payout_method import PasswordConfirm, PayoutMethodCreate, PayoutMethodUpdate
from app.services import (
    account,
    login_guard,
    mail,
    onboarding,
    payout_methods,
    tech_profile,
    technicians,
    unavailability,
    user_history,
)
from app.services.errors import CodedError, WorkflowError

PASSWORD_REQUIRED = (
    "Confirme com a sua senha atual para mudar o e-mail, os dados da empresa ou as formas de "
    "recebimento"
)
WRONG_PASSWORD = "Senha atual incorreta"
EMAIL_TAKEN = "E-mail já cadastrado"
TEMPORARY_PASSWORD = (
    "Crie sua senha no app antes de mudar o e-mail, os dados da empresa ou as formas de recebimento"
)
CPF_LOCKED = "O CPF já foi informado. Para corrigir, fale com a central pelo WhatsApp"
CPF_TAKEN = "Este CPF já está em outro cadastro"
CPF_TAKEN_CODE = "CPF_TAKEN"
EMAIL_MAIL_OFF = (
    "O envio de e-mail está desligado: para trocar o e-mail, fale com a central pelo WhatsApp"
)
EMAIL_NOT_SENDABLE = "Este e-mail não recebe mensagens"
# POST /me/profile/email/verification.
EMAIL_ALREADY_VERIFIED = "Seu e-mail já está validado"
EMAIL_ALREADY_VERIFIED_CODE = "EMAIL_ALREADY_VERIFIED"
LINK_NOT_SENDABLE = "Este e-mail não recebe mensagens. Troque o e-mail"
MAIL_DISABLED = "MAIL_DISABLED"
MAIL_DISABLED_TEXT = "O envio de e-mail está desligado. Fale com a central pelo WhatsApp"
# "Muitas tentativas de confirmar a senha. Tente de novo em N minutos."
CONFIRM_ACTION = "de confirmar a senha"
# Trocas de e-mail por hora, já com a senha certa: quem sabe a própria senha também não testa à
# vontade quais e-mails de outras pessoas estão cadastrados. O mesmo para o CPF (só enquanto ele
# está vazio: o primeiro livre fica gravado).
MAX_EMAIL_CHECKS_PER_HOUR = 10
MAX_CPF_CHECKS_PER_HOUR = 10
# Links de validação pedidos pelo app, por técnico.
LINKS_PER_HOUR = 3

# Campos de texto que só são copiados (a normalização é do schema).
_PLAIN = (
    "name",
    "phone",
    "phone_secondary",
    "coverage_area",
    "address_district",
    "bio",
    "vehicle_model",
    "vehicle_plate",
    "birth_date",
)
_ADDRESS = ("address_line", "address_number", "address_complement")
_RG = ("rg_number", "rg_issuer", "rg_state")
_COMPANY = ("company_document", "company_name", "company_trade_name")


def link_wait_text(retry_after: int) -> str:
    """429 do "Enviar link": "Aguarde N minutos para pedir outro link"."""
    minutes = max(1, -(-retry_after // 60))
    return f"Aguarde {minutes} minuto{'s' if minutes > 1 else ''} para pedir outro link"


async def _link_sent_at(db: AsyncSession, user: User) -> datetime | None:
    """Quando entrou o último link de validação (na fila ou enviado) para o e-mail que falta
    validar: o pendente ou o do login."""
    target = (user.email_pending or user.email or "").strip().lower()
    if not target:
        return None
    return await db.scalar(
        select(func.max(EmailOutbox.created_at)).where(
            EmailOutbox.user_id == user.id,
            EmailOutbox.template == EmailTemplate.VERIFY_EMAIL,
            EmailOutbox.status.in_((EmailStatus.PENDING, EmailStatus.SENT)),
            EmailOutbox.to_email == target,
        )
    )


async def profile(db: AsyncSession, user: User) -> MyProfile:
    """O cadastro como o app mostra (o grupo já vem carregado com o usuário). Consultas a mais: as
    formas de recebimento, o último link de validação, os documentos e, com ferramenta, aptidão
    ou área guardada, os itens dele no catálogo (só os ativos aparecem)."""
    # Os documentos puxam o histórico do cadastro (que usa os schemas daqui): import tardio.
    from app.services import technician_documents

    team = user.team
    tools = await tech_profile.user_tools(db, user)
    skills = await tech_profile.user_skills(db, user)
    areas = await tech_profile.user_areas(db, user)
    methods = await payout_methods.list_for(db, user.id)
    periods = unavailability.current(user.unavailability or [], personal.local_today())
    return MyProfile(
        id=user.id,
        name=user.name,
        email=user.email,
        email_pending=user.email_pending,
        email_verified_at=user.email_verified_at,
        email_link_sent_at=await _link_sent_at(db, user),
        mail_enabled=settings.mail_enabled,
        phone=user.phone,
        phone_secondary=user.phone_secondary,
        cpf=user.cpf,
        rg_number=user.rg_number,
        rg_issuer=user.rg_issuer,
        rg_state=user.rg_state,
        birth_date=user.birth_date,
        job_title=user.job_title,
        team=Ref(id=team.id, name=team.name) if team is not None else None,
        home_city=user.home_city,
        home_state=user.home_state,
        coverage_area=user.coverage_area,
        address_line=user.address_line,
        address_number=user.address_number,
        address_complement=user.address_complement,
        address_district=user.address_district,
        address_zip=user.address_zip,
        bio=user.bio,
        company_document=user.company_document,
        company_name=user.company_name,
        company_trade_name=user.company_trade_name,
        vehicle_model=user.vehicle_model,
        vehicle_plate=user.vehicle_plate,
        avatar_url=technicians.avatar_url(user),
        payout_methods=[payout_methods.to_out(m) for m in methods],
        pix=payout_methods.pix_info(methods),
        unavailability=[UnavailabilityPeriod.model_validate(p) for p in periods],
        tool_ids=tech_profile.active_tool_ids(user, tools),
        availability=tech_profile.sort_slots(user.availability or []),
        transport=tech_profile.transport_of(user),
        skills=tech_profile.skills_of(user, skills),
        area_ids=tech_profile.active_area_ids(user, areas),
        education=tech_profile.education_of(user),
        tech_profile_updated=tech_profile.stamps_of(user),
        documents=await technician_documents.my_documents(db, user),
    )


def _phone_digits(value: str | None) -> str:
    """O mesmo celular escrito de outro jeito ("(11) 98888-7777", "5511988887777") não é mudança."""
    digits = re.sub(r"\D", "", value or "")
    return digits[2:] if len(digits) in (12, 13) and digits.startswith("55") else digits


# A trava do técnico (uma gravação por vez): a mesma da central, em services/technicians.py.
lock = technicians.lock_technician


async def confirm_password(user: User, password: str | None) -> None:
    """Senha atual para e-mail, empresa e formas de recebimento: o contador de erros é o da troca
    de senha, e a tentativa conta antes do bcrypt (pedidos em paralelo não furam o limite)."""
    if not password:
        raise WorkflowError(PASSWORD_REQUIRED)
    await login_guard.password_attempt(str(user.id), action=CONFIRM_ACTION)
    if not await verify_password_async(password, user.password_hash):
        raise WorkflowError(WRONG_PASSWORD)
    await login_guard.password_change_succeeded(str(user.id))


async def _guard(user: User, password: str | None) -> None:
    """O que pede a senha: fechado com a provisória; depois, a senha atual."""
    if user.must_change_password:
        raise WorkflowError(TEMPORARY_PASSWORD)
    await confirm_password(user, password)


def _sent_or_stored(data: MyProfileUpdate, user: User, fields: tuple[str, ...]) -> tuple:
    sent = data.model_fields_set
    return tuple(getattr(data if name in sent else user, name) for name in fields)


def _wanted_address(data: MyProfileUpdate, user: User) -> tuple | None:
    """Logradouro, número e complemento juntos. O app de antes (sem `address_number`) manda a linha
    inteira: ela vira o logradouro, sem número nem complemento."""
    sent = data.model_fields_set
    stored = (user.address_line, user.address_number, user.address_complement)
    if "address_line" in sent and "address_number" not in sent:
        if data.address_line == user.address_line:
            return None
        return data.address_line, None, None
    if not sent.intersection(_ADDRESS):
        return None
    wanted = _sent_or_stored(data, user, _ADDRESS)
    return wanted if wanted != stored else None


def _wanted_rg(data: MyProfileUpdate, user: User) -> tuple | None:
    """Os três ou nenhum: sem o número, os três ficam vazios; com ele, órgão e UF são obrigatórios
    (o que veio já foi conferido pelo schema; o gravado fica como está). O órgão com a UF no fim
    ("SSP/SP") grava separado: a UF do fim vale quando a do RG está vazia (personal.rg_group)."""
    if not data.model_fields_set.intersection(_RG):
        return None
    number, issuer, state = _sent_or_stored(data, user, _RG)
    issuer, issuer_state = personal.split_issuer(issuer)
    state = state or issuer_state
    if number is None:
        wanted: tuple = (None, None, None)
    elif issuer is None or state is None:
        raise WorkflowError(personal.RG_INCOMPLETE)
    else:
        wanted = (number, issuer, state)
    return wanted if wanted != (user.rg_number, user.rg_issuer, user.rg_state) else None


def _wanted_company(data: MyProfileUpdate, user: User) -> tuple | None:
    """CNPJ, razão social e nome fantasia: os nomes pedem o CNPJ."""
    if not data.model_fields_set.intersection(_COMPANY):
        return None
    document, name, trade = _sent_or_stored(data, user, _COMPANY)
    if (name or trade) and not document:
        raise WorkflowError(personal.COMPANY_WITHOUT_CNPJ)
    wanted = (document, name, trade)
    stored = (user.company_document, user.company_name, user.company_trade_name)
    return wanted if wanted != stored else None


def _wanted_unavailability(data: MyProfileUpdate, user: User) -> list[dict[str, str]] | None:
    """A lista inteira dos períodos que não acabaram, pela regra do app e da central
    (unavailability.wanted: 422 no período que não vale; None quando as datas são as vigentes)."""
    if "unavailability" not in data.model_fields_set:
        return None
    return unavailability.wanted(data.unavailability, user.unavailability, personal.local_today())


async def _wanted(db: AsyncSession, user: User, data: MyProfileUpdate) -> dict[str, Any]:
    """Só o que muda de verdade (o mesmo valor escrito de outro jeito não conta). As partes do
    perfil técnico vêm de tech_profile.wanted, com as chaves de tech_profile.PARTS (levanta
    WorkflowError na ferramenta que não existe e CodedError na área ou aptidão fora do catálogo,
    repetida ou além do limite). Levanta WorkflowError no CPF já informado, nos grupos incompletos
    e nos períodos que não valem."""
    sent = data.model_fields_set
    new: dict[str, Any] = {}
    for key in _PLAIN:
        if key not in sent:
            continue
        value = getattr(data, key)
        if key == "phone":
            changed = _phone_digits(value) != _phone_digits(user.phone)
        else:
            changed = value != getattr(user, key)
        if changed:
            new[key] = value
    if "cpf" in sent:
        if user.cpf:
            if data.cpf != user.cpf:
                raise WorkflowError(CPF_LOCKED)
        elif data.cpf:
            new["cpf"] = data.cpf
    if "email" in sent:
        email = data.email or ""
        login = (user.email or "").lower()
        pending = (user.email_pending or "").lower() or None
        if email == login:
            if pending:
                new["email_cancel"] = pending
        elif email != pending:
            new["email_request"] = email
    for key, wanted in (
        ("address", _wanted_address(data, user)),
        ("rg", _wanted_rg(data, user)),
        ("company", _wanted_company(data, user)),
        ("unavailability", _wanted_unavailability(data, user)),
    ):
        if wanted is not None:
            new[key] = wanted
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
    new.update(await tech_profile.wanted(db, user, data))
    return new


async def _cpf_taken(db: AsyncSession, cpf: str, user: User) -> bool:
    return (
        await db.scalar(select(User.id).where(User.cpf == cpf, User.id != user.id).limit(1))
    ) is not None


async def _forget_link(db: AsyncSession, user: User, address: str) -> None:
    """O pedido de troca para `address` não vale mais: revoga os links de validação dele e tira da
    fila os que ainda não saíram ("Não enviado")."""
    target = address.strip().lower()
    await account.revoke(
        db, user_id=user.id, purpose=AccountTokenPurpose.VERIFY_EMAIL, email=target
    )
    await db.execute(
        sql_update(EmailOutbox)
        .where(
            EmailOutbox.user_id == user.id,
            EmailOutbox.template == EmailTemplate.VERIFY_EMAIL,
            EmailOutbox.status == EmailStatus.PENDING,
            EmailOutbox.to_email == target,
        )
        .values(status=EmailStatus.EXPIRED)
        .execution_options(synchronize_session=False)
    )


async def _drop_pending(db: AsyncSession, user: User) -> None:
    address = user.email_pending
    user.email_pending = None
    user.email_pending_at = None
    if address:
        await _forget_link(db, user, address)


async def _send_link(db: AsyncSession, user: User, address: str, reason: str) -> None:
    """Põe o link de validação na fila; com o envio ligado, ele sai logo depois do commit."""
    row, status = await mail.enqueue(
        db,
        template=EmailTemplate.VERIFY_EMAIL,
        to_email=address,
        user=user,
        context={"name": user.name, "reason": reason},
        created_by=user,
    )
    if row is not None and status == "queued":
        mail.deliver_after_commit(db, [row.id])


async def _request_email(db: AsyncSession, user: User, address: str) -> None:
    """O e-mail novo fica pendente até o link (o login não muda); o pedido anterior sai."""
    if user.email_pending:
        await _forget_link(db, user, user.email_pending)
    user.email_pending = address
    user.email_pending_at = utcnow()
    await _send_link(db, user, address, "change")


async def update(db: AsyncSession, user: User, data: MyProfileUpdate) -> list[dict[str, Any]]:
    """PATCH /me/profile: aplica e grava no histórico o que mudou; devolve as mudanças (vazio:
    nada mudou, sem histórico nem aviso). O commit e o aviso à central são da rota; o link de
    validação do e-mail novo sai sozinho depois do commit.

    Ordem quando o e-mail ou a empresa mudam: e-mail com o envio desligado (EMAIL_MAIL_OFF) ou que
    não recebe mensagens (EMAIL_NOT_SENDABLE), senha provisória (TEMPORARY_PASSWORD), e-mail da
    empresa (onboarding.COMPANY_EMAIL), senha atual (PASSWORD_REQUIRED, WRONG_PASSWORD; conta a
    tentativa) e só então e-mail já cadastrado (EMAIL_TAKEN). Levanta WorkflowError (422) nesses
    casos, no CPF já informado (CPF_LOCKED), nos grupos incompletos, nos períodos que não valem e na
    ferramenta que não existe (tech_profile.TOOL_NOT_FOUND); CodedError 409 CPF_TAKEN no CPF de
    outro usuário; login_guard.LoginBlocked (429) depois de muitas senhas erradas e
    login_guard.RateLimited (429) depois de MAX_EMAIL_CHECKS_PER_HOUR trocas de e-mail (ou
    MAX_CPF_CHECKS_PER_HOUR CPFs) na hora. O perfil técnico grava com tech_profile.apply (e o 1º
    uso dos itens do catálogo, tech_profile.mark_used) entre as duas fotos do histórico."""
    await lock(db, user)
    new = await _wanted(db, user, data)
    if not new:
        return []
    email = new.get("email_request")
    if email is not None:
        if not settings.mail_enabled:
            raise WorkflowError(EMAIL_MAIL_OFF)
        if not mail.sendable(email):
            raise WorkflowError(EMAIL_NOT_SENDABLE)
    guarded = email is not None or "company" in new
    if guarded and user.must_change_password:
        raise WorkflowError(TEMPORARY_PASSWORD)
    if email is not None and onboarding.company_email(email):
        raise WorkflowError(onboarding.COMPANY_EMAIL)
    if guarded:
        await confirm_password(user, data.current_password)
    if email is not None:
        await login_guard.hit("profile-email", str(user.id), MAX_EMAIL_CHECKS_PER_HOUR, 3600)
        if await onboarding.email_taken(db, email):
            raise WorkflowError(EMAIL_TAKEN)
    if "cpf" in new:
        await login_guard.hit("profile-cpf", str(user.id), MAX_CPF_CHECKS_PER_HOUR, 3600)
        if await _cpf_taken(db, new["cpf"], user):
            raise CodedError(CPF_TAKEN, CPF_TAKEN_CODE, 409)

    before = await user_history.snapshot(db, user)
    for key in (*_PLAIN, "address_zip", "cpf"):
        if key in new:
            setattr(user, key, new[key])
    for key, fields in (("address", _ADDRESS), ("rg", _RG), ("company", _COMPANY)):
        if key in new:
            for name, value in zip(fields, new[key], strict=True):
                setattr(user, name, value)
    if "home" in new:
        technicians.set_home(user, *new["home"])
    if "unavailability" in new:
        user.unavailability = [dict(p) for p in new["unavailability"]]
    if "email_cancel" in new:
        await _drop_pending(db, user)
    if email is not None:
        await _request_email(db, user, email)
    tech_profile.apply(user, new, via=tech_profile.VIA_APP, at=utcnow())
    await tech_profile.mark_used(db, new)
    return await user_history.track(db, user, before, via=VIA_APP, actor=user)


# ------------------------------------------------------------------ e-mail pelo app


async def send_email_link(db: AsyncSession, user: User) -> None:
    """POST /me/profile/email/verification: o link de validação para o e-mail pendente ou, sem ele,
    para o login ainda não validado. Validado e sem pendente: 409; endereço que não recebe: 422;
    envio desligado: 503 MAIL_DISABLED; mais de LINKS_PER_HOUR na hora: login_guard.RateLimited.
    O link sai depois do commit (da rota)."""
    await lock(db, user)
    target = user.email_pending or (None if user.email_verified_at else user.email)
    if not target:
        raise CodedError(EMAIL_ALREADY_VERIFIED, EMAIL_ALREADY_VERIFIED_CODE, 409)
    if not mail.sendable(target):
        raise WorkflowError(LINK_NOT_SENDABLE)
    if not settings.mail_enabled:
        raise CodedError(MAIL_DISABLED_TEXT, MAIL_DISABLED, 503)
    await login_guard.hit("mail-resend-user", str(user.id), LINKS_PER_HOUR, 3600)
    await _send_link(db, user, target, "change" if user.email_pending else "check")


async def cancel_email_change(db: AsyncSession, user: User) -> list[dict[str, Any]]:
    """DELETE /me/profile/email/pending: o pedido de troca sai (os links dele deixam de valer) e
    fica no histórico; sem pedido, nada."""
    await lock(db, user)
    if not user.email_pending:
        return []
    before = await user_history.snapshot(db, user)
    await _drop_pending(db, user)
    return await user_history.track(db, user, before, via=VIA_APP, actor=user)


# ------------------------------------------------------------------ formas de recebimento


async def add_payout_method(
    db: AsyncSession, user: User, data: PayoutMethodCreate
) -> list[dict[str, Any]]:
    """POST /me/profile/payout-methods: senha, limite, repetida; a 1ª é a preferencial."""
    await lock(db, user)
    await _guard(user, data.current_password)
    methods = await payout_methods.list_for(db, user.id)
    payout_methods.check(methods, data)
    before = await user_history.snapshot(db, user)
    await payout_methods.add(db, user, data, methods, preferred=data.preferred)
    return await user_history.track(db, user, before, via=VIA_APP, actor=user)


async def edit_payout_method(
    db: AsyncSession, user: User, method_id: Any, data: PayoutMethodUpdate
) -> list[dict[str, Any]]:
    """PUT /me/profile/payout-methods/{id}: a forma inteira, do mesmo tipo (404 se não existe mais;
    422 se o tipo muda), com a senha."""
    await lock(db, user)
    methods = await payout_methods.list_for(db, user.id)
    method = payout_methods.find(methods, method_id)
    payout_methods.ensure_same_kind(method, data)
    await _guard(user, data.current_password)
    payout_methods.check(methods, data, editing=method)
    before = await user_history.snapshot(db, user)
    if not await payout_methods.edit(db, method, data):
        return []
    return await user_history.track(db, user, before, via=VIA_APP, actor=user)


async def prefer_payout_method(
    db: AsyncSession, user: User, method_id: Any, data: PasswordConfirm
) -> list[dict[str, Any]]:
    """POST /me/profile/payout-methods/{id}/preferred: com a senha, esta vira a preferencial."""
    await lock(db, user)
    methods = await payout_methods.list_for(db, user.id)
    method = payout_methods.find(methods, method_id)
    await _guard(user, data.current_password)
    before = await user_history.snapshot(db, user)
    if not await payout_methods.make_preferred(db, method, methods):
        return []
    return await user_history.track(db, user, before, via=VIA_APP, actor=user)


async def remove_payout_method(
    db: AsyncSession, user: User, method_id: Any, data: PasswordConfirm
) -> list[dict[str, Any]]:
    """POST /me/profile/payout-methods/{id}/remove: com a senha; era a preferencial, a mais nova
    das que ficam passa a ser."""
    await lock(db, user)
    methods = await payout_methods.list_for(db, user.id)
    method = payout_methods.find(methods, method_id)
    await _guard(user, data.current_password)
    before = await user_history.snapshot(db, user)
    await payout_methods.delete(db, method, methods)
    return await user_history.track(db, user, before, via=VIA_APP, actor=user)
