"""Rótulos pt-BR dos enums, servidos em /meta para web e mobile."""

from enum import StrEnum

from app.core.enums import (
    AssetType,
    Impact,
    TicketSource,
    TicketType,
    Urgency,
    UserRole,
)

ROLE_LABELS = {
    UserRole.ADMIN: "Administrador",
    UserRole.SUPERVISOR: "Supervisor",
    UserRole.ANALYST: "Analista",
    UserRole.TECHNICIAN: "Técnico de campo",
    UserRole.REQUESTER: "Solicitante",
}

TYPE_LABELS = {
    TicketType.INCIDENT: "Incidente (corretiva)",
    TicketType.SERVICE_REQUEST: "Requisição de serviço",
    TicketType.PREVENTIVE: "Manutenção preventiva",
    TicketType.INSTALLATION: "Instalação",
}

SOURCE_LABELS = {
    TicketSource.WEB: "Portal web",
    TicketSource.MOBILE: "App mobile",
    TicketSource.EMAIL: "E-mail",
    TicketSource.PHONE: "Telefone",
    TicketSource.WHATSAPP: "WhatsApp",
    TicketSource.MONITORING: "Monitoramento",
}

ASSET_TYPE_LABELS = {
    AssetType.PRINTER: "Impressora",
    AssetType.DESKTOP: "Computador",
    AssetType.NOTEBOOK: "Notebook",
    AssetType.SERVER: "Servidor",
    AssetType.SWITCH: "Switch",
    AssetType.ROUTER: "Roteador",
    AssetType.ACCESS_POINT: "Access point",
    AssetType.FIREWALL: "Firewall",
    AssetType.CAMERA: "Câmera (CFTV)",
    AssetType.DVR_NVR: "DVR / NVR",
    AssetType.PHONE: "Telefone / ramal",
    AssetType.OTHER: "Outro",
}

LEVEL_LABELS = {"high": "Alta", "medium": "Média", "low": "Baixa"}


def as_options(labels: dict[StrEnum, str]) -> list[dict[str, str]]:
    return [{"value": k.value, "label": v} for k, v in labels.items()]


def enum_options() -> dict[str, list[dict[str, str]]]:
    return {
        "ticket_types": as_options(TYPE_LABELS),  # type: ignore[arg-type]
        "sources": as_options(SOURCE_LABELS),  # type: ignore[arg-type]
        "asset_types": as_options(ASSET_TYPE_LABELS),  # type: ignore[arg-type]
        "roles": as_options(ROLE_LABELS),  # type: ignore[arg-type]
        "impacts": [{"value": i.value, "label": LEVEL_LABELS[i.value]} for i in Impact],
        "urgencies": [{"value": u.value, "label": LEVEL_LABELS[u.value]} for u in Urgency],
    }
