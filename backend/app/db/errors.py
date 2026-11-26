"""Erros do banco pelo SQLSTATE e pelo nome da restrição, nunca pelo texto do erro.

O texto do erro do Postgres (`str(exc.orig)`) leva os valores: o DETAIL de um índice único mostra a
chave ("Key (cpf)=(…) already exists") e o erro de formato mostra o que foi digitado. Por isso o log
fica só com o SQLSTATE e o nome da restrição. Fora de app.main: as rotas e os serviços usam sem
importá-lo.
"""

from sqlalchemy.exc import DBAPIError

# Outra gravação ao mesmo tempo: impasse entre duas transações (deadlock) ou falha de serialização.
# O banco desfaz uma delas, e tentar de novo resolve.
RETRY_SQLSTATES = frozenset({"40P01", "40001"})


def _sources(exc: DBAPIError) -> tuple[object, ...]:
    """O erro do adaptador (exc.orig) e o do asyncpg, que fica em __cause__."""
    orig = exc.orig
    return (orig, getattr(orig, "__cause__", None))


def db_sqlstate(exc: DBAPIError) -> str:
    """O SQLSTATE do erro original do banco ("" sem ele): o adaptador do asyncpg o copia em
    `sqlstate`, e o erro do asyncpg fica em __cause__."""
    for source in _sources(exc):
        code = getattr(source, "sqlstate", None)
        if code:
            return str(code)
    return ""


def constraint_name(exc: DBAPIError) -> str | None:
    """O nome da restrição que barrou a gravação (o erro do asyncpg traz), ou None."""
    for source in reversed(_sources(exc)):
        name = getattr(source, "constraint_name", None)
        if name:
            return str(name)
    return None


def retryable(exc: BaseException) -> bool:
    """Outra gravação ao mesmo tempo desfez esta transação (RETRY_SQLSTATES): desfazer e repetir
    resolve."""
    return isinstance(exc, DBAPIError) and db_sqlstate(exc) in RETRY_SQLSTATES
