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
    # Cobrança da resposta do cliente ("Cobrar": lembrete pelo WhatsApp), só para a gestão.
    QUOTE_REMINDED = "quote_reminded"
    # Autorização do cliente para a visita (cada chamado é cobrado).
    AUTHORIZATION_RECORDED = "authorization_recorded"
    # Pedido de peça do técnico (peça só entra com orçamento aprovado).
    PART_REQUESTED = "part_requested"
    PART_REQUEST_UPDATED = "part_request_updated"
    # Horários reais corrigidos pela central (o técnico nunca mexe no horário).
    TIMES_CORRECTED = "times_corrected"
    # Valor do técnico na OS (parceiro pago por chamado): só a gestão vê.
    PAYOUT_SET = "payout_set"
    PAYOUT_REMOVED = "payout_removed"
    # Oferta da OS com preço para técnicos parceiros (services/offers.py). Levam o valor: só quem
    # tem Pagamentos vê no histórico.
    OFFER_SENT = "offer_sent"
    OFFER_ACCEPTED = "offer_accepted"
    OFFER_DECLINED = "offer_declined"
    OFFER_CANCELLED = "offer_cancelled"
    # Avaliação do cliente sobre um técnico da OS concluída, registrada pela central
    # (services/technician_ratings.py): só a gestão vê; nada no app e fora do Elo.
    RATING_SET = "rating_set"
    RATING_REMOVED = "rating_removed"


class DevicePlatform(StrEnum):
    IOS = "ios"
    ANDROID = "android"
    WEB = "web"


class PixKeyType(StrEnum):
    """Tipo da chave PIX que o técnico cadastra no app para receber por chamado (core/pix.py)."""

    CPF = "cpf"
    CNPJ = "cnpj"
    EMAIL = "email"
    PHONE = "phone"  # celular, gravado como +55 e 11 dígitos
    RANDOM = "random"  # chave aleatória (EVP), gravada com os hífens


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
    TECHNICIAN = "technician"  # o técnico (pesa no elo dele: services/technician_levels.py)


class LevelTier(StrEnum):
    """Elo do técnico (services/technician_levels.py), do mais baixo ao mais alto."""

    BRONZE = "bronze"
    SILVER = "silver"
    GOLD = "gold"
    DIAMOND = "diamond"


class LevelOccurrenceKind(StrEnum):
    """O que pesou no elo do técnico (a central pode desconsiderar cada uma)."""

    LATE = "late"  # chegou mais de 30 min depois do horário combinado
    REWORK = "rework"  # OS concluída reaberta em até 30 dias
    UNPRODUCTIVE = "unproductive"  # visita improdutiva com motivo de responsabilidade do técnico


class LevelEntryKind(StrEnum):
    """Tipo do lançamento no livro de pontos do elo (models/level_points.py; só a central vê
    pontos). O sinal dos pontos de cada tipo fica no check ck_technician_level_entries_sign."""

    OPENING = "opening"  # abertura pelo histórico de atendimentos (>= 0)
    COMPLETION = "completion"  # atendimento concluído (> 0)
    ON_TIME = "on_time"  # chegada dentro do SLA (> 0)
    LATE = "late"  # chegada fora do SLA (<= 0)
    ABANDONMENT = "abandonment"  # abandono confirmado pela operação (<= 0)
    REWORK_FAILURE = "rework_failure"  # retorno com falha confirmada (<= 0)
    ADJUSTMENT = "adjustment"  # ajuste excepcional, com motivo e autor (!= 0)
    REVERSAL = "reversal"  # estorno de outro lançamento (qualquer sinal)
    RECATEGORIZATION = "recategorization"  # faixas novas aprovadas com o elo ativo (= 0)


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


class InvoiceStatus(StrEnum):
    """Nota fiscal que o técnico parceiro envia pelo app (opcional; services/invoices.py). A recusa
    é final: o técnico apaga a nota e envia outra."""

    PENDING = "pending"  # aguardando conferência
    CHECKED = "checked"  # conferida pela central
    REJECTED = "rejected"  # recusada, com motivo


class OfferStatus(StrEnum):
    """Oferta da OS com preço para um técnico parceiro (aceita pelo valor ou recusa, sem
    contraproposta). "expired" não é gravado: é a pendente com o prazo para responder vencido
    (services/offers.effective_state)."""

    PENDING = "pending"  # aguardando a resposta do técnico
    ACCEPTED = "accepted"  # o técnico aceitou e ficou com a OS
    DECLINED = "declined"  # o técnico recusou
    CANCELLED = "cancelled"  # encerrada sem resposta dele (o motivo em OfferCancelReason)


class OfferCancelReason(StrEnum):
    """Por que a oferta foi cancelada."""

    CENTRAL = "central"  # a central cancelou a oferta
    TAKEN = "taken"  # outro técnico aceitou primeiro
    ASSIGNED = "assigned"  # a central definiu o técnico da OS na mão
    TICKET_CLOSED = "ticket_closed"  # a OS foi cancelada, resolvida ou fechada
    REPLACED = "replaced"  # a central mandou ao técnico uma oferta nova da mesma OS


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


# --------------------------------------------------------------- cadastro V2 dos técnicos


class OperationalStatus(StrEnum):
    """Situação do técnico na operação (só a central vê). Receber OS pede "active" e o acesso ao
    app liberado (users.is_active), que continua separado: Inativo e Bloqueado seguem entrando no
    app."""

    ACTIVE = "active"
    INACTIVE = "inactive"
    BLOCKED = "blocked"


class PayoutMethodKind(StrEnum):
    """Forma de recebimento do técnico (models/payout_method.py)."""

    PIX = "pix"
    BANK = "bank"  # conta bancária


class BankAccountType(StrEnum):
    CHECKING = "checking"  # conta corrente
    SAVINGS = "savings"  # conta poupança
    PAYMENT = "payment"  # conta de pagamento


class AccountTokenPurpose(StrEnum):
    """Link de uso único mandado por e-mail (models/account_token.py)."""

    VERIFY_EMAIL = "verify_email"  # validar o e-mail
    RESET_PASSWORD = "reset_password"  # criar uma senha nova (ou a primeira, na boas-vindas)


class EmailTemplate(StrEnum):
    """E-mail transacional (services/mail_templates.py)."""

    VERIFY_EMAIL = "verify_email"
    WELCOME = "welcome"
    PASSWORD_RESET = "password_reset"


class EmailStatus(StrEnum):
    """Linha da fila de e-mails (models/email_outbox.py)."""

    PENDING = "pending"  # na fila (com o envio desligado, fica assim até vencer)
    SENT = "sent"
    FAILED = "failed"  # recusado pelo servidor ou sem sucesso depois das tentativas
    EXPIRED = "expired"  # passou do prazo sem sair: "Não enviado"


# --------------------------------------------------------------- gestão dos técnicos (Entrega 2)


class TechDocumentKind(StrEnum):
    """Documento do técnico (models/technician_document.py). O técnico (app e ficha) envia os três
    primeiros; o anexo interno é só da central, com Técnicos Editar, e nunca chega ao app."""

    CERTIFICATION = "certification"  # certificação ou curso (a única com validade)
    PERSONAL = "personal"  # documento pessoal (RG, CNH, comprovante...)
    RESUME = "resume"  # currículo: um só por técnico (enviar outro substitui)
    INTERNAL = "internal"  # anexo interno da parceria (contrato, ocorrências)


# O nome do desenho do backend (D-B2): o mesmo enum.
TechnicianDocumentKind = TechDocumentKind


class RatingSource(StrEnum):
    """De onde veio a avaliação do cliente (models/technician_rating.py)."""

    CENTRAL = "central"  # registrada pela central na OS concluída
    CLIENT = "client"  # o formulário do cliente (módulo de OS, depois)
