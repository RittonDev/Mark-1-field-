"""Histórico do cadastro do técnico (tabela user_changes) e o aviso em tempo real à central.

Toda mudança no cadastro, pelo app (Meu cadastro) ou pela central (Técnicos, Usuários, Pagamentos),
vira uma linha com quem fez, por onde e as mudanças [{field, from, to}] já com o texto da tela:
- name, email, phone, job_title, home_city, home_state, coverage_area, address_line,
  address_district, address_zip: o valor como está;
- team: o nome do grupo; is_active: "Liberado" ou "Bloqueado"; role: o rótulo do papel;
- work_schedule: "08:00–17:00, intervalo 12:00–13:00"; services: "12 serviços";
- pix: a chave MASCARADA ("CPF ***.456.789-**"), null sem chave; pix_holder: o titular da conta;
- avatar: to "nova" na troca e null na remoção; password: to "provisória" (redefinição em Técnicos),
  "definida pela central" (Usuários), "criada no app" (o técnico trocou a provisória) ou "trocada
  no app";
- perfil técnico (o técnico muda no app; services/tech_profile.py): tools, availability, skills e
  education (DELTA_FIELDS) gravam o que SAIU em "from" e o que ENTROU em "to" (null: nada), e não
  o de → para: tools com os nomes em ordem alfabética ("Escada, Multímetro"), availability em
  turnos ("sáb · tarde e noite"), skills "Linux (Básico)" em ordem alfabética, education "Técnico
  em redes · Escola Exemplo · Técnico · desde 02/2024 (em andamento)" pelo início, separados por
  "; " (listas com mais de 10 itens: os 10 primeiros e " e mais N"); transport segue de → para,
  "Carro, Moto · com CNH", null quando não informado.
E-mail e celular ficam em claro (a central desfaz uma troca indevida); a chave PIX nunca. Quem não
tem Pagamentos lê o histórico sem o titular e com a chave como "***" (`hide_pix`). As partes do
perfil técnico comparam como tech_profile.wanted (a rota do app só grava com mudança no histórico).

Uso: `before = await snapshot(db, user)`, aplica, `changes = await track(db, user, before, ...)`
(ou `record` com as mudanças especiais) e, depois do commit, `publish_changed`.
"""

import logging
import uuid
from collections.abc import Callable, Iterable, Mapping
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions, pix
from app.core.enums import UserRole
from app.core.labels import ROLE_LABELS
from app.db.base import utcnow
from app.models import Team, User, UserChange
from app.models.user_change import VIA_CENTRAL
from app.schemas.my_profile import UserChangeItem, UserChangeOut
from app.services import tech_profile

log = logging.getLogger(__name__)

EVENT = "profile.changed"

# Mudanças que não saem da comparação dos dados.
PHOTO_ADDED: dict[str, Any] = {"field": "avatar", "from": None, "to": "nova"}
PHOTO_REMOVED: dict[str, Any] = {"field": "avatar", "from": "anterior", "to": None}
PASSWORD_TEMPORARY: dict[str, Any] = {"field": "password", "from": None, "to": "provisória"}
PASSWORD_SET: dict[str, Any] = {"field": "password", "from": None, "to": "definida pela central"}
# POST /auth/change-password do técnico: a provisória trocada pela dele, ou a dele trocada.
PASSWORD_CREATED: dict[str, Any] = {"field": "password", "from": None, "to": "criada no app"}
PASSWORD_CHANGED: dict[str, Any] = {"field": "password", "from": None, "to": "trocada no app"}

# Campo do histórico -> campo do aviso (o titular faz parte da chave PIX).
_EVENT_FIELD = {"pix_holder": "pix"}

# Troca de e-mail ou de chave PIX pelo app até 72 h depois de a central redefinir a senha: o aviso
# diz quem redefiniu e quando. Não bloqueia (o técnico novo recebe a senha da central e precisa
# cadastrar o PIX), só sinaliza: quem redefiniu também conheceu a senha.
RESET_ALERT_WINDOW = timedelta(hours=72)
_RESET_ALERT_FIELDS = frozenset({"pix", "email"})

# A chave no histórico de quem não tem Pagamentos.
PIX_HIDDEN = "***"

# Partes do perfil técnico em lista: "from" = o que saiu, "to" = o que entrou.
DELTA_FIELDS = frozenset({"tools", "availability", "skills", "education"})
# Ferramenta marcada que não está mais no catálogo (a API não exclui; só apagando no banco).
TOOL_GONE = "Ferramenta removida"

# Campo -> (valor para comparar, texto da tela). Nos DELTA_FIELDS, o valor é o conjunto dos itens e
# o "texto" é a função que escreve um pedaço deles (o que saiu ou o que entrou).
ItemsText = Callable[[Iterable[Any]], str | None]
Snapshot = dict[str, tuple[Any, Any]]


def _same(value: Any) -> tuple[Any, str | None]:
    return value, value


def _schedule(schedule: dict[str, Any] | None) -> tuple[Any, str | None]:
    if not schedule or not any(schedule.values()):
        return None, None

    def hm(key: str) -> str:
        return str(schedule.get(key) or "")[:5] or "?"

    text = f"{hm('start')}–{hm('end')}"
    if schedule.get("break_start") or schedule.get("break_end"):
        text += f", intervalo {hm('break_start')}–{hm('break_end')}"
    keys = ("start", "end", "break_start", "break_end")
    return tuple(schedule.get(k) for k in keys), text


def _services(ids: list[str] | None) -> tuple[Any, str | None]:
    wanted = frozenset(str(i) for i in ids or [])
    if not wanted:
        return wanted, None
    return wanted, f"{len(wanted)} serviço{'s' if len(wanted) > 1 else ''}"


def _role(role: UserRole | str | None) -> tuple[Any, str | None]:
    if role is None:
        return None, None
    value = UserRole(role)
    return value.value, ROLE_LABELS.get(value, value.value)


# ------------------------------------------------------------- perfil técnico
# Os valores comparados são os de tech_profile (os mesmos de `wanted`).


def _alphabetical(labels: Iterable[str]) -> list[str]:
    return sorted(labels, key=lambda label: (tech_profile.fold(label), label))


def _tools(user: User, catalog: Mapping[str, tech_profile.ToolInfo]) -> tuple[Any, ItemsText]:
    def text(ids: Iterable[str]) -> str | None:
        names = [catalog[key].name if key in catalog else TOOL_GONE for key in ids]
        return tech_profile.items_text(_alphabetical(names))

    return tech_profile.tool_set(user), text


def _slots_text(slots: Iterable[str]) -> str | None:
    return tech_profile.slots_text(slots) or None


def _skills_text(items: Iterable[tuple[Any, Any]]) -> str | None:
    labels = [tech_profile.skill_label({"name": name, "level": level}) for name, level in items]
    return tech_profile.items_text(_alphabetical(labels))


def _education_text(items: Iterable[tuple[Any, ...]]) -> str | None:
    courses = [dict(zip(tech_profile.EDUCATION_KEYS, item[1:], strict=True)) for item in items]
    courses.sort(key=lambda c: (str(c["start"] or ""), tech_profile.fold(str(c["course"] or ""))))
    return tech_profile.items_text([tech_profile.education_label(c) for c in courses], "; ")


def _transport(user: User) -> tuple[Any, str | None]:
    value = tech_profile.transport_key(user)
    return value, tech_profile.transport_text(*value) if value is not None else None


async def snapshot(db: AsyncSession, user: User) -> Snapshot:
    """O cadastro agora, campo a campo (sem ir ao banco a não ser pelo nome do grupo e, com
    ferramenta marcada, pelos nomes delas)."""
    team = await db.get(Team, user.team_id) if user.team_id else None
    tools = await tech_profile.user_tools(db, user)
    key_type, key = user.pix_key_type, user.pix_key
    has_pix = bool(key_type and key)
    return {
        "name": _same(user.name),
        "email": ((user.email or "").lower(), user.email),
        "phone": _same(user.phone),
        "job_title": _same(user.job_title),
        "team": (user.team_id, team.name if team else None),
        "is_active": (bool(user.is_active), "Liberado" if user.is_active else "Bloqueado"),
        "role": _role(user.role),
        "home_city": _same(user.home_city),
        "home_state": _same(user.home_state),
        "coverage_area": _same(user.coverage_area),
        "address_line": _same(user.address_line),
        "address_district": _same(user.address_district),
        "address_zip": _same(user.address_zip),
        "work_schedule": _schedule(user.work_schedule),
        "services": _services(user.service_type_ids),
        "pix": (
            (str(key_type), key) if key_type and key else None,
            pix.describe(key_type, key) if key_type and key else None,
        ),
        "pix_holder": _same(user.pix_holder_name if has_pix else None),
        "tools": _tools(user, tools),
        "availability": (tech_profile.slot_set(user), _slots_text),
        "transport": _transport(user),
        "skills": (tech_profile.skill_set(user.skills or []), _skills_text),
        "education": (tech_profile.education_set(user.education or []), _education_text),
    }


def diff(before: Snapshot, after: Snapshot) -> list[dict[str, Any]]:
    """As mudanças entre duas fotos do cadastro, na ordem dos campos. Nos DELTA_FIELDS, "from" é
    o que saiu e "to" o que entrou."""
    changes: list[dict[str, Any]] = []
    for key, (value, text) in after.items():
        if key not in before or before[key][0] == value:
            continue
        old, old_text = before[key]
        if key in DELTA_FIELDS:
            changes.append({"field": key, "from": old_text(old - value), "to": text(value - old)})
        else:
            changes.append({"field": key, "from": old_text, "to": text})
    return changes


def record(
    db: AsyncSession,
    user: User,
    changes: list[dict[str, Any]],
    *,
    via: str,
    actor: User | None,
) -> UserChange | None:
    """Uma linha no histórico (nada quando não há mudança). Grava junto com a mudança (o commit é
    de quem chamou)."""
    if not changes:
        return None
    row = UserChange(
        id=uuid.uuid4(),
        user_id=user.id,
        actor_id=actor.id if actor else None,
        via=via,
        changes=changes,
        created_at=utcnow(),
    )
    db.add(row)
    return row


async def track(
    db: AsyncSession,
    user: User,
    before: Snapshot,
    *,
    via: str,
    actor: User | None,
    extra: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Compara com o cadastro de agora, grava o que mudou (mais as mudanças especiais, como a senha
    ou a foto) e devolve as mudanças."""
    changes = [*diff(before, await snapshot(db, user)), *(extra or [])]
    record(db, user, changes, via=via, actor=actor)
    return changes


def event_fields(changes: list[dict[str, Any]]) -> list[str]:
    """Os campos do aviso, sem repetir (o titular conta como "pix")."""
    fields: list[str] = []
    for change in changes:
        name = _EVENT_FIELD.get(change["field"], change["field"])
        if name not in fields:
            fields.append(name)
    return fields


async def list_changes(db: AsyncSession, user_id: uuid.UUID, limit: int = 50) -> list[UserChange]:
    """O histórico do cadastro, do mais novo para o mais antigo."""
    rows = await db.scalars(
        select(UserChange)
        .where(UserChange.user_id == user_id)
        .order_by(UserChange.created_at.desc(), UserChange.id.desc())
        .limit(limit)
    )
    return list(rows)


def _hidden(value: str | None) -> str | None:
    return None if value is None else PIX_HIDDEN


def hide_pix(rows: list[UserChange]) -> list[UserChangeOut]:
    """O histórico para quem tem Técnicos mas não Pagamentos: sem o titular e com a chave como "***"
    (null continua null: "cadastrada" e "removida" seguem legíveis). A troca só do titular vira
    "***" → "***" na chave, para a linha não ficar vazia. Devolve cópias: os objetos do banco ficam
    como estão."""
    out: list[UserChangeOut] = []
    for row in rows:
        full = UserChangeOut.model_validate(row)
        has_pix = any(item.field == "pix" for item in full.changes)
        changes: list[UserChangeItem] = []
        for item in full.changes:
            if item.field == "pix_holder":
                if not has_pix:
                    hidden = {"field": "pix", "from": PIX_HIDDEN, "to": PIX_HIDDEN}
                    changes.append(UserChangeItem.model_validate(hidden))
                    has_pix = True
            elif item.field == "pix":
                update = {"from_": _hidden(item.from_), "to": _hidden(item.to)}
                changes.append(item.model_copy(update=update))
            else:
                changes.append(item)
        out.append(full.model_copy(update={"changes": changes}))
    return out


def for_viewer(rows: list[UserChange], viewer: User) -> list[UserChange] | list[UserChangeOut]:
    """GET /technicians/{id}/changes: como está para quem tem Pagamentos (o cadastro mostra a
    seção Pagamento); para quem só tem Técnicos, `hide_pix`."""
    if permissions.of(viewer).can("commercial.payouts"):
        return rows
    return hide_pix(rows)


async def after_reset(
    db: AsyncSession, user: User, changes: list[dict[str, Any]]
) -> dict[str, str] | None:
    """Para o aviso da troca de e-mail ou de chave PIX pelo app: a redefinição de senha pela
    central (Técnicos ou Usuários) mais recente nas últimas 72 h, como {"by": quem redefiniu,
    "at": ISO}. None sem ela ou quando a troca não é de e-mail nem de PIX."""
    if not _RESET_ALERT_FIELDS.intersection(event_fields(changes)):
        return None
    row = await db.scalar(
        select(UserChange)
        .where(
            UserChange.user_id == user.id,
            UserChange.via == VIA_CENTRAL,
            UserChange.created_at >= utcnow() - RESET_ALERT_WINDOW,
            UserChange.changes.contains([{"field": "password"}]),
        )
        .order_by(UserChange.created_at.desc(), UserChange.id.desc())
        .limit(1)
    )
    if row is None:
        return None
    return {"by": row.actor.name if row.actor else "Sistema", "at": row.created_at.isoformat()}


async def publish_changed(
    user: User,
    changes: list[dict[str, Any]],
    *,
    via: str,
    actor: User | None,
    after_reset: dict[str, str] | None = None,
) -> None:
    """Depois do commit: avisa a central (quem tem Técnicos ou Pagamentos; o técnico e o cliente
    não recebem). `after_reset` (ver a função de mesmo nome) vai em data só quando existe. Falhar o
    aviso não desfaz a gravação."""
    from app.services.realtime import bus  # realtime puxa os modelos da OS: import tardio

    fields = event_fields(changes)
    if not fields:
        return
    data: dict[str, Any] = {"fields": fields, "via": via}
    if after_reset:
        data["after_reset"] = after_reset
    try:
        await bus.publish(
            {
                "type": EVENT,
                "user_id": str(user.id),
                "name": user.name,
                "actor_id": str(actor.id) if actor else None,
                "actor_name": actor.name if actor else "Sistema",
                "occurred_at": utcnow().isoformat(),
                "data": data,
                "audience": {"managers_only": True},
            }
        )
    except Exception:
        log.exception("Falha ao avisar a mudança no cadastro do técnico")
