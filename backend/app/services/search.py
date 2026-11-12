"""Busca por palavras (lojas, clientes, técnicos).

"Le Biscuit Iguatemi Fortaleza" acha "Le Biscuit - Shopping Iguatemi Fortaleza": cada palavra
precisa aparecer em algum dos campos, em qualquer ordem, sem diferença de acento ou maiúscula.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from sqlalchemy import ColumnElement, and_, case, func, or_

from app.services.technician_regions import fold_sql, fold_text

_WORD = re.compile(r"[a-z0-9]+")
MAX_WORDS = 8


def words(q: str | None) -> list[str]:
    """Palavras da busca, sem acento e em minúsculas (pontuação separa: CNPJ com pontos vira pedaços)."""
    return _WORD.findall(fold_text(q))[:MAX_WORDS]


def all_words(
    q: str | None,
    columns: Sequence[ColumnElement],
    digit_columns: Sequence[ColumnElement] = (),
) -> ColumnElement | None:
    """Condição: toda palavra casa com pelo menos uma coluna (texto dobrado ou só dígitos)."""
    terms = words(q)
    if not terms:
        return None
    folded = [fold_sql(func.coalesce(c, "")) for c in columns]
    digits_only = [
        func.regexp_replace(func.lower(func.coalesce(c, "")), r"[^0-9a-z]", "", "g")
        for c in digit_columns
    ]
    conds = []
    for term in terms:
        options = [col.like(f"%{term}%") for col in folded]
        if any(ch.isdigit() for ch in term):
            options += [col.like(f"%{term}%") for col in digits_only]
        conds.append(or_(*options))
    return and_(*conds)


def rank(
    q: str | None,
    name: ColumnElement,
    exact: Sequence[ColumnElement] = (),
) -> ColumnElement:
    """Ordem de relevância: código/documento exato, nome que começa com a busca, com a 1ª palavra."""
    terms = words(q)
    text = " ".join(terms)
    first = terms[0] if terms else ""
    compact = "".join(terms)
    folded_name = fold_sql(func.coalesce(name, ""))
    whens = []
    if compact:
        for col in exact:
            whens.append(
                (
                    func.regexp_replace(func.lower(func.coalesce(col, "")), r"[^0-9a-z]", "", "g")
                    == compact,
                    0,
                )
            )
    if text:
        whens.append((folded_name.like(f"{text}%"), 1))
    if first:
        whens.append((folded_name.like(f"{first}%"), 2))
    if not whens:
        return case((name.is_(None), 3), else_=3)
    return case(*whens, else_=3)
