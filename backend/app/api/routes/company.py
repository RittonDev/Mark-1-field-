from fastapi import APIRouter

from app.api.deps import DB, ManagerUser, TicketManagerUser
from app.schemas.company import CompanyProfile, CompanyProfileIn
from app.services import company as svc

router = APIRouter(tags=["settings"])


@router.get("/settings/company", response_model=CompanyProfile)
async def get_company(db: DB, _: TicketManagerUser) -> CompanyProfile:
    return await svc.profile(db)


@router.put("/settings/company", response_model=CompanyProfile)
async def put_company(body: CompanyProfileIn, db: DB, user: ManagerUser) -> CompanyProfile:
    """Dados da empresa no cabeçalho dos orçamentos e relatórios (supervisor ou admin). O CNPJ
    precisa ser válido e é guardado sem pontuação."""
    saved = await svc.save_profile(db, body, user)
    await db.commit()
    return saved
