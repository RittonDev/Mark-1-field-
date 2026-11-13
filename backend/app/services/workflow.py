"""Máquina de estados da OS.

Baseada nos estados usados por ServiceNow / Jira Service Management / ITIL v4
(New, Assigned, In Progress, On Hold, Resolved, Closed, Cancelled, Reopened)
mais os estados de atendimento em campo (Scheduled, En Route).
"""

from dataclasses import asdict, dataclass

from app.core.enums import Impact, TicketPriority, TicketStatus, Urgency, UserRole
from app.services.errors import PermissionDenied, WorkflowError  # noqa: F401 (reexport)

S = TicketStatus


@dataclass(frozen=True)
class StatusInfo:
    label: str
    group: str  # open | active | pending | done | final
    color: str
    sla_paused: bool = False
    final: bool = False
    requires_assignee: bool = False
    description: str = ""


STATUS_INFO: dict[TicketStatus, StatusInfo] = {
    S.NEW: StatusInfo("Novo", "open", "#64748b", description="Aberto, aguardando triagem"),
    S.TRIAGE: StatusInfo("Em triagem", "open", "#8b5cf6", description="Sendo classificado"),
    S.ASSIGNED: StatusInfo(
        "Atribuído",
        "active",
        "#3b82f6",
        requires_assignee=True,
        description="Responsável definido, ainda não iniciado",
    ),
    S.SCHEDULED: StatusInfo(
        "Agendado",
        "active",
        "#06b6d4",
        requires_assignee=True,
        description="Visita técnica agendada",
    ),
    S.EN_ROUTE: StatusInfo(
        "Em deslocamento",
        "active",
        "#0ea5e9",
        requires_assignee=True,
        description="Técnico a caminho do local",
    ),
    S.IN_PROGRESS: StatusInfo(
        "Em atendimento",
        "active",
        "#f59e0b",
        requires_assignee=True,
        description="Atendimento em execução",
    ),
    S.ON_HOLD_CUSTOMER: StatusInfo(
        "Aguardando cliente",
        "pending",
        "#a855f7",
        sla_paused=True,
        description="Pendente de retorno/ação do solicitante (SLA pausado)",
    ),
    S.ON_HOLD_VENDOR: StatusInfo(
        "Aguardando fornecedor/peça",
        "pending",
        "#d946ef",
        sla_paused=True,
        description="Pendente de terceiro ou peça (SLA pausado)",
    ),
    S.RESOLVED: StatusInfo(
        "Resolvido", "done", "#10b981", description="Solução aplicada, aguardando aceite"
    ),
    S.CLOSED: StatusInfo("Fechado", "final", "#334155", final=True, description="Encerrado"),
    S.CANCELLED: StatusInfo("Cancelado", "final", "#ef4444", final=True, description="Cancelado"),
    S.REOPENED: StatusInfo(
        "Reaberto", "open", "#f97316", description="Solução recusada, voltou para a fila"
    ),
}

TRANSITIONS: dict[TicketStatus, tuple[TicketStatus, ...]] = {
    S.NEW: (S.TRIAGE, S.ASSIGNED, S.ON_HOLD_CUSTOMER, S.CANCELLED),
    S.TRIAGE: (S.ASSIGNED, S.ON_HOLD_CUSTOMER, S.CANCELLED),
    S.ASSIGNED: (
        S.SCHEDULED,
        S.EN_ROUTE,
        S.IN_PROGRESS,
        S.ON_HOLD_CUSTOMER,
        S.ON_HOLD_VENDOR,
        S.CANCELLED,
    ),
    S.SCHEDULED: (S.EN_ROUTE, S.IN_PROGRESS, S.ASSIGNED, S.ON_HOLD_CUSTOMER, S.CANCELLED),
    S.EN_ROUTE: (S.IN_PROGRESS, S.SCHEDULED, S.ON_HOLD_CUSTOMER),
    S.IN_PROGRESS: (S.ON_HOLD_CUSTOMER, S.ON_HOLD_VENDOR, S.SCHEDULED, S.RESOLVED),
    S.ON_HOLD_CUSTOMER: (S.ASSIGNED, S.SCHEDULED, S.IN_PROGRESS, S.RESOLVED, S.CANCELLED),
    S.ON_HOLD_VENDOR: (S.SCHEDULED, S.IN_PROGRESS, S.RESOLVED, S.CANCELLED),
    S.RESOLVED: (S.CLOSED, S.REOPENED),
    S.CLOSED: (),
    S.CANCELLED: (),
    S.REOPENED: (
        S.ASSIGNED,
        S.SCHEDULED,
        S.EN_ROUTE,
        S.IN_PROGRESS,
        S.ON_HOLD_CUSTOMER,
        S.ON_HOLD_VENDOR,
        S.RESOLVED,
    ),
}

# Estados em que o chamado ainda está "vivo" (conta no backlog e no SLA).
OPEN_STATUSES: frozenset[TicketStatus] = frozenset(
    s for s, info in STATUS_INFO.items() if info.group in ("open", "active", "pending")
)
SLA_PAUSED_STATUSES: frozenset[TicketStatus] = frozenset(
    s for s, info in STATUS_INFO.items() if info.sla_paused
)
# Sair destes estados (por ação da equipe) conta como primeira resposta.
UNTOUCHED_STATUSES: frozenset[TicketStatus] = frozenset({S.NEW, S.TRIAGE})
# O que o técnico pode fazer com a visita (o resto do fluxo é da central).
TECHNICIAN_TARGETS: frozenset[TicketStatus] = frozenset({S.EN_ROUTE, S.IN_PROGRESS, S.RESOLVED})

PRIORITY_INFO: dict[TicketPriority, dict[str, str]] = {
    TicketPriority.CRITICAL: {"label": "Crítica", "code": "P1", "color": "#dc2626"},
    TicketPriority.HIGH: {"label": "Alta", "code": "P2", "color": "#ea580c"},
    TicketPriority.MEDIUM: {"label": "Média", "code": "P3", "color": "#ca8a04"},
    TicketPriority.LOW: {"label": "Baixa", "code": "P4", "color": "#16a34a"},
}

# Matriz ITIL impacto x urgência.
_P = TicketPriority
PRIORITY_MATRIX: dict[tuple[Impact, Urgency], TicketPriority] = {
    (Impact.HIGH, Urgency.HIGH): _P.CRITICAL,
    (Impact.HIGH, Urgency.MEDIUM): _P.HIGH,
    (Impact.HIGH, Urgency.LOW): _P.MEDIUM,
    (Impact.MEDIUM, Urgency.HIGH): _P.HIGH,
    (Impact.MEDIUM, Urgency.MEDIUM): _P.MEDIUM,
    (Impact.MEDIUM, Urgency.LOW): _P.LOW,
    (Impact.LOW, Urgency.HIGH): _P.MEDIUM,
    (Impact.LOW, Urgency.MEDIUM): _P.LOW,
    (Impact.LOW, Urgency.LOW): _P.LOW,
}


def compute_priority(impact: Impact, urgency: Urgency) -> TicketPriority:
    return PRIORITY_MATRIX[(impact, urgency)]


def can_transition(from_status: TicketStatus, to_status: TicketStatus) -> bool:
    return to_status in TRANSITIONS.get(from_status, ())


def validate_transition(
    *,
    from_status: TicketStatus,
    to_status: TicketStatus,
    has_assignee: bool,
    has_schedule: bool,
    note: str | None,
    resolution_notes: str | None,
) -> None:
    """Valida a transição e suas pré-condições. Levanta WorkflowError."""
    if from_status == to_status:
        raise WorkflowError(f"A OS já está em '{STATUS_INFO[to_status].label}'")
    if not can_transition(from_status, to_status):
        raise WorkflowError(
            f"Transição não permitida: '{STATUS_INFO[from_status].label}' -> "
            f"'{STATUS_INFO[to_status].label}'"
        )
    if STATUS_INFO[to_status].requires_assignee and not has_assignee:
        raise WorkflowError("Atribua um responsável antes de mudar para este status")
    if to_status == S.SCHEDULED and not has_schedule:
        raise WorkflowError("Informe a data/hora da visita (scheduled_start) para agendar")
    if to_status == S.RESOLVED and not (resolution_notes and resolution_notes.strip()):
        raise WorkflowError("Descreva a solução aplicada (resolution_notes) para resolver")
    if to_status in (S.CANCELLED, S.REOPENED) and not (note and note.strip()):
        raise WorkflowError("Informe o motivo (note)")


def user_can_transition(
    *,
    role: UserRole,
    user_id: object,
    user_team_id: object,
    ticket_assignee_id: object,
    ticket_team_id: object,
    ticket_requester_id: object,
    from_status: TicketStatus,
    to_status: TicketStatus,
) -> bool:
    if role in (UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.ANALYST):
        return True
    if role == UserRole.TECHNICIAN:
        # Só nas OS em que é o responsável (o analista o coloca na OS), e só andando com a
        # visita: sair, iniciar (chegada) e concluir. Agendar, pausar, devolver e cancelar são da
        # central — o técnico nunca mexe no horário; o tempo dele corre do início à conclusão.
        return ticket_assignee_id == user_id and to_status in TECHNICIAN_TARGETS
    # Solicitante: cancela enquanto ninguém pegou; aceita (fecha) ou recusa (reabre) a solução.
    if ticket_requester_id != user_id:
        return False
    if to_status == S.CANCELLED:
        return from_status in UNTOUCHED_STATUSES
    return from_status == S.RESOLVED and to_status in (S.CLOSED, S.REOPENED)


def workflow_metadata() -> dict:
    """Metadados servidos em /meta para web e mobile renderizarem o fluxo."""
    return {
        "statuses": [{"value": s.value, **asdict(info)} for s, info in STATUS_INFO.items()],
        "transitions": {s.value: [t.value for t in ts] for s, ts in TRANSITIONS.items()},
        "priorities": [{"value": p.value, **info} for p, info in PRIORITY_INFO.items()],
        "priority_matrix": [
            {"impact": i.value, "urgency": u.value, "priority": p.value}
            for (i, u), p in PRIORITY_MATRIX.items()
        ],
    }
