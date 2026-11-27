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
  "Banco Exemplo ****5678-9"; core/payout.describe); muda quando outra forma vira a preferencial.
  Com a mesma máscara dos dois lados, vão também o titular e o documento dele mascarado e, se ainda
  sair igual, " (outra forma)" no "to";
- avatar: to "nova" na troca e null na remoção; password: to "provisória" (redefinição em Técnicos),
  "definida pela central" (Usuários), "criada no app" (o técnico trocou a provisória) ou "trocada
  no app"; as linhas especiais de `record` (application, password pelo link, password_link) vêm de
  quem grava;
- DELTA_FIELDS gravam o que SAIU em "from" e o que ENTROU em "to" (null: nada), e não o de → para:
  payout_methods ("PIX CPF ***.456.789-** · Tecnico Alfa"; core/payout.describe_with_holder; quando
  o destino muda sem mudar a máscara, o texto diz o que mudou sem abrir o dado: o documento do
  titular mascarado, o tipo de conta e a agência pelo rótulo ("Conta corrente" → "Conta poupança",
  "Ag. 0001" → "Ag. 0002"), o código do banco ("banco 999") e "outra conta", "outra chave" ou
  "outro documento" só no "to"; `_methods_delta`),
  unavailability ("20/12/2026 a 05/01/2027"; só os períodos que não acabaram) e o perfil técnico
  (o técnico no app e a central; services/tech_profile.py): tools com os nomes em ordem
  alfabética ("Escada, Multímetro"), availability em turnos ("sáb · tarde e noite"), skills
  "Linux (Básico)" em ordem alfabética (o nome atual do catálogo; o que saiu dele, "Aptidão
  removida"), areas pelos nomes em ordem alfabética ("Área removida"), education "Técnico em
  redes · Escola Exemplo · Técnico · desde 02/2024 (em andamento)" pelo início, separados por
  "; " (listas com mais de 10 itens: os 10 primeiros e " e mais N"); transport segue de → para,
  "Carro, Moto · com CNH", null quando não informado;
- as linhas de `record` com a frase em "to" ("from" null): documents e internal_attachments (os
  documentos do técnico e os anexos internos, services/technician_documents.py), ratings (as
  avaliações do cliente, services/technician_ratings.py) e favorites (as decisões de favorito por
  cidade, services/technician_favorites.py, com a nota do pedido em `note`).
As linhas antigas de pix/pix_holder (a chave única de antes das formas de recebimento) continuam
legíveis. E-mail e celular ficam em claro (a central desfaz uma troca indevida); chave PIX e conta
nunca. Quem não tem Pagamentos lê o histórico com as formas de recebimento como "***" e sem o
titular (`hide_payout`); quem não tem Técnicos em Editar, os anexos internos como "***"
(`hide_internal`). As partes do perfil técnico comparam como tech_profile.wanted (a rota só grava
com mudança no histórico).

Uso: `before = await snapshot(db, user)`, aplica, `changes = await track(db, user, before, ...)`
(ou `record` com as mudanças especiais) e, depois do commit, `publish_changed`: o aviso
profile.changed vai à central e, quando a mudança não veio do app e é de algo que o app mostra
(APP_FIELDS), o me.profile_changed vai só ao técnico (o app relê GET /me/profile). O `snapshot` faz
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
from app.models.user_change import VIA_APP, VIA_CENTRAL
from app.schemas import personal
from app.schemas.my_profile import UserChangeItem, UserChangeOut
from app.services import tech_profile, unavailability
from app.services.errors import WorkflowError
from app.services.technician_catalogs import CatalogInfo

log = logging.getLogger(__name__)

EVENT = "profile.changed"
# Só para o técnico (o app relê GET /me/profile): a central, a aprovação da ficha ou o link do
# e-mail mudou algo que o app mostra. Sem dados (= ME_PROFILE_EVENT de lib/constants.ts).
ME_EVENT = "me.profile_changed"
# Os campos do histórico que o app mostra (MyProfile): o me.profile_changed vai quando algum deles
# muda por outro caminho que não o app. Nunca pela situação, pelo acesso, pela senha, pelos
# favoritos, pelas avaliações nem pelos anexos internos (o técnico é terceiro).
APP_FIELDS = frozenset(
    {
        "name",
        "email",
        "email_pending",
        "email_verified",
        "phone",
        "phone_secondary",
        "cpf",
        "rg",
        "birth_date",
        "job_title",
        "team",
        "home_city",
        "home_state",
        "coverage_area",
        "address_line",
        "address_number",
        "address_complement",
        "address_district",
        "address_zip",
        "bio",
        "company_document",
        "company_name",
        "company_trade_name",
        "vehicle",
        "unavailability",
        "tools",
        "availability",
        "transport",
        "skills",
        "education",
        "areas",
        "documents",
        "avatar",
        "payout_methods",
        "payout_preferred",
    }
)

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
# Os anexos internos no histórico de quem não tem Técnicos em Editar (a tela diz "Anexos internos
# alterados").
INTERNAL_FIELD = "internal_attachments"
INTERNAL_HIDDEN = "***"

# Partes em lista: "from" = o que saiu, "to" = o que entrou.
DELTA_FIELDS = frozenset(
    {"tools", "availability", "skills", "education", "areas", "payout_methods", "unavailability"}
)
# Item guardado que não está mais no catálogo (excluir só vale para o que nunca foi usado: só
# apagando no banco).
TOOL_GONE = "Ferramenta removida"
SKILL_GONE = "Aptidão removida"
AREA_GONE = "Área removida"

# O destino do pagamento mudou sem mudar a máscara: as marcas neutras do "to" (o dado não aparece)
# e o último recurso, quando nada do que se pode mostrar difere.
OTHER_ACCOUNT, OTHER_KEY, OTHER_DOCUMENT = "outra conta", "outra chave", "outro documento"
PAYOUT_DATA_CHANGED = "dados alterados"
OTHER_PREFERRED = " (outra forma)"
# Chaves auxiliares do snapshot (começam com "_"): o que o texto detalhado precisa e o diff não
# lista. Aqui, a forma preferencial inteira (payout_preferred compara só o id).
_AUX = "_"
_PREFERRED_METHOD = "_payout_preferred_method"

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


def _names_text(catalog: Mapping[str, CatalogInfo], gone: str) -> ItemsText:
    """Os ids pelos nomes do catálogo, em ordem alfabética (o que saiu do catálogo: `gone`)."""

    def text(ids: Iterable[str]) -> str | None:
        names = [catalog[key].name if key in catalog else gone for key in ids]
        return tech_profile.items_text(_alphabetical(names))

    return text


def _tools(user: User, catalog: Mapping[str, CatalogInfo]) -> tuple[Any, ItemsText]:
    return tech_profile.tool_set(user), _names_text(catalog, TOOL_GONE)


def _areas(user: User, catalog: Mapping[str, CatalogInfo]) -> tuple[Any, ItemsText]:
    return tech_profile.area_set(user.service_areas), _names_text(catalog, AREA_GONE)


def _slots_text(slots: Iterable[str]) -> str | None:
    return tech_profile.slots_text(slots) or None


def _skills(user: User, catalog: Mapping[str, CatalogInfo]) -> tuple[Any, ItemsText]:
    """(skill_id, nível) de cada aptidão; o texto pelo nome atual do catálogo: "Linux (Básico)"."""

    def text(items: Iterable[tuple[Any, Any]]) -> str | None:
        labels = [
            tech_profile.skill_label(
                {"name": catalog[key].name if key in catalog else SKILL_GONE, "level": level}
            )
            for key, level in items
        ]
        return tech_profile.items_text(_alphabetical(labels))

    return tech_profile.skill_set(user.skills or []), text


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


def _method_detail(method: _Method) -> str:
    """A forma com o titular e o documento dele mascarado ("PIX E-mail t***@exemplo.com · Tecnico
    Alfa · CPF ***.456.789-**")."""
    text = payout.describe_with_holder(method)
    document = _masked_document(method.holder_document)
    return f"{text} · {document}" if document else text


def _methods_text_with_document(items: Iterable[_Method]) -> str | None:
    return tech_profile.items_text(sorted(_method_detail(m) for m in items), "; ")


def _account_type(value: str | None) -> str:
    return payout.ACCOUNT_TYPE_LABELS.get(value or "", value or "")


def _method_marks(old: _Method, new: _Method) -> tuple[list[str], list[str]]:
    """O que mudou de uma forma para a outra (do mesmo tipo) e a máscara não mostra, sem abrir o
    dado: o código do banco, a agência e o tipo de conta pelo rótulo, dos dois lados; a conta, a
    chave e o documento do titular só com a marca neutra no que entrou."""
    gone: list[str] = []
    came: list[str] = []
    if new.kind == "bank":
        if old.bank_code != new.bank_code:
            gone.append(f"banco {old.bank_code}")
            came.append(f"banco {new.bank_code}")
        if old.branch != new.branch:
            gone.append(f"Ag. {old.branch}")
            came.append(f"Ag. {new.branch}")
        if old.account_type != new.account_type:
            gone.append(_account_type(old.account_type))
            came.append(_account_type(new.account_type))
        if (old.account_number, old.account_digit) != (new.account_number, new.account_digit):
            came.append(OTHER_ACCOUNT)
    elif (old.pix_key_type, old.pix_key) != (new.pix_key_type, new.pix_key):
        came.append(OTHER_KEY)
    if old.holder_document != new.holder_document:
        came.append(OTHER_DOCUMENT)
    return gone, came


def _with_marks(text: str | None, marks: list[str]) -> str | None:
    return " · ".join([text, *marks]) if text is not None and marks else text


def _methods_delta(
    gone: frozenset[_Method], came: frozenset[_Method]
) -> tuple[str | None, str | None]:
    """O texto de uma mudança nas formas de recebimento: o que saiu ("from") e o que entrou ("to").
    Quando o texto de sempre sai igual dos dois lados (o destino mudou sem mudar a máscara), vai
    também o documento do titular mascarado; ainda igual, numa forma trocada por outra do mesmo
    tipo (a edição troca uma por uma), o que mudou (_method_marks); e, se nada do que se pode
    mostrar difere, "dados alterados" no que entrou. Nunca a chave ou a conta inteira."""
    frm, to = _methods_text(gone), _methods_text(came)
    if frm != to:
        return frm, to
    detailed = _methods_text_with_document(gone), _methods_text_with_document(came)
    if detailed[0] != detailed[1]:
        return detailed
    if len(gone) == 1 and len(came) == 1:
        [old], [new] = gone, came
        if old.kind == new.kind:
            marks_gone, marks_came = _method_marks(old, new)
            frm, to = _with_marks(frm, marks_gone), _with_marks(to, marks_came)
    if frm == to:
        to = _with_marks(to, [PAYOUT_DATA_CHANGED])
    return frm, to


def _preferred_texts(
    old: _Method | None, new: _Method | None, frm: str | None, to: str | None
) -> tuple[str | None, str | None]:
    """payout_preferred com a mesma máscara dos dois lados (outra forma virou a preferencial):
    com o titular e o documento dele mascarado; se ainda sair igual, " (outra forma)" no "to"."""
    if old is not None and new is not None:
        frm, to = _method_detail(old), _method_detail(new)
    if frm == to and to is not None:
        to = f"{to}{OTHER_PREFERRED}"
    return frm, to


def _periods_text(items: Iterable[tuple[str, str]]) -> str | None:
    labels = [unavailability.period_text({"start": s, "end": e}) for s, e in sorted(items)]
    return tech_profile.items_text(labels, "; ")


async def _payout_rows(db: AsyncSession, user_id: uuid.UUID) -> list[TechnicianPayoutMethod]:
    return list(
        await db.scalars(
            select(TechnicianPayoutMethod).where(TechnicianPayoutMethod.user_id == user_id)
        )
    )


async def snapshot(db: AsyncSession, user: User) -> Snapshot:
    """O cadastro agora, campo a campo. Vai ao banco pelo nome do grupo, pelas formas de
    recebimento e, com ferramenta, aptidão ou área guardada, pelos nomes delas (só os ids do
    técnico: technician_catalogs.picked); antes, flush (a sessão é autoflush=False: o que a
    gravação acabou de mudar precisa estar no banco)."""
    await db.flush()
    team = await db.get(Team, user.team_id) if user.team_id else None
    tools = await tech_profile.user_tools(db, user)
    skills = await tech_profile.user_skills(db, user)
    areas = await tech_profile.user_areas(db, user)
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
        _PREFERRED_METHOD: (_method(preferred) if preferred else None, None),
        "unavailability": (frozenset((p["start"], p["end"]) for p in periods), _periods_text),
        "tools": _tools(user, tools),
        "availability": (tech_profile.slot_set(user), _slots_text),
        "transport": _transport(user),
        "vehicle": _vehicle(user),
        "skills": _skills(user, skills),
        "education": (tech_profile.education_set(user.education or []), _education_text),
        "areas": _areas(user, areas),
    }


def diff(before: Snapshot, after: Snapshot) -> list[dict[str, Any]]:
    """As mudanças entre duas fotos do cadastro, na ordem dos campos. Nos DELTA_FIELDS, "from" é
    o que saiu e "to" o que entrou. Nas formas de recebimento, a linha não sai com "from" igual a
    "to": com a mesma máscara, o texto diz o que mudou (_methods_delta e _preferred_texts). As
    chaves auxiliares ("_…") não entram."""
    changes: list[dict[str, Any]] = []
    for key, (value, text) in after.items():
        if key.startswith(_AUX) or key not in before or before[key][0] == value:
            continue
        old, old_text = before[key]
        if key == "payout_methods":
            frm, to = _methods_delta(old - value, value - old)
        elif key in DELTA_FIELDS:
            frm, to = old_text(old - value), text(value - old)
        elif key == "payout_preferred" and old_text == text:
            frm, to = _preferred_texts(
                before.get(_PREFERRED_METHOD, (None, None))[0],
                after.get(_PREFERRED_METHOD, (None, None))[0],
                old_text,
                text,
            )
        else:
            frm, to = old_text, text
        changes.append({"field": key, "from": frm, "to": to})
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
    db: AsyncSession,
    user_id: uuid.UUID,
    limit: int = 50,
    before: str | None = None,
    field: str | None = None,
) -> list[UserChange]:
    """O histórico do cadastro, do mais novo para o mais antigo, `limit` linhas por vez. Com
    `before` (parse_before), só as linhas mais antigas que a última recebida: a página seguinte,
    sem repetir nem pular linha, também com várias no mesmo instante (o id desempata). Com `field`
    (o nome cru, "operational_status"), só as linhas que mudaram esse campo (a linha vem
    inteira)."""
    stmt = (
        select(UserChange)
        .where(UserChange.user_id == user_id)
        .order_by(UserChange.created_at.desc(), UserChange.id.desc())
        .limit(limit)
    )
    if field:
        stmt = stmt.where(UserChange.changes.contains([{"field": field}]))
    if before:
        at, row_id = parse_before(before)
        stmt = stmt.where(
            tuple_(UserChange.created_at, UserChange.id)
            < tuple_(literal(at, DateTime(timezone=True)), literal(row_id, Uuid()))
        )
    return list(await db.scalars(stmt))


def _hidden(value: str | None) -> str | None:
    return None if value is None else PIX_HIDDEN


def hide_payout(rows: list[UserChange]) -> list[UserChangeOut]:
    """O histórico para quem tem Técnicos mas não Pagamentos: as formas de recebimento (e a chave
    PIX das linhas antigas) como "***" e sem o titular (null continua null: "cadastrada" e
    "removida" seguem legíveis; a tela diz "Formas de recebimento alteradas"). A troca só do
    titular de uma linha antiga vira "***" → "***" na chave, para a linha não ficar vazia. Devolve
    cópias: os objetos do banco ficam como estão."""
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
            elif item.field in _PAYOUT_FIELDS:
                update = {"from_": _hidden(item.from_), "to": _hidden(item.to)}
                changes.append(item.model_copy(update=update))
            else:
                changes.append(item)
        out.append(full.model_copy(update={"changes": changes}))
    return out


def hide_internal(rows: list[UserChangeOut]) -> list[UserChangeOut]:
    """O histórico para quem não tem Técnicos em Editar: os itens dos anexos internos com "from"
    e "to" como "***" (null continua null; a tela diz "Anexos internos alterados"). Devolve
    cópias."""

    def masked(value: str | None) -> str | None:
        return None if value is None else INTERNAL_HIDDEN

    out: list[UserChangeOut] = []
    for row in rows:
        changes = [
            item.model_copy(update={"from_": masked(item.from_), "to": masked(item.to)})
            if item.field == INTERNAL_FIELD
            else item
            for item in row.changes
        ]
        out.append(row.model_copy(update={"changes": changes}))
    return out


def for_viewer(rows: list[UserChange], viewer: User) -> list[UserChange] | list[UserChangeOut]:
    """GET /technicians/{id}/changes: como está para quem tem Pagamentos e Técnicos em Editar; sem
    Pagamentos, `hide_payout` (a ficha não mostra as Formas de recebimento); sem Técnicos em
    Editar, `hide_internal` (os anexos internos são só de quem edita)."""
    access = permissions.of(viewer)
    payouts = access.can("commercial.payouts")
    edit = access.can("base.technicians", "edit")
    if payouts and edit:
        return rows
    out = [UserChangeOut.model_validate(row) for row in rows] if payouts else hide_payout(rows)
    return out if edit else hide_internal(out)


async def after_reset(
    db: AsyncSession, user: User, changes: list[dict[str, Any]]
) -> dict[str, str] | None:
    """Para o aviso da troca de e-mail (ou do pedido de troca), de forma de recebimento ou do CNPJ
    pelo app: a redefinição de senha pela central (Técnicos ou Usuários) mais recente nas últimas
    72 h, como {"by": quem redefiniu, "at": ISO}. None sem ela ou quando a troca não é de nenhum
    desses campos."""
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
    """Depois do commit: avisa a central (profile.changed, para quem tem Técnicos ou Pagamentos;
    o técnico e o cliente não recebem). `after_reset` (ver a função de mesmo nome) vai em data só
    quando existe. Com `via` diferente de "app" (a central, a aprovação da ficha, o link do e-mail)
    e algum campo de APP_FIELDS, avisa também o técnico: me.profile_changed endereçado só a ele,
    sem dados nem quem fez (o app relê GET /me/profile). Falhar um aviso não desfaz a gravação nem
    segura o outro."""
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
    if via == VIA_APP or APP_FIELDS.isdisjoint(fields):
        return
    try:
        await bus.publish(
            {
                "type": ME_EVENT,
                "occurred_at": utcnow().isoformat(),
                "data": {},
                "audience": {"user_ids": [str(user.id)]},
            }
        )
    except Exception:
        log.exception("Falha ao avisar o técnico da mudança no cadastro")
