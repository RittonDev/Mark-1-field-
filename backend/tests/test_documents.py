import pytest

from app.core.documents import (
    cnpj_with_check_digits,
    is_valid_cnpj,
    is_valid_cpf,
    normalize_document,
)


def test_numeric_cnpj_and_cpf() -> None:
    assert is_valid_cnpj("11.222.333/0001-81")
    assert not is_valid_cnpj("11.222.333/0001-80")
    assert is_valid_cpf("529.982.247-25")
    assert not is_valid_cpf("529.982.247-24")
    assert not is_valid_cpf("111.111.111-11")


def test_alphanumeric_cnpj_from_receita_example() -> None:
    # Exemplo oficial da Receita Federal para o CNPJ alfanumérico (julho/2026).
    assert is_valid_cnpj("12.ABC.345/01DE-35")
    assert cnpj_with_check_digits("12ABC34501DE") == "12ABC34501DE35"
    assert not is_valid_cnpj("12.ABC.345/01DE-36")


def test_normalize_document() -> None:
    assert normalize_document("11.222.333/0001-81") == "11222333000181"
    assert normalize_document("12.abc.345/01de-35") == "12ABC34501DE35"
    assert normalize_document("  ") is None
    assert normalize_document(None) is None
    with pytest.raises(ValueError, match="CPF/CNPJ inválido"):
        normalize_document("123")
