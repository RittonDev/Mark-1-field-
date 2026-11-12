"""Links públicos assinados (relatório da OS, orçamento).

O token é `<id>.<assinatura>`: só o id fica no banco e a assinatura é um HMAC com o segredo
da API, separado por tipo de link. Assim o link pode ser copiado de novo a qualquer momento,
trocado quando preciso, e um vazamento do banco não entrega links válidos.
"""

import base64
import hashlib
import hmac
import secrets

from app.core.config import settings

SIG_LENGTH = 22
MAX_ID_LENGTH = 24


def new_link_id() -> str:
    return secrets.token_urlsafe(9)


def sign(kind: str, link_id: str) -> str:
    mac = hmac.new(
        settings.JWT_SECRET.encode(), f"{kind}:".encode() + link_id.encode(), hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(mac).rstrip(b"=").decode()[:SIG_LENGTH]


def token_for(kind: str, link_id: str) -> str:
    return f"{link_id}.{sign(kind, link_id)}"


def parse_token(kind: str, token: str) -> str | None:
    """Id do link quando a assinatura confere; None para token inválido ou adulterado."""
    link_id, sep, sig = token.partition(".")
    if not sep or not link_id or len(link_id) > MAX_ID_LENGTH or len(sig) != SIG_LENGTH:
        return None
    if not hmac.compare_digest(sig, sign(kind, link_id)):
        return None
    return link_id
