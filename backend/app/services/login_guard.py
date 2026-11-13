"""Proteção contra tentativa e erro: login, troca de senha e envios públicos.

Login: conta as senhas erradas por e-mail vindo de cada IP, por e-mail no total e por IP, numa
janela de tempo. Passou do limite, o login fica bloqueado até a janela acabar, mesmo com a senha
certa; acertar a senha zera a contagem do e-mail. Quem errar de propósito a senha de alguém, de
um IP, só tranca aquela origem: o dono continua entrando do computador dele (o teto total por
e-mail, mais alto, segura o ataque espalhado por vários IPs). Conta também e-mails que não
existem, para o bloqueio não revelar quais contas existem.

`hit` limita envios por janela (ex.: fichas públicas de técnico por IP e por link).

Com REDIS_URL a contagem é compartilhada entre as instâncias da API; sem Redis (ou se ele cair),
fica na memória do processo (ver core/ephemeral.py).
"""

from app.core import ephemeral

WINDOW_SECONDS = 15 * 60
# Senhas erradas do mesmo e-mail vindas do mesmo IP.
MAX_PER_ACCOUNT = 5
# Do mesmo e-mail somando todos os IPs (ataque espalhado).
MAX_PER_ACCOUNT_TOTAL = 30
# Alto de propósito: atrás de um proxy que o uvicorn não reconhece (FORWARDED_ALLOW_IPS), todo
# mundo chega com o mesmo IP, e um limite baixo trancaria a empresa inteira. A proteção de cada
# conta é o limite por e-mail; o do IP só segura ataque em massa.
MAX_PER_IP = 100
# Senha atual errada na troca de senha (sessão já aberta, ex.: aparelho emprestado).
MAX_PASSWORD_CHANGE = 5
_PREFIX = "maxxchamados:login-fail:"
_RATE = "maxxchamados:rate:"


class LoginBlocked(Exception):
    def __init__(self, retry_after: int, action: str = "de login") -> None:
        self.retry_after = max(1, retry_after)
        minutes = max(1, -(-self.retry_after // 60))
        super().__init__(
            f"Muitas tentativas {action}. Tente de novo em {minutes} "
            f"minuto{'s' if minutes > 1 else ''}."
        )


class RateLimited(Exception):
    """Passou do limite de envios na janela; `retry_after` em segundos."""

    def __init__(self, retry_after: int) -> None:
        self.retry_after = max(1, retry_after)
        super().__init__("Muitas tentativas. Tente mais tarde.")


def _keys(email: str, ip: str | None) -> list[tuple[str, int]]:
    account = email.strip().lower()
    if not ip:
        return [(f"{_PREFIX}acct:{account}", MAX_PER_ACCOUNT)]
    return [
        (f"{_PREFIX}acct-ip:{account}|{ip}", MAX_PER_ACCOUNT),
        (f"{_PREFIX}acct:{account}", MAX_PER_ACCOUNT_TOTAL),
        (f"{_PREFIX}ip:{ip}", MAX_PER_IP),
    ]


async def check(email: str, ip: str | None) -> None:
    """Levanta LoginBlocked se o e-mail (daquele IP ou no total) ou o IP passou do limite."""
    for key, limit in _keys(email, ip):
        count, ttl = await ephemeral.count(key)
        if count >= limit:
            raise LoginBlocked(ttl)


async def failed(email: str, ip: str | None) -> None:
    """Senha errada (ou conta inexistente/inativa): soma na janela."""
    for key, _ in _keys(email, ip):
        await ephemeral.incr(key, WINDOW_SECONDS)


async def succeeded(email: str, ip: str | None = None) -> None:
    """Login certo: zera a contagem do e-mail (a do IP segue a janela)."""
    keys = [key for key, _ in _keys(email, ip) if not key.startswith(f"{_PREFIX}ip:")]
    await ephemeral.delete(*keys)


async def check_password_change(user_id: str) -> None:
    """Troca de senha: bloqueia depois de várias senhas atuais erradas."""
    count, ttl = await ephemeral.count(f"{_PREFIX}pwd:{user_id}")
    if count >= MAX_PASSWORD_CHANGE:
        raise LoginBlocked(ttl, "de trocar a senha")


async def password_change_failed(user_id: str) -> None:
    await ephemeral.incr(f"{_PREFIX}pwd:{user_id}", WINDOW_SECONDS)


async def password_change_succeeded(user_id: str) -> None:
    await ephemeral.delete(f"{_PREFIX}pwd:{user_id}")


async def hit(scope: str, key: str, limit: int, window: int) -> None:
    """Conta um envio; passou de `limit` na janela de `window` segundos, levanta RateLimited."""
    count, ttl = await ephemeral.incr(f"{_RATE}{scope}:{key}", window)
    if count > limit:
        raise RateLimited(ttl)


def reset_memory() -> None:
    """Para os testes: começa cada um sem contagem (login, envios, sessões e marcas de uso)."""
    ephemeral.reset_memory()
