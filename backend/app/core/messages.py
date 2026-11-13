"""Mensagens de validação em português.

O pydantic responde em inglês ("String should have at least 3 characters", "Field required").
`translate_errors` mantém o formato que a web e o app já tratam ({loc, msg, type, ctx}: o `loc`
continua com o nome técnico do campo, que as telas usam para achar o rótulo) e troca o texto por
português simples; quando o campo é conhecido, `label` traz o nome dele em português. O valor
enviado (`input`) não volta na resposta: não ecoa senha nem arquivo. Serve às respostas 422 da
API e a quem mais valida dados recebidos (sync do app, importações).
"""

from collections.abc import Iterable, Mapping
from typing import Any

FIELD_LABELS: dict[str, str] = {
    "title": "Título",
    "name": "Nome",
    "full_name": "Nome completo",
    "email": "E-mail",
    "password": "Senha",
    "new_password": "Nova senha",
    "current_password": "Senha atual",
    "description": "Descrição",
    "phone": "Telefone",
    "document": "CPF/CNPJ",
    "company_document": "CNPJ",
    "city": "Cidade",
    "state": "UF",
    "zip_code": "CEP",
    "postal_code": "CEP",
    "address": "Endereço",
    "address_line": "Endereço",
    "district": "Bairro",
    "contact": "Contato",
    "contact_name": "Contato",
    "contact_phone": "Telefone do contato",
    "client_reference": "Nº do chamado do cliente",
    "location_id": "Loja",
    "customer_id": "Cliente",
    "reason": "Motivo",
    "note": "Observação",
    "notes": "Observações",
    "quantity": "Quantidade",
    "unit_value": "Valor unitário",
    "unit_price": "Preço unitário",
    "amount": "Valor",
    "discount": "Desconto",
    "items": "Itens",
    "birth_date": "Data de nascimento",
    "job_title": "Cargo",
    "label": "Nome do link",
    "days_valid": "Validade",
    "signature": "Assinatura",
    "urgency": "Urgência",
    "role": "Papel",
    "coverage_area": "Região de atendimento",
    "service_areas": "Áreas de atuação",
    "privacy_consent": "Aviso de privacidade",
    "valid_until": "Validade",
}

# Partes do loc que não são campo (corpo, query, índices de lista).
_NOT_FIELDS = {"body", "query", "path", "header", "cookie", "form"}


def _ctx(error: Mapping[str, Any], key: str) -> Any:
    return (error.get("ctx") or {}).get(key)


def _plural(count: Any, one: str, many: str) -> str:
    return one if str(count) == "1" else many


def message_for(error: Mapping[str, Any]) -> str:
    """Texto em português para um erro do pydantic (pelo `type`)."""
    kind = str(error.get("type") or "")
    if kind == "missing":
        return "Campo obrigatório"
    if kind == "string_too_short":
        n = _ctx(error, "min_length")
        return f"Use pelo menos {n} {_plural(n, 'caractere', 'caracteres')}"
    if kind == "string_too_long":
        n = _ctx(error, "max_length")
        return f"Use no máximo {n} {_plural(n, 'caractere', 'caracteres')}"
    if kind in ("too_short",):
        n = _ctx(error, "min_length")
        return f"Informe pelo menos {n} {_plural(n, 'item', 'itens')}"
    if kind in ("too_long",):
        n = _ctx(error, "max_length")
        return f"No máximo {n} {_plural(n, 'item', 'itens')}"
    if kind == "greater_than":
        return f"Deve ser maior que {_ctx(error, 'gt')}"
    if kind == "greater_than_equal":
        return f"Deve ser maior ou igual a {_ctx(error, 'ge')}"
    if kind == "less_than":
        return f"Deve ser menor que {_ctx(error, 'lt')}"
    if kind == "less_than_equal":
        return f"Deve ser menor ou igual a {_ctx(error, 'le')}"
    if kind in ("uuid_parsing", "uuid_type", "uuid_version"):
        return "Identificador inválido"
    if kind.startswith("date") or kind.startswith("datetime"):
        return "Data inválida"
    if kind.startswith("time"):
        return "Horário inválido"
    if kind == "decimal_max_places":
        n = _ctx(error, "decimal_places")
        return f"Use no máximo {n} {_plural(n, 'casa decimal', 'casas decimais')}"
    if kind == "decimal_max_digits":
        return "Número grande demais"
    if kind in ("decimal_parsing", "decimal_type", "float_parsing", "float_type"):
        return "Informe um número"
    if kind in ("int_parsing", "int_type", "int_from_float"):
        return "Informe um número inteiro"
    if kind in ("finite_number",):
        return "Informe um número válido"
    if kind in ("bool_parsing", "bool_type"):
        return "Informe sim ou não"
    if kind in ("literal_error", "enum"):
        return "Opção inválida"
    if kind in ("string_type",):
        return "Informe um texto"
    if kind in ("list_type",):
        return "Informe uma lista"
    if kind in ("dict_type", "model_type", "model_attributes_type"):
        return "Formato inválido"
    if kind == "value_error":
        msg = str(error.get("msg") or "")
        msg = msg.removeprefix("Value error, ")
        if msg.startswith("value is not a valid email address"):
            return "E-mail inválido"
        return msg or "Valor inválido"
    if kind == "assertion_error":
        return str(error.get("msg") or "").removeprefix("Assertion failed, ") or "Valor inválido"
    if kind == "string_pattern_mismatch":
        return "Formato inválido"
    if kind == "json_invalid":
        return "Dados enviados com formato inválido"
    return "Valor inválido"


def field_of(loc: Iterable[Any]) -> str | None:
    """O nome técnico do campo no loc (o último texto que não é body/query)."""
    for part in reversed(list(loc)):
        if isinstance(part, str) and part not in _NOT_FIELDS:
            return part
    return None


def _safe_ctx(ctx: Any) -> dict[str, Any]:
    """Limites do erro (min_length, ge...) em tipos que viram JSON; o resto vira texto."""
    if not isinstance(ctx, Mapping):
        return {}
    out: dict[str, Any] = {}
    for key, value in ctx.items():
        if value is None or isinstance(value, bool | int | float | str):
            out[str(key)] = value
        else:
            out[str(key)] = str(value)
    return out


def translate_errors(errors: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Erros do pydantic em português, no formato {loc, msg, type, ctx, label}."""
    out = []
    for err in errors:
        loc = list(err.get("loc") or ())
        item: dict[str, Any] = {
            "loc": loc,
            "msg": message_for(err),
            "type": str(err.get("type") or ""),
        }
        ctx = _safe_ctx(err.get("ctx"))
        if ctx:
            item["ctx"] = ctx
        field = field_of(loc)
        if field in FIELD_LABELS:
            item["label"] = FIELD_LABELS[field]
        out.append(item)
    return out


def line_messages(
    errors: Iterable[Mapping[str, Any]], labels: Mapping[str, str] | None = None
) -> list[str]:
    """Uma frase por erro (ex.: "UF: Use no máximo 2 caracteres") para mensagens de linha."""
    names = {**FIELD_LABELS, **(labels or {})}
    out = []
    for err in translate_errors(errors):
        field = field_of(err["loc"])
        label = names.get(field or "", field)
        out.append(f"{label}: {err['msg']}" if label else err["msg"])
    return out
