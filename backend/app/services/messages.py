"""Textos prontos da OS para o grupo de WhatsApp dos técnicos.

A gestão mantém os modelos (com variáveis entre chaves, ex.: {tecnico}); a API preenche com os
dados da OS na hora. Ex.: "Técnico {tecnico} em deslocamento para {local}, chega às
{chegada_prevista}" vira "Técnico Carlos Souza em deslocamento para Loja 27, chega às 14:35".
A previsão de chegada usa a posição ao vivo do técnico (rastreamento) quando há.
"""

import re
import unicodedata
import uuid
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import AuthorizationStatus, TicketEventType
from app.db.base import utcnow
from app.models import LocationPing, SystemSetting, TechnicianShift, Ticket, TicketEvent, User
from app.schemas.ticket import format_ticket_code
from app.services import client_report, geo
from app.services.errors import WorkflowError
from app.services.suggestions import km_between
from app.services.workflow import PRIORITY_INFO, STATUS_INFO

TEMPLATES_KEY = "messages.templates"
URBAN_KMH = 25.0  # velocidade média urbana para a previsão de chegada
ROAD_FACTOR = 1.3  # distância em linha reta -> pelas ruas
LIVE_WINDOW = timedelta(minutes=30)

VARIABLES: dict[str, str] = {
    "tecnico": "Nome do técnico responsável",
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
    "link_relatorio": "Link do relatório para o cliente (OS concluída)",
    "prazo_chegada": "Prazo para o técnico chegar (4h nas capitais), ex.: 14:30",
    "autorizado_por": "Quem autorizou a visita pelo cliente",
}

DEFAULT_TEMPLATES: list[dict[str, str]] = [
    {
        "key": "deslocamento",
        "name": "Deslocamento",
        "body": "*{os}* · {cliente}\nTécnico {tecnico} em deslocamento para {local} ({cidade}). "
        "Chegada prevista às {chegada_prevista} (prazo {prazo_chegada}).",
    },
    {
        "key": "chegada",
        "name": "Chegada",
        "body": "*{os}* · {cliente}\nTécnico {tecnico} chegou em {local} às {agora} "
        "e iniciou o atendimento.",
    },
    {
        "key": "atraso",
        "name": "Atraso",
        "body": "*{os}* · {cliente}\nTécnico {tecnico} está a caminho de {local} com atraso. "
        "Nova previsão de chegada: {chegada_prevista}.",
    },
    {
        "key": "agendamento",
        "name": "Agendamento",
        "body": "*{os}* · {cliente}\nVisita agendada para {agendamento} em {local}, {endereco}.\n"
        "Técnico: {tecnico}. Contato no local: {contato}.",
    },
    {
        "key": "fechamento",
        "name": "Fechamento",
        "body": "*{os}* · {cliente}\nAtendimento concluído por {tecnico} em {local} às {agora}.\n"
        "Solução: {solucao}\nRelatório: {link_relatorio}",
    },
    {
        "key": "improdutiva",
        "name": "Visita improdutiva",
        "body": "*{os}* · {cliente}\nVisita improdutiva em {local}: {motivo_improdutiva}. "
        "Vamos reagendar e avisamos o novo horário.",
    },
]

_VAR = re.compile(r"\{(\w+)\}")


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
    """(hora prevista de chegada, distância) pela última posição do técnico em jornada."""
    loc = ticket.location
    if (
        ticket.assignee_id is None
        or loc is None
        or not geo.valid_coords(loc.latitude, loc.longitude)
    ):
        return None, None
    on_shift = await db.scalar(
        select(TechnicianShift.id).where(
            TechnicianShift.user_id == ticket.assignee_id, TechnicianShift.ended_at.is_(None)
        )
    )
    if on_shift is None:
        return None, None
    ping = await db.scalar(
        select(LocationPing)
        .where(
            LocationPing.user_id == ticket.assignee_id,
            LocationPing.recorded_at >= now - LIVE_WINDOW,
        )
        .order_by(LocationPing.recorded_at.desc())
        .limit(1)
    )
    if ping is None:
        return None, None
    km = km_between((ping.latitude, ping.longitude), (loc.latitude, loc.longitude)) * ROAD_FACTOR
    minutes = max(5, round(km / URBAN_KMH * 60))
    return _local(now + timedelta(minutes=minutes)).strftime("%H:%M"), f"{km:.0f} km"


async def context(db: AsyncSession, ticket: Ticket, actor: User) -> dict[str, str]:
    now = utcnow()
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
    values: dict[str, Any] = {
        "tecnico": assignee.name if assignee else "(técnico a definir)",
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
        "chegada_prevista": eta or "__:__",
        "distancia": distance or "",
        "agora": local_now.strftime("%H:%M"),
        "hoje": local_now.strftime("%d/%m"),
        "status": STATUS_INFO[ticket.status].label,
        "prioridade": f"{priority['code']} {priority['label']}",
        "solucao": ticket.resolution_notes or "",
        "motivo_improdutiva": reason or "",
        "projeto": ticket.project.name if ticket.project else "",
        "analista": ticket.owner.name if ticket.owner else actor.name,
        "link_relatorio": await client_report.url_if_finished(db, ticket)
        or "(disponível quando a OS for concluída)",
        "prazo_chegada": (
            _local(ticket.arrival_due_at).strftime("%H:%M")
            if ticket.arrival_due_at
            else "(sem prazo)"
        ),
        "autorizado_por": ticket.authorized_by_name
        or (
            "(não exigida)"
            if ticket.authorization_status == AuthorizationStatus.NOT_REQUIRED
            else "(aguardando autorização)"
        ),
    }
    return {k: str(v) for k, v in values.items()}


def render(body: str, ctx: dict[str, str]) -> str:
    """Troca {variavel} pelo valor; variável desconhecida fica como está (o analista vê)."""
    text = _VAR.sub(lambda m: ctx.get(m.group(1), m.group(0)), body)
    # Parênteses vazios de variáveis em branco (ex.: cidade não cadastrada).
    return re.sub(r" \(\)", "", text).strip()


async def for_ticket(db: AsyncSession, ticket: Ticket, actor: User) -> list[dict[str, str]]:
    ctx = await context(db, ticket, actor)
    return [
        {"key": t["key"], "name": t["name"], "text": render(t["body"], ctx)}
        for t in await templates(db)
    ]
