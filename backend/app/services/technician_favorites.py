"""Técnicos favoritos por cidade: a regra automática e as decisões da central.

Automático (calculado na hora, nada gravado): até 3 por cidade, entre quem mais atendeu nas lojas
da cidade nos últimos 365 dias, com pelo menos 2 OS. Atendimento é o mesmo de "Base em X (N OS)"
(technician_regions.footprint): responsável ou outro técnico da visita numa OS não cancelada que
teve chegada ou foi concluída, ou quem apontou trabalho; conta 1 por técnico e OS. Desempate:
quem tem acesso ao app, depois a visita mais recente, depois o nome. Os inativos (parceiros do
Field Control sem acesso ao app) entram no ranking; só não recebem OS nem aparecem nas sugestões.

Manual (tabela technician_favorites): a central fixa qualquer técnico na cidade (até 10, com
nota) ou tira um automático, e aí o próximo sobe. Favorito efetivo = fixado ou automático.

A cidade é a da LOJA, com a UF: (UF em maiúsculas, cidade sem acento), a mesma chave das cidades
padronizadas. Loja sem UF ou sem cidade fica fora.
"""

import logging
import re
import uuid
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import delete, func, select, text, tuple_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import UserRole
from app.db.base import utcnow
from app.models import Location, Ticket, User
from app.models.technician_favorite import FavoriteKind, TechnicianFavorite
from app.schemas.common import Ref
from app.schemas.technician_favorite import NOTE_MAX as NOTE_MAX  # o FavoriteSet confere
from app.schemas.technician_favorite import (
    FavoriteCity,
    FavoriteCityDetail,
    FavoriteSet,
    FavoritesOut,
    FavoriteTechnician,
)
from app.services import technician_regions, technicians
from app.services.errors import NotFound, WorkflowError
from app.services.technician_regions import fold_text
from app.services.workflow import OPEN_STATUSES

log = logging.getLogger(__name__)

WINDOW = timedelta(days=365)
MIN_VISITS = 2
TOP = 3
MAX_PINNED_PER_CITY = 10
SUGGESTION_POINTS = 25
OTHERS_LIMIT = 10

_UF = re.compile(r"^[A-Z]{2}$")
CityKey = tuple[str, str]  # (UF, cidade sem acento)


# ------------------------------------------------------------------ ranking (sem banco)


@dataclass(frozen=True)
class Visit:
    """OS de um técnico nas lojas de uma cidade, dentro da janela."""

    user_id: uuid.UUID
    name: str
    is_active: bool
    visits: int
    last_visit_at: datetime | None


def _rank_key(v: Visit) -> tuple:
    recent = -v.last_visit_at.timestamp() if v.last_visit_at is not None else float("inf")
    return (-v.visits, not v.is_active, recent, fold_text(v.name), str(v.user_id))


def rank_city(
    rows: Iterable[Visit], hidden: frozenset[uuid.UUID] = frozenset()
) -> tuple[list[Visit], list[uuid.UUID]]:
    """Ranking completo da cidade (mais OS, acesso ao app, visita mais recente, nome) e os
    automáticos: os 3 primeiros com pelo menos 2 OS que a central não tirou da lista."""
    ranked = sorted(rows, key=_rank_key)
    automatic = [v.user_id for v in ranked if v.visits >= MIN_VISITS and v.user_id not in hidden]
    return ranked, automatic[:TOP]


# ------------------------------------------------------------------ consultas


@dataclass
class _City:
    state: str
    key: str
    city: str  # a grafia de Location.city mais usada na chave
    stores: int = 0  # lojas ativas
    visits: int = 0  # OS distintas na janela (uma OS com 2 técnicos conta 1)
    rows: list[Visit] = field(default_factory=list)


def _key(state: str | None, city: str | None) -> CityKey | None:
    """(UF, cidade sem acento) de uma grafia; None sem UF ou sem cidade."""
    uf, city_key = (state or "").strip().upper(), fold_text(city)
    return (uf, city_key) if uf and city_key else None


def _place(state: str | None, city: str | None) -> CityKey:
    uf = (state or "").strip().upper()
    if not _UF.match(uf):
        raise WorkflowError("UF inválida")
    key = fold_text(city)
    if not key:
        raise WorkflowError("Informe a cidade")
    return uf, key


async def _cities(
    db: AsyncSession,
    now: datetime,
    *,
    state: str | None = None,
    key: str | None = None,
    with_visits: bool = True,
) -> dict[CityKey, _City]:
    """As cidades com loja (todas, as da UF ou só a pedida), com as visitas de cada técnico na
    janela. O banco devolve as grafias e a chave sai de _key (fold_text): a mesma dos pedidos e
    das decisões gravadas, sem depender de o banco tirar o acento do mesmo jeito."""

    def wanted(place: CityKey) -> bool:
        return (not state or place[0] == state) and (not key or place[1] == key)

    uf_col = func.upper(func.trim(Location.state))
    stores = (
        select(Location.state, Location.city, func.count().filter(Location.is_active), func.count())
        .where(Location.state.is_not(None), Location.city.is_not(None))
        .group_by(Location.state, Location.city)
    )
    if state:
        stores = stores.where(uf_col == state)
    out: dict[CityKey, _City] = {}
    spellings: dict[CityKey, Counter[str]] = {}
    written: list[tuple[str, str]] = []  # (UF, cidade) como estão nas lojas das cidades pedidas
    for raw_state, raw_city, active, total in (await db.execute(stores)).all():
        place = _key(raw_state, raw_city)
        if place is None or not wanted(place):
            continue
        out.setdefault(place, _City(state=place[0], key=place[1], city="")).stores += active
        spellings.setdefault(place, Counter())[raw_city.strip()] += total
        written.append((raw_state, raw_city))
    for place, counts in spellings.items():
        # A grafia mais usada nas lojas (no empate, a primeira em ordem alfabética).
        out[place].city = min(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    if not out or not with_visits:
        return out

    # Visitas: uma passada só, com o total de OS distintas de cada grafia no mesmo GROUP BY. A OS
    # é de uma loja só, então somar as grafias da mesma cidade não conta OS duas vezes. Uma cidade
    # só (a da loja da OS, a do detalhe, a de uma decisão): só as lojas dela, pelas grafias, em vez
    # de montar as visitas de todas as lojas e filtrar depois.
    city_stores = (
        select(Location.id).where(tuple_(Location.state, Location.city).in_(written))
        if key
        else None
    )
    fp = technician_regions.footprint(now - WINDOW, until=now, location_ids=city_stores)
    visited = (
        select(
            Location.state,
            Location.city,
            fp.c.user_id,
            fp.c.ticket_id,
            fp.c.at,
            User.name,
            User.is_active,
        )
        .select_from(fp)
        .join(Location, Location.id == fp.c.location_id)
        .join(User, User.id == fp.c.user_id)
        .where(
            User.role == UserRole.TECHNICIAN,
            Location.state.is_not(None),
            Location.city.is_not(None),
        )
    )
    if state:
        visited = visited.where(uf_col == state)
    v = visited.subquery("city_visits")
    rows = await db.execute(
        select(
            v.c.state,
            v.c.city,
            v.c.user_id,
            v.c.name,
            v.c.is_active,
            func.count(v.c.ticket_id.distinct()),
            func.max(v.c.at),
        ).group_by(
            func.grouping_sets(
                tuple_(v.c.state, v.c.city, v.c.user_id, v.c.name, v.c.is_active),
                tuple_(v.c.state, v.c.city),
            )
        )
    )
    merged: dict[tuple[CityKey, uuid.UUID], Visit] = {}
    for raw_state, raw_city, user_id, name, is_active, count, last_at in rows.all():
        place = _key(raw_state, raw_city)
        city = out.get(place) if place is not None else None
        if place is None or city is None:
            continue
        if user_id is None:  # total da grafia
            city.visits += count
            continue
        before = merged.get((place, user_id))
        if before is not None:  # a mesma cidade escrita de outro jeito
            count += before.visits
            last_at = max((d for d in (last_at, before.last_visit_at) if d), default=None)
        merged[(place, user_id)] = Visit(user_id, name, is_active, count, last_at)
    for (place, _), visit in merged.items():
        out[place].rows.append(visit)
    return out


@dataclass(frozen=True)
class _Decision:
    kind: FavoriteKind
    note: str | None
    updated_by_id: uuid.UUID | None
    updated_at: datetime


async def _decisions(
    db: AsyncSession, *, state: str | None = None, key: str | None = None
) -> dict[CityKey, dict[uuid.UUID, _Decision]]:
    stmt = (
        select(
            TechnicianFavorite.state,
            TechnicianFavorite.city_key,
            TechnicianFavorite.user_id,
            TechnicianFavorite.kind,
            TechnicianFavorite.note,
            TechnicianFavorite.updated_by_id,
            TechnicianFavorite.updated_at,
        )
        .join(User, User.id == TechnicianFavorite.user_id)
        # Quem deixou de ser técnico sai das contagens (a decisão volta a valer se ele voltar).
        .where(User.role == UserRole.TECHNICIAN)
    )
    if state:
        stmt = stmt.where(TechnicianFavorite.state == state)
    if key:
        stmt = stmt.where(TechnicianFavorite.city_key == key)
    out: dict[CityKey, dict[uuid.UUID, _Decision]] = {}
    for uf, city_key, user_id, kind, note, by, at in (await db.execute(stmt)).all():
        out.setdefault((uf, city_key), {})[user_id] = _Decision(kind, note, by, at)
    return out


async def _city_state(
    db: AsyncSession,
    uf: str,
    key: str,
    now: datetime | None = None,
    *,
    with_visits: bool = True,
) -> tuple[_City | None, dict[uuid.UUID, _Decision]]:
    cities = await _cities(db, now or utcnow(), state=uf, key=key, with_visits=with_visits)
    decisions = (await _decisions(db, state=uf, key=key)).get((uf, key), {})
    return cities.get((uf, key)), decisions


# ------------------------------------------------------------------ favorito efetivo


@dataclass
class _Board:
    """Quem é quem numa cidade: fixados, automáticos, tirados e os outros que atenderam."""

    city: _City
    decisions: dict[uuid.UUID, _Decision]
    pinned: list[uuid.UUID]
    automatic: list[uuid.UUID]  # na ordem do ranking
    hidden: list[uuid.UUID]
    others: list[uuid.UUID]  # na ordem do ranking
    rank: dict[uuid.UUID, int]
    visit: dict[uuid.UUID, Visit]

    def is_favorite(self, user_id: uuid.UUID) -> bool:
        return user_id in self.pinned or user_id in self.automatic


def _board(city: _City, decisions: dict[uuid.UUID, _Decision]) -> _Board:
    hidden = {uid for uid, d in decisions.items() if d.kind == FavoriteKind.HIDE}
    pinned = [uid for uid, d in decisions.items() if d.kind == FavoriteKind.INCLUDE]
    ranked, automatic = rank_city(city.rows, frozenset(hidden))
    favorites = set(pinned) | set(automatic)
    return _Board(
        city=city,
        decisions=decisions,
        pinned=pinned,
        automatic=automatic,
        hidden=list(hidden),
        others=[
            v.user_id for v in ranked if v.user_id not in favorites and v.user_id not in hidden
        ],
        rank={v.user_id: i for i, v in enumerate(ranked, start=1)},
        visit={v.user_id: v for v in ranked},
    )


@dataclass
class _People:
    users: dict[uuid.UUID, User]
    open_tickets: dict[uuid.UUID, int]
    on_shift: set[uuid.UUID]


async def _people(db: AsyncSession, ids: set[uuid.UUID], setters: set[uuid.UUID]) -> _People:
    """Cadastro, OS em aberto e jornada dos técnicos envolvidos (e o nome de quem decidiu)."""
    everyone = ids | setters
    if not everyone:
        return _People({}, {}, set())
    users = {u.id: u for u in await db.scalars(select(User).where(User.id.in_(everyone)))}
    open_tickets: dict[uuid.UUID, int] = {}
    on_shift: set[uuid.UUID] = set()
    if ids:
        rows = await db.execute(
            select(Ticket.assignee_id, func.count())
            .where(Ticket.assignee_id.in_(ids), Ticket.status.in_(OPEN_STATUSES))
            .group_by(Ticket.assignee_id)
        )
        open_tickets = {user_id: n for user_id, n in rows.all()}
        from app.services import tracking  # tracking usa tickets, que usa as sugestões

        on_shift = set(await tracking.active_shifts(db, ids))
    return _People(users, open_tickets, on_shift)


def _setters(boards: Iterable[_Board]) -> set[uuid.UUID]:
    return {
        d.updated_by_id for b in boards for d in b.decisions.values() if d.updated_by_id is not None
    }


def _technician(board: _Board, user: User, people: _People) -> FavoriteTechnician:
    decision = board.decisions.get(user.id)
    visit = board.visit.get(user.id)
    setter = (
        people.users.get(decision.updated_by_id)
        if decision is not None and decision.updated_by_id
        else None
    )
    return FavoriteTechnician(
        id=user.id,
        name=user.name,
        email=user.email,
        phone=user.phone,
        avatar_url=technicians.avatar_url(user),
        is_active=user.is_active,
        on_shift=user.id in people.on_shift,
        open_tickets=people.open_tickets.get(user.id, 0),
        base_city=user.base_city,
        base_state=user.base_state,
        visits=visit.visits if visit else 0,
        last_visit_at=visit.last_visit_at if visit else None,
        rank=board.rank.get(user.id),
        automatic=user.id in board.automatic,
        pinned=decision is not None and decision.kind == FavoriteKind.INCLUDE,
        hidden=decision is not None and decision.kind == FavoriteKind.HIDE,
        note=decision.note if decision else None,
        set_by=Ref(id=setter.id, name=setter.name) if setter else None,
        set_at=decision.updated_at if decision else None,
    )


def _technicians(
    board: _Board, ids: Iterable[uuid.UUID], people: _People
) -> list[FavoriteTechnician]:
    out = []
    for uid in ids:
        user = people.users.get(uid)
        if user is not None and user.role == UserRole.TECHNICIAN:
            out.append(_technician(board, user, people))
    return out


def _favorite_ids(board: _Board, people: _People) -> list[uuid.UUID]:
    """Primeiro os fixados (mais OS, depois o nome), depois os automáticos pelo ranking."""

    def pinned_order(uid: uuid.UUID) -> tuple:
        visit = board.visit.get(uid)
        user = people.users.get(uid)
        return (-(visit.visits if visit else 0), fold_text(user.name if user else ""), str(uid))

    pinned = sorted(board.pinned, key=pinned_order)
    return pinned + [uid for uid in board.automatic if uid not in board.pinned]


def _hidden_ids(board: _Board, people: _People) -> list[uuid.UUID]:
    def order(uid: uuid.UUID) -> tuple:
        user = people.users.get(uid)
        rank = board.rank.get(uid)
        return (rank is None, rank or 0, fold_text(user.name if user else ""), str(uid))

    return sorted(board.hidden, key=order)


def _city_out(board: _Board, people: _People) -> dict[str, Any]:
    city = board.city
    return {
        "state": city.state,
        "city": city.city,
        "key": city.key,
        "stores": city.stores,
        "visits": city.visits,
        "favorites": _technicians(board, _favorite_ids(board, people), people),
        "hidden_count": len(board.hidden),
        "others_count": len(board.others),
    }


# ------------------------------------------------------------------ leitura


async def list_cities(
    db: AsyncSession,
    *,
    state: str | None = None,
    technician_id: uuid.UUID | None = None,
    now: datetime | None = None,
) -> FavoritesOut:
    """Todas as cidades com loja (também as sem favorito), por OS na janela, UF e cidade. Com
    `technician_id`, só as cidades em que ele é favorito ou foi tirado da lista."""
    uf = (state or "").strip().upper() or None
    cities = await _cities(db, now or utcnow(), state=uf)
    decisions = await _decisions(db, state=uf)
    boards = [_board(c, decisions.get(k, {})) for k, c in cities.items()]
    if technician_id is not None:
        boards = [b for b in boards if b.is_favorite(technician_id) or technician_id in b.hidden]
    ids = {uid for b in boards for uid in (*b.pinned, *b.automatic)}
    people = await _people(db, ids, _setters(boards))
    boards.sort(key=lambda b: (-b.city.visits, b.city.state, fold_text(b.city.city)))
    return FavoritesOut(
        window_days=WINDOW.days,
        min_visits=MIN_VISITS,
        top=TOP,
        max_pinned=MAX_PINNED_PER_CITY,
        cities=[FavoriteCity(**_city_out(b, people)) for b in boards],
    )


async def city_detail(
    db: AsyncSession, state: str | None, city: str | None, now: datetime | None = None
) -> FavoriteCityDetail:
    """Uma cidade: favoritos, tirados da lista e até 10 outros que atenderam na janela."""
    uf, key = _place(state, city)
    found, decisions = await _city_state(db, uf, key, now)
    if found is None:
        raise NotFound(f"Nenhuma loja em {(city or '').strip()}-{uf}")
    board = _board(found, decisions)
    others = board.others[:OTHERS_LIMIT]
    ids = {*board.pinned, *board.automatic, *board.hidden, *others}
    people = await _people(db, ids, _setters([board]))
    return FavoriteCityDetail(
        **_city_out(board, people),
        hidden=_technicians(board, _hidden_ids(board, people), people),
        others=_technicians(board, others, people),
    )


async def resolve_location(db: AsyncSession, location_id: uuid.UUID) -> CityKey:
    """(UF, cidade sem acento) da loja."""
    loc = await db.get(Location, location_id)
    if loc is None:
        raise NotFound("Loja não encontrada")
    uf = (loc.state or "").strip().upper()
    key = fold_text(loc.city)
    if not uf or not key:
        raise WorkflowError("A loja não tem cidade e UF")
    return uf, key


@dataclass(frozen=True)
class FavoriteMark:
    """Favorito na cidade da loja, para as sugestões da OS."""

    kind: Literal["auto", "manual"]  # manual = fixado pela central
    note: str | None
    label: str  # "Santos-SP"


async def marks_for_place(
    db: AsyncSession, state: str | None, city: str | None, now: datetime | None = None
) -> dict[uuid.UUID, FavoriteMark]:
    """Os favoritos efetivos da cidade (ativos ou não), com a nota e o rótulo "Cidade-UF"."""
    uf = (state or "").strip().upper()
    key = fold_text(city)
    if not uf or not key:
        return {}
    found, decisions = await _city_state(db, uf, key, now)
    if found is None:
        return {}
    board = _board(found, decisions)
    label = f"{found.city}-{uf}"
    marks: dict[uuid.UUID, FavoriteMark] = {}
    for uid in (*board.pinned, *board.automatic):
        decision = decisions.get(uid)
        manual = decision is not None and decision.kind == FavoriteKind.INCLUDE
        marks[uid] = FavoriteMark(
            kind="manual" if manual else "auto",
            note=decision.note if decision else None,
            label=label,
        )
    return marks


# ------------------------------------------------------------------ decisões da central


async def _save(
    db: AsyncSession,
    user_id: uuid.UUID,
    city: _City,
    kind: FavoriteKind,
    note: str | None,
    actor: User,
) -> None:
    """Grava a decisão (cria ou troca a que existe); a nota do pedido substitui a gravada."""
    now = utcnow()
    stmt = pg_insert(TechnicianFavorite).values(
        id=uuid.uuid4(),
        state=city.state,
        city_key=city.key,
        city=city.city,
        user_id=user_id,
        kind=kind,
        note=note,
        created_by_id=actor.id,
        updated_by_id=actor.id,
        created_at=now,
        updated_at=now,
    )
    await db.execute(
        stmt.on_conflict_do_update(
            constraint="uq_technician_favorites_city_tech",
            set_={
                "kind": stmt.excluded.kind,
                "note": stmt.excluded.note,
                "city": stmt.excluded.city,
                "updated_by_id": stmt.excluded.updated_by_id,
                "updated_at": stmt.excluded.updated_at,
            },
        )
    )


async def _delete(db: AsyncSession, user_id: uuid.UUID, uf: str, key: str, actor: User) -> None:
    result = await db.execute(
        delete(TechnicianFavorite).where(
            TechnicianFavorite.state == uf,
            TechnicianFavorite.city_key == key,
            TechnicianFavorite.user_id == user_id,
        )
    )
    if result.rowcount:
        log.info(
            "Favorito por cidade desfeito: técnico %s em %s/%s, por %s", user_id, key, uf, actor.id
        )


async def _lock_city(db: AsyncSession, uf: str, key: str) -> None:
    """Uma decisão por vez em cada cidade, até o fim da transação: o limite de fixados é conferido
    lendo as decisões antes de gravar, e dois pedidos juntos passariam de MAX_PINNED_PER_CITY."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"technician-favorites:{uf}:{key}"},
    )


async def set_favorite(
    db: AsyncSession, technician_id: uuid.UUID, data: FavoriteSet, actor: User
) -> None:
    """favorite=true fixa o técnico na cidade (um tirado vira fixado). favorite=false: tirado só
    troca a nota; automático agora vira tirado (o próximo sobe); fora disso, apaga a decisão."""
    tech = await technicians.get_technician(db, technician_id)
    uf, key = _place(data.state, data.city)
    await _lock_city(db, uf, key)
    # O ranking só importa para tirar: fixar não mexe nos automáticos.
    city, decisions = await _city_state(db, uf, key, with_visits=not data.favorite)
    if city is None:
        raise NotFound(f"Nenhuma loja em {data.city}-{uf}")
    mine = decisions.get(tech.id)
    if data.favorite:
        pinned = sum(
            1 for uid, d in decisions.items() if d.kind == FavoriteKind.INCLUDE and uid != tech.id
        )
        if pinned >= MAX_PINNED_PER_CITY:
            raise WorkflowError(f"Até {MAX_PINNED_PER_CITY} técnicos fixados por cidade")
        await _save(db, tech.id, city, FavoriteKind.INCLUDE, data.note, actor)
        return
    hidden = mine is not None and mine.kind == FavoriteKind.HIDE
    # hide: o Desfazer de um tirado grava tirado mesmo fora do top 3 (a decisão não se perde).
    if data.hide or hidden or tech.id in _board(city, decisions).automatic:
        await _save(db, tech.id, city, FavoriteKind.HIDE, data.note, actor)
    elif mine is not None:
        await _delete(db, tech.id, uf, key, actor)


async def clear_favorite(
    db: AsyncSession, technician_id: uuid.UUID, state: str, city: str, actor: User
) -> None:
    """Apaga a decisão (fixado ou tirado): volta a valer só a regra. Sem decisão, não faz nada."""
    tech = await technicians.get_technician(db, technician_id)
    uf, key = _place(state, city)
    found, _ = await _city_state(db, uf, key, with_visits=False)
    if found is None:
        raise NotFound(f"Nenhuma loja em {city.strip()}-{uf}")
    await _delete(db, tech.id, uf, key, actor)
