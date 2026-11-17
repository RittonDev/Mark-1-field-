"""Etiquetas automáticas da OS (como a equipe usa no Field Control).

Quatro listas: as etiquetas da OS aberta (avulsa), as da OS de projeto, as que entram quando a
gestão lança um custo extra e as que saem quando os técnicos da OS são pagos.
"""

from typing import Literal, get_args

from pydantic import BaseModel, Field, field_validator, model_validator

# Cores do Field Control (as etiquetas migradas usam estes nomes).
TagColor = Literal[
    "green",
    "pink",
    "yellow",
    "indigo",
    "purple",
    "field-pale",
    "light-blue",
    "brown",
    "red",
    "blue-grey",
    "blue",
    "teal",
    "orange",
    "grey",
]
TAG_COLORS: tuple[str, ...] = get_args(TagColor)
MAX_RULE_TAGS = 10
MAX_RULE_NAME = 40

# Nome de cada lista nas mensagens de erro (os mesmos títulos da tela de Configurações).
_LIST_LABELS = {
    "on_create": "Toda OS nova (avulsa)",
    "on_project": "OS de projeto",
    "on_extra_cost": "Ao lançar custo extra",
    "remove_on_payout_paid": "Ao marcar o técnico como pago, remover",
}


def clean_rule_name(value: str) -> str:
    """Nome sem espaços sobrando, de 1 a 40 caracteres."""
    name = " ".join(value.split())
    if not name:
        raise ValueError("Informe o nome da etiqueta")
    if len(name) > MAX_RULE_NAME:
        raise ValueError(f"Nome da etiqueta com no máximo {MAX_RULE_NAME} caracteres: {name}")
    return name


class TagRule(BaseModel):
    name: str
    color: TagColor | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return clean_rule_name(value)


class TicketTagRules(BaseModel):
    """`on_create`: OS nova sem projeto; `on_project`: OS nova de projeto; `on_extra_cost`:
    incluídas ao lançar um custo extra; `remove_on_payout_paid`: nomes tirados quando todos os
    valores dos técnicos da OS ficam pagos. Até 10 por lista, sem repetir (maiúscula não conta).
    """

    on_create: list[TagRule] = Field(max_length=MAX_RULE_TAGS)
    on_project: list[TagRule] = Field(max_length=MAX_RULE_TAGS)
    on_extra_cost: list[TagRule] = Field(max_length=MAX_RULE_TAGS)
    remove_on_payout_paid: list[str] = Field(max_length=MAX_RULE_TAGS)

    @field_validator("remove_on_payout_paid")
    @classmethod
    def _names(cls, value: list[str]) -> list[str]:
        return [clean_rule_name(name) for name in value]

    @model_validator(mode="after")
    def _no_repeats(self) -> "TicketTagRules":
        lists: dict[str, list[str]] = {
            "on_create": [t.name for t in self.on_create],
            "on_project": [t.name for t in self.on_project],
            "on_extra_cost": [t.name for t in self.on_extra_cost],
            "remove_on_payout_paid": self.remove_on_payout_paid,
        }
        for key, names in lists.items():
            seen: set[str] = set()
            for name in names:
                if name.lower() in seen:
                    raise ValueError(f"{_LIST_LABELS[key]}: a etiqueta {name} está repetida")
                seen.add(name.lower())
        return self
