"""Projetos: cadastro e o acompanhamento (OS, custos extras, orçamentos aprovados)."""

import uuid
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions
from app.core.enums import ExpenseStatus, PayoutStatus, ProjectStatus, QuoteStatus, TicketStatus
from app.models import Customer, Project, Quote, Team, Ticket, TicketExpense, TicketPayout, User
from app.schemas.project import ProjectIn, ProjectOut, ProjectStats
from app.services.errors import NotFound, WorkflowError
from app.services.tickets import visibility_clause
from app.services.workflow import OPEN_STATUSES

DONE = (TicketStatus.RESOLVED, TicketStatus.CLOSED)


async def get(db: AsyncSession, project_id: uuid.UUID) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise NotFound("Projeto não encontrado")
    return project


async def _check(db: AsyncSession, data: ProjectIn) -> None:
    if data.customer_id and await db.get(Customer, data.customer_id) is None:
        raise WorkflowError("Cliente não encontrado")
    if data.team_id and await db.get(Team, data.team_id) is None:
        raise WorkflowError("Grupo não encontrado")
    if data.manager_id and await db.get(User, data.manager_id) is None:
        raise WorkflowError("Responsável não encontrado")
    if data.start_date and data.end_date and data.end_date < data.start_date:
        raise WorkflowError("O fim do projeto deve ser depois do início")


def _values(data: ProjectIn) -> dict:
    values = data.model_dump()
    values["name"] = data.name.strip()
    values["member_ids"] = [str(m) for m in data.member_ids]
    return values


async def create(db: AsyncSession, data: ProjectIn, actor: User) -> Project:
    await _check(db, data)
    project = Project(id=uuid.uuid4(), created_by_id=actor.id, **_values(data))
    db.add(project)
    await db.flush()
    await db.refresh(project, ["number", "customer", "manager", "team"])
    return project


async def update(db: AsyncSession, project: Project, data: ProjectIn) -> Project:
    await _check(db, data)
    for key, value in _values(data).items():
        setattr(project, key, value)
    await db.flush()
    await db.refresh(project, ["customer", "manager", "team"])
    return project


def _shown(viewer: User | None) -> dict[str, bool]:
    """Que valores a pessoa vê. A lista de projetos é de toda a gestão (o seletor da Nova OS
    usa), então o valor do contrato só sai com a tela de Projetos, e cada total também pede a
    tela dele (como os blocos comerciais do detalhe da OS). Sem `viewer`: tudo."""
    acc = permissions.of(viewer) if viewer is not None else permissions.FULL_ACCESS
    see = acc.can("commercial.projects")
    return {
        "contract": see,
        "expenses_total": see and acc.can("commercial.expenses"),
        "payouts_total": see and acc.can("commercial.payouts"),
        "quotes_approved_total": see and acc.can("commercial.quotes"),
    }


async def stats(
    db: AsyncSession, ids: list[uuid.UUID], viewer: User | None = None
) -> dict[uuid.UUID, ProjectStats]:
    """Números de cada projeto. Com `viewer`, só as OS da fila que ele vê, e os totais em
    dinheiro só das telas que ele tem (sem a tela, o total fica 0 e nem é calculado)."""
    out = {i: ProjectStats() for i in ids}
    if not ids:
        return out
    shown = _shown(viewer)
    vis = visibility_clause(viewer) if viewer is not None else None
    scope = (vis,) if vis is not None else ()
    for pid, total, open_, done, cancelled, unproductive in await db.execute(
        select(
            Ticket.project_id,
            func.count(),
            func.count().filter(Ticket.status.in_(OPEN_STATUSES)),
            func.count().filter(Ticket.status.in_(DONE)),
            func.count().filter(Ticket.status == TicketStatus.CANCELLED),
            func.coalesce(func.sum(Ticket.unproductive_count), 0),
        )
        .where(Ticket.project_id.in_(ids), *scope)
        .group_by(Ticket.project_id)
    ):
        s = out[pid]
        s.tickets_total, s.tickets_open, s.tickets_done = total, open_, done
        s.tickets_cancelled, s.unproductive = cancelled, unproductive
    if shown["expenses_total"]:
        for pid, total in await db.execute(
            select(Ticket.project_id, func.sum(TicketExpense.total))
            .join(Ticket, Ticket.id == TicketExpense.ticket_id)
            .where(
                Ticket.project_id.in_(ids), TicketExpense.status != ExpenseStatus.REJECTED, *scope
            )
            .group_by(Ticket.project_id)
        ):
            out[pid].expenses_total = total or Decimal("0")
    # Valor dos técnicos: o pago e o que ainda vai ser pago (pendente de OS cancelada não conta,
    # como em Pagamentos).
    if shown["payouts_total"]:
        for pid, total in await db.execute(
            select(Ticket.project_id, func.sum(TicketPayout.amount))
            .join(Ticket, Ticket.id == TicketPayout.ticket_id)
            .where(
                Ticket.project_id.in_(ids),
                or_(
                    TicketPayout.status == PayoutStatus.PAID,
                    Ticket.status != TicketStatus.CANCELLED,
                ),
                *scope,
            )
            .group_by(Ticket.project_id)
        ):
            out[pid].payouts_total = total or Decimal("0")
    # Aprovado de OS cancelada não conta (não vai ser cobrado), como em Pagamentos.
    if shown["quotes_approved_total"]:
        for pid, total in await db.execute(
            select(Ticket.project_id, func.sum(Quote.total))
            .join(Ticket, Ticket.id == Quote.ticket_id)
            .where(
                Ticket.project_id.in_(ids),
                Quote.status == QuoteStatus.APPROVED,
                Ticket.status != TicketStatus.CANCELLED,
                *scope,
            )
            .group_by(Ticket.project_id)
        ):
            out[pid].quotes_approved_total = total or Decimal("0")
    return out


async def to_out(
    db: AsyncSession, projects: list[Project], viewer: User | None = None
) -> list[ProjectOut]:
    numbers = await stats(db, [p.id for p in projects], viewer)
    shown = _shown(viewer)
    # A margem desconta os custos extras e os valores dos técnicos: sem uma das duas telas, não
    # sai (seria o contrato inteiro). Com "Somente a própria fila" também não: os totais são só
    # das OS da fila da pessoa, e o contrato é do projeto inteiro.
    with_margin = (
        shown["expenses_total"]
        and shown["payouts_total"]
        and (viewer is None or permissions.of(viewer).all_queues)
    )
    member_ids = {uuid.UUID(m) for p in projects for m in (p.member_ids or [])}
    names = {}
    if member_ids:
        names = {
            u.id: u.name for u in await db.scalars(select(User).where(User.id.in_(member_ids)))
        }
    ref = lambda o: {"id": o.id, "name": o.name} if o else None  # noqa: E731
    out = []
    for p in projects:
        s = numbers[p.id]
        contract = p.contract_value if shown["contract"] else None
        margin = None
        if contract is not None and with_margin:
            margin = float(contract - s.expenses_total - s.payouts_total)
        out.append(
            ProjectOut(
                id=p.id,
                number=p.number,
                name=p.name,
                customer=ref(p.customer),
                description=p.description,
                status=p.status,
                start_date=p.start_date,
                end_date=p.end_date,
                contract_value=contract,
                pricing_notes=p.pricing_notes if shown["contract"] else None,
                manager=ref(p.manager),
                team=ref(p.team),
                members=[
                    {"id": uuid.UUID(m), "name": names[uuid.UUID(m)]}
                    for m in (p.member_ids or [])
                    if uuid.UUID(m) in names
                ],
                stats=s,
                margin=margin,
                created_at=p.created_at,
            )
        )
    return out


async def list_projects(
    db: AsyncSession,
    status: ProjectStatus | None,
    q: str | None,
    customer_id: uuid.UUID | None,
    viewer: User | None = None,
) -> list[ProjectOut]:
    stmt = select(Project).order_by(Project.number.desc())
    if status is not None:
        stmt = stmt.where(Project.status == status)
    if customer_id is not None:
        stmt = stmt.where(Project.customer_id == customer_id)
    if q:
        term = f"%{q.strip()}%"
        stmt = stmt.where(or_(Project.name.ilike(term), Project.description.ilike(term)))
    return await to_out(db, list(await db.scalars(stmt.limit(500))), viewer)
