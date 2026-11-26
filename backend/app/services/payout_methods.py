"""Formas de recebimento do técnico parceiro (pago por chamado): chaves PIX e contas bancárias.

- Quem cadastra e muda é o técnico, no app (services/my_profile.py confere a senha antes, com o mesmo
  contador da troca de senha, e fecha tudo com a senha provisória); a central vê e remove em
  Pagamentos (GET/DELETE /technicians/{id}/payout-methods), com histórico via "central".
- Com a lista não vazia, sempre uma é a preferencial (onde a central paga): a 1ª nasce preferencial;
  `preferred` ou "Tornar preferencial" movem (preferred_since na nova, null na antiga); excluir a
  preferencial promove a mais nova das que ficam. O índice único parcial segura duas preferenciais
  numa gravação simultânea (a troca desmarca a antiga e grava antes de marcar a nova).
- Repetida: o mesmo tipo e a mesma chave (normalizada), ou o mesmo banco, agência, conta (sem os
  zeros à esquerda) e dígito. Até METHODS_MAX.
- `changed_at`: a última troca do destino (chave, conta, tipo de conta ou titular). Com
  `preferred_since`, dá o "Nova" da central (destination_changed_at).
- "Titular diferente" (`holder_differs`): com o documento do titular e o técnico com CPF ou CNPJ, o
  documento não é nenhum dos dois; sem isso, o nome do titular (sem acento e maiúsculas) não é o
  nome, a razão social nem o nome fantasia do técnico.

Tudo aqui roda na transação de quem chama (sem commit) e espera a linha do técnico já travada
(SELECT ... FOR UPDATE): as rotas do app travam em services/my_profile.py; a central, em
`remove_by_central`. O histórico e o aviso são de quem chama (user_history.snapshot antes,
`track` depois).
"""

import uuid
from collections.abc import Iterable, Sequence
from datetime import datetime
from typing import Any, Protocol

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import PayoutMethodKind, UserRole
from app.db.base import utcnow
from app.models import TechnicianPayoutMethod, User
from app.models.user_change import VIA_CENTRAL
from app.schemas.my_profile import PixInfo
from app.schemas.payout_method import (
    METHODS_MAX,
    PayoutMethodAdmin,
    PayoutMethodIn,
    PayoutMethodOut,
    PayoutMethodSummary,
)
from app.services import tech_profile, user_history
from app.services.errors import CodedError, NotFound

DUPLICATE = "PAYOUT_METHOD_DUPLICATE"
LIMIT = "PAYOUT_METHODS_LIMIT"
NOT_FOUND = "PAYOUT_METHOD_NOT_FOUND"
KIND_LOCKED = "PAYOUT_METHOD_KIND_LOCKED"
DUPLICATE_PIX = "Esta chave PIX já está na lista"
DUPLICATE_BANK = "Esta conta já está na lista"
LIMIT_TEXT = f"Limite de {METHODS_MAX} formas de recebimento. Exclua uma para incluir outra"
NOT_FOUND_TEXT = "Esta forma de recebimento não existe mais. Atualize a lista"
KIND_LOCKED_TEXT = "Para mudar o tipo, exclua e cadastre de novo"
TECHNICIAN_NOT_FOUND = "Técnico não encontrado"

# O destino do pagamento: mudar um destes grava changed_at (o nome do banco é só o rótulo).
_DESTINATION = (
    "pix_key_type",
    "pix_key",
    "bank_code",
    "branch",
    "account_number",
    "account_digit",
    "account_type",
    "holder_name",
    "holder_document",
)


class Owner(Protocol):
    """O que "Titular diferente" compara: o usuário ou uma linha com os mesmos campos."""

    name: str
    cpf: str | None
    company_document: str | None
    company_name: str | None
    company_trade_name: str | None


# ------------------------------------------------------------------ leitura


def _order_key(method: TechnicianPayoutMethod) -> tuple[Any, ...]:
    return (not method.preferred, -method.created_at.timestamp(), str(method.id))


def ordered(methods: Iterable[TechnicianPayoutMethod]) -> list[TechnicianPayoutMethod]:
    """A preferencial primeiro, depois as mais novas."""
    return sorted(methods, key=_order_key)


async def list_for(db: AsyncSession, user_id: uuid.UUID) -> list[TechnicianPayoutMethod]:
    """As formas do técnico, a preferencial primeiro, depois as mais novas."""
    rows = await db.scalars(
        select(TechnicianPayoutMethod).where(TechnicianPayoutMethod.user_id == user_id)
    )
    return ordered(rows)


def find(methods: Sequence[TechnicianPayoutMethod], method_id: uuid.UUID) -> TechnicianPayoutMethod:
    """A forma da lista do técnico; outra pessoa ou excluída: 404 PAYOUT_METHOD_NOT_FOUND."""
    method = next((m for m in methods if m.id == method_id), None)
    if method is None:
        raise CodedError(NOT_FOUND_TEXT, NOT_FOUND, 404)
    return method


def preferred_of(methods: Iterable[TechnicianPayoutMethod]) -> TechnicianPayoutMethod | None:
    return next((m for m in methods if m.preferred), None)


def destination_changed_at(method: TechnicianPayoutMethod) -> datetime:
    """Quando o destino do pagamento mudou: a troca da chave/conta/titular ou a escolha como
    preferencial, o que vier depois."""
    since = method.preferred_since
    return max(method.changed_at, since) if since is not None else method.changed_at


def holder_differs(method: Any, owner: Owner) -> bool:
    """O titular não é o técnico nem a empresa dele (a central confere antes de pagar)."""
    documents = {d for d in (owner.cpf, owner.company_document) if d}
    document = getattr(method, "holder_document", None)
    if document and documents:
        return document not in documents
    names = {
        tech_profile.fold(name)
        for name in (owner.name, owner.company_name, owner.company_trade_name)
        if name
    }
    return tech_profile.fold(getattr(method, "holder_name", None) or "") not in names


def to_out(method: TechnicianPayoutMethod) -> PayoutMethodOut:
    return PayoutMethodOut.model_validate(method)


def to_admin(method: TechnicianPayoutMethod, owner: Owner) -> PayoutMethodAdmin:
    return PayoutMethodAdmin.model_validate(
        {
            **PayoutMethodOut.model_validate(method).model_dump(),
            "holder_differs": holder_differs(method, owner),
            "destination_changed_at": destination_changed_at(method),
        }
    )


def pix_info(methods: Iterable[TechnicianPayoutMethod]) -> PixInfo | None:
    """MyProfile.pix (o app de antes): a preferencial quando ela é PIX."""
    method = preferred_of(methods)
    if method is None or method.kind != PayoutMethodKind.PIX or not method.pix_key_type:
        return None
    return PixInfo(
        key_type=method.pix_key_type,
        key=method.pix_key or "",
        holder_name=method.holder_name,
        updated_at=method.changed_at,
    )


async def counts(
    db: AsyncSession, user_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, tuple[int, datetime | None]]:
    """Para a lista de técnicos: (quantas formas, quando o destino da preferencial mudou) de cada
    id pedido; sem forma, (0, None)."""
    ids = {i for i in user_ids if i is not None}
    if not ids:
        return {}
    m = TechnicianPayoutMethod
    destination = func.greatest(m.changed_at, func.coalesce(m.preferred_since, m.changed_at))
    rows = await db.execute(
        select(m.user_id, func.count(), func.max(case((m.preferred, destination))))
        .where(m.user_id.in_(ids))
        .group_by(m.user_id)
    )
    out: dict[uuid.UUID, tuple[int, datetime | None]] = dict.fromkeys(ids, (0, None))
    for user_id, total, changed in rows:
        out[user_id] = (int(total), changed)
    return out


async def _owners(db: AsyncSession, user_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, Any]:
    rows = await db.execute(
        select(
            User.id,
            User.name,
            User.cpf,
            User.company_document,
            User.company_name,
            User.company_trade_name,
        ).where(User.id.in_(set(user_ids)))
    )
    return {row.id: row for row in rows}


async def summary_map(
    db: AsyncSession, user_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, PayoutMethodSummary]:
    """Pagamentos (GET /payouts?with_payout_methods=true): a preferencial (inteira, quem paga
    copia) e quantas formas cada técnico tem. Sem forma, fora do mapa."""
    ids = {i for i in user_ids if i is not None}
    if not ids:
        return {}
    preferred = list(
        await db.scalars(
            select(TechnicianPayoutMethod).where(
                TechnicianPayoutMethod.user_id.in_(ids), TechnicianPayoutMethod.preferred
            )
        )
    )
    if not preferred:
        return {}
    totals = await counts(db, [m.user_id for m in preferred])
    owners = await _owners(db, [m.user_id for m in preferred])
    return {
        m.user_id: PayoutMethodSummary(
            preferred=to_admin(m, owners[m.user_id]), total=totals[m.user_id][0]
        )
        for m in preferred
        if m.user_id in owners
    }


# ------------------------------------------------------------------ regras da gravação


def _account_key(values: Any) -> tuple[Any, ...]:
    def get(name: str) -> Any:
        return values.get(name) if isinstance(values, dict) else getattr(values, name, None)

    number = (get("account_number") or "").lstrip("0") or "0"
    return (get("bank_code"), get("branch"), number, get("account_digit"))


def _same_destination(method: TechnicianPayoutMethod, values: dict[str, Any]) -> bool:
    if str(method.kind) != str(values["kind"]):
        return False
    if values["kind"] == PayoutMethodKind.PIX:
        return (str(method.pix_key_type), method.pix_key) == (
            str(values["pix_key_type"]),
            values["pix_key"],
        )
    return _account_key(method) == _account_key(values)


def check(
    methods: Sequence[TechnicianPayoutMethod],
    data: PayoutMethodIn,
    *,
    editing: TechnicianPayoutMethod | None = None,
) -> None:
    """Antes de gravar: o limite (só ao incluir) e a repetida (409 PAYOUT_METHOD_DUPLICATE)."""
    if editing is None and len(methods) >= METHODS_MAX:
        raise CodedError(LIMIT_TEXT, LIMIT, 422)
    values = data.values()
    for method in methods:
        if method is not editing and _same_destination(method, values):
            text = DUPLICATE_PIX if values["kind"] == PayoutMethodKind.PIX else DUPLICATE_BANK
            raise CodedError(text, DUPLICATE, 409)


async def _unset_preferred(db: AsyncSession, methods: Iterable[TechnicianPayoutMethod]) -> None:
    """Desmarca a preferencial e grava já: o índice único não aceita duas no meio do flush."""
    changed = False
    for method in methods:
        if method.preferred:
            method.preferred = False
            method.preferred_since = None
            changed = True
    if changed:
        await db.flush()


async def add(
    db: AsyncSession,
    user: User,
    data: PayoutMethodIn,
    methods: Sequence[TechnicianPayoutMethod],
    *,
    preferred: bool,
) -> TechnicianPayoutMethod:
    """Inclui a forma (já conferida por `check`). A 1ª é a preferencial; com outras, `preferred`
    a torna a preferencial."""
    now = utcnow()
    make_preferred = preferred or preferred_of(methods) is None
    if make_preferred:
        await _unset_preferred(db, methods)
    row = TechnicianPayoutMethod(
        id=uuid.uuid4(),
        user_id=user.id,
        **data.values(),
        preferred=make_preferred,
        preferred_since=now if make_preferred else None,
        changed_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.flush()
    return row


def ensure_same_kind(method: TechnicianPayoutMethod, data: PayoutMethodIn) -> None:
    """PUT não muda o tipo: 422 "Para mudar o tipo, exclua e cadastre de novo"."""
    if str(method.kind) != str(data.kind):
        raise CodedError(KIND_LOCKED_TEXT, KIND_LOCKED, 422)


async def edit(db: AsyncSession, method: TechnicianPayoutMethod, data: PayoutMethodIn) -> bool:
    """Grava os campos novos (já conferidos por `check` e `ensure_same_kind`); mudou o destino,
    `changed_at` é agora. Devolve se algo mudou."""
    values = data.values()
    changed = [key for key, value in values.items() if getattr(method, key) != value]
    if not changed:
        return False
    for key in changed:
        setattr(method, key, values[key])
    if any(key in _DESTINATION for key in changed):
        method.changed_at = utcnow()
    await db.flush()
    return True


async def make_preferred(
    db: AsyncSession, method: TechnicianPayoutMethod, methods: Sequence[TechnicianPayoutMethod]
) -> bool:
    """Esta passa a ser a preferencial (preferred_since agora). Já era: nada (False)."""
    if method.preferred:
        return False
    await _unset_preferred(db, methods)
    method.preferred = True
    method.preferred_since = utcnow()
    await db.flush()
    return True


async def delete(
    db: AsyncSession, method: TechnicianPayoutMethod, methods: Sequence[TechnicianPayoutMethod]
) -> TechnicianPayoutMethod | None:
    """Exclui a forma. Era a preferencial e sobram outras: a mais nova das que ficam vira a
    preferencial (devolvida)."""
    was_preferred = method.preferred
    await db.delete(method)
    await db.flush()
    if not was_preferred:
        return None
    remaining = [m for m in methods if m.id != method.id]
    if not remaining:
        return None
    newest = max(remaining, key=lambda m: (m.created_at, str(m.id)))
    newest.preferred = True
    newest.preferred_since = utcnow()
    await db.flush()
    return newest


# ------------------------------------------------------------------ central (Pagamentos)


async def technician(db: AsyncSession, user_id: uuid.UUID, *, lock: bool = False) -> User:
    """O técnico (404 "Técnico não encontrado" para outro papel ou id que não existe)."""
    stmt = select(User).where(User.id == user_id, User.role == UserRole.TECHNICIAN)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    user = await db.scalar(stmt)
    if user is None:
        raise NotFound(TECHNICIAN_NOT_FOUND)
    return user


async def admin_list(db: AsyncSession, user_id: uuid.UUID) -> list[PayoutMethodAdmin]:
    """GET /technicians/{id}/payout-methods: as formas com "Titular diferente" e o "Nova"."""
    user = await technician(db, user_id)
    return [to_admin(m, user) for m in await list_for(db, user.id)]


async def remove_by_central(
    db: AsyncSession, user_id: uuid.UUID, method_id: uuid.UUID, actor: User
) -> tuple[User, list[dict[str, Any]]]:
    """DELETE /technicians/{id}/payout-methods/{method_id}: a central remove (chave errada ou
    suspeita) com a mesma regra da preferencial e histórico via "central". Devolve o técnico e as
    mudanças (o commit e o aviso são da rota). Forma que não existe: 404 PAYOUT_METHOD_NOT_FOUND."""
    user = await technician(db, user_id, lock=True)
    methods = await list_for(db, user.id)
    method = find(methods, method_id)
    before = await user_history.snapshot(db, user)
    await delete(db, method, methods)
    changes = await user_history.track(db, user, before, via=VIA_CENTRAL, actor=actor)
    return user, changes
