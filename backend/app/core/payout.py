"""Forma de recebimento do técnico em texto mascarado: histórico do cadastro, registro do pagamento e
extrato do WhatsApp.

- PIX: "PIX " + core/pix.describe ("PIX CPF ***.456.789-**").
- Conta: "{banco} ****5678-9" (os 4 últimos números da conta; com até 4 números, os 2 últimos:
  "**34-4"), mais o dígito.

O mesmo texto de lib/constants.ts (payoutMethodText, maskAccount), que usa "•" no lugar de "*". A
conta inteira só aparece na central, para quem tem Pagamentos (bankAccountText).
"""

from collections.abc import Mapping
from typing import Any

from app.core import pix

# = BANK_ACCOUNT_TYPE de lib/constants.ts.
ACCOUNT_TYPE_LABELS: dict[str, str] = {
    "checking": "Conta corrente",
    "savings": "Conta poupança",
    "payment": "Conta de pagamento",
}


def _get(method: Any, key: str) -> Any:
    if isinstance(method, Mapping):
        return method.get(key)
    return getattr(method, key, None)


def mask_account(number: str | None, digit: str | None) -> str:
    """A conta mascarada (= maskAccount): "****5678-9"; com até 4 números, os 2 últimos ("**34-4")."""
    value = number or ""
    tail = f"****{value[-4:]}" if len(value) > 4 else f"**{value[-2:]}"
    return f"{tail}-{digit}" if digit else tail


def describe(method: Any) -> str:
    """A forma numa linha, mascarada: "PIX CPF ***.456.789-**" | "Banco Exemplo ****5678-9".
    Aceita o modelo (TechnicianPayoutMethod), um schema ou um dicionário com os mesmos campos."""
    if str(_get(method, "kind")) == "pix":
        return f"PIX {pix.describe(_get(method, 'pix_key_type'), _get(method, 'pix_key') or '')}"
    bank = _get(method, "bank_name") or "Conta"
    return f"{bank} {mask_account(_get(method, 'account_number'), _get(method, 'account_digit'))}"


def describe_with_holder(method: Any) -> str:
    """Com o titular (histórico das formas): "PIX CPF ***.456.789-** · Tecnico Alfa"."""
    holder = " ".join(str(_get(method, "holder_name") or "").split())
    text = describe(method)
    return f"{text} · {holder}" if holder else text
