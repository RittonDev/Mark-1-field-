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
    PORTAL = "portal"  # portal do cliente (solicitação aberta pelo próprio cliente)


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
    # Analista responsável pela OS (a fila dele), separado do técnico que executa.
    OWNER_CHANGED = "owner_changed"
    COMMENT_ADDED = "comment_added"
    WORKLOG_ADDED = "worklog_added"
    ATTACHMENT_ADDED = "attachment_added"
    ATTACHMENT_UPDATED = "attachment_updated"
    ATTACHMENT_REMOVED = "attachment_removed"
    HELPERS_CHANGED = "helpers_changed"
    FORM_ADDED = "form_added"
    FORM_COMPLETED = "form_completed"
    FORM_REMOVED = "form_removed"
    SIGNATURE_COLLECTED = "signature_collected"
    EXPENSE_ADDED = "expense_added"
    EXPENSE_UPDATED = "expense_updated"
    EXPENSE_REMOVED = "expense_removed"
    UNPRODUCTIVE_VISIT = "unproductive_visit"
    QUOTE_SENT = "quote_sent"
    QUOTE_APPROVED = "quote_approved"
    QUOTE_REJECTED = "quote_rejected"
    # Autorização do cliente para a visita (cada chamado é cobrado).
    AUTHORIZATION_RECORDED = "authorization_recorded"
    # Pedido de peça do técnico (peça só entra com orçamento aprovado).
    PART_REQUESTED = "part_requested"
    PART_REQUEST_UPDATED = "part_request_updated"
    # Horários reais corrigidos pela central (o técnico nunca mexe no horário).
    TIMES_CORRECTED = "times_corrected"


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


class ViolationScope(StrEnum):
    """A qual relógio de SLA o motivo de violação se aplica."""

    RESPONSE = "response"
    RESOLUTION = "resolution"
    BOTH = "both"


class Responsibility(StrEnum):
    """De quem é a causa da violação (é o que torna o motivo estatística útil)."""

    INTERNAL = "internal"
    CUSTOMER = "customer"
    THIRD_PARTY = "third_party"


class ApplicationStatus(StrEnum):
    """Ficha de homologação de técnico."""

    PENDING = "pending"  # aguardando análise
    APPROVED = "approved"  # virou técnico da base
    REJECTED = "rejected"


class FormStatus(StrEnum):
    """Formulário (checklist) anexado à OS."""

    PENDING = "pending"  # ninguém respondeu ainda
    IN_PROGRESS = "in_progress"  # respostas salvas, falta concluir
    COMPLETED = "completed"  # validado: obrigatórios respondidos e fotos mínimas enviadas


class ExpenseKind(StrEnum):
    """Custo extra da OS (reembolso ao técnico)."""

    MATERIAL = "material"  # compra de material (ex.: velcro, conectores)
    KM = "km"  # quilometragem rodada (km x valor por km)
    TOLL = "toll"  # pedágio
    PARKING = "parking"  # estacionamento
    TRANSPORT = "transport"  # aplicativo de transporte, ônibus
    MEAL = "meal"  # alimentação
    OTHER = "other"


class PayoutStatus(StrEnum):
    """Pagamento do técnico pela OS (os técnicos são parceiros e recebem por chamado)."""

    PENDING = "pending"  # a pagar
    PAID = "paid"  # pago


class ExpenseStatus(StrEnum):
    PENDING = "pending"  # lançado, aguardando aprovação
    APPROVED = "approved"  # aprovado para reembolso
    PAID = "paid"  # reembolsado ao técnico
    REJECTED = "rejected"  # não será reembolsado


class QuoteStatus(StrEnum):
    DRAFT = "draft"  # em elaboração
    SENT = "sent"  # link enviado ao cliente
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"  # passou da validade sem resposta
    CANCELLED = "cancelled"


class ProjectStatus(StrEnum):
    PLANNING = "planning"
    ACTIVE = "active"
    PAUSED = "paused"
    DONE = "done"
    CANCELLED = "cancelled"


class RepairStatus(StrEnum):
    """Equipamento retirado do cliente e enviado para assistência técnica externa."""

    WITHDRAWN = "withdrawn"  # retirado no cliente (a caminho da Maxx)
    RECEIVED = "received"  # recebido na Maxx
    SENT_TO_VENDOR = "sent_to_vendor"  # enviado à assistência
    VENDOR_QUOTE = "vendor_quote"  # assistência mandou orçamento (aguardando aprovação)
    IN_REPAIR = "in_repair"  # em reparo na assistência
    READY_AT_VENDOR = "ready_at_vendor"  # pronto, aguardando retirada na assistência
    BACK_IN_STOCK = "back_in_stock"  # de volta na Maxx, pronto para entregar
    DELIVERED = "delivered"  # entregue ao cliente (fim)
    UNREPAIRABLE = "unrepairable"  # sem conserto (devolver ou descartar)
    CANCELLED = "cancelled"


class AuthorizationStatus(StrEnum):
    """Autorização do cliente para a visita: o técnico só sai com ela (quando a regra exige)."""

    NOT_REQUIRED = "not_required"  # regra desligada ou OS anterior à regra
    PENDING = "pending"  # aguardando o cliente autorizar
    AUTHORIZED = "authorized"
    DENIED = "denied"


class AuthorizationChannel(StrEnum):
    """Por onde o cliente autorizou."""

    WHATSAPP = "whatsapp"
    EMAIL = "email"
    PHONE = "phone"
    PORTAL = "portal"
    MAXXCON = "maxxcon"  # central de suporte remoto do grupo
    OTHER = "other"


class PartRequestStatus(StrEnum):
    """Pedido de peça feito pelo técnico em campo."""

    OPEN = "open"  # aguardando a gestão montar o orçamento
    QUOTED = "quoted"  # orçamento montado e ligado ao pedido
    APPROVED = "approved"  # cliente aprovou o orçamento: pode trocar
    REJECTED = "rejected"
    CANCELLED = "cancelled"
