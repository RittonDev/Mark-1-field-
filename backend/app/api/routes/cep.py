"""Busca de CEP dos formulários de endereço (os 6 lugares: ficha pública, Técnicos, Clientes, Locais,
Empresa e o Endereço no app). Pública: a ficha chama sem login e o limite é por IP; a central e o
app chamam logados e o limite é por pessoa (a central inteira pode sair pelo mesmo IP). A regra de
preencher o formulário fica nas telas (cepFill de lib/constants.ts)."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials

from app.api.deps import DB, bearer, optional_user
from app.schemas.cep import CepOut
from app.services import cep as svc
from app.services import login_guard

public = APIRouter(prefix="/public/cep", tags=["cep"])

# Buscas por janela de 10 minutos: sem sessão, por IP; com sessão, por pessoa.
MAX_PER_IP = 30
MAX_PER_USER = 120
WINDOW_SECONDS = 600


@public.get("/{cep}", response_model=CepOut)
async def lookup_cep(
    cep: str,
    request: Request,
    db: DB,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> CepOut:
    """O endereço do CEP. 422 sem os 8 números; 404 CEP_NOT_FOUND; 503 CEP_UNAVAILABLE (os dois
    serviços fora: a tela deixa os campos livres); 429 com Retry-After. Sessão inválida ou vencida
    vale como sem sessão (o limite do IP)."""
    digits = svc.digits(cep)
    if digits is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, svc.INVALID)
    user = await optional_user(db, creds)
    if user is not None:
        scope, key, limit = "cep-user", str(user.id), MAX_PER_USER
    else:
        ip = request.client.host if request.client else "sem-ip"
        scope, key, limit = "cep-ip", ip, MAX_PER_IP
    if creds is not None:
        # Daqui em diante nada usa o banco: a conexão volta ao pool antes das buscas de fora.
        await db.close()
    try:
        await login_guard.hit(scope, key, limit, WINDOW_SECONDS)
    except login_guard.RateLimited as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    return await svc.lookup(digits)
