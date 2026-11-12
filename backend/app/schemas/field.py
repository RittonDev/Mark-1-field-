"""Regras de campo: os dois relógios de 4 horas e a autorização do cliente."""

from pydantic import BaseModel, Field


class FieldRules(BaseModel):
    """Configurável em Configurações (supervisor ou admin).

    - Chegada: até `arrival_hours_capital` horas nas capitais e `arrival_hours_interior` no
      interior, contadas da solicitação (ou da autorização do cliente, quando exigida).
      `null` = sem prazo de chegada.
    - Permanência: até `onsite_hours` horas de técnico na loja, contadas da chegada; o aviso
      aparece `onsite_warning_minutes` antes do limite.
    - `require_authorization`: o técnico só sai para a visita com a autorização do cliente.
    """

    arrival_hours_capital: int | None = Field(default=4, ge=1, le=72)
    arrival_hours_interior: int | None = Field(default=24, ge=1, le=240)
    onsite_hours: int = Field(default=4, ge=1, le=24)
    onsite_warning_minutes: int = Field(default=30, ge=5, le=240)
    require_authorization: bool = True
