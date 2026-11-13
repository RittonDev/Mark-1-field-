"""Erros de validação (pydantic) em português simples, com o nome do campo que a pessoa vê.

O pydantic responde em inglês ("String should have at least 3 characters", "Field required").
Estes textos chegam ao analista (aviso da web) e ao técnico (aviso do sync), então viram
"Motivo: informe pelo menos 3 caracteres". Mensagens nossas (ValueError dos validadores) já são
em português e passam como estão.
"""

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

# Nome técnico do campo -> como aparece nas telas.
FIELD_LABELS: dict[str, str] = {
    "title": "Título",
    "description": "Descrição",
    "type": "Tipo",
    "impact": "Impacto",
    "urgency": "Urgência",
    "priority": "Prioridade",
    "source": "Origem",
    "status": "Status",
    "to_status": "Status",
    "note": "Motivo",
    "reason": "Motivo",
    "reason_id": "Motivo",
    "resolution_notes": "Solução",
    "scheduled_start": "Início da visita",
    "scheduled_end": "Fim da visita",
    "en_route_at": "Saída para o local",
    "arrived_at": "Início do atendimento",
    "resolved_at": "Término",
    "work_minutes": "Tempo de atendimento",
    "started_at": "Início",
    "ended_at": "Fim",
    "minutes": "Duração",
    "estimated_minutes": "Duração estimada",
    "customer_id": "Cliente",
    "location_id": "Loja",
    "category_id": "Categoria",
    "service_type_id": "Tipo de serviço",
    "team_id": "Grupo",
    "project_id": "Projeto",
    "assignee_id": "Técnico",
    "owner_id": "Analista responsável",
    "helper_ids": "Outros técnicos",
    "requester_name": "Solicitante",
    "requester_contact": "Contato do solicitante",
    "service_address": "Endereço do atendimento",
    "client_reference": "Nº do chamado do cliente",
    "visit_note": "Recado para o técnico",
    "tags": "Etiquetas",
    "body": "Texto",
    "latitude": "Latitude",
    "longitude": "Longitude",
    "recorded_at": "Hora do ponto",
    "expected_version": "Versão da OS",
    "form_id": "Formulário",
    "answers": "Respostas",
    "quantity": "Quantidade",
    "unit": "Unidade",
    "attachment_ids": "Fotos",
    "violation_note": "Observação da violação",
    "response_violation_reason_id": "Motivo da violação (resposta)",
    "resolution_violation_reason_id": "Motivo da violação (solução)",
    "client_op_id": "Operação",
    "ticket_id": "OS",
    "payload": "Dados da operação",
    "operations": "Operações",
    "pings": "Pontos",
}

# Partes do caminho que não são campo (corpo da requisição, query, índice de lista...).
_SKIP = {"body", "query", "path", "header"}


def field_label(loc: Sequence[str | int]) -> str:
    """Rótulo do campo pelo caminho do erro ("body.reason" -> "Motivo"); vazio no nível do
    modelo (validação que olha vários campos)."""
    names = [str(p) for p in loc if isinstance(p, str) and p not in _SKIP]
    if not names:
        return ""
    name = names[-1]
    return FIELD_LABELS.get(name, name)


def _plural(n: Any, one: str, many: str) -> str:
    return one if str(n) == "1" else many


def _options(expected: Any) -> str:
    """"'a', 'b' or 'c'" -> "a, b ou c"."""
    text = str(expected or "").replace("'", "")
    head, sep, tail = text.rpartition(" or ")
    return f"{head} ou {tail}" if sep else text


def message(error: Mapping[str, Any]) -> str:
    """A mensagem de um erro do pydantic, em português."""
    kind = str(error.get("type") or "")
    ctx: Mapping[str, Any] = error.get("ctx") or {}
    raw = str(error.get("msg") or "")
    if kind == "value_error":
        return raw.removeprefix("Value error, ")
    if kind == "assertion_error":
        return raw.removeprefix("Assertion failed, ")
    if kind == "missing":
        return "campo obrigatório"
    if kind == "string_too_short":
        n = ctx.get("min_length")
        return f"informe pelo menos {n} {_plural(n, 'caractere', 'caracteres')}"
    if kind == "string_too_long":
        n = ctx.get("max_length")
        return f"no máximo {n} {_plural(n, 'caractere', 'caracteres')}"
    if kind == "too_short":
        n = ctx.get("min_length")
        return f"informe pelo menos {n} {_plural(n, 'item', 'itens')}"
    if kind == "too_long":
        n = ctx.get("max_length")
        return f"no máximo {n} {_plural(n, 'item', 'itens')}"
    if kind == "greater_than":
        return f"deve ser maior que {ctx.get('gt')}"
    if kind == "greater_than_equal":
        return f"deve ser no mínimo {ctx.get('ge')}"
    if kind == "less_than":
        return f"deve ser menor que {ctx.get('lt')}"
    if kind == "less_than_equal":
        return f"deve ser no máximo {ctx.get('le')}"
    if kind in ("uuid_parsing", "uuid_type", "uuid_version"):
        return "identificador inválido"
    if kind in ("datetime_parsing", "datetime_type", "datetime_from_date_parsing"):
        return "data e hora inválidas"
    if kind in ("date_parsing", "date_type", "date_from_datetime_parsing"):
        return "data inválida"
    if kind in ("time_parsing", "time_type"):
        return "hora inválida"
    if kind in ("enum", "literal_error"):
        return f"escolha uma das opções: {_options(ctx.get('expected'))}"
    if kind in ("bool_parsing", "bool_type"):
        return "informe sim ou não"
    if kind in ("int_parsing", "int_type", "int_from_float"):
        return "informe um número inteiro"
    if kind in ("float_parsing", "float_type", "finite_number", "decimal_parsing", "decimal_type"):
        return "informe um número"
    if kind in ("decimal_max_digits", "decimal_max_places", "decimal_whole_digits"):
        return "número com dígitos demais"
    if kind in ("string_type", "string_unicode"):
        return "informe um texto"
    if kind in ("list_type", "tuple_type", "set_type"):
        return "informe uma lista"
    if kind in ("dict_type", "model_type", "model_attributes_type"):
        return "formato inválido"
    if kind in ("json_invalid", "json_type"):
        return "conteúdo inválido (JSON)"
    if kind == "extra_forbidden":
        return "campo não aceito"
    return raw


def readable(errors: Iterable[Mapping[str, Any]]) -> str:
    """Texto único ("Motivo: informe pelo menos 3 caracteres; Status: ..."), sem repetir."""
    parts: list[str] = []
    for error in errors:
        label = field_label(error.get("loc") or ())
        text = message(error)
        line = f"{label}: {text}" if label else text[:1].upper() + text[1:]
        if line not in parts:
            parts.append(line)
    return "; ".join(parts)


def detail(errors: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Lista no formato da resposta 422 ({loc, msg, type}), com o rótulo do campo no lugar do
    nome técnico e a mensagem em português (a web mostra "loc: msg")."""
    out: list[dict[str, Any]] = []
    for error in errors:
        loc = list(error.get("loc") or ())
        prefix = [p for p in loc[:1] if p in _SKIP]
        label = field_label(loc)
        out.append(
            {
                "loc": [*prefix, label] if label else prefix,
                "msg": message(error),
                "type": error.get("type"),
            }
        )
    return out
