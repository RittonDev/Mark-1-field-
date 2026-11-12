from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.schemas.ticket import TicketTransition, WorklogCreate
from app.services.sync import validation_text


def test_model_level_error_has_no_empty_field_prefix() -> None:
    with pytest.raises(ValidationError) as info:
        WorklogCreate(description="Troca do fusor", started_at=datetime.now(UTC))
    assert validation_text(info.value) == "Informe ended_at ou minutes"


def test_field_error_keeps_field_name() -> None:
    with pytest.raises(ValidationError) as info:
        TicketTransition.model_validate({"to_status": "voando"})
    assert validation_text(info.value).startswith("to_status: ")
