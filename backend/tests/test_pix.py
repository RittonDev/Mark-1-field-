"""Chave PIX do técnico (core/pix.py) e quem recebe o aviso de cadastro alterado. Sem banco.

Só dados fictícios: CPF 12345678909, CNPJ gerado por cnpj_with_check_digits, @exemplo.com.
"""

import dataclasses

import pytest

from app.core import permissions, pix
from app.core.documents import cnpj_with_check_digits
from app.core.enums import UserRole
from app.services.realtime import should_deliver

CPF = "12345678909"
CNPJ = cnpj_with_check_digits("123456780001")
CNPJ_SHOWN = f"12.345.678/0001-{CNPJ[12:]}"
CNPJ_ALNUM = cnpj_with_check_digits("12ABC34501DE")
RANDOM = "123e4567-e89b-42d3-a456-426614174000"


def test_normalize_each_type() -> None:
    assert pix.normalize("cpf", "123.456.789-09") == CPF
    assert pix.normalize("cnpj", CNPJ_SHOWN) == CNPJ
    # CNPJ alfanumérico (Receita, jul/2026): em maiúsculas, sem pontuação.
    assert pix.normalize("cnpj", CNPJ_ALNUM.lower()) == CNPJ_ALNUM
    assert pix.normalize("email", "  Tecnico.Alfa@Exemplo.com ") == "tecnico.alfa@exemplo.com"
    for phone in ("(11) 98888-7777", "11988887777", "+55 11 98888-7777"):
        assert pix.normalize("phone", phone) == "+5511988887777"
    assert pix.normalize("random", RANDOM.replace("-", "").upper()) == RANDOM
    assert pix.normalize("random", f" {RANDOM} ") == RANDOM


@pytest.mark.parametrize(
    ("kind", "text", "message"),
    [
        ("cpf", "111.111.111-11", pix.INVALID_CPF),
        ("cpf", "123.456.789-00", pix.INVALID_CPF),
        ("cnpj", CNPJ[:-1] + str((int(CNPJ[-1]) + 1) % 10), pix.INVALID_CNPJ),
        ("email", "x@y", pix.INVALID_EMAIL),
        ("email", "a" * 70 + "@exemplo.com", pix.INVALID_EMAIL),
        ("phone", "(11) 3333-4444", pix.INVALID_PHONE),
        ("phone", "(01) 98888-7777", pix.INVALID_PHONE),
        ("random", "abc", pix.INVALID_RANDOM),
        ("boleto", "123", pix.INVALID_TYPE),
    ],
)
def test_invalid_keys_have_clear_messages(kind: str, text: str, message: str) -> None:
    with pytest.raises(ValueError) as caught:
        pix.normalize(kind, text)
    assert str(caught.value) == message


def test_display_and_mask() -> None:
    assert pix.display("cpf", CPF) == "123.456.789-09"
    assert pix.display("cnpj", CNPJ) == CNPJ_SHOWN
    assert pix.display("phone", "+5511988887777") == "+55 (11) 98888-7777"
    assert pix.display("email", "tecnico@exemplo.com") == "tecnico@exemplo.com"
    assert pix.display("random", RANDOM) == RANDOM

    assert pix.mask("cpf", CPF) == "***.456.789-**"
    assert pix.mask("cnpj", CNPJ) == "12.345.678/****-**"
    assert pix.mask("email", "tecnico@exemplo.com") == "t***@exemplo.com"
    assert pix.mask("phone", "+5511988887777") == "+55 (11) *****-7777"
    assert pix.mask("random", RANDOM) == "…4000"

    assert pix.describe("cpf", CPF) == "CPF ***.456.789-**"
    assert pix.describe("cpf", CPF, masked=False) == "CPF 123.456.789-09"
    assert pix.describe("random", RANDOM) == "Chave aleatória …4000"
    assert pix.describe("phone", "+5511988887777") == "Celular +55 (11) *****-7777"


def test_profile_event_audience() -> None:
    """profile.changed: para quem tem Técnicos ou Pagamentos; nunca para técnico e cliente."""
    event = {
        "type": "profile.changed",
        "user_id": "tecnico-alfa",
        "data": {"fields": ["pix"], "via": "app"},
        "audience": {"managers_only": True},
    }
    analyst = permissions.Access(full=False, items=dict(permissions.ROLE_DEFAULTS["analyst"]))
    only_payouts = dataclasses.replace(
        analyst,
        items={**dict.fromkeys(permissions.ITEM_KEYS, "none"), "commercial.payouts": "view"},
    )
    only_technicians = dataclasses.replace(
        only_payouts,
        items={**dict.fromkeys(permissions.ITEM_KEYS, "none"), "base.technicians": "view"},
    )
    neither = dataclasses.replace(
        analyst, items={**analyst.items, "base.technicians": "none", "commercial.payouts": "none"}
    )

    def deliver(role: UserRole, access: permissions.Access | None) -> bool:
        return should_deliver(user_id="x", role=role, team_id=None, event=event, access=access)

    assert deliver(UserRole.ANALYST, analyst)
    assert deliver(UserRole.ANALYST, only_payouts)
    assert deliver(UserRole.SUPERVISOR, only_technicians)
    assert deliver(UserRole.ADMIN, permissions.FULL_ACCESS)
    assert not deliver(UserRole.ANALYST, neither)
    assert not deliver(UserRole.TECHNICIAN, None)
    assert not deliver(UserRole.REQUESTER, None)
    # Nome do evento fora de "technician.*": a web manda esses para o mapa.
    assert not event["type"].startswith("technician.")
