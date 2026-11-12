"""Enumerações de domínio.

Os valores (strings) são o contrato com o frontend web e os apps mobile:
nunca renomeie um valor existente, apenas adicione novos.
"""

from enum import StrEnum


class UserRole(StrEnum):
    ADMIN = "admin"
    SUPERVISOR = "supervisor"  # gestor / despachante
    ANALYST = "analyst"  # analista de service desk: gerencia todas as OS pela web
    TECHNICIAN = "technician"  # técnico de campo: atende as OS dele/do grupo (app mobile)
    REQUESTER = "requester"  # solicitante / cliente


class TicketStatus(StrEnum):
    """Ciclo de vida da OS (ITIL / ServiceNow / Jira SM + estados de campo)."""

    NEW = "new"
    TRIAGE = "triage"
    ASSIGNED = "assigned"
    SCHEDULED = "scheduled"
    EN_ROUTE = "en_route"
    IN_PROGRESS = "in_progress"
    ON_HOLD_CUSTOMER = "on_hold_customer"
    ON_HOLD_VENDOR = "on_hold_vendor"
    RESOLVED = "resolved"
    CLOSED = "closed"
    CANCELLED = "cancelled"
    REOPENED = "reopened"


class TicketPriority(StrEnum):
    CRITICAL = "critical"  # P1
    HIGH = "high"  # P2
    MEDIUM = "medium"  # P3
    LOW = "low"  # P4


class Impact(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class Urgency(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class TicketType(StrEnum):
    INCIDENT = "incident"  # corretiva
    SERVICE_REQUEST = "service_request"  # requisição de serviço
    PREVENTIVE = "preventive"  # manutenção preventiva
    INSTALLATION = "installation"  # instalação / implantação


class TicketSource(StrEnum):
    WEB = "web"
    MOBILE = "mobile"
    EMAIL = "email"
    PHONE = "phone"
    WHATSAPP = "whatsapp"
    MONITORING = "monitoring"


class AssetType(StrEnum):
    PRINTER = "printer"
    DESKTOP = "desktop"
    NOTEBOOK = "notebook"
    SERVER = "server"
    SWITCH = "switch"
    ROUTER = "router"
    ACCESS_POINT = "access_point"
    FIREWALL = "firewall"
    CAMERA = "camera"
    DVR_NVR = "dvr_nvr"
    PHONE = "phone"
    OTHER = "other"


class TicketEventType(StrEnum):
    CREATED = "created"
    UPDATED = "updated"
    STATUS_CHANGED = "status_changed"
    ASSIGNED = "assigned"
    COMMENT_ADDED = "comment_added"
    WORKLOG_ADDED = "worklog_added"
    ATTACHMENT_ADDED = "attachment_added"


class DevicePlatform(StrEnum):
    IOS = "ios"
    ANDROID = "android"
    WEB = "web"


class SlaStatus(StrEnum):
    OK = "ok"
    AT_RISK = "at_risk"
    BREACHED = "breached"
    PAUSED = "paused"
    MET = "met"
