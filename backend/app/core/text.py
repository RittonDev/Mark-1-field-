"""Texto como se grava e como se compara (puro: só unicodedata).

- `visible`: sem os caracteres das categorias Cc (controles: U+0000, ...) e Cf (formatação: espaço
  de largura zero, BOM, marcas de direção como U+202E); tab, LF, VT, FF e CR viram espaço.
- `fold`: a chave de comparação dos nomes, sem acento e sem maiúsculas ("Multímetro" =
  " multimetro "): é o `name_key` dos catálogos de Configurações › Técnicos (models/catalog.py).
- `clean`: o texto que se grava (NFC, espaços colapsados).

Os mesmos do app (cleanText e foldName em lib/techProfileForm.ts). A migração c8f2a4e6b0d3 tem uma
cópia (tests/test_gestao_migration.py confere).
"""

import unicodedata

# Os únicos controles que viram espaço (os outros saem do texto).
_SPACE_CONTROLS = frozenset("\t\n\v\f\r")


def visible(text: str) -> str:
    """Sem controles (Cc) nem formatação (Cf); tab, LF, VT, FF e CR viram espaço."""
    return "".join(
        " " if ch in _SPACE_CONTROLS else ch
        for ch in text
        if ch in _SPACE_CONTROLS or unicodedata.category(ch) not in ("Cc", "Cf")
    )


def fold(text: str | None) -> str:
    """Sem controles nem formatação (`visible`), NFKD sem marcas, casefold, espaços colapsados
    (comparar nomes sem acento e sem maiúsculas; a ligadura "ﬁ" vira "fi"). None: ""."""
    decomposed = unicodedata.normalize("NFKD", visible(text or ""))
    plain = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(plain.casefold().split())


def clean(text: str | None) -> str:
    """Sem controles nem formatação (`visible`, antes do NFC: o acento separado da letra por um
    invisível volta a ser uma letra só), NFC e espaços colapsados nas pontas e no meio (o que se
    grava). None: ""."""
    return " ".join(unicodedata.normalize("NFC", visible(text or "")).split())
