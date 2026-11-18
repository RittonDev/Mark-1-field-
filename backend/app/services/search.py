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
# As variantes de cada letra sem acento (as mesmas que fold_words_sql troca).
_ACCENTS = {
    "a": "aáàâãäAÁÀÂÃÄ",
    "e": "eéèêëEÉÈÊË",
    "i": "iíìîïIÍÌÎÏ",
    "o": "oóòôõöOÓÒÔÕÖ",
    "u": "uúùûüUÚÙÛÜ",
    "c": "cçCÇ",
    "n": "nñNÑ",
}


def words(q: str | None) -> list[str]:
    """Palavras da busca, sem acento e em minúsculas (pontuação separa as palavras)."""
    return _WORD.findall(fold_text(q))[:MAX_WORDS]


def accent_regex(word: str) -> str:
    """ "relicario" -> expressão regular que casa "Relicário" (as palavras da busca só têm
    [a-z0-9]). Com o ~* do banco (sem diferença de maiúscula), dá o mesmo que
    fold_words_sql(coluna) LIKE '%palavra%', cerca de 10x mais rápido nas descrições longas:
    traduzir letra a letra 15 mil descrições leva quase 1 s por palavra."""
    return "".join(f"[{_ACCENTS[ch]}]" if ch in _ACCENTS else ch for ch in word)


def has_word(column: ColumnElement, word: str) -> ColumnElement[bool]:
    """A palavra (de words) aparece na coluna, sem diferença de acento ou maiúscula."""
    return column.regexp_match(accent_regex(word), flags="i")


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
    """Relevância: código/documento exato, nome começando pela busca, pela 1ª palavra."""
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
