"""Canais de acesso: navegador para analistas e gestores, celular para técnicos de campo.

Inspirado no Field Control: o escritório gerencia pela web, o técnico atende pelo app.
O solicitante (cliente) usa o portal web para abrir e acompanhar os próprios chamados.
"""

from typing import Literal

from app.core.enums import UserRole

Channel = Literal["web", "mobile"]

CHANNEL_ROLES: dict[str, frozenset[UserRole]] = {
    "web": frozenset({UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.ANALYST, UserRole.REQUESTER}),
    "mobile": frozenset({UserRole.TECHNICIAN}),
}

CHANNEL_DENIED_MESSAGE: dict[str, str] = {
    "web": "Técnicos de campo acessam pelo app MaxxChamados no celular (Android ou iOS).",
    "mobile": (
        "O app é exclusivo para técnicos de campo. Analistas e gestores acessam pelo navegador."
    ),
}


def channel_allows(channel: str | None, role: UserRole) -> bool:
    """Sem canal informado (integrações, scripts), não restringe."""
    return channel is None or role in CHANNEL_ROLES.get(channel, frozenset())


def channel_metadata() -> dict[str, list[str]]:
    return {channel: sorted(r.value for r in roles) for channel, roles in CHANNEL_ROLES.items()}
