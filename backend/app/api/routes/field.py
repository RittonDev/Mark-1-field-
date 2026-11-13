from fastapi import APIRouter

from app.api.deps import DB, ManagerUser, StaffUser
from app.schemas.field import FieldRules
from app.services import field as svc

router = APIRouter(tags=["settings"])


@router.get("/settings/field", response_model=FieldRules)
async def get_field_rules(db: DB, _: StaffUser) -> FieldRules:
    """Leitura para a equipe: a gestão configura e o app do técnico usa os prazos nos avisos de
    permanência. O cliente (portal) não lê a configuração interna."""
    return await svc.rules(db)


@router.put("/settings/field", response_model=FieldRules)
async def put_field_rules(body: FieldRules, db: DB, user: ManagerUser) -> FieldRules:
    """Prazos de chegada (capital x interior) e o tempo de técnico na loja."""
    saved = await svc.save_rules(db, body, user)
    await db.commit()
    return saved
