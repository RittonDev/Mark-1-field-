"""CPF e CNPJ: normalização e validação dos dígitos verificadores.

Aceita o CNPJ alfanumérico (Receita Federal, a partir de julho de 2026): as 12 primeiras
posições podem ter letras; os 2 dígitos verificadores continuam numéricos. O cálculo usa o
valor ASCII - 48 de cada caractere, o que mantém o resultado igual para CNPJ só com números.
Guardamos sem pontuação e em maiúsculas.
"""

import re

_CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
_CNPJ_W2 = [6, *_CNPJ_W1]


def _clean(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z]", "", value).upper()


def _cnpj_digit(chars: str, weights: list[int]) -> int:
    total = sum((ord(c) - 48) * w for c, w in zip(chars, weights, strict=True))
    rest = total % 11
    return 0 if rest < 2 else 11 - rest


def cnpj_with_check_digits(base12: str) -> str:
    """Completa uma raiz de 12 caracteres com os dígitos verificadores (seed e testes)."""
    base = _clean(base12)
    first = _cnpj_digit(base, _CNPJ_W1)
    second = _cnpj_digit(base + str(first), _CNPJ_W2)
    return f"{base}{first}{second}"


def is_valid_cnpj(value: str) -> bool:
    d = _clean(value)
    if not re.fullmatch(r"[0-9A-Z]{12}[0-9]{2}", d) or len(set(d)) == 1:
        return False
    return cnpj_with_check_digits(d[:12]) == d


def is_valid_cpf(value: str) -> bool:
    d = _clean(value)
    if not re.fullmatch(r"\d{11}", d) or len(set(d)) == 1:
        return False
    for n in (9, 10):
        total = sum(int(d[i]) * (n + 1 - i) for i in range(n))
        if (total * 10) % 11 % 10 != int(d[n]):
            return False
    return True


def normalize_document(value: str | None) -> str | None:
    """Vazio vira None; CPF/CNPJ válido volta limpo; inválido levanta ValueError."""
    if value is None:
        return None
    d = _clean(value)
    if not d:
        return None
    if (len(d) == 11 and is_valid_cpf(d)) or (len(d) == 14 and is_valid_cnpj(d)):
        return d
    raise ValueError("CPF/CNPJ inválido (confira os dígitos verificadores)")
