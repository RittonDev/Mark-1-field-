"""Elo por pontos, Etapa 1: Configurações › Elo (services/level_rules.py e /level-rules).

As funções puras (padrões do QA, divisas das categorias, textos, validações e saldo mínimo) rodam
sem banco; as rotas (guardas, estado, aprovação, versão, histórico e quem confirma) contra o
PostgreSQL dos testes, que nasce sem a linha level.rules (a primeira gravação grava o seed antes).
"""

import copy
import re
import uuid
from typing import Any, get_args

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core import permissions
from app.core.config import settings
from app.core.enums import LevelTier, UserRole
from app.core.labels import LEVEL_ENTRY_KIND_LABELS
from app.core.security import hash_password
from app.models import LevelRuleChange, SystemSetting, User
from app.schemas.level_rules import RULE_KEYS, RULE_LABELS, LevelRuleKey
from app.schemas.technician_level import MyLevel
from app.services import level_rules as lr
from app.services.errors import CodedError
from tests.conftest import World, requires_db

API = settings.API_PREFIX
T = LevelTier
DEFINE = [
    "completion_gain",
    "on_time_gain",
    "late",
    "min_balance",
    "arrival_tolerance",
    "arrival_time",
]
APPROVE = [
    "count_bands",
    "points_bands",
    "opening_bonus",
    "abandonment_loss",
    "rework_loss",
    "confirmers",
    "app_reasons",
]
# Os valores que faltam (só para os testes: a operação é quem decide).
FILLED = {
    "completion_gain": 7,
    "on_time_gain": 3,
    "late": {"mode": "deduct", "points": 4},
    "min_balance": "negative",
    "arrival_tolerance": 15,
    "arrival_time": "server",
}


def _numbers(value: Any) -> list[int]:
    if isinstance(value, bool):
        return []
    if isinstance(value, int):
        return [value]
    if isinstance(value, dict):
        return [n for item in value.values() for n in _numbers(item)]
    if isinstance(value, list):
        return [n for item in value for n in _numbers(item)]
    return []


# ------------------------------------------------------------------ puras


def test_keys_labels_and_kinds() -> None:
    assert RULE_KEYS == get_args(LevelRuleKey) == tuple(RULE_LABELS)
    assert len(RULE_KEYS) == 13 and RULE_KEYS[-2:] == ("confirmers", "app_reasons")
    assert RULE_LABELS["late"] == "Chegada fora do SLA"
    assert RULE_LABELS["confirmers"] == "Quem confirma abandono e retorno"
    # Os limites que a web lê (sem "_" nos números) e os do livro.
    assert (lr.COUNT_MAX, lr.POINTS_MAX, lr.GAIN_MAX, lr.LOSS_MAX) == (100000, 1000000, 1000, 10000)
    assert (lr.ABANDONMENT_MIN, lr.REWORK_MIN, lr.TOLERANCE_MAX) == (80, 50, 240)
    assert (lr.ADJUST_MAX, lr.REASON_MIN, lr.REASON_MAX) == (10000, 10, 500)
    assert lr.SETTING_KEY == "level.rules"
    assert list(LEVEL_ENTRY_KIND_LABELS.values()) == [
        "Abertura",
        "Atendimento concluído",
        "Chegada dentro do SLA",
        "Chegada fora do SLA",
        "Abandono confirmado",
        "Retorno com falha confirmada",
        "Ajuste excepcional",
        "Estorno",
        "Recategorização",
    ]
    # "Elo: confirmar ocorrências": Sem acesso ou Editar; supervisor sim, analista e perfil novo não.
    item = permissions.ITEM_BY_KEY["base.level_confirm"]
    assert (item.label, item.href, item.levels) == (
        "Elo: confirmar ocorrências",
        "/pendencias-elo",
        ("none", "edit"),
    )
    keys = list(permissions.ITEM_KEYS)
    assert keys.index("base.level_confirm") == keys.index("base.technicians") + 1
    assert permissions.ROLE_DEFAULTS["supervisor"]["base.level_confirm"] == "edit"
    assert permissions.ROLE_DEFAULTS["analyst"]["base.level_confirm"] == "none"
    assert permissions.FULL_ACCESS.level("base.level_confirm") == "edit"
    assert permissions.clamp("base.level_confirm", "view") == "none"


def test_defaults_are_the_qa_suggestions() -> None:
    """(1) As 5 sugestões do QA e os motivos no app desligados; as decisões pendentes vazias e os
    +10/+5/−10 da conversa em lugar nenhum."""
    doc = lr.default_doc()
    assert doc["version"] == 1 and doc["activated_at"] is None and doc["activated_by"] is None
    values = lr.values_of(doc)
    assert values == {
        "count_bands": {"silver": 51, "gold": 101, "diamond": 151},
        "points_bands": {"bronze": 100, "silver": 901, "gold": 1401, "diamond": 1850},
        "opening_bonus": 100,
        "completion_gain": None,
        "on_time_gain": None,
        "late": None,
        "abandonment_loss": 80,
        "rework_loss": 50,
        "min_balance": None,
        "arrival_tolerance": None,
        "arrival_time": None,
        "app_reasons": False,
    }
    assert "value" not in doc["items"]["confirmers"]
    assert {key for key, item in doc["items"].items() if item["origin"] == "qa"} == {
        "count_bands",
        "points_bands",
        "opening_bonus",
        "abandonment_loss",
        "rework_loss",
    }
    assert all(item["approved"] is None for item in doc["items"].values())
    assert not {10, 5, -10} & set(_numbers(doc))
    seed = lr.seed_changes()
    assert not any(re.search(r"\b(?:10|5) pontos\b", change["to"]) for change in seed)
    assert [change["item"] for change in seed] == APPROVE
    assert all(change["from"] is None for change in seed)
    # Cópia nova a cada chamada.
    doc["items"]["count_bands"]["value"]["silver"] = 1
    assert lr.default_doc()["items"]["count_bands"]["value"]["silver"] == 51


COUNTS = [
    (0, T.BRONZE),
    (50, T.BRONZE),
    (51, T.SILVER),
    (100, T.SILVER),
    (101, T.GOLD),
    (150, T.GOLD),
    (151, T.DIAMOND),
    (12000, T.DIAMOND),
]
BALANCES = [
    (-50, T.BRONZE),
    (0, T.BRONZE),
    (99, T.BRONZE),
    (100, T.BRONZE),
    (900, T.BRONZE),
    (901, T.SILVER),
    (1400, T.SILVER),
    (1401, T.GOLD),
    (1849, T.GOLD),
    (1850, T.DIAMOND),
    (10**9, T.DIAMOND),
]


@pytest.mark.parametrize(("count", "tier"), COUNTS)
def test_opening_tier_by_count(count: int, tier: LevelTier) -> None:
    """(2) Sem sobreposição: 50/100/150 ficam embaixo, 51/101/151 sobem."""
    assert lr.tier_for_count(lr.QA_VALUES["count_bands"], count) == tier


@pytest.mark.parametrize(("balance", "tier"), BALANCES)
def test_tier_by_balance(balance: int, tier: LevelTier) -> None:
    """(2) Abaixo da Prata é Bronze, mesmo negativo; o Diamante não tem teto."""
    assert lr.tier_for_balance(lr.QA_VALUES["points_bands"], balance) == tier


def test_openings_stay_inside_their_tier() -> None:
    bands = lr.QA_VALUES["points_bands"]
    openings = {tier: lr.opening_balance(bands, 100, tier) for tier in lr.TIERS}
    assert openings == {T.BRONZE: 200, T.SILVER: 1001, T.GOLD: 1501, T.DIAMOND: 1950}
    for tier, balance in openings.items():
        assert lr.tier_for_balance(bands, balance) == tier


def test_value_texts() -> None:
    values = {**lr.values_of(lr.default_doc()), **FILLED}
    text = lr.value_text
    assert text("count_bands", values) == (
        "Bronze 0 a 50 · Prata 51 a 100 · Ouro 101 a 150 · Diamante 151 ou mais"
    )
    assert text("points_bands", values) == (
        "Bronze 100 a 900 · Prata 901 a 1.400 · Ouro 1.401 a 1.849 · Diamante 1.850 ou mais"
    )
    assert text("opening_bonus", values) == (
        "100 pontos: Bronze 200 · Prata 1.001 · Ouro 1.501 · Diamante 1.950"
    )
    assert text("completion_gain", {"completion_gain": 10}) == "Ganha 10 pontos"
    assert text("completion_gain", {"completion_gain": 0}) == "Não gera pontos"
    assert text("on_time_gain", {"on_time_gain": 1}) == "Ganha 1 ponto"
    assert text("late", {"late": {"mode": "deduct", "points": 10}}) == "Desconta 10 pontos"
    assert text("late", {"late": {"mode": "no_gain", "points": None}}) == "Só deixa de ganhar"
    assert text("abandonment_loss", values) == "Perde 80 pontos"
    assert text("rework_loss", {"rework_loss": 1200}) == "Perde 1.200 pontos"
    assert text("min_balance", {"min_balance": "negative"}) == "Pode ficar negativo"
    assert text("min_balance", {"min_balance": "zero"}) == "Para em zero"
    assert text("arrival_tolerance", values) == "15 min"
    assert text("arrival_time", {"arrival_time": "server"}) == "Hora do servidor"
    assert text("arrival_time", {"arrival_time": "device"}) == "Hora do aparelho"
    assert text("app_reasons", {"app_reasons": False}) == "Desligado"
    assert text("app_reasons", {"app_reasons": True}) == "Ligado (sem pontos)"
    assert text("completion_gain", {"completion_gain": None}) is None
    people = lr.Confirmers(
        profiles=((uuid.uuid4(), "Supervisor"),), people=((uuid.uuid4(), "Ana Exemplo"),)
    )
    assert text("confirmers", values, people) == (
        "Administrador · Supervisor · Ana Exemplo (ajuste próprio)"
    )
    assert lr.default_confirmers_text() == "Administrador · Supervisor"


def _problems(**changes: Any) -> list[tuple[str, str]]:
    values = {**lr.values_of(lr.default_doc()), **FILLED, **changes}
    return lr.rule_problems(values)


def _server(**changes: Any) -> str:
    values = {**lr.values_of(lr.default_doc()), **FILLED, **changes}
    with pytest.raises(CodedError) as caught:
        lr.validate(values)
    assert caught.value.code == "LEVEL_RULE_INVALID" and caught.value.status_code == 422
    return str(caught.value)


def test_messages_of_section_2_3() -> None:
    """(3) Na tela com ponto; no servidor, "{rótulo}: {mensagem com inicial minúscula}"."""
    assert _problems() == []
    lr.validate({**lr.values_of(lr.default_doc()), **FILLED})
    counts = {"silver": 51, "gold": 101, "diamond": 151}
    points = {"bronze": 100, "silver": 901, "gold": 1401, "diamond": 1850}

    assert _problems(count_bands={**counts, "silver": 0}) == [
        ("count_bands.silver", "Use um número inteiro de 1 a 100.000.")
    ]
    assert _server(count_bands={**counts, "diamond": 100001}) == (
        "Abertura por atendimentos: use um número inteiro de 1 a 100.000"
    )
    assert _problems(count_bands={**counts, "gold": 51}) == [
        ("count_bands.gold", "O início do Ouro tem de ser maior que o da Prata.")
    ]
    assert _problems(points_bands={**points, "silver": 100}) == [
        ("points_bands.silver", "O início da Prata tem de ser maior que o do Bronze.")
    ]
    assert _server(points_bands={**points, "gold": 900}) == (
        "Faixas de pontos: o início do Ouro tem de ser maior que o da Prata"
    )
    assert _problems(points_bands={**points, "diamond": 1401}) == [
        ("points_bands.diamond", "O início do Diamante tem de ser maior que o do Ouro.")
    ]
    assert _problems(points_bands={**points, "bronze": None}) == [
        ("points_bands.bronze", "Use um número inteiro de 0 a 1.000.000.")
    ]
    assert _problems(opening_bonus=500) == [
        (
            "opening_bonus",
            "Com este bônus, a abertura da Prata (1.401) passa do fim da faixa (1.400).",
        )
    ]
    assert _server(opening_bonus=900) == (
        "Bônus de abertura: com este bônus, a abertura do Bronze (1.000) passa do fim da faixa (900)"
    )
    assert _problems(opening_bonus=None) == [
        ("opening_bonus", "Use um número inteiro de 0 a 1.000.000.")
    ]
    # Faixa errada: a abertura não é conferida (o erro fica nas faixas).
    assert _problems(points_bands={**points, "gold": 900}, opening_bonus=900) == [
        ("points_bands.gold", "O início do Ouro tem de ser maior que o da Prata.")
    ]
    assert _problems(completion_gain=1001) == [
        ("completion_gain", "Use um número inteiro de 0 a 1.000.")
    ]
    assert _server(on_time_gain=-1) == "Chegada dentro do SLA: use um número inteiro de 0 a 1.000"
    assert _problems(completion_gain=0, on_time_gain=None) == []
    assert _problems(late={"mode": None, "points": 4}) == [
        ("late.mode", "Escolha se o atraso desconta pontos ou só deixa de ganhar.")
    ]
    assert _server(late={"mode": "deduct", "points": None}) == (
        "Chegada fora do SLA: informe quantos pontos o atraso desconta"
    )
    assert _problems(late={"mode": "deduct", "points": 0}) == [
        ("late.points", "Use um número inteiro de 1 a 1.000.")
    ]
    assert _problems(late={"mode": "no_gain", "points": None}) == []
    assert _problems(late=None) == []
    assert _problems(abandonment_loss=79) == [("abandonment_loss", "No mínimo 80 pontos.")]
    assert _server(abandonment_loss=79) == "Abandono confirmado: no mínimo 80 pontos"
    assert _problems(abandonment_loss=10001) == [
        ("abandonment_loss", "Use um número inteiro de 80 a 10.000.")
    ]
    assert _problems(abandonment_loss=None) == [
        ("abandonment_loss", "Use um número inteiro de 80 a 10.000.")
    ]
    assert _server(rework_loss=49) == "Retorno com falha confirmada: no mínimo 50 pontos"
    assert _problems(rework_loss=10000) == []
    assert _problems(arrival_tolerance=241) == [
        ("arrival_tolerance", "Use minutos inteiros de 0 a 240.")
    ]
    assert _server(arrival_tolerance=-1) == (
        "Tolerância do SLA de chegada: use minutos inteiros de 0 a 240"
    )
    assert _problems(arrival_tolerance=0) == [] == _problems(arrival_tolerance=240)
    # Vários problemas: o servidor diz o primeiro, na ordem da tela.
    assert _server(abandonment_loss=1, count_bands={**counts, "gold": 10}) == (
        "Abertura por atendimentos: o início do Ouro tem de ser maior que o da Prata"
    )


def test_minimum_balance_floor() -> None:
    """(4) Com o saldo mínimo em zero a perda para no zero (os pontos pedidos ficam guardados);
    negativo ou ganho, como vieram."""
    assert lr.apply_floor("zero", 200, -300) == (-200, -300)
    assert lr.apply_floor("zero", 200, -200) == (-200, None)
    assert lr.apply_floor("zero", 200, -100) == (-100, None)
    assert lr.apply_floor("zero", 0, -100) == (0, -100)
    assert lr.apply_floor("zero", -50, -10) == (0, -10)
    assert lr.apply_floor("zero", 200, 50) == (50, None)
    assert lr.apply_floor("negative", 200, -300) == (-300, None)
    assert lr.apply_floor(None, 0, -80) == (-80, None)


def _approved(doc: dict[str, Any], confirmers: lr.Confirmers) -> dict[str, Any]:
    """O documento com todas as regras aprovadas como estão."""
    out = copy.deepcopy(doc)
    values = lr.values_of(out)
    for key in RULE_KEYS:
        out["items"][key]["approved"] = {
            "value": lr.comparable(key, values, confirmers),
            "text": lr.value_text(key, values, confirmers),
            "at": "2026-11-27T12:00:00+00:00",
            "by": {"id": str(uuid.uuid4()), "name": "Super"},
        }
    return out


def test_activation_lock_and_effective_values() -> None:
    """(11) Nada ativa com regra a definir ou a validar; só o aprovado vale."""
    confirmers = lr.Confirmers(profiles=((uuid.uuid4(), "Supervisor"),))
    doc = lr.default_doc()
    assert lr.activation_missing(doc, confirmers) == list(RULE_KEYS)
    assert lr.effective(doc) == {}
    for key, value in FILLED.items():
        doc["items"][key]["value"] = value
    approved = _approved(doc, confirmers)
    assert lr.activation_missing(approved, confirmers) == []
    effective = lr.effective(approved)
    assert effective["opening_bonus"] == 100 and effective["min_balance"] == "negative"
    assert effective["confirmers"] == confirmers.value
    # Mudou depois de aprovar: a validar, e vale o aprovado.
    changed = copy.deepcopy(approved)
    changed["items"]["completion_gain"]["value"] = 9
    assert lr.activation_missing(changed, confirmers) == ["completion_gain"]
    assert lr.effective(changed)["completion_gain"] == 7
    # Faixas novas: a abertura volta a validar e, aprovadas só as faixas, deixa de valer.
    bands = {"bronze": 100, "silver": 901, "gold": 1500, "diamond": 1850}
    changed["items"]["points_bands"]["value"] = bands
    assert lr.activation_missing(changed, confirmers) == [
        "points_bands",
        "opening_bonus",
        "completion_gain",
    ]
    changed["items"]["points_bands"]["approved"]["value"] = bands
    assert "opening_bonus" not in lr.effective(changed)
    assert lr.effective(changed)["points_bands"] == bands
    # Os perfis mudaram: quem confirma volta a validar.
    other = lr.Confirmers(profiles=((uuid.uuid4(), "Analista"),))
    assert lr.activation_missing(approved, other) == ["confirmers"]
    assert lr.states(approved, None)["confirmers"] == "pending"


# ------------------------------------------------------------------ rotas


async def _get(client: AsyncClient, headers: dict) -> dict:
    r = await client.get(f"{API}/level-rules", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _body(rules: dict, **changes: Any) -> dict:
    """O corpo do PUT: os 12 valores lidos, as mudanças e a versão lida."""
    return {**rules["values"], **changes, "version": rules["version"]}


async def _put(client: AsyncClient, headers: dict, rules: dict, **changes: Any) -> dict:
    r = await client.put(f"{API}/level-rules", json=_body(rules, **changes), headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def _approve(client: AsyncClient, headers: dict, rules: dict, *keys: str) -> dict:
    body = {"version": rules["version"], "keys": list(keys)}
    r = await client.post(f"{API}/level-rules/approve", json=body, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def _history(client: AsyncClient, headers: dict, **params: Any) -> list[dict]:
    r = await client.get(f"{API}/level-rules/history", params=params, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def _set_items(client: AsyncClient, world: World, user_id: object, items: dict) -> None:
    """Ajustes próprios da pessoa (sobre o perfil padrão do papel)."""
    overrides = {"items": items, "queue_scope": None, "queue_unowned": None}
    r = await client.patch(
        f"{API}/users/{user_id}",
        json={"access": {"profile_id": None, "overrides": overrides}},
        headers=world.admin.headers,
    )
    assert r.status_code == 200, r.text


@requires_db
async def test_guards(client: AsyncClient, world: World) -> None:
    """(5) Lê quem tem Configurações; grava e aprova administrador ou supervisor com Editar."""
    for actor in (world.admin, world.supervisor):
        assert (await _get(client, actor.headers))["can_edit"] is True
    r = await client.get(f"{API}/level-rules", headers=world.analyst.headers)
    assert r.status_code == 403
    assert (r.json()["code"], r.json()["item"]) == ("MODULE_FORBIDDEN", "setup.settings")
    rules = await _get(client, world.supervisor.headers)
    calls = [
        ("GET", "/level-rules", None),
        ("GET", "/level-rules/history", None),
        ("PUT", "/level-rules", _body(rules)),
        ("POST", "/level-rules/approve", {"version": 1, "keys": ["count_bands"]}),
    ]
    for actor in (world.tech, world.requester):
        for method, path, body in calls:
            r = await client.request(method, f"{API}{path}", json=body, headers=actor.headers)
            assert r.status_code == 403, (actor.user.role, method, path)
            assert r.json()["detail"] == "Sem permissão para esta ação"

    # Analista com Configurações em Editar: lê, mas não grava nem aprova (só admin e supervisor).
    await _set_items(client, world, world.analyst.user.id, {"setup.settings": "edit"})
    seen = await _get(client, world.analyst.headers)
    assert seen["can_edit"] is False and seen["version"] == 1
    r = await client.put(f"{API}/level-rules", json=_body(rules), headers=world.analyst.headers)
    assert r.status_code == 403 and r.json()["detail"] == "Sem permissão para esta ação"
    r = await client.post(
        f"{API}/level-rules/approve",
        json={"version": 1, "keys": ["count_bands"]},
        headers=world.analyst.headers,
    )
    assert r.status_code == 403

    # Supervisor só com Visualizar: lê sem poder gravar.
    await _set_items(client, world, world.supervisor.user.id, {"setup.settings": "view"})
    assert (await _get(client, world.supervisor.headers))["can_edit"] is False
    r = await client.put(f"{API}/level-rules", json=_body(rules), headers=world.supervisor.headers)
    assert r.status_code == 403
    assert r.json()["code"] == "MODULE_FORBIDDEN" and r.json()["required"] == "edit"
    assert r.json()["detail"] == "Seu acesso a Configurações é só de visualização."
    # Nada foi gravado.
    assert await _history(client, world.admin.headers) == []


@requires_db
async def test_start_state(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    """(6) Versão 1, inativo, 6 a definir, 7 a validar e quem confirma = Supervisor; ler não
    grava nada."""
    rules = await _get(client, world.supervisor.headers)
    assert (rules["version"], rules["active"], rules["activated_at"]) == (1, False, None)
    assert rules["missing"] == {"define": DEFINE, "approve": APPROVE}
    assert list(rules["items"]) == list(RULE_KEYS)
    assert [p["name"] for p in rules["confirmers"]["profiles"]] == ["Supervisor"]
    assert rules["confirmers"]["people"] == []
    items = rules["items"]
    assert items["count_bands"] == {
        "state": "to_validate",
        "origin": "qa",
        "text": "Bronze 0 a 50 · Prata 51 a 100 · Ouro 101 a 150 · Diamante 151 ou mais",
        "changed": None,
        "approved": None,
    }
    assert items["completion_gain"]["state"] == "pending"
    assert items["completion_gain"]["text"] is None
    assert items["completion_gain"]["origin"] == "default"
    assert (items["app_reasons"]["origin"], items["app_reasons"]["text"]) == (
        "default",
        "Desligado",
    )
    assert items["confirmers"]["origin"] is None
    assert items["confirmers"]["text"] == "Administrador · Supervisor"
    assert rules["values"]["late"] is None and rules["values"]["app_reasons"] is False
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        assert await db.get(SystemSetting, lr.SETTING_KEY) is None
        assert list(await db.scalars(select(LevelRuleChange))) == []


@requires_db
async def test_save_marks_to_validate_and_keeps_the_version(
    client: AsyncClient, world: World
) -> None:
    """(7) Ganho 10 → a validar, origem central, quem e quando, "Ganha 10 pontos"; repetir não
    grava; versão velha 409; inválido 422."""
    sup = world.supervisor.headers
    rules = await _get(client, sup)
    saved = await _put(client, sup, rules, completion_gain=10)
    assert saved["version"] == 2
    item = saved["items"]["completion_gain"]
    assert (item["state"], item["origin"], item["text"]) == (
        "to_validate",
        "central",
        "Ganha 10 pontos",
    )
    assert item["changed"]["by"] == {"id": str(world.supervisor.user.id), "name": "Super"}
    assert item["changed"]["at"] and item["approved"] is None
    assert saved["values"]["completion_gain"] == 10
    assert saved["missing"]["define"] == DEFINE[1:]
    # A primeira gravação grava antes o seed (como a migração).
    history = await _history(client, sup)
    assert [row["action"] for row in history] == ["save", "seed"]
    assert history[0]["actor"] == {"id": str(world.supervisor.user.id), "name": "Super"}
    assert history[0]["changes"] == [
        {"item": "completion_gain", "from": None, "to": "Ganha 10 pontos"}
    ]
    assert history[1]["actor"] is None and history[1]["note"] == lr.SEED_NOTE
    assert history[1]["changes"] == lr.seed_changes()

    # O mesmo de novo: nada gravado.
    again = await _put(client, sup, saved, completion_gain=10)
    assert again["version"] == 2 and len(await _history(client, sup)) == 2

    # Versão velha.
    r = await client.put(f"{API}/level-rules", json=_body(rules, on_time_gain=3), headers=sup)
    assert r.status_code == 409
    assert r.json() == {
        "detail": "As regras do elo mudaram em outra tela. Recarregue",
        "code": "LEVEL_RULES_CHANGED",
    }
    # Inválidos: a mensagem do serviço; tipo errado, a validação de sempre.
    r = await client.put(f"{API}/level-rules", json=_body(saved, rework_loss=49), headers=sup)
    assert r.status_code == 422
    assert r.json() == {
        "detail": "Retorno com falha confirmada: no mínimo 50 pontos",
        "code": "LEVEL_RULE_INVALID",
    }
    for odd in ({"completion_gain": "10"}, {"completion_gain": 10.0}, {"app_reasons": None}):
        r = await client.put(f"{API}/level-rules", json=_body(saved, **odd), headers=sup)
        assert r.status_code == 422 and isinstance(r.json()["detail"], list), odd
    assert (await _get(client, sup))["version"] == 2

    # "Só deixa de ganhar" grava os pontos em branco; voltar ao vazio é permitido.
    late = await _put(client, sup, saved, late={"mode": "no_gain", "points": 9})
    assert late["values"]["late"] == {"mode": "no_gain", "points": None}
    assert late["items"]["late"]["text"] == "Só deixa de ganhar"
    empty = await _put(client, sup, late, completion_gain=None, late=None)
    assert empty["items"]["completion_gain"]["state"] == "pending"
    assert empty["items"]["completion_gain"]["origin"] == "central"
    assert empty["missing"]["define"] == DEFINE
    assert (await _history(client, sup, limit=1))[0]["changes"] == [
        {"item": "completion_gain", "from": "Ganha 10 pontos", "to": None},
        {"item": "late", "from": "Só deixa de ganhar", "to": None},
    ]


@requires_db
async def test_approve(client: AsyncClient, world: World) -> None:
    """(8) Vazio não se aprova; aprovado volta a validar quando muda e volta a aprovar quando o
    valor aprovado volta; aprovar de novo não grava."""
    sup = world.supervisor.headers
    rules = await _get(client, sup)
    r = await client.post(
        f"{API}/level-rules/approve",
        json={"version": 1, "keys": ["abandonment_loss", "completion_gain"]},
        headers=sup,
    )
    assert r.status_code == 422
    assert r.json() == {"detail": "Falta definir: Atendimento concluído", "code": "LEVEL_RULE_EMPTY"}
    r = await client.post(
        f"{API}/level-rules/approve", json={"version": 1, "keys": ["nada"]}, headers=sup
    )
    assert r.status_code == 422
    r = await client.post(
        f"{API}/level-rules/approve", json={"version": 9, "keys": ["rework_loss"]}, headers=sup
    )
    assert r.status_code == 409 and r.json()["code"] == "LEVEL_RULES_CHANGED"

    approved = await _approve(client, sup, rules, "abandonment_loss")
    item = approved["items"]["abandonment_loss"]
    assert item["state"] == "approved" and item["origin"] == "qa"
    assert item["approved"]["text"] == "Perde 80 pontos"
    assert item["approved"]["by"]["name"] == "Super" and item["approved"]["at"]
    assert "abandonment_loss" not in approved["missing"]["approve"]
    history = await _history(client, sup)
    assert [row["action"] for row in history] == ["approve", "seed"]
    assert history[0]["changes"] == [
        {"item": "abandonment_loss", "from": None, "to": "Perde 80 pontos"}
    ]

    ninety = await _put(client, sup, approved, abandonment_loss=90)
    item = ninety["items"]["abandonment_loss"]
    assert item["state"] == "to_validate" and item["text"] == "Perde 90 pontos"
    assert item["approved"]["text"] == "Perde 80 pontos"
    back = await _put(client, sup, ninety, abandonment_loss=80)
    assert back["items"]["abandonment_loss"]["state"] == "approved"
    assert back["items"]["abandonment_loss"]["origin"] == "central"
    again = await _approve(client, sup, back, "abandonment_loss")
    assert again["version"] == back["version"]
    assert len(await _history(client, sup)) == 4  # seed, approve, save 90, save 80


@requires_db
async def test_new_bands_ask_for_the_opening_again(client: AsyncClient, world: World) -> None:
    """(9) Faixas de pontos novas: a abertura volta a validar, e o histórico leva o texto dela."""
    sup = world.supervisor.headers
    rules = await _approve(
        client, sup, await _get(client, sup), "points_bands", "opening_bonus", "count_bands"
    )
    assert {rules["items"][k]["state"] for k in ("points_bands", "opening_bonus")} == {"approved"}
    bands = {"bronze": 100, "silver": 901, "gold": 1500, "diamond": 1850}
    saved = await _put(client, sup, rules, points_bands=bands)
    assert saved["items"]["points_bands"]["state"] == "to_validate"
    assert saved["items"]["opening_bonus"]["state"] == "to_validate"
    assert saved["items"]["opening_bonus"]["changed"] is None  # o bônus não mudou
    assert saved["items"]["count_bands"]["state"] == "approved"
    assert saved["missing"]["approve"][:2] == ["points_bands", "opening_bonus"]
    [latest] = await _history(client, sup, limit=1)
    assert latest["changes"] == [
        {
            "item": "points_bands",
            "from": "Bronze 100 a 900 · Prata 901 a 1.400 · Ouro 1.401 a 1.849 · Diamante 1.850 "
            "ou mais",
            "to": "Bronze 100 a 900 · Prata 901 a 1.499 · Ouro 1.500 a 1.849 · Diamante 1.850 "
            "ou mais",
        },
        {
            "item": "opening_bonus",
            "from": "100 pontos: Bronze 200 · Prata 1.001 · Ouro 1.501 · Diamante 1.950",
            "to": "100 pontos: Bronze 200 · Prata 1.001 · Ouro 1.600 · Diamante 1.950",
        },
    ]
    done = await _approve(client, sup, saved, "opening_bonus", "points_bands")
    assert done["items"]["opening_bonus"]["approved"]["text"] == (
        "100 pontos: Bronze 200 · Prata 1.001 · Ouro 1.600 · Diamante 1.950"
    )
    # Voltar às faixas de antes: as duas a validar de novo.
    old = await _put(client, sup, done, points_bands=rules["values"]["points_bands"])
    assert old["items"]["opening_bonus"]["state"] == "to_validate"


@requires_db
async def test_confirmers_follow_the_access_profiles(
    client: AsyncClient, world: World, engine: AsyncEngine
) -> None:
    """(10) Quem confirma sai dos perfis: o padrão (Supervisor), a pessoa com o ajuste próprio e o
    item dado ao Analista; cada mudança volta a pedir aprovação."""
    adm, sup = world.admin.headers, world.supervisor.headers
    rules = await _approve(client, sup, await _get(client, sup), "confirmers")
    item = rules["items"]["confirmers"]
    assert item["state"] == "approved" and item["approved"]["text"] == "Administrador · Supervisor"

    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        ana = User(
            name="Ana Exemplo",
            email="ana.exemplo@exemplo.com",
            password_hash=hash_password("senha-teste-123"),
            role=UserRole.ANALYST,
            is_active=True,
            access_overrides={"items": {"base.level_confirm": "edit"}},
        )
        db.add(ana)
        await db.commit()
    seen = await _get(client, sup)
    assert seen["confirmers"]["people"] == [{"id": str(ana.id), "name": "Ana Exemplo"}]
    item = seen["items"]["confirmers"]
    assert item["state"] == "to_validate"
    assert item["text"] == "Administrador · Supervisor · Ana Exemplo (ajuste próprio)"
    assert item["approved"]["text"] == "Administrador · Supervisor"
    assert seen["missing"]["approve"] == ["confirmers"] or "confirmers" in seen["missing"]["approve"]

    # O item dado ao perfil Analista: a pessoa sai da lista (o perfil já dá o item).
    profiles = (await client.get(f"{API}/access/profiles", headers=adm)).json()
    analyst = next(p for p in profiles if p["system_key"] == "analyst")
    r = await client.patch(
        f"{API}/access/profiles/{analyst['id']}",
        json={"items": {"base.level_confirm": "edit"}},
        headers=adm,
    )
    assert r.status_code == 200, r.text
    seen = await _get(client, sup)
    assert [p["name"] for p in seen["confirmers"]["profiles"]] == ["Supervisor", "Analista"]
    assert seen["confirmers"]["people"] == []
    assert seen["items"]["confirmers"]["text"] == "Administrador · Supervisor · Analista"
    approved = await _approve(client, sup, seen, "confirmers")
    assert approved["items"]["confirmers"]["state"] == "approved"

    # "Visualizar" não existe neste item: o perfil recusa.
    r = await client.patch(
        f"{API}/access/profiles/{analyst['id']}",
        json={"items": {"base.level_confirm": "view"}},
        headers=adm,
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "Elo: confirmar ocorrências só tem Sem acesso ou Editar"


@requires_db
async def test_history_pages(client: AsyncClient, world: World) -> None:
    """(12) Do mais novo para o mais antigo, por páginas sem repetir; `before` estragado, 422."""
    sup = world.supervisor.headers
    rules = await _get(client, sup)
    for gain in (1, 2, 3):
        rules = await _put(client, sup, rules, completion_gain=gain)
    rows = await _history(client, sup)
    assert [row["action"] for row in rows] == ["save", "save", "save", "seed"]
    assert [row["changes"][0]["to"] for row in rows[:3]] == [
        "Ganha 3 pontos",
        "Ganha 2 pontos",
        "Ganha 1 ponto",
    ]
    first = await _history(client, sup, limit=2)
    assert [row["id"] for row in first] == [row["id"] for row in rows[:2]]
    last = first[-1]
    rest = await _history(client, sup, limit=2, before=f"{last['created_at']}|{last['id']}")
    assert [row["id"] for row in rest] == [row["id"] for row in rows[2:]]
    for odd in ("x", "2026-11-27T10:00:00|" + str(uuid.uuid4()), "2026-11-27T10:00:00+00:00|1"):
        r = await client.get(
            f"{API}/level-rules/history", params={"before": odd}, headers=sup
        )
        assert r.status_code == 422
        assert r.json()["detail"] == "Página do histórico inválida. Recarregue a tela"
    r = await client.get(f"{API}/level-rules/history", params={"limit": 0}, headers=sup)
    assert r.status_code == 422


@requires_db
async def test_everything_approved_still_inactive(client: AsyncClient, world: World) -> None:
    """Tudo aprovado: nada falta, mas o elo por pontos só fica ativo na Etapa 2."""
    sup = world.supervisor.headers
    rules = await _put(client, sup, await _get(client, sup), **FILLED)
    done = await _approve(client, sup, rules, *RULE_KEYS)
    assert done["missing"] == {"define": [], "approve": []}
    assert done["active"] is False and done["activated_at"] is None
    assert {item["state"] for item in done["items"].values()} == {"approved"}
    assert done["items"]["arrival_tolerance"]["approved"]["text"] == "15 min"


@requires_db
async def test_technician_sees_nothing_new(client: AsyncClient, world: World) -> None:
    """(13) O app não muda: /me/level com as mesmas chaves e sem pontos; /level-rules, 403."""
    r = await client.get(f"{API}/me/level", headers=world.tech.headers)
    assert r.status_code == 200, r.text
    assert set(r.json()) == set(MyLevel.model_fields)
    assert "points" not in r.text and "balance" not in r.text
    r = await client.get(f"{API}/level-rules", headers=world.tech.headers)
    assert r.status_code == 403
