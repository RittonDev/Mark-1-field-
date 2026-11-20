"""Histórico de atendimentos do técnico (app, aba Perfil; GET /me/history).

As OS concluídas em que o técnico atuou: o atendimento das Estatísticas
(technician_levels.attended_clause: resolvida ou fechada, com visita, e ele é hoje o responsável ou
vai junto), por isso a lista e o total do Perfil sempre batem. Das mais recentes para as mais
antigas (resolved_at, id), no recorte de campo: código, serviço, loja, cidade e data. Nunca vêm
cliente, endereço, contato, valores, etiquetas, SLA, analista, solicitante nem descrição.

Paginação por chave com um cursor opaco (base64url sem "=" de "{resolved_at ISO com fuso}|{id}"):
a OS concluída enquanto o técnico rola não repete nem empurra itens nas páginas seguintes. O total
vem só na primeira página; cada página traz o total de cada mês que aparece nela (as seções da
lista). Só leitura: nada é gravado e não há evento.
"""

import base64
import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, Uuid, func, literal, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Location, ServiceType, Ticket, User
from app.schemas.my_history import HistoryItem, HistoryMonthCount, MyHistoryPage
from app.schemas.ticket import format_ticket_code
from app.services.errors import WorkflowError
from app.services.technician_levels import attended_clause, month_key

HISTORY_PAGE = 30
HISTORY_PAGE_MAX = 50
# O cursor que a rota aceita (o nosso tem uns 90 caracteres).
CURSOR_MAX = 200
CURSOR_ERROR = "Página do histórico inválida. Puxe a lista para recarregar."


def encode_cursor(at: datetime, ticket_id: uuid.UUID) -> str:
    """A posição depois da OS (`at` com fuso, como vem do banco)."""
    raw = f"{at.isoformat()}|{ticket_id}".encode()
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    """O contrário de encode_cursor, com a data em UTC. Cursor estragado (base64, separador, data
    sem fuso ou fora da faixa, id): 422 com CURSOR_ERROR. Fora da faixa é a data que não cabe em
    UTC (o ano 1 com +14:00, o 9999 com -14:00): sem a conversão aqui, o banco falhava (500)."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = base64.b64decode(padded, altchars=b"-_", validate=True).decode("utf-8")
        at_text, id_text = raw.split("|")
        parsed = datetime.fromisoformat(at_text)
        ticket_id = uuid.UUID(id_text)
        # Sem fuso a conversão usaria o do servidor: fica None e vira erro logo abaixo.
        at = parsed.astimezone(UTC) if parsed.tzinfo is not None else None
    # binascii.Error e UnicodeError são ValueError; a data fora da faixa é OverflowError.
    except (ValueError, OverflowError) as exc:
        raise WorkflowError(CURSOR_ERROR) from exc
    if at is None:
        raise WorkflowError(CURSOR_ERROR)
    return at, ticket_id


async def history_page(
    db: AsyncSession, user: User, *, limit: int = HISTORY_PAGE, cursor: str | None = None
) -> MyHistoryPage:
    """Uma página do histórico do técnico (no máximo 3 idas ao banco: a página, o total na
    primeira e a contagem dos meses dela)."""
    limit = max(1, min(limit, HISTORY_PAGE_MAX))
    after = decode_cursor(cursor) if cursor else None
    attended = attended_clause(user.id)
    month = month_key(Ticket.resolved_at)
    stmt = (
        select(
            Ticket.id,
            Ticket.number,
            Ticket.title,
            Ticket.resolved_at,
            Ticket.assignee_id,
            Ticket.legacy.is_not(None).label("legacy"),
            ServiceType.name.label("service"),
            Location.code.label("location_code"),
            Location.name.label("location_name"),
            Location.city,
            Location.state,
            month.label("month"),
        )
        .select_from(Ticket)
        .outerjoin(ServiceType, ServiceType.id == Ticket.service_type_id)
        .outerjoin(Location, Location.id == Ticket.location_id)
        .where(attended)
        .order_by(Ticket.resolved_at.desc(), Ticket.id.desc())
        .limit(limit + 1)
    )
    if after is not None:
        at, ticket_id = after
        stmt = stmt.where(
            tuple_(Ticket.resolved_at, Ticket.id)
            < tuple_(literal(at, DateTime(timezone=True)), literal(ticket_id, Uuid()))
        )
    rows = (await db.execute(stmt)).all()
    more = len(rows) > limit
    rows = rows[:limit]

    total = None
    if after is None:
        total = await db.scalar(select(func.count()).select_from(Ticket).where(attended)) or 0
    # Os meses da página, na ordem da lista (do mais novo para o mais antigo), com o total de
    # cada um inteiro (também a parte que fica para a próxima página).
    keys = list(dict.fromkeys(row.month for row in rows))
    per_month: dict[str, int] = {}
    if keys:
        per_month = {
            key: count
            for key, count in (
                await db.execute(
                    select(month, func.count())
                    .select_from(Ticket)
                    .where(attended, month.in_(keys))
                    .group_by(month)
                )
            ).all()
        }
    last = rows[-1] if rows else None
    return MyHistoryPage(
        items=[
            HistoryItem(
                id=row.id,
                code=format_ticket_code(row.number),
                service=row.service or row.title,
                location_code=row.location_code,
                location_name=row.location_name,
                city=row.city,
                state=row.state,
                resolved_at=row.resolved_at,
                month=row.month,
                role="assignee" if row.assignee_id == user.id else "helper",
                legacy=row.legacy,
            )
            for row in rows
        ],
        next_cursor=(
            encode_cursor(last.resolved_at, last.id) if more and last is not None else None
        ),
        total=total,
        months=[HistoryMonthCount(month=key, count=per_month.get(key, 0)) for key in keys],
    )
