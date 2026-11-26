"""Meu cadastro (app do técnico): o próprio cadastro, o perfil técnico, a foto, o e-mail e as formas
de recebimento.

Só para o técnico (a gestão edita em Técnicos e em Usuários; o perfil técnico, a central só vê).
Tudo pede internet: nada entra na fila offline do sync, a senha não fica guardada e o aviso à
central sai na hora (services/my_profile.py). Toda rota responde o MyProfile inteiro (o app guarda o
que voltar).
"""

import uuid
from collections.abc import Awaitable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.api.deps import DB, require_roles
from app.core.enums import UserRole
from app.models import User
from app.models.user_change import VIA_APP
from app.schemas.my_profile import MyProfile, MyProfileUpdate
from app.schemas.payout_method import PasswordConfirm, PayoutMethodCreate, PayoutMethodUpdate
from app.services import login_guard, technicians, user_history
from app.services import my_profile as svc

router = APIRouter(tags=["my-profile"])

TechnicianUser = Annotated[User, Depends(require_roles(UserRole.TECHNICIAN))]


def _too_many(
    exc: login_guard.LoginBlocked | login_guard.RateLimited, text: str | None = None
) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        text or str(exc),
        headers={"Retry-After": str(exc.retry_after)},
    )


async def _save(db: DB, user: User, write: Awaitable[list[dict[str, Any]]]) -> MyProfile:
    """Roda a gravação; com mudança, commit e o aviso à central (com quem redefiniu a senha, quando
    a troca sensível vem até 72 h depois). Devolve o cadastro."""
    try:
        changes = await write
    except (login_guard.LoginBlocked, login_guard.RateLimited) as exc:
        raise _too_many(exc) from exc
    if changes:
        after_reset = await user_history.after_reset(db, user, changes)
        await db.commit()
        await user_history.publish_changed(
            user, changes, via=VIA_APP, actor=user, after_reset=after_reset
        )
    return await svc.profile(db, user)


@router.get("/me/profile", response_model=MyProfile)
async def get_my_profile(db: DB, user: TechnicianUser) -> MyProfile:
    return await svc.profile(db, user)


@router.patch("/me/profile", response_model=MyProfile)
async def update_my_profile(body: MyProfileUpdate, db: DB, user: TechnicianUser) -> MyProfile:
    """Só o que vier no corpo muda. E-mail e dados da empresa pedem `current_password` (422 sem ela
    ou errada, e com a senha provisória; 429 depois de 5 erros em 15 min, somando os da troca de
    senha). A senha é conferida antes de "E-mail já cadastrado". Sem nada novo: 200, sem histórico
    e sem aviso. A troca sensível (e-mail, empresa) até 72 h depois de a central redefinir a senha
    vai no aviso com `after_reset` (quem redefiniu e quando).

    E-mail novo: fica em `email_pending` até o link de validação (o login não muda); com o envio de
    e-mail desligado, 422 (a troca fica com a central). O mesmo do login com pedido aberto cancela o
    pedido. CPF: só com o gravado vazio (409 em outro cadastro; 422 depois de gravado).
    `unavailability`: a lista inteira dos períodos que não acabaram. `pix`: 422 (a chave PIX agora
    é forma de recebimento, com rota própria).

    Perfil técnico (`tool_ids`, `availability`, `transport`, `skills`, `education`): sem senha,
    cada parte inteira (o app manda uma por vez); a resposta volta normalizada (ordem, "desde" das
    aptidões, id dos cursos). 422 com as mensagens do app (ferramenta que não existe: "Ferramenta
    não encontrada. Atualize a lista.")."""
    return await _save(db, user, svc.update(db, user, body))


@router.post("/me/profile/photo", response_model=MyProfile)
async def upload_my_photo(
    db: DB, user: TechnicianUser, file: Annotated[UploadFile, File()]
) -> MyProfile:
    """Foto do cadastro (o app manda já recortada e reduzida): JPG, PNG ou WebP até 2 MB. A anterior
    sai do disco quando ninguém mais usa."""
    changes, previous = await technicians.set_photo(db, user, file, via=VIA_APP, actor=user)
    await db.commit()
    await technicians.drop_unused_photo(db, previous, user.id)
    await user_history.publish_changed(user, changes, via=VIA_APP, actor=user)
    return await svc.profile(db, user)


@router.delete("/me/profile/photo", response_model=MyProfile)
async def remove_my_photo(db: DB, user: TechnicianUser) -> MyProfile:
    """Tira a foto (também a que veio do Field Control); no lugar ficam as iniciais."""
    changes, previous = technicians.remove_photo(db, user, via=VIA_APP, actor=user)
    if changes:
        await db.commit()
        await technicians.drop_unused_photo(db, previous, user.id)
        await user_history.publish_changed(user, changes, via=VIA_APP, actor=user)
    return await svc.profile(db, user)


# ------------------------------------------------------------------ e-mail


@router.post("/me/profile/email/verification", response_model=MyProfile)
async def send_my_email_link(db: DB, user: TechnicianUser) -> MyProfile:
    """Manda (de novo) o link de validação: para o e-mail pendente ou, sem ele, para o login ainda
    não validado. A resposta traz `email_link_sent_at` novo. 409 com o e-mail já validado e sem
    pedido; 422 com o endereço que não recebe mensagens; 503 MAIL_DISABLED com o envio desligado;
    429 depois de 3 pedidos na hora."""
    try:
        await svc.send_email_link(db, user)
    except login_guard.RateLimited as exc:
        raise _too_many(exc, svc.link_wait_text(exc.retry_after)) from exc
    await db.commit()
    return await svc.profile(db, user)


@router.delete("/me/profile/email/pending", response_model=MyProfile)
async def cancel_my_email_change(db: DB, user: TechnicianUser) -> MyProfile:
    """Cancela a troca de e-mail pedida (o link dela deixa de valer); o login continua o mesmo. Sem
    pedido: 200 igual."""
    return await _save(db, user, svc.cancel_email_change(db, user))


# ------------------------------------------------------------------ formas de recebimento
# Uma ação por pedido, com a senha no corpo (o api.delete do app não leva corpo: excluir é POST).
# 404 PAYOUT_METHOD_NOT_FOUND, 409 PAYOUT_METHOD_DUPLICATE, 422 PAYOUT_METHODS_LIMIT.


@router.post("/me/profile/payout-methods", response_model=MyProfile)
async def add_my_payout_method(body: PayoutMethodCreate, db: DB, user: TechnicianUser) -> MyProfile:
    """Inclui uma chave PIX ou conta (até 10). A 1ª é a preferencial; `preferred: true` faz desta a
    preferencial."""
    return await _save(db, user, svc.add_payout_method(db, user, body))


@router.put("/me/profile/payout-methods/{method_id}", response_model=MyProfile)
async def edit_my_payout_method(
    method_id: uuid.UUID, body: PayoutMethodUpdate, db: DB, user: TechnicianUser
) -> MyProfile:
    """Troca a forma inteira (o tipo não muda: exclua e cadastre de novo)."""
    return await _save(db, user, svc.edit_payout_method(db, user, method_id, body))


@router.post("/me/profile/payout-methods/{method_id}/preferred", response_model=MyProfile)
async def prefer_my_payout_method(
    method_id: uuid.UUID, body: PasswordConfirm, db: DB, user: TechnicianUser
) -> MyProfile:
    """Os pagamentos passam a ir para esta forma."""
    return await _save(db, user, svc.prefer_payout_method(db, user, method_id, body))


@router.post("/me/profile/payout-methods/{method_id}/remove", response_model=MyProfile)
async def remove_my_payout_method(
    method_id: uuid.UUID, body: PasswordConfirm, db: DB, user: TechnicianUser
) -> MyProfile:
    """Exclui a forma; era a preferencial, a mais nova das que ficam passa a ser."""
    return await _save(db, user, svc.remove_payout_method(db, user, method_id, body))
