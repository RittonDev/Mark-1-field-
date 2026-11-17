"""Tela inicial da gestão (pontos de atenção, indicadores, sugestões) e a busca inteligente."""

import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, SerializerFunctionWrapHandler, model_serializer

from app.core.enums import TicketPriority, TicketSource, TicketStatus, TicketType
from app.schemas.common import TagOut
from app.schemas.expense import Money


class ListFilters(BaseModel):
    """Recorte da lista de OS (os mesmos parâmetros de GET /tickets). A web transforma em URL da
    lista de chamados. Só vão na resposta as chaves usadas (as ausentes ficam de fora).

    `technician_id` é o "técnico que atuou": responsável atual, outro técnico da visita ou quem já
    foi responsável (histórico de atribuições)."""

    status: list[TicketStatus] | None = None
    priority: list[TicketPriority] | None = None
    number: int | None = None
    customer_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    technician_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    tag: list[str] | None = None
    created_from: date | None = None
    created_to: date | None = None
    scheduled_from: date | None = None
    scheduled_to: date | None = None
    q: str | None = None
    open_only: bool | None = None
    sla_breached: bool | None = None
    unassigned: bool | None = None
    no_owner: bool | None = None
    violation_pending: bool | None = None
    type: TicketType | None = None
    source: TicketSource | None = None
    # Ordem da lista (o `order_by` de GET /tickets), ex.: "created_at" = mais antigas primeiro.
    order_by: str | None = None

    @model_serializer(mode="wrap")
    def _only_present(self, handler: SerializerFunctionWrapHandler):
        data = handler(self)
        return {key: value for key, value in data.items() if value is not None}


# --------------------------------------------------------------------------- tela inicial

Severity = Literal["critical", "high", "medium", "low"]
# "now": pede ação agora (entra no número do topo); "routine": o resto.
Tier = Literal["now", "routine"]


class HomeKpis(BaseModel):
    open: int
    scheduled_today: int
    in_field_now: int
    resolved_today: int
    late: int  # em aberto com SLA estourado (a aba "SLA violado" da lista)
    unassigned: int  # em aberto sem técnico


class AttentionItem(BaseModel):
    ticket_id: uuid.UUID | None = None
    number: int | None = None
    title: str
    customer: str | None = None
    location: str | None = None
    technician: str | None = None
    when: datetime | None = None
    reason: str


class AttentionGroup(BaseModel):
    key: str
    title: str
    severity: Severity
    count: int
    hint: str
    filters: ListFilters | None = None
    link: str | None = None
    items: list[AttentionItem] = Field(default_factory=list)
    tier: Tier = "routine"


class Suggestion(BaseModel):
    key: str
    title: str
    detail: str
    link: str | None = None
    filters: ListFilters | None = None


class WeekDay(BaseModel):
    day: date
    created: int
    resolved: int


# --------------------------------------------------------------------------- sinais vitais


class Ratio(BaseModel):
    """Parte de uma base: a tela mostra "count de base" e só põe % com base suficiente."""

    count: int
    base: int


class HomeFocus(BaseModel):
    total: int  # OS distintas em algum grupo "now" (uma OS com dois motivos conta uma vez)
    next_visit_at: datetime | None = None  # próxima visita de hoje ainda não iniciada


class HomeToday(BaseModel):
    """Visitas de hoje (agendadas para hoje e não canceladas).
    planned = done + in_field + not_started + upcoming + on_hold."""

    planned: int  # = kpis.scheduled_today
    done: int  # resolvidas ou fechadas
    in_field: int  # em deslocamento ou em atendimento
    not_started: int  # = grupo today_not_started (30 min ou mais depois do horário)
    on_hold: int  # aguardando cliente ou fornecedor
    upcoming: int  # não iniciadas e ainda no horário
    unassigned: int  # sem técnico e não concluídas
    unassigned_filters: ListFilters
    technicians: int  # técnicos distintos com visita hoje
    resolved: int  # OS resolvidas hoje, de qualquer agenda (= kpis.resolved_today)


class HomeTomorrow(BaseModel):
    day: date
    planned: int  # visitas de amanhã fora de concluídas e canceladas
    technicians: int
    unassigned: int  # o mesmo número da sugestão tomorrow_unassigned
    unassigned_filters: ListFilters


class AgeBucket(BaseModel):
    key: Literal["d7", "d30", "d90", "older"]
    count: int
    filters: ListFilters  # abertas criadas na faixa, mais antigas primeiro


class OldReason(BaseModel):
    key: Literal["no_owner", "unassigned", "overdue_visit", "sla_breached", "unproductive"]
    label: str
    count: int
    filters: ListFilters | None = None  # None quando a lista não reproduz o número


class HomeBacklog(BaseModel):
    open: int  # = kpis.open
    recent: int  # abertas nos últimos 30 dias
    old: int  # abertas antes disso (a "Fila antiga")
    median_age_days: float | None = None  # 1 casa; None sem OS em aberto
    ages: list[AgeBucket]  # sempre as 4, nesta ordem; somam `open`
    entered_30d: int
    resolved_30d: int
    cancelled_30d: int
    old_reasons: list[OldReason] = Field(default_factory=list)  # só com OS, maior primeiro
    old_filters: ListFilters  # a fila antiga inteira, mais antigas primeiro


class HomeQuality(BaseModel):
    on_time: Ratio  # chegadas no prazo de chegada ou, sem ele, até 30 min depois da agenda
    resolution_sla: Ratio  # resolvidas dentro do prazo de solução (só OS com prazo)
    resolution_sla_imported: int  # da base acima, quantas vieram do Field Control
    store_return: Ratio  # concluídas com nova corretiva na mesma loja em até return_days
    return_days: int = 7
    unproductive: int  # visitas improdutivas na janela
    visits: int  # idas à loja: chegadas na janela + improdutivas


class HomeTeam(BaseModel):
    worked: int  # técnicos responsáveis por OS resolvidas na janela
    resolved: int  # OS resolvidas por eles
    top3_resolved: int  # dessas, quantas os 3 técnicos com mais OS resolveram
    in_app: int  # de worked, quantos já entraram no app
    onsite_median_minutes: int | None = None
    onsite_over: Ratio  # visitas com mais de onsite_limit_hours na loja / visitas com tempo
    onsite_limit_hours: int


class CustomerPulse(BaseModel):
    id: uuid.UUID
    name: str
    created: int  # OS do cliente abertas na janela
    on_time: Ratio  # a regra de quality.on_time, só do cliente
    breached: int  # abertas na janela, ainda em aberto e com SLA estourado
    filters: ListFilters
    breached_filters: ListFilters | None = None  # None com breached 0


class HomeCustomers(BaseModel):
    active: int  # clientes com OS abertas na janela
    entered: int  # = backlog.entered_30d (base da participação)
    top: list[CustomerPulse] = Field(default_factory=list)  # até 5, com mais OS primeiro


class HomeFinance(BaseModel):
    """Valor sem lançamento sai 0: quem diz "sem valores" é a contagem."""

    payouts_to_pay: Money  # pagamentos pendentes de OS concluídas
    payouts_to_pay_count: int
    payouts_technicians: int
    payouts_late: int  # desses, OS concluída há mais de 7 dias (= grupo payouts_pending)
    payouts_expected: Money  # pendentes de OS ainda em aberto
    payout_tag: str | None = None  # a etiqueta que sai quando o técnico é pago
    payout_tag_tickets: int = 0  # OS concluídas que ainda têm a etiqueta
    payout_tag_technicians: int = 0
    payout_tag_over_30d: int = 0
    payout_tag_filters: ListFilters | None = None
    quotes_waiting: int
    quotes_waiting_total: Money
    quotes_approved_month: int
    quotes_approved_month_total: Money
    costs_pending: int
    costs_pending_total: Money


class HomeQuotes(BaseModel):
    """Orçamentos para a caixinha da Início. Os recortes "aguardando", "vencidos" e "rascunhos"
    contam exatamente o que a lista de /orcamentos mostra com o filtro do link (mesma regra de
    vencido da lista: enviado com validade passada conta como vencido), inclusive de OS cancelada.
    Valor sem orçamento sai 0: quem diz "nenhum" é a contagem."""

    awaiting: int  # enviados na validade (ou sem validade): aguardando a assinatura do cliente
    awaiting_total: Money
    awaiting_no_link: int  # desses, sem link: o cliente não tem como assinar
    expiring: int  # desses, com a validade hoje ou amanhã
    expired_90d: int  # vencidos criados nos últimos 90 dias (now - 90 × 24 h, como a lista)
    expired_90d_total: Money
    drafts: int  # rascunhos (todos)
    in_review: int  # desses, já enviados (editados depois do envio)
    follow_up: int  # a fila "Para cobrar" (= grupo quotes_waiting)
    follow_up_total: Money
    approved_month: int  # aprovados no mês (fuso da operação), OS não cancelada
    approved_month_total: Money
    rejected_month: int  # recusados no mês, OS não cancelada
    approved_90d: int  # aprovados nos últimos 90 dias, OS não cancelada
    # A base da taxa de aprovação: aprovados e recusados nos últimos 90 dias mais os vencidos com
    # a validade nos 90 dias anteriores a hoje (OS não cancelada).
    decided_90d: int


class WeekFlow(BaseModel):
    start: date  # segunda-feira (fuso da operação)
    created: int
    resolved: int


class HomePulse(BaseModel):
    window_from: date  # 1º dia dos "últimos 30 dias" (hoje - 29)
    today: HomeToday
    tomorrow: HomeTomorrow
    backlog: HomeBacklog
    quality: HomeQuality
    team: HomeTeam
    customers: HomeCustomers
    finance: HomeFinance | None = None  # None: sem permissão para ver valores
    quotes: HomeQuotes | None = None  # None: sem permissão (reservado; hoje sempre preenchido)
    weeks: list[WeekFlow]  # 8, da mais antiga para a atual (em andamento)


class HomeOverview(BaseModel):
    generated_at: datetime
    kpis: HomeKpis
    attention: list[AttentionGroup]
    suggestions: list[Suggestion]
    week: list[WeekDay]
    focus: HomeFocus
    pulse: HomePulse


# --------------------------------------------------------------------------- busca inteligente

ChipKind = Literal[
    "number",
    "status",
    "period",
    "customer",
    "location",
    "technician",
    "tag",
    "city",
    "priority",
    "text",
]


class SearchChip(BaseModel):
    """Como a busca entendeu um pedaço da frase (ex.: "Agendadas: amanhã")."""

    kind: ChipKind
    label: str


class SearchTicket(BaseModel):
    id: uuid.UUID
    number: int
    title: str
    status: TicketStatus
    customer: str | None = None
    location: str | None = None
    city: str | None = None
    technician: str | None = None
    scheduled_start: datetime | None = None
    created_at: datetime
    tags: list[TagOut] = Field(default_factory=list)


class SearchCustomer(BaseModel):
    id: uuid.UUID
    name: str
    document: str | None = None
    open_count: int = 0


class SearchLocation(BaseModel):
    id: uuid.UUID
    name: str
    code: str | None = None
    city: str | None = None
    customer: str | None = None


class SearchTechnician(BaseModel):
    id: uuid.UUID
    name: str
    city: str | None = None
    active: bool


class SmartSearchResult(BaseModel):
    query: str
    chips: list[SearchChip] = Field(default_factory=list)
    filters: ListFilters | None = None
    total: int = 0
    tickets: list[SearchTicket] = Field(default_factory=list)
    customers: list[SearchCustomer] = Field(default_factory=list)
    locations: list[SearchLocation] = Field(default_factory=list)
    technicians: list[SearchTechnician] = Field(default_factory=list)


def tags_out(raw: Any) -> list[TagOut]:
    """Etiquetas da OS (JSONB [{name, color}]) sem as vazias ou malformadas."""
    out: list[TagOut] = []
    for tag in raw or []:
        if isinstance(tag, dict) and str(tag.get("name") or "").strip():
            color = tag.get("color")
            out.append(
                TagOut(name=str(tag["name"]), color=color if isinstance(color, str) else None)
            )
    return out
