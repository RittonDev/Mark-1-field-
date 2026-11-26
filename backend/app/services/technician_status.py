"""Situação do técnico na operação (Ativo, Inativo, Bloqueado) e quem recebe OS.

- A situação é da central (Técnicos em Editar), sempre com o motivo, quem mudou e quando, e vai para
  o histórico do cadastro (via central, com o motivo em `note`). O técnico nunca a vê: nada em
  /me/*, nos e-mails nem nas mensagens de erro que chegam ao app.
- Ela é separada do acesso ao app (users.is_active): Inativo e Bloqueado continuam entrando no app
  (histórico, faturamento, nota), a não ser que a central corte o acesso junto (`cut_access`).
  Reativar não devolve o acesso (isso é o "Liberar acesso" de Técnicos).
- Receber OS pede o acesso liberado e a situação Ativo: as sugestões e as ofertas só trazem quem
  pode; a atribuição e os auxiliares conferem só quem entra (`ensure_can_receive`), e a OS que ele
  já tem fica com ele. Sair de Ativo fecha as ofertas em aberto para ele.
- Indisponibilidade (services/unavailability.py, os períodos que o técnico informa no app): tira
  das sugestões e das ofertas nos dias da visita; a atribuição manual não trava (a web avisa).
"""

import uuid
from collections.abc import Iterable
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import AccountTokenPurpose, OperationalStatus, UserRole
from app.db.base import utcnow
from app.models import User
from app.models.user_change import VIA_CENTRAL
from app.schemas import personal
from app.schemas.technician import OperationalStatusIn
from app.services import account, unavailability, user_history
from app.services.errors import CodedError, NotFound, WorkflowError

LABELS: dict[str, str] = {"active": "Ativo", "inactive": "Inativo", "blocked": "Bloqueado"}

NO_ACCESS = "Sem acesso ao app"
# Quem entra numa OS (responsável, auxiliar ou oferta) sem o acesso ao app.
NO_ACCESS_TO_ENTER = "{name} está sem acesso ao app: libere o acesso em Técnicos"
SAME_STATUS = "O técnico já está {label}"
SAME_STATUS_CODE = "OPERATIONAL_STATUS_UNCHANGED"
NOT_RECEIVING = "{name} está {label} e não recebe OS"
UNAVAILABLE = "{name} está indisponível {period}"
# Nota do fechamento das ofertas em aberto quando o técnico sai de Ativo (histórico da OS, só a
# central vê).
OFFERS_CLOSED_NOTE = "Técnico {label} na operação"


def _status(value: Any) -> OperationalStatus:
    """A situação gravada (o padrão é Ativo)."""
    return OperationalStatus(value or OperationalStatus.ACTIVE)


def label(status: Any) -> str:
    """ "Ativo" | "Inativo" | "Bloqueado"."""
    return LABELS[_status(status).value]


def _reason(user: User) -> str:
    return " ".join((user.operational_reason or "").split())


def badge(user: User) -> dict[str, Any]:
    """A situação e o motivo para o selo da central (`operational_status`, `operational_reason`
    = o title): o motivo só fora de Ativo, como no Colaborador (o da reativação não aparece)."""
    status = _status(user.operational_status)
    reason = _reason(user) if status != OperationalStatus.ACTIVE else ""
    return {"operational_status": status, "operational_reason": reason or None}


def receive_block(user: User) -> str | None:
    """Por que o técnico não recebe OS agora, para a central: "Sem acesso ao app", "Inativo:
    {motivo}" ou "Bloqueado: {motivo}"; None quando recebe."""
    if not user.is_active:
        return NO_ACCESS
    status = _status(user.operational_status)
    if status == OperationalStatus.ACTIVE:
        return None
    reason = _reason(user)
    return f"{LABELS[status.value]}: {reason}" if reason else LABELS[status.value]


def ensure_can_receive(user: User) -> None:
    """Técnico Inativo ou Bloqueado não entra numa OS (responsável, auxiliar ou oferta): 422
    "{nome} está inativo e não recebe OS: {motivo}". O acesso ao app cada lugar confere antes
    (NO_ACCESS_TO_ENTER). Quem não é técnico passa."""
    if user.role != UserRole.TECHNICIAN:
        return
    status = _status(user.operational_status)
    if status == OperationalStatus.ACTIVE:
        return
    text = NOT_RECEIVING.format(name=user.name, label=LABELS[status.value].lower())
    reason = _reason(user)
    raise WorkflowError(f"{text}: {reason}" if reason else text)


def today() -> date:
    """Hoje no fuso da operação."""
    return personal.local_today()


def unavailable_between(stored: Iterable[Any] | None, first: date, last: date) -> dict | None:
    """O primeiro período (pelo início) com algum dia entre `first` e `last`, os dois inclusive;
    None sem nenhum."""
    end = last.isoformat()
    return next((p for p in unavailability.current(stored, first) if p["start"] <= end), None)


def unavailable_for_visit(user: User, start: datetime | None, end: datetime | None) -> dict | None:
    """O período de indisponibilidade que toca os dias da visita (sem horário: hoje). Só conta o
    que não acabou (fim >= hoje), os mesmos que a central recebe para avisar: numa visita que já
    passou, o período que terminou antes de hoje não recusa."""
    first, last = unavailability.days_of(start, end)
    return unavailable_between(user.unavailability, max(first, today()), last)


def ensure_available(user: User, start: datetime | None, end: datetime | None) -> None:
    """Para a oferta: indisponível nos dias da visita (sem horário: hoje; a visita que vira a noite
    conta os dois dias) → 422 "{nome} está indisponível de 20/12 a 05/01/2027"."""
    period = unavailable_for_visit(user, start, end)
    if period is not None:
        text = unavailability.period_short(period, today())
        raise WorkflowError(UNAVAILABLE.format(name=user.name, period=text))


async def _locked(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.scalar(
        select(User)
        .where(User.id == user_id, User.role == UserRole.TECHNICIAN)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None:
        raise NotFound("Técnico não encontrado")
    return user


def _same(status: OperationalStatus) -> CodedError:
    return CodedError(SAME_STATUS.format(label=LABELS[status.value].lower()), SAME_STATUS_CODE, 409)


async def apply(
    db: AsyncSession, user_id: uuid.UUID, data: OperationalStatusIn, actor: User
) -> tuple[User, list[dict[str, Any]]]:
    """Muda a situação (sem commit; a rota grava com `commit_and_publish` e depois avisa com
    `user_history.publish_changed`). Devolve o técnico e as mudanças do histórico.

    A mesma situação: 409. Para Inativo ou Bloqueado, as ofertas em aberto para ele fecham antes de
    a linha dele travar (a ordem do aceite: as OS, depois o técnico); `cut_access` (só fora de
    Ativo e com o acesso liberado) corta também o acesso: sai do app na hora e os links de senha
    deixam de valer."""
    from app.services import tickets  # tickets usa este módulo: import tardio

    current = await db.get(User, user_id)
    if current is None or current.role != UserRole.TECHNICIAN:
        raise NotFound("Técnico não encontrado")
    status = _status(data.status)
    if _status(current.operational_status) == status:
        raise _same(status)
    if status != OperationalStatus.ACTIVE:
        note = OFFERS_CLOSED_NOTE.format(label=LABELS[status.value].lower())
        await tickets.close_technician_offers(db, user_id, actor, note=note)
    user = await _locked(db, user_id)
    if _status(user.operational_status) == status:  # mudou enquanto esperava a trava
        raise _same(status)
    before = await user_history.snapshot(db, user)
    now = utcnow()
    user.operational_status = status
    user.operational_reason = data.reason
    user.operational_changed_at = now
    user.operational_changed_by_id = actor.id
    if status != OperationalStatus.ACTIVE and data.cut_access and user.is_active:
        user.is_active = False
        user.sessions_revoked_at = now
        await account.revoke(db, user_id=user.id, purpose=AccountTokenPurpose.RESET_PASSWORD)
    await db.flush()
    changes = await user_history.track(
        db, user, before, via=VIA_CENTRAL, actor=actor, note=data.reason
    )
    return user, changes


async def change(
    db: AsyncSession, user_id: uuid.UUID, data: OperationalStatusIn, actor: User
) -> User:
    """`apply` sem as mudanças do histórico (sem commit)."""
    user, _ = await apply(db, user_id, data, actor)
    return user
