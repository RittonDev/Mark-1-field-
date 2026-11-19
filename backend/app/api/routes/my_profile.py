"""Meu cadastro (app do técnico): o próprio cadastro e a foto.

Só para o técnico (a gestão edita em Técnicos e em Usuários). Tudo pede internet: nada entra na fila
offline, a senha não fica guardada e o aviso à central sai na hora (services/my_profile.py).
"""

from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.api.deps import DB, require_roles
from app.core.enums import UserRole
from app.models import User
from app.models.user_change import VIA_APP
from app.schemas.my_profile import MyProfile, MyProfileUpdate
from app.services import login_guard, technicians, user_history
from app.services import my_profile as svc

router = APIRouter(tags=["my-profile"])

TechnicianUser = Annotated[User, Depends(require_roles(UserRole.TECHNICIAN))]


@router.get("/me/profile", response_model=MyProfile)
async def get_my_profile(user: TechnicianUser) -> MyProfile:
    return svc.profile(user)


@router.patch("/me/profile", response_model=MyProfile)
async def update_my_profile(body: MyProfileUpdate, db: DB, user: TechnicianUser) -> MyProfile:
    """Só o que vier no corpo muda. E-mail e chave PIX pedem `current_password` (422 sem ela ou
    errada, e com a senha provisória; 429 depois de 5 erros em 15 min, somando os da troca de
    senha). A senha é conferida antes de "E-mail já cadastrado". Sem nada novo: 200, sem histórico
    e sem aviso. A troca de e-mail ou PIX até 72 h depois de a central redefinir a senha vai no
    aviso com `after_reset` (quem redefiniu e quando)."""
    try:
        changes = await svc.update(db, user, body)
    except (login_guard.LoginBlocked, login_guard.RateLimited) as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    if changes:
        after_reset = await user_history.after_reset(db, user, changes)
        await db.commit()
        await user_history.publish_changed(
            user, changes, via=VIA_APP, actor=user, after_reset=after_reset
        )
    return svc.profile(user)


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
    return svc.profile(user)


@router.delete("/me/profile/photo", response_model=MyProfile)
async def remove_my_photo(db: DB, user: TechnicianUser) -> MyProfile:
    """Tira a foto (também a que veio do Field Control); no lugar ficam as iniciais."""
    changes, previous = technicians.remove_photo(db, user, via=VIA_APP, actor=user)
    if changes:
        await db.commit()
        await technicians.drop_unused_photo(db, previous, user.id)
        await user_history.publish_changed(user, changes, via=VIA_APP, actor=user)
    return svc.profile(user)
