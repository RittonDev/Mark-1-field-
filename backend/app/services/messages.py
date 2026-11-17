"""Textos prontos da OS para colar nos grupos de WhatsApp (o do cliente e o dos técnicos).

A gestão mantém os modelos (com variáveis entre chaves, ex.: {tecnico}); a API preenche com os
dados da OS na hora. Ex.: "O técnico {tecnico} está a caminho de {local}. Chegada prevista às
{chegada_prevista}." vira "O técnico Carlos Souza está a caminho de Loja 27. Chegada prevista às
14:35.". A previsão de chegada usa a posição ao vivo do técnico (rastreamento) quando há.

Os modelos padrão seguem os avisos do Field Control para o grupo do cliente: atividade confirmada,
técnico em deslocamento (ou atrasado), chegada, atividade encerrada (com o link do relatório) e
visita improdutiva. O texto que combina com a situação da OS agora vem marcado (`suggested`).

Os textos padrão vão para o grupo do cliente com um clique, sem revisão: a frase com um dado que
falta (sem previsão de chegada, sem técnico) sai inteira. Nos textos escritos pela gestão a marca
("__:__", "(técnico a definir)") fica, para o analista completar antes de mandar.
"""

import re
import unicodedata
import uuid
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import TicketEventType, TicketStatus
from app.db.base import utcnow
from app.models import SystemSetting, Ticket, TicketEvent, User
from app.schemas.ticket import format_ticket_code
from app.services import client_report, geo, tracking
from app.services import field as field_rules
from app.services.errors import WorkflowError
from app.services.map_distances import ROAD_FACTOR, travel_minutes
from app.services.suggestions import km_between
from app.services.workflow import PRIORITY_INFO, STATUS_INFO

S = TicketStatus
TEMPLATES_KEY = "messages.templates"
# Posição mais velha que isto não serve para prever a chegada.
LIVE_WINDOW = timedelta(minutes=30)
MIN_ETA_MINUTES = 5
# Antes de o técnico sair para o local (o texto da vez é a confirmação da atividade).
BEFORE_FIELD = frozenset({S.NEW, S.TRIAGE, S.ASSIGNED, S.SCHEDULED, S.REOPENED})
# Marcas de dado que falta. Nos textos padrão a frase com uma delas sai (ver `render`).
NO_ETA = "__:__"
NO_TECHNICIAN = "(técnico a definir)"
# Link do relatório desativado pela gestão: o texto não recria o link sozinho.
NO_REPORT_LINK = "(link do relatório desativado)"
PLACEHOLDERS = frozenset({NO_ETA, NO_TECHNICIAN, NO_REPORT_LINK})

VARIABLES: dict[str, str] = {
    "tecnico": "Nome do técnico responsável",
    "equipe": "Técnicos da visita (o responsável e quem vai junto)",
    "tecnico_telefone": "Telefone do técnico",
    "os": "Código da OS (ex.: OS-000123)",
    "titulo": "Título da OS",
    "cliente": "Cliente",
    "local": "Local / loja do atendimento",
    "cidade": "Cidade do local",
    "endereco": "Endereço do atendimento",
    "mapa": "Link do mapa do local",
    "contato": "Contato no local",
    "agendamento": "Data e hora agendadas (ex.: 13/11 às 10:00)",
    "hora_agendada": "Só a hora agendada",
    "chegada_prevista": "Previsão de chegada (pela posição ao vivo do técnico)",
    "distancia": "Distância do técnico até o local, agora",
    "agora": "Hora atual",
    "hoje": "Data de hoje",
    "status": "Status da OS",
    "prioridade": "Prioridade (ex.: P2 Alta)",
    "solucao": "Solução registrada ao concluir",
    "motivo_improdutiva": "Motivo da última visita improdutiva",
    "projeto": "Projeto da OS",
    "analista": "Analista responsável pela OS (sem responsável: quem copia o texto)",
    "link_relatorio": (
        "Link do relatório para o cliente (mostra o andamento e, depois de concluída, o resultado; "
        "se a gestão desativou o link, a frase sai do texto)"
    ),
    "prazo_chegada": "Prazo para o técnico chegar (4h nas capitais), ex.: 14:30",
    "hora_chegada": "Hora em que o técnico chegou (início do atendimento; antes disso, a atual)",
    "hora_conclusao": "Hora em que a OS foi concluída (antes disso, a atual)",
}

# Na ordem do atendimento, para o grupo do cliente (como os avisos do Field Control).
DEFAULT_TEMPLATES: list[dict[str, str]] = [
    {
        "key": "agendamento",
        "name": "Atividade confirmada",
        "body": "*{os}* · {cliente}\nAtividade confirmada para {agendamento} em {local}.\n"
        "Técnico: {tecnico}.",
    },
    {
        "key": "deslocamento",
        "name": "Técnico em deslocamento",
        "body": "*{os}* · {cliente}\nO técnico {tecnico} está a caminho de {local}. "
        "Chegada prevista às {chegada_prevista}.",
    },
    {
        "key": "chegada",
        "name": "Técnico chegou",
        "body": "*{os}* · {cliente}\nO técnico {tecnico} chegou em {local} às {hora_chegada} "
        "e iniciou o atendimento.",
    },
    {
        "key": "atraso",
        "name": "Atraso na chegada",
        "body": "*{os}* · {cliente}\nO técnico {tecnico} está a caminho de {local}, com atraso. "
        "Nova previsão de chegada: {chegada_prevista}.",
    },
    {
        "key": "fechamento",
        "name": "Atividade encerrada",
        # O técnico em linha própria: OS concluída no remoto, sem técnico, perde só essa linha.
        "body": "*{os}* · {cliente}\nAtividade encerrada em {local} às {hora_conclusao}.\n"
        "Técnico: {tecnico}.\nRelatório do atendimento: {link_relatorio}",
    },
    {
        "key": "improdutiva",
        "name": "Visita improdutiva",
        "body": "*{os}* · {cliente}\nVisita improdutiva em {local} ({motivo_improdutiva}). "
        "Vamos reagendar e avisamos o novo horário.",
    },
]
_DEFAULT_BODIES = {t["key"]: t["body"] for t in DEFAULT_TEMPLATES}

_VAR = re.compile(r"\{(\w+)\}")
# Fim de frase dentro da linha (o modelo ainda tem as variáveis: nenhuma URL no meio).
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])[ \t]+")


def _slug(name: str) -> str:
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "_", text).strip("_")[:40] or uuid.uuid4().hex[:8]


async def templates(db: AsyncSession) -> list[dict[str, str]]:
    setting = await db.get(SystemSetting, TEMPLATES_KEY)
    return (
        list(setting.value) if setting and setting.value else [dict(t) for t in DEFAULT_TEMPLATES]
    )


async def save_templates(
    db: AsyncSession, items: list[dict[str, str]], actor: User
) -> list[dict[str, str]]:
    clean: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in items:
        name = " ".join((item.get("name") or "").split())
        body = (item.get("body") or "").strip()
        if not name or not body:
            raise WorkflowError("Cada texto precisa de nome e conteúdo")
        key = _slug(item.get("key") or name)
        while key in seen:
            key = f"{key}_{len(seen)}"
        seen.add(key)
        clean.append({"key": key, "name": name[:60], "body": body[:2000]})
    if not clean:
        raise WorkflowError("Mantenha pelo menos um texto")
    setting = await db.get(SystemSetting, TEMPLATES_KEY)
    if setting is None:
        setting = SystemSetting(key=TEMPLATES_KEY)
        db.add(setting)
    setting.value = clean
    setting.updated_by_id = actor.id
    await db.flush()
    return clean


async def reset_templates(db: AsyncSession) -> list[dict[str, str]]:
    setting = await db.get(SystemSetting, TEMPLATES_KEY)
    if setting is not None:
        await db.delete(setting)
        await db.flush()
    return [dict(t) for t in DEFAULT_TEMPLATES]


def _local(value: datetime) -> datetime:
    return value.astimezone(ZoneInfo(settings.TIMEZONE))


async def _eta(db: AsyncSession, ticket: Ticket, now: datetime) -> tuple[str | None, str | None]:
    """(hora prevista de chegada, distância) pela última posição do técnico na jornada aberta,
    com o mesmo tempo de carro do mapa (cidade, estrada)."""
    loc = ticket.location
    if (
        ticket.assignee_id is None
        or loc is None
        or not geo.valid_coords(loc.latitude, loc.longitude)
    ):
        return None, None
    shifts = await tracking.active_shifts(db, [ticket.assignee_id], now)
    ping = (await tracking.latest_pings(db, shifts)).get(ticket.assignee_id)
    if ping is None or ping.recorded_at < now - LIVE_WINDOW:
        return None, None
    road_km = (
        km_between((ping.latitude, ping.longitude), (loc.latitude, loc.longitude)) * ROAD_FACTOR
    )
    minutes = max(MIN_ETA_MINUTES, travel_minutes(road_km))
    return _local(now + timedelta(minutes=minutes)).strftime("%H:%M"), f"{road_km:.0f} km"


async def context(
    db: AsyncSession, ticket: Ticket, actor: User, now: datetime | None = None
) -> dict[str, str]:
    now = now or utcnow()
    loc = ticket.location
    assignee = ticket.assignee
    eta, distance = await _eta(db, ticket, now)
    scheduled = _local(ticket.scheduled_start) if ticket.scheduled_start else None
    if eta is None and scheduled is not None and ticket.scheduled_start > now:
        eta = scheduled.strftime("%H:%M")
    address = ", ".join(
        p
        for p in [
            ticket.service_address,
            loc.address_line if loc else None,
            loc.district if loc else None,
            f"{loc.city}-{loc.state}"
            if loc and loc.city and loc.state
            else (loc.city if loc else None),
        ]
        if p
    )
    if loc and geo.valid_coords(loc.latitude, loc.longitude):
        maps = f"https://maps.google.com/?q={loc.latitude},{loc.longitude}"
    else:
        maps = f"https://maps.google.com/?q={address.replace(' ', '+')}" if address else ""
    contact = " · ".join(
        p
        for p in [
            ticket.requester_name or (loc.contact_name if loc else None),
            ticket.requester_contact or (loc.contact_phone if loc else None),
        ]
        if p
    )
    reason = await db.scalar(
        select(TicketEvent.to_value)
        .where(
            TicketEvent.ticket_id == ticket.id,
            TicketEvent.event_type == TicketEventType.UNPRODUCTIVE_VISIT,
        )
        .order_by(TicketEvent.created_at.desc())
        .limit(1)
    )
    priority = PRIORITY_INFO[ticket.priority]
    local_now = _local(now)
    # Chegada: o início do atendimento atual (ou o primeiro, com a OS já fora de atendimento).
    arrived = ticket.work_started_at or ticket.arrived_at
    team = [p.name for p in ([assignee] if assignee else []) + list(ticket.helpers)]
    values: dict[str, Any] = {
        "tecnico": assignee.name if assignee else NO_TECHNICIAN,
        "equipe": (" e ".join([", ".join(team[:-1]), team[-1]]) if len(team) > 1 else team[0])
        if team
        else NO_TECHNICIAN,
        "tecnico_telefone": (assignee.phone if assignee else None) or "",
        "os": format_ticket_code(ticket.number),
        "titulo": ticket.title,
        "cliente": ticket.customer.name if ticket.customer else "",
        "local": loc.name if loc else (ticket.service_address or "o local"),
        "cidade": (loc.city if loc else None) or "",
        "endereco": address,
        "mapa": maps,
        "contato": contact or "(sem contato)",
        "agendamento": scheduled.strftime("%d/%m às %H:%M") if scheduled else "(a agendar)",
        "hora_agendada": scheduled.strftime("%H:%M") if scheduled else "",
        "chegada_prevista": eta or NO_ETA,
        "distancia": distance or "",
        "agora": local_now.strftime("%H:%M"),
        "hoje": local_now.strftime("%d/%m"),
        "status": STATUS_INFO[ticket.status].label,
        "prioridade": f"{priority['code']} {priority['label']}",
        "solucao": ticket.resolution_notes or "",
        "motivo_improdutiva": reason or "",
        "projeto": ticket.project.name if ticket.project else "",
        "analista": ticket.owner.name if ticket.owner else actor.name,
        "link_relatorio": await client_report.report_url(db, ticket) or NO_REPORT_LINK,
        "prazo_chegada": (
            _local(ticket.arrival_due_at).strftime("%H:%M")
            if ticket.arrival_due_at
            else "(sem prazo)"
        ),
        "hora_chegada": _local(arrived or now).strftime("%H:%M"),
        "hora_conclusao": _local(ticket.resolved_at or now).strftime("%H:%M"),
    }
    return {k: str(v) for k, v in values.items()}


def _without_missing(body: str, missing: set[str]) -> str:
    """O modelo sem as frases que usam uma variável de `missing` (e sem a linha que ficou vazia).
    Ex.: "O técnico {tecnico} está a caminho de {local}. Chegada prevista às {chegada_prevista}."
    sem previsão de chegada fica só "O técnico {tecnico} está a caminho de {local}."."""
    if not missing:
        return body
    lines: list[str] = []
    for line in body.split("\n"):
        kept = [s for s in _SENTENCE_BREAK.split(line) if not missing & set(_VAR.findall(s))]
        if kept or not line.strip():
            lines.append(" ".join(kept))
    return "\n".join(lines)


def render(body: str, ctx: dict[str, str], *, drop_missing: bool = False) -> str:
    """Troca {variavel} pelo valor; variável desconhecida fica como está (o analista vê).

    `drop_missing` (textos padrão, copiados com um clique para o grupo do cliente): a frase com um
    dado que falta (sem previsão de chegada, sem técnico) sai, em vez de levar "__:__" ao cliente.
    """
    if drop_missing:
        body = _without_missing(body, {k for k, v in ctx.items() if v in PLACEHOLDERS})
    text = _VAR.sub(lambda m: ctx.get(m.group(1), m.group(0)), body)
    # Parênteses vazios de variáveis em branco (ex.: cidade não cadastrada).
    return re.sub(r" \(\)", "", text).strip()


def is_default(template: dict[str, str]) -> bool:
    """O texto é o padrão do sistema (mesmo gravado pela gestão sem mudar nada)."""
    return template.get("body") == _DEFAULT_BODIES.get(template.get("key", ""))


async def _unproductive_pending(db: AsyncSession, ticket: Ticket) -> bool:
    """A última ida a campo terminou em visita improdutiva e a OS ainda não foi remarcada."""
    if ticket.last_unproductive_at is None or ticket.scheduled_start is not None:
        return False
    later_visit = await db.scalar(
        select(TicketEvent.id)
        .where(
            TicketEvent.ticket_id == ticket.id,
            TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
            TicketEvent.to_value.in_((S.EN_ROUTE.value, S.IN_PROGRESS.value)),
            TicketEvent.created_at > ticket.last_unproductive_at,
        )
        .limit(1)
    )
    return later_visit is None


async def _trip_start(db: AsyncSession, ticket: Ticket) -> datetime | None:
    """Desde quando vale a ida a campo de agora: o fim da última passagem pelo local (a primeira
    chegada, ou a saída de "Em atendimento": concluída, pausada, improdutiva) ou a última
    reabertura. None: a OS ainda está na primeira ida (nunca chegou nem foi reaberta)."""
    if ticket.arrived_at is None and not ticket.reopen_count:
        return None
    last = await db.scalar(
        select(func.max(TicketEvent.created_at)).where(
            TicketEvent.ticket_id == ticket.id,
            TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
            or_(
                TicketEvent.from_value == S.IN_PROGRESS.value,
                TicketEvent.to_value == S.REOPENED.value,
            ),
        )
    )
    moments = [m for m in (ticket.arrived_at, last) if m is not None]
    return max(moments) if moments else None


def _schedule_for_trip(ticket: Ticket, trip_start: datetime | None) -> datetime | None:
    """A visita marcada para esta ida. A agenda de uma ida anterior (a OS reaberta ou que volta
    ao local sem remarcar guarda a data velha) não vale."""
    start = ticket.scheduled_start
    if start is None or (trip_start is not None and start <= trip_start):
        return None
    return start


async def suggested_keys(db: AsyncSession, ticket: Ticket, now: datetime) -> tuple[str, ...]:
    """Os textos que combinam com a situação da OS agora, do melhor para o substituto (se a
    gestão tirou o modelo "atraso", vale o de deslocamento). Vazio: nenhum combina (cancelada,
    sem técnico ou sem agenda em dia, pausada)."""
    status = ticket.status
    if status == S.CANCELLED:
        return ()
    if status in (S.RESOLVED, S.CLOSED):
        return ("fechamento",)
    if status == S.IN_PROGRESS:
        return ("chegada",)
    if status == S.EN_ROUTE:
        trip_start = await _trip_start(db, ticket)
        if trip_start is None:
            # Primeira ida: o prazo de chegada (o da cidade, ou a visita combinada + tolerância).
            late = ticket.arrival_due_at is not None and ticket.arrival_due_at < now
        else:
            # Revisita ou OS reaberta: o prazo de chegada era o da primeira ida (não muda depois
            # da chegada); vale a visita marcada para esta ida, com a mesma tolerância.
            visit = _schedule_for_trip(ticket, trip_start)
            late = visit is not None and visit + field_rules.SCHEDULE_TOLERANCE < now
        return ("atraso", "deslocamento") if late else ("deslocamento",)
    if await _unproductive_pending(db, ticket):
        return ("improdutiva",)
    if (
        status in BEFORE_FIELD
        and ticket.assignee_id is not None
        and ticket.scheduled_start is not None
        # Agenda de dia que já passou não se confirma (o texto daria uma data vencida).
        and _local(ticket.scheduled_start).date() >= _local(now).date()
        and _schedule_for_trip(ticket, await _trip_start(db, ticket)) is not None
    ):
        return ("agendamento",)
    return ()


async def for_ticket(db: AsyncSession, ticket: Ticket, actor: User) -> list[dict[str, Any]]:
    """Os textos da OS já preenchidos; no máximo um vem com `suggested` (o da situação atual)."""
    now = utcnow()
    ctx = await context(db, ticket, actor, now)
    items = await templates(db)
    keys = [t["key"] for t in items]
    wanted = next((k for k in await suggested_keys(db, ticket, now) if k in keys), None)
    chosen = keys.index(wanted) if wanted is not None else -1
    return [
        {
            "key": t["key"],
            "name": t["name"],
            "text": render(t["body"], ctx, drop_missing=is_default(t)),
            "suggested": index == chosen,
        }
        for index, t in enumerate(items)
    ]
