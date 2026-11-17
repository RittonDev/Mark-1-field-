"""Etiquetas automáticas da OS, como a equipe faz hoje no Field Control.

- Abertura: a OS avulsa nasce com "Pendente Envio PGTO" (o técnico ainda não recebeu) e "Ticket
  Avulso"; a de projeto, só com "Projeto". A web mostra a lista já preenchida e o analista muda
  antes de criar (a lista enviada vale como está).
- Custo extra lançado: entra "Custo Extra", se a OS ainda não tem.
- Técnico pago: quando todos os valores dos técnicos da OS ficam pagos, sai "Pendente Envio PGTO".

A gestão (supervisor e admin) muda as listas; ficam em system_settings ("tickets.tag_rules").
Nada mais mexe nas etiquetas sozinho: as OS migradas só mudam por estes eventos.

As etiquetas se comparam pelo nome, sem diferenciar maiúsculas nem espaços sobrando; a grafia e a
cor que a OS já tem ficam.
"""

from collections.abc import Iterable, Mapping
from typing import Any

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SystemSetting, User
from app.schemas.tag_rules import TagRule, TicketTagRules

SETTING_KEY = "tickets.tag_rules"
# Etiquetas por OS (o mesmo limite da edição da OS).
MAX_TICKET_TAGS = 20
MAX_TICKET_TAG_NAME = 60

DEFAULT_RULES = TicketTagRules(
    on_create=[
        TagRule(name="Pendente Envio PGTO", color="field-pale"),
        TagRule(name="Ticket Avulso", color="green"),
    ],
    on_project=[TagRule(name="Projeto", color="purple")],
    on_extra_cost=[TagRule(name="Custo Extra", color="yellow")],
    remove_on_payout_paid=["Pendente Envio PGTO"],
)


async def get_rules(db: AsyncSession) -> TicketTagRules:
    """As listas gravadas pela gestão; a que faltar (ou estiver inválida) fica com o padrão."""
    setting = await db.get(SystemSetting, SETTING_KEY)
    if setting is None or not isinstance(setting.value, dict):
        return DEFAULT_RULES.model_copy(deep=True)
    try:
        return TicketTagRules.model_validate({**DEFAULT_RULES.model_dump(), **setting.value})
    except ValidationError:
        return DEFAULT_RULES.model_copy(deep=True)


async def save_rules(db: AsyncSession, rules: TicketTagRules, actor: User) -> TicketTagRules:
    setting = await db.get(SystemSetting, SETTING_KEY)
    if setting is None:
        setting = SystemSetting(key=SETTING_KEY)
        db.add(setting)
    setting.value = rules.model_dump()
    setting.updated_by_id = actor.id
    await db.flush()
    return rules


async def opening_tags(db: AsyncSession, *, project: bool) -> list[dict[str, Any]]:
    """Etiquetas da OS nova aberta sem lista própria: as da OS de projeto ou as da abertura."""
    rules = await get_rules(db)
    return [tag.model_dump() for tag in (rules.on_project if project else rules.on_create)]


def tag_key(name: object) -> str:
    """Chave de comparação: sem espaços sobrando e sem diferenciar maiúsculas."""
    return " ".join(str(name or "").split()).lower()


def merged(
    tags: list[dict[str, Any]], add: Iterable[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """As etiquetas da OS mais as de `add` que ela ainda não tem (até 20 na OS)."""
    out = list(tags)
    have = {tag_key(tag.get("name")) for tag in out}
    for tag in add:
        name = " ".join(str(tag.get("name") or "").split())[:MAX_TICKET_TAG_NAME]
        key = name.lower()
        if not key or key in have or len(out) >= MAX_TICKET_TAGS:
            continue
        color = tag.get("color")
        out.append({"name": name, "color": color if isinstance(color, str) and color else None})
        have.add(key)
    return out


def without(tags: list[dict[str, Any]], names: Iterable[str]) -> list[dict[str, Any]]:
    """As etiquetas da OS sem as de `names`."""
    drop = {tag_key(name) for name in names} - {""}
    return [tag for tag in tags if tag_key(tag.get("name")) not in drop]
