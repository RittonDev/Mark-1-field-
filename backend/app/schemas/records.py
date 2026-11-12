"""Partes das fichas completas (técnico, cliente e loja): contatos e jornada de trabalho."""

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

_TIME = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$")


class ContactOut(BaseModel):
    """Contato como está gravado (leitura tolerante: dado importado não é revalidado)."""

    kind: str
    value: str
    name: str | None = None
    # work | personal | mobile | home (como no Field Control) ou livre.
    label: str | None = None
    primary: bool = False


class ContactIn(BaseModel):
    """Contato digitado: e-mail em minúsculas; telefone só com dígitos e DDI (55 se faltar)."""

    kind: Literal["email", "phone"]
    value: str = Field(min_length=1, max_length=255)
    name: str | None = Field(default=None, max_length=160)
    label: str | None = Field(default=None, max_length=20)
    primary: bool = False

    @model_validator(mode="after")
    def _normalize(self) -> "ContactIn":
        value = self.value.strip()
        if self.kind == "email":
            value = value.lower()
            if "@" not in value or " " in value:
                raise ValueError("E-mail inválido")
        else:
            international = value.startswith("+")
            value = re.sub(r"\D", "", value)
            # Gravado como no import: com o DDI na frente ("(85) 3333-2222" -> "558533332222").
            if not international and len(value) in (10, 11):
                value = "55" + value
            if len(value) < 8:
                raise ValueError("Telefone inválido")
        self.value = value
        self.name = (self.name or "").strip() or None
        self.label = (self.label or "").strip().lower() or None
        return self


def dedupe_contacts(contacts: list[ContactIn] | list[dict]) -> list[dict]:
    """Lista gravável: sem repetidos (mesmo tipo e valor), na ordem recebida.

    O repetido não se perde de todo: se ele era o principal ou tinha nome/rótulo, isso passa
    para o que ficou.
    """
    out: list[dict] = []
    index: dict[tuple[str, str], int] = {}
    for item in contacts:
        data = item.model_dump() if isinstance(item, BaseModel) else dict(item)
        key = (data["kind"], data["value"])
        if key in index:
            kept = out[index[key]]
            kept["primary"] = bool(kept.get("primary") or data.get("primary"))
            for field in ("name", "label"):
                kept[field] = kept.get(field) or data.get(field)
            continue
        index[key] = len(out)
        out.append(data)
    return out


def primary_contact(contacts: list[dict], kind: str) -> dict | None:
    """O contato principal do tipo (ou o primeiro, se nenhum estiver marcado)."""
    of_kind = [c for c in contacts if c.get("kind") == kind]
    return next((c for c in of_kind if c.get("primary")), of_kind[0] if of_kind else None)


def format_phone(value: str | None) -> str | None:
    """ "5511999998888" -> "(11) 99999-8888" (o campo único de telefone, legível)."""
    digits = re.sub(r"\D", "", value or "")
    if not digits:
        return None
    if digits.startswith("55") and len(digits) in (12, 13):
        digits = digits[2:]
    if len(digits) == 11:
        return f"({digits[:2]}) {digits[2:7]}-{digits[7:]}"
    if len(digits) == 10:
        return f"({digits[:2]}) {digits[2:6]}-{digits[6:]}"
    return digits[:40]


class WorkScheduleOut(BaseModel):
    start: str | None = None
    end: str | None = None
    break_start: str | None = None
    break_end: str | None = None


class WorkSchedule(WorkScheduleOut):
    """Jornada do técnico: aceita "HH:MM" ou "HH:MM:SS" e grava "HH:MM:SS"."""

    @field_validator("start", "end", "break_start", "break_end")
    @classmethod
    def _time(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        match = _TIME.match(value.strip())
        if not match:
            raise ValueError("Horário inválido: use HH:MM")
        return f"{match.group(1)}:{match.group(2)}:{match.group(3) or '00'}"
