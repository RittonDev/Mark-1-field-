from fastapi import APIRouter

from app.api.deps import DB, CurrentUser, ManagerUser
from app.schemas.field import FieldRules
from app.services import field as svc

router = APIRouter(tags=["settings"])


@router.get("/settings/field", response_model=FieldRules)
async def get_field_rules(db: DB, _: CurrentUser) -> FieldRules:
    """Leitura liberada a todos: o app do técnico usa os prazos para os avisos de permanência."""
    return await svc.rules(db)


@router.put("/settings/field", response_model=FieldRules)
async def put_field_rules(body: FieldRules, db: DB, user: ManagerUser) -> FieldRules:
    """Prazos de chegada (capital x interior), tempo na loja e autorização do cliente."""
    saved = await svc.save_rules(db, body, user)
    await db.commit()
    return saved
