"""Regras de campo: os dois relógios de 4 horas (chegada e permanência na loja)."""

from pydantic import BaseModel, Field


class FieldRules(BaseModel):
    """Configurável em Configurações (supervisor ou admin).

    - Chegada: até `arrival_hours_capital` horas nas capitais e `arrival_hours_interior` no
      interior, contadas da solicitação. `null` = sem prazo de chegada.
    - Permanência: até `onsite_hours` horas de técnico na loja, contadas da chegada; o aviso
      aparece `onsite_warning_minutes` antes do limite.

    A autorização do cliente antes da visita foi retirada (2026-11-12): a central combina com o
    cliente e o técnico não espera registro nenhum para sair. Valores antigos guardados com
    `require_authorization` são ignorados.
    """

    arrival_hours_capital: int | None = Field(default=4, ge=1, le=72)
    arrival_hours_interior: int | None = Field(default=24, ge=1, le=240)
    onsite_hours: int = Field(default=4, ge=1, le=24)
    onsite_warning_minutes: int = Field(default=30, ge=5, le=240)
