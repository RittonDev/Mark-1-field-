from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import DB, TicketManagerUser
from app.schemas.home import HomeOverview, SmartSearchResult
from app.services import home as svc
from app.services import smart_search

router = APIRouter(tags=["home"])


@router.get("/home/overview", response_model=HomeOverview)
async def overview(db: DB, _: TicketManagerUser) -> HomeOverview:
    """Tela inicial da gestão: indicadores do dia, pontos de atenção das OS (os mais graves
    primeiro, cada um com até 5 exemplos e o filtro da lista ou a página que mostra todos),
    sugestões tiradas dos dados e a semana (abertas x concluídas por dia, no fuso da operação)."""
    return await svc.overview(db)


@router.get("/search/smart", response_model=SmartSearchResult)
async def search(
    db: DB,
    user: TicketManagerUser,
    q: Annotated[str, Query()] = "",
    limit: Annotated[int, Query(ge=1, le=smart_search.MAX_LIMIT)] = 6,
) -> SmartSearchResult:
    """Busca em português: nº da OS, CPF/CNPJ, status ("abertas", "atrasadas", "em campo"),
    períodos ("hoje", "semana passada", "novembro/2025", "de 01/11 a 15/11"), cliente, loja,
    técnico (o que atuou na OS), cidade e etiquetas. `filters` é o recorte da lista de OS; o
    texto que não casou com nada vai em `filters.q`. Clientes, lojas e técnicos parecidos com o
    texto vêm sempre, até `limit` de cada."""
    return await smart_search.smart_search(db, user, q, limit)
