"""Histórico do cadastro do técnico (tabela user_changes) e o aviso em tempo real à central.

Toda mudança no cadastro, pelo app (Meu cadastro), pela central (Técnicos, Usuários, Pagamentos),
pela aprovação da ficha (Homologação) ou pelo técnico no link do e-mail vira uma linha com quem
fez, por onde (`via`: app, central, ficha, link), o motivo quando a tela pede um (`note`: a situação
na operação) e as mudanças [{field, from, to}] já com o texto da tela:
- name, email, phone, phone_secondary, job_title, home_city, home_state, coverage_area,
  address_line (o logradouro), address_number, address_complement, address_district, address_zip,
  bio, company_name, company_trade_name, email_pending (o e-mail novo pedido no app, à espera do
  link): o valor como está;
- cpf "123.456.789-09"; rg "12.345.678-9 · SSP/SP"; birth_date "25/11/1990"; company_document
  "12.345.678/0001-95"; vehicle "Modelo Exemplo · ABC-1234" (o que houver);
- team: o nome do grupo; is_active (acesso ao app): "Liberado" ou "Sem acesso"; role: o rótulo do
  papel; operational_status: "Ativo", "Inativo" ou "Bloqueado" (o motivo vai em `note`);
  email_verified: "validado" ou "pendente";
- work_schedule: "08:00–17:00, intervalo 12:00–13:00"; services: "12 serviços";
- payout_preferred: a forma de recebimento preferencial MASCARADA ("PIX CPF ***.456.789-**",
  "Banco Exemplo ****5678-9"; core/payout.describe); muda quando outra forma vira a preferencial;
- avatar: to "nova" na troca e null na remoção; password: to "provisória" (redefinição em Técnicos),
  "definida pela central" (Usuários), "criada no app" (o técnico trocou a provisória) ou "trocada
  no app"; as linhas especiais de `record` (application, password pelo link, password_link) vêm de
  quem grava;
- DELTA_FIELDS gravam o que SAIU em "from" e o que ENTROU em "to" (null: nada), e não o de → para:
  payout_methods ("PIX CPF ***.456.789-** · Tecnico Alfa"; core/payout.describe_with_holder),
  unavailability ("20/12/2026 a 05/01/2027"; só os períodos que não acabaram) e o perfil técnico
  (o técnico muda no app; services/tech_profile.py): tools com os nomes em ordem alfabética
  ("Escada, Multímetro"), availability em turnos ("sáb · tarde e noite"), skills "Linux (Básico)"
  em ordem alfabética, education "Técnico em redes · Escola Exemplo · Técnico · desde 02/2024 (em
  andamento)" pelo início, separados por "; " (listas com mais de 10 itens: os 10 primeiros e " e
  mais N"); transport segue de → para, "Carro, Moto · com CNH", null quando não informado.
As linhas antigas de pix/pix_holder (a chave única de antes das formas de recebimento) continuam
legíveis. E-mail e celular ficam em claro (a central desfaz uma troca indevida); chave PIX e conta
nunca. Quem não tem Pagamentos lê o histórico com as formas de recebimento como "***" e sem o
titular (`hide_payout`). As partes do perfil técnico comparam como tech_profile.wanted (a rota do
app só grava com mudança no histórico).

Uso: `before = await snapshot(db, user)`, aplica, `changes = await track(db, user, before, ...)`
(ou `record` com as mudanças especiais) e, depois do commit, `publish_changed`. O `snapshot` faz
flush antes de ler (a sessão é autoflush=False): as formas de recebimento recém-gravadas contam.
"""

import logging
import uuid
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, NamedTuple

from sqlalchemy import DateTime, Uuid, literal, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import payout, permissions, pix
from app.core.enums import UserRole
from app.core.labels import ROLE_LABELS
from app.db.base import utcnow
from app.models import Team, TechnicianPayoutMethod, User, UserChange
from app.models.user_change import VIA_CENTRAL
from app.schemas import personal
from app.schemas.my_profile import UserChangeItem, UserChangeOut
from app.services import tech_profile, unavailability
from app.services.errors import WorkflowError

log = logging.getLogger(__name__)

EVENT = "profile.changed"

# GET /technicians/{id}/changes em páginas: `before` estragado (o nosso tem uns 70 caracteres).
CHANGES_PAGE_ERROR = "Página do histórico inválida. Recarregue a ficha."
CHANGES_BEFORE_MAX = 100

# Mudanças que não saem da comparação dos dados.
PHOTO_ADDED: dict[str, Any] = {"field": "avatar", "from": None, "to": "nova"}
PHOTO_REMOVED: dict[str, Any] = {"field": "avatar", "from": "anterior", "to": None}
PASSWORD_TEMPORARY: dict[str, Any] = {"field": "password", "from": None, "to": "provisória"}
PASSWORD_SET: dict[str, Any] = {"field": "password", "from": None, "to": "definida pela central"}
# POST /auth/change-password do técnico: a provisória trocada pela dele, ou a dele trocada.
PASSWORD_CREATED: dict[str, Any] = {"field": "password", "from": None, "to": "criada no app"}
PASSWORD_CHANGED: dict[str, Any] = {"field": "password", "from": None, "to": "trocada no app"}

# Campo do histórico -> campo do aviso: os nomes crus, menos o titular das linhas antigas de PIX
# (fazia parte da chave).
_EVENT_FIELD = {"pix_holder": "pix"}

# Troca de e-mail, de forma de recebimento ou do CNPJ pelo app até 72 h depois de a central
# redefinir a senha: o aviso diz quem redefiniu e quando. Não bloqueia (o técnico novo recebe a
# senha da central e precisa cadastrar onde recebe), só sinaliza: quem redefiniu também conheceu a
# senha. O CNPJ entra porque decide se o titular da conta é "diferente".
RESET_ALERT_WINDOW = timedelta(hours=72)
_RESET_ALERT_FIELDS = frozenset(
    {"pix", "email", "email_pending", "payout_methods", "payout_preferred", "company_document"}
)

# As formas de recebimento no histórico de quem não tem Pagamentos.
PIX_HIDDEN = "***"
_PAYOUT_FIELDS = frozenset({"pix", "payout_methods", "payout_preferred"})

# Partes em lista: "from" = o que saiu, "to" = o que entrou.
DELTA_FIELDS = frozenset(
    {"tools", "availability", "skills", "education", "payout_methods", "unavailability"}
)
# Ferramenta marcada que não está mais no catálogo (a API não exclui; só apagando no banco).
TOOL_GONE = "Ferramenta removida"

# Acesso ao app (users.is_active) e situação na operação (= OPERATIONAL_STATUS e APP_ACCESS de
# lib/constants.ts).
ACCESS_ON, ACCESS_OFF = "Liberado", "Sem acesso"
OPERATIONAL_LABELS = {"active": "Ativo", "inactive": "Inativo", "blocked": "Bloqueado"}
EMAIL_VERIFIED, EMAIL_UNVERIFIED = "validado", "pendente"

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


# ------------------------------------------------------------- dados pessoais e da empresa


def _rg(user: User) -> tuple[Any, str | None]:
    value = (user.rg_number, user.rg_issuer, user.rg_state)
    if not any(value):
        return None, None
    return value, personal.format_rg(*value)


def _vehicle(user: User) -> tuple[Any, str | None]:
    model, plate = user.vehicle_model or None, user.vehicle_plate or None
    if model is None and plate is None:
        return None, None
    text = " · ".join(part for part in (model, personal.format_plate(plate)) if part)
    return (model, plate), text


def _email_pending(user: User) -> tuple[Any, str | None]:
    pending = user.email_pending or None
    return (pending.lower() if pending else None), pending


# ------------------------------------------------------------- formas de recebimento


class _Method(NamedTuple):
    """Uma forma de recebimento como o histórico compara: tudo o que a tela mostra ou o destino do
    pagamento usa (o id não: trocar a chave é sair uma e entrar outra)."""

    kind: str
    pix_key_type: str | None
    pix_key: str | None
    bank_code: str | None
    bank_name: str | None
    branch: str | None
    account_number: str | None
    account_digit: str | None
    account_type: str | None
    holder_name: str | None
    holder_document: str | None


def _method(row: TechnicianPayoutMethod) -> _Method:
    def text(value: Any) -> str | None:
        return None if value is None else str(value)

    return _Method(
        kind=str(row.kind),
        pix_key_type=text(row.pix_key_type),
        pix_key=row.pix_key,
        bank_code=row.bank_code,
        bank_name=row.bank_name,
        branch=row.branch,
        account_number=row.account_number,
        account_digit=row.account_digit,
        account_type=text(row.account_type),
        holder_name=row.holder_name,
        holder_document=row.holder_document,
    )


def _masked_document(document: str | None) -> str | None:
    """O CPF ou o CNPJ do titular mascarado, como a chave PIX ("CPF ***.456.789-**")."""
    if not document:
        return None
    if len(document) == 11:
        return pix.describe("cpf", document)
    if len(document) == 14:
        return pix.describe("cnpj", document)
    return None


def _methods_text(items: Iterable[_Method]) -> str | None:
    return tech_profile.items_text(sorted(payout.describe_with_holder(m) for m in items), "; ")


def _methods_text_with_document(items: Iterable[_Method]) -> str | None:
    """Quando só o documento do titular mudou, o texto de sempre sairia igual dos dois lados: aí
    vai também o documento mascarado."""
    labels = []
    for method in items:
        text = payout.describe_with_holder(method)
        document = _masked_document(method.holder_document)
        labels.append(f"{text} · {document}" if document else text)
    return tech_profile.items_text(sorted(labels), "; ")


def _periods_text(items: Iterable[tuple[str, str]]) -> str | None:
    labels = [unavailability.period_text({"start": s, "end": e}) for s, e in sorted(items)]
    return tech_profile.items_text(labels, "; ")


# Nos DELTA_FIELDS em que o texto de sempre pode não mostrar a diferença.
_DETAILED_TEXT: dict[str, ItemsText] = {"payout_methods": _methods_text_with_document}


async def _payout_rows(db: AsyncSession, user_id: uuid.UUID) -> list[TechnicianPayoutMethod]:
    return list(
        await db.scalars(
            select(TechnicianPayoutMethod).where(TechnicianPayoutMethod.user_id == user_id)
        )
    )


async def snapshot(db: AsyncSession, user: User) -> Snapshot:
    """O cadastro agora, campo a campo. Vai ao banco pelo nome do grupo, pelas formas de
    recebimento e, com ferramenta marcada, pelos nomes delas; antes, flush (a sessão é
    autoflush=False: o que a gravação acabou de mudar precisa estar no banco)."""
    await db.flush()
    team = await db.get(Team, user.team_id) if user.team_id else None
    tools = await tech_profile.user_tools(db, user)
    methods = await _payout_rows(db, user.id)
    preferred = next((m for m in methods if m.preferred), None)
    periods = unavailability.current(user.unavailability or [], personal.local_today())
    status = str(user.operational_status) if user.operational_status else None
    return {
        "name": _same(user.name),
        "email": ((user.email or "").lower(), user.email),
        "email_pending": _email_pending(user),
        "email_verified": (
            user.email_verified_at is not None,
            EMAIL_VERIFIED if user.email_verified_at is not None else EMAIL_UNVERIFIED,
        ),
        "phone": _same(user.phone),
        "phone_secondary": _same(user.phone_secondary),
        "cpf": (user.cpf, personal.format_cpf(user.cpf)),
        "rg": _rg(user),
        "birth_date": (user.birth_date, personal.format_date(user.birth_date)),
        "job_title": _same(user.job_title),
        "team": (user.team_id, team.name if team else None),
        "is_active": (bool(user.is_active), ACCESS_ON if user.is_active else ACCESS_OFF),
        "operational_status": (status, OPERATIONAL_LABELS.get(status or "", status)),
        "role": _role(user.role),
        "home_city": _same(user.home_city),
        "home_state": _same(user.home_state),
        "coverage_area": _same(user.coverage_area),
        "address_line": _same(user.address_line),
        "address_number": _same(user.address_number),
        "address_complement": _same(user.address_complement),
        "address_district": _same(user.address_district),
        "address_zip": _same(user.address_zip),
        "bio": _same(user.bio),
        "company_document": (user.company_document, personal.format_cnpj(user.company_document)),
        "company_name": _same(user.company_name),
        "company_trade_name": _same(user.company_trade_name),
        "work_schedule": _schedule(user.work_schedule),
        "services": _services(user.service_type_ids),
        "payout_methods": (frozenset(_method(m) for m in methods), _methods_text),
        "payout_preferred": (
            preferred.id if preferred else None,
            payout.describe(preferred) if preferred else None,
        ),
        "unavailability": (frozenset((p["start"], p["end"]) for p in periods), _periods_text),
        "tools": _tools(user, tools),
        "availability": (tech_profile.slot_set(user), _slots_text),
        "transport": _transport(user),
        "vehicle": _vehicle(user),
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
            gone, came = old - value, value - old
            frm, to = old_text(gone), text(came)
            if frm == to and key in _DETAILED_TEXT:
                frm, to = _DETAILED_TEXT[key](gone), _DETAILED_TEXT[key](came)
            changes.append({"field": key, "from": frm, "to": to})
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
    note: str | None = None,
) -> UserChange | None:
    """Uma linha no histórico (nada quando não há mudança), com o motivo (`note`) quando a tela pede
    um. Grava junto com a mudança (o commit é de quem chamou)."""
    if not changes:
        return None
    row = UserChange(
        id=uuid.uuid4(),
        user_id=user.id,
        actor_id=actor.id if actor else None,
        via=via,
        changes=changes,
        note=note or None,
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
    note: str | None = None,
) -> list[dict[str, Any]]:
    """Compara com o cadastro de agora, grava o que mudou (mais as mudanças especiais, como a senha
    ou a foto, e o motivo em `note`) e devolve as mudanças."""
    changes = [*diff(before, await snapshot(db, user)), *(extra or [])]
    record(db, user, changes, via=via, actor=actor, note=note)
    return changes


def event_fields(changes: list[dict[str, Any]]) -> list[str]:
    """Os campos do aviso, sem repetir: os nomes crus (o titular das linhas antigas de PIX conta
    como "pix")."""
    fields: list[str] = []
    for change in changes:
        name = _EVENT_FIELD.get(change["field"], change["field"])
        if name not in fields:
            fields.append(name)
    return fields


def parse_before(before: str) -> tuple[datetime, uuid.UUID]:
    """O `before` de GET /technicians/{id}/changes: "{created_at ISO 8601 com fuso}|{id}" da última
    linha recebida, com a data em UTC. Estragado (tamanho, separador, data sem fuso ou fora da
    faixa, id): 422 com CHANGES_PAGE_ERROR."""
    if len(before) > CHANGES_BEFORE_MAX:
        raise WorkflowError(CHANGES_PAGE_ERROR)
    try:
        at_text, id_text = before.split("|")
        parsed = datetime.fromisoformat(at_text)
        row_id = uuid.UUID(id_text)
        # Sem fuso a conversão usaria o do servidor: fica None e vira erro logo abaixo.
        at = parsed.astimezone(UTC) if parsed.tzinfo is not None else None
    # A data que não cabe em UTC (o ano 1 com +14:00, o 9999 com -14:00) é OverflowError.
    except (ValueError, OverflowError) as exc:
        raise WorkflowError(CHANGES_PAGE_ERROR) from exc
    if at is None:
        raise WorkflowError(CHANGES_PAGE_ERROR)
    return at, row_id


async def list_changes(
    db: AsyncSession, user_id: uuid.UUID, limit: int = 50, before: str | None = None
) -> list[UserChange]:
    """O histórico do cadastro, do mais novo para o mais antigo, `limit` linhas por vez. Com
    `before` (parse_before), só as linhas mais antigas que a última recebida: a página seguinte,
    sem repetir nem pular linha, também com várias no mesmo instante (o id desempata)."""
    stmt = (
        select(UserChange)
        .where(UserChange.user_id == user_id)
        .order_by(UserChange.created_at.desc(), UserChange.id.desc())
        .limit(limit)
    )
    if before:
        at, row_id = parse_before(before)
        stmt = stmt.where(
            tuple_(UserChange.created_at, UserChange.id)
            < tuple_(literal(at, DateTime(timezone=True)), literal(row_id, Uuid()))
        )
    return list(await db.scalars(stmt))


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
