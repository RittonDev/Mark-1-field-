"""Um só jeito de escrever cada cidade, por UF.

O Field Control trouxe a mesma cidade de vários jeitos ("FORTALEZA" e "Fortaleza",
"SAO BERNARDO DO CAMPO" e "São Bernardo do Campo"). Para cada (UF, cidade sem acento e sem
diferença de maiúscula) fica a grafia mais usada entre as de nome próprio com acento; sem
nenhuma assim, o título pt-BR ("de", "da", "do", "das", "dos" e "e" em minúsculas) da mais
usada, preferindo a acentuada (ver `canonical`). Vale para lojas, matriz dos clientes e a
cidade de casa e de atuação dos técnicos.

Uso avulso: python -m app.services.cities
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections import Counter, defaultdict
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Customer, Location, User
from app.services.technician_regions import fold_text

log = logging.getLogger(__name__)

CONNECTORS = frozenset({"de", "da", "do", "das", "dos", "e"})

# (modelo, coluna da cidade, coluna da UF): todos os lugares onde guardamos cidade.
CITY_COLUMNS: tuple[tuple[Any, str, str], ...] = (
    (Location, "city", "state"),
    (Customer, "city", "state"),
    (User, "home_city", "home_state"),
    (User, "base_city", "base_state"),
)


# Partícula minúscula grudada na palavra: "d'Oeste", "del-Rei".
_PARTICLE = re.compile(r"^(?:d'|del-)")


def _cap(part: str) -> str:
    return part[:1].upper() + part[1:]


def title_pt(name: str) -> str:
    """Título pt-BR: "SAO BERNARDO DO CAMPO" -> "Sao Bernardo do Campo"; "D'OESTE" -> "d'Oeste"."""
    out: list[str] = []
    for index, word in enumerate(name.split()):
        low = word.lower()
        particle = _PARTICLE.match(low) if index > 0 else None
        if index > 0 and low in CONNECTORS:
            out.append(low)
        elif particle and len(low) > particle.end():
            out.append(particle.group(0) + _cap(low[particle.end() :]))
        else:
            out.append("-".join(_cap(seg) for seg in low.split("-")))
    return " ".join(out)


def _proper(name: str) -> bool:
    """Grafia de nome próprio: iniciais maiúsculas, resto minúsculo, conectores minúsculos."""
    if not any(c.islower() for c in name):
        return False
    for index, word in enumerate(name.split()):
        if index > 0 and word.lower() in CONNECTORS:
            if word != word.lower():
                return False
            continue
        letters = [c for c in _PARTICLE.sub("", word) if c.isalpha()]
        if not letters:
            continue
        if not letters[0].isupper() or (len(letters) > 1 and all(c.isupper() for c in letters)):
            return False
    return True


def _accented(name: str) -> bool:
    return any(ord(c) > 127 for c in name)


def _most_used(pool: Counter[str]) -> str:
    return max(pool.items(), key=lambda kv: (kv[1], kv[0]))[0]


def canonical(variants: Counter[str]) -> str:
    """A grafia escolhida para um grupo de variantes da mesma cidade (com as contagens).

    1. a mais usada com grafia de nome próprio e acento;
    2. sem ela, a mais usada com acento, em título pt-BR ("SÃO PAULO" -> "São Paulo");
    3. sem acento em nenhuma, a mais usada com grafia de nome próprio;
    4. senão, a mais usada em título pt-BR.
    """
    proper = Counter({v: n for v, n in variants.items() if _proper(v)})
    proper_accented = Counter({v: n for v, n in proper.items() if _accented(v)})
    if proper_accented:
        return _most_used(proper_accented)
    accented = Counter({v: n for v, n in variants.items() if _accented(v)})
    if accented:
        return title_pt(_most_used(accented))
    if proper:
        return _most_used(proper)
    return title_pt(_most_used(variants))


async def normalize_all(db: AsyncSession) -> dict[str, int]:
    """Reescreve as cidades com a grafia canônica; devolve quantos registros mudaram por campo."""
    # Por (UF, cidade dobrada): grafias (espaços normalizados) e os valores exatos gravados.
    spellings: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    raw_values: dict[tuple[str, str], set[str]] = defaultdict(set)
    for model, city_col, state_col in CITY_COLUMNS:
        city, state = getattr(model, city_col), getattr(model, state_col)
        rows = await db.execute(select(state, city).where(city.is_not(None)))
        for uf, name in rows:
            spaced = " ".join((name or "").split())
            if not spaced:
                continue
            key = (uf or "", fold_text(spaced))
            spellings[key][spaced] += 1
            raw_values[key].add(name)
    changed: Counter[str] = Counter()
    for key, variants in spellings.items():
        uf = key[0]
        target = canonical(variants)
        stale = [value for value in raw_values[key] if value != target]
        if not stale:
            continue
        for model, city_col, state_col in CITY_COLUMNS:
            city, state = getattr(model, city_col), getattr(model, state_col)
            state_cond = state.is_(None) if uf == "" else state == uf
            result = await db.execute(
                update(model)
                .where(state_cond, city.in_(stale))
                .values({city_col: target})
                .execution_options(synchronize_session=False)
            )
            if result.rowcount:
                changed[f"{model.__tablename__}.{city_col}"] += result.rowcount
    return dict(changed)


async def _main() -> None:
    from app.db.session import SessionLocal
    from app.services import technician_regions

    async with SessionLocal() as db:
        changed = await normalize_all(db)
        bases = await technician_regions.refresh_bases(db)
        await db.commit()
    log.info("Cidades padronizadas: %s · bases: %s", changed, bases)
    print({"cities_changed": changed, "bases": bases})


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_main())
