"""Regras de campo: os dois relógios de 4 horas (chegada e permanência na loja)."""

from pydantic import BaseModel, Field, model_validator

# O aviso de "perto do limite" sai pelo menos isto depois da chegada (como na tela de configuração).
MIN_WARNING_MINUTES = 5


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
    onsite_warning_minutes: int = Field(default=30, ge=MIN_WARNING_MINUTES, le=240)

    @model_validator(mode="after")
    def _warning_inside_the_limit(self) -> "FieldRules":
        """O aviso sai "X minutos antes do fim": maior que o tempo na loja, ele tocaria antes de o
        técnico chegar (e toda OS ficaria "Perto do limite na loja" desde a chegada)."""
        most = self.onsite_hours * 60 - MIN_WARNING_MINUTES
        if self.onsite_warning_minutes > most:
            raise ValueError(
                f"Com {self.onsite_hours}h na loja, avise no máximo {most} minutos antes do fim"
            )
        return self
