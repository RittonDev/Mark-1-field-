from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.schemas.ticket import TicketTimesIn, TicketTransition, TicketUnproductive, WorklogCreate
from app.services.sync import validation_text


def test_model_level_error_has_no_empty_field_prefix() -> None:
    with pytest.raises(ValidationError) as info:
        WorklogCreate(description="Troca do fusor", started_at=datetime.now(UTC))
    assert validation_text(info.value) == "Informe o fim ou a duração"


def test_field_error_shows_the_field_label_in_portuguese() -> None:
    with pytest.raises(ValidationError) as info:
        TicketTransition.model_validate({"to_status": "voando"})
    text = validation_text(info.value)
    assert text.startswith("Status: escolha uma das opções: ")
    assert " ou " in text and "Input should" not in text
    with pytest.raises(ValidationError) as info:
        TicketUnproductive.model_validate({"note": "x"})
    assert validation_text(info.value) == "Motivo: campo obrigatório"
    with pytest.raises(ValidationError) as info:
        TicketTimesIn.model_validate({"reason": "ok"})
    assert validation_text(info.value) == "Motivo: informe pelo menos 3 caracteres"
