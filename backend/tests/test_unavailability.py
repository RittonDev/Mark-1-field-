"""Indisponibilidade do técnico (services/unavailability.py): períodos de/até sem motivo, a lista
inteira no PATCH /me/profile, os textos (= periodText/periodShort de lib/constants.ts) e o
histórico. Os efeitos na sugestão, nas ofertas e na atribuição ficam em test_operational_status.py.

Só dados fictícios.
"""

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.models import User
from app.schemas import personal
from app.services import unavailability as un
from tests.conftest import World, requires_db
from tests.test_my_profile import history, messages, patch

TODAY = date(2026, 11, 25)


def day(offset: int, base: date = TODAY) -> str:
    return (base + timedelta(days=offset)).isoformat()


def period(start: int, end: int, period_id: str | None = None) -> dict:
    item: dict = {"start": day(start), "end": day(end)}
    if period_id is not None:
        item["id"] = period_id
    return item


# ------------------------------------------------------------------ sem banco


def test_normalize_drops_ended_keeps_ids_and_sorts() -> None:
    kept = str(uuid.uuid4())
    stored = [
        {"id": kept, "start": day(-5), "end": day(3)},
        {"id": str(uuid.uuid4()), "start": day(-20), "end": day(-10)},
    ]
    out = un.normalize(
        [period(30, 40), {"id": kept, "start": day(-5), "end": day(3)}, period(-12, -11)],
        stored,
        TODAY,
    )
    # O que já acabou sai; o id gravado fica; o novo ganha id; ordem do início.
    assert [(p["start"], p["end"]) for p in out] == [(day(-5), day(3)), (day(30), day(40))]
    assert out[0]["id"] == kept
    uuid.UUID(out[1]["id"])
    assert out[1]["id"] != kept
    # Um id que não está gravado é período novo.
    stranger = str(uuid.uuid4())
    [fresh] = un.normalize([period(1, 2, stranger)], stored, TODAY)
    assert fresh["id"] != stranger
    # O mesmo id duas vezes: o segundo é outro período.
    twice = un.normalize([period(1, 1, kept), period(5, 6, kept)], stored, TODAY)
    assert len({p["id"] for p in twice}) == 2
    assert un.normalize([], stored, TODAY) == []


@pytest.mark.parametrize(
    ("items", "stored", "message"),
    [
        ([period(5, 4)], [], un.END_BEFORE_START),
        ([period(-2, 3)], [], un.START_IN_PAST),
        ([period(10, 367)], [], un.TOO_FAR),
        ([period(1, 5), period(5, 8)], [], un.OVERLAP),
        ([period(1, 5), period(3, 4)], [], un.OVERLAP),
        ([period(i * 3, i * 3 + 1) for i in range(11)], [], un.TOO_MANY),
        # O período gravado que já começou só passa com o mesmo início.
        (
            [{"id": "a" * 8, "start": day(-3), "end": day(2)}],
            [{"id": "a" * 8, "start": day(-4), "end": day(2)}],
            un.START_IN_PAST,
        ),
    ],
)
def test_period_messages(items: list, stored: list, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        un.normalize(items, stored, TODAY)


def test_period_limits_that_pass() -> None:
    """Folga de um dia no fuso do aparelho: ontem e hoje + 366 passam; o gravado que já começou
    passa com o mesmo início; dias encostados (sem dia em comum) passam."""
    assert un.normalize([period(-1, 0), period(1, 366)], [], TODAY)
    started = [{"id": "p1", "start": day(-40), "end": day(2)}]
    [same] = un.normalize([{"id": "p1", "start": day(-40), "end": day(5)}], started, TODAY)
    assert (same["id"], same["start"], same["end"]) == ("p1", day(-40), day(5))
    assert len(un.normalize([period(i * 2, i * 2) for i in range(10)], [], TODAY)) == 10


def test_period_texts() -> None:
    """Os casos do contrato (hoje 2026-11-25)."""
    assert un.period_text({"start": "2026-12-20", "end": "2027-01-05"}) == "20/12/2026 a 05/01/2027"
    assert un.period_text({"start": "2026-12-20", "end": "2026-12-20"}) == "20/12/2026"
    cases = [
        (("2026-11-20", "2026-11-30"), "até 30/11"),
        (("2026-12-10", "2026-12-20"), "de 10/12 a 20/12"),
        (("2026-12-10", "2026-12-10"), "em 10/12"),
        (("2026-12-20", "2027-01-05"), "de 20/12 a 05/01/2027"),
        (("2026-11-25", "2027-01-05"), "até 05/01/2027"),
    ]
    for (start, end), text in cases:
        assert un.period_short({"start": start, "end": end}, TODAY) == text
        assert un.period_short({"start": start, "end": end}, "2026-11-25") == text


def test_current_on_day_and_days_of() -> None:
    stored = [
        {"id": "b", "start": day(10), "end": day(12)},
        {"id": "a", "start": day(-3), "end": day(0)},
        {"id": "c", "start": day(-9), "end": day(-1)},
        {"id": "x", "start": "quebrado", "end": day(5)},
    ]
    assert [p["id"] for p in un.current(stored, TODAY)] == ["a", "b"]
    assert un.on_day(stored, TODAY)["id"] == "a"
    assert un.on_day(stored, TODAY + timedelta(days=12))["id"] == "b"
    assert un.on_day(stored, TODAY + timedelta(days=13)) is None
    # Dias da visita no fuso da operação (Brasília): 01:00 UTC ainda é o dia anterior.
    start = datetime(2026, 12, 10, 1, 0, tzinfo=UTC)
    assert un.days_of(start, start + timedelta(days=2)) == (date(2026, 12, 9), date(2026, 12, 11))
    assert un.days_of(start, None) == (date(2026, 12, 9), date(2026, 12, 9))
    today = personal.local_today()
    assert un.days_of(None, None) == (today, today)


# ------------------------------------------------------------------ com banco


@requires_db
async def test_patch_and_history(client: AsyncClient, world: World, engine: AsyncEngine) -> None:
    today = personal.local_today()

    def iso(offset: int) -> str:
        return day(offset, today)

    r = await patch(
        client,
        world,
        unavailability=[
            {"start": iso(20), "end": iso(25)},
            {"start": iso(0), "end": iso(2)},
        ],
    )
    assert r.status_code == 200, r.text
    periods = r.json()["unavailability"]
    assert [(p["start"], p["end"]) for p in periods] == [(iso(0), iso(2)), (iso(20), iso(25))]
    first_id, second_id = (p["id"] for p in periods)
    [row] = await history(client, world)
    today_text = f"{today + timedelta(days=0):%d/%m/%Y}"
    assert row["changes"] == [
        {
            "field": "unavailability",
            "from": None,
            "to": (
                f"{today_text} a {today + timedelta(days=2):%d/%m/%Y}; "
                f"{today + timedelta(days=20):%d/%m/%Y} a {today + timedelta(days=25):%d/%m/%Y}"
            ),
        }
    ]

    # Editar um (mesmo id) e tirar o outro: o histórico diz o que saiu e o que entrou.
    r = await patch(
        client, world, unavailability=[{"id": second_id, "start": iso(20), "end": iso(20)}]
    )
    assert r.status_code == 200, r.text
    assert r.json()["unavailability"] == [{"id": second_id, "start": iso(20), "end": iso(20)}]
    assert (await history(client, world))[0]["changes"] == [
        {
            "field": "unavailability",
            "from": (
                f"{today_text} a {today + timedelta(days=2):%d/%m/%Y}; "
                f"{today + timedelta(days=20):%d/%m/%Y} a {today + timedelta(days=25):%d/%m/%Y}"
            ),
            "to": f"{today + timedelta(days=20):%d/%m/%Y}",
        }
    ]
    assert first_id != second_id

    # Os mesmos dias de novo (sem id): nada muda e o id gravado fica.
    count = len(await history(client, world))
    r = await patch(client, world, unavailability=[{"start": iso(20), "end": iso(20)}])
    assert r.status_code == 200 and r.json()["unavailability"][0]["id"] == second_id
    assert len(await history(client, world)) == count

    # Mensagens (sem o ponto final) e o limite.
    for body, message in (
        ([{"start": iso(5), "end": iso(4)}], un.END_BEFORE_START),
        ([{"start": iso(-5), "end": iso(4)}], un.START_IN_PAST),
        ([{"start": iso(5), "end": iso(400)}], un.TOO_FAR),
        ([{"start": iso(1), "end": iso(5)}, {"start": iso(5), "end": iso(6)}], un.OVERLAP),
        ([{"start": iso(i * 2), "end": iso(i * 2)} for i in range(11)], un.TOO_MANY),
    ):
        r = await patch(client, world, unavailability=body)
        assert r.status_code == 422 and messages(r) == [message]
    r = await patch(client, world, unavailability=[{"start": "2026-02-30", "end": iso(1)}])
    assert r.status_code == 422 and r.json()["detail"][0]["label"] == "Início"
    r = await patch(client, world, unavailability=[{"start": iso(1), "end": iso(1), "motivo": "x"}])
    assert r.status_code == 422 and r.json()["detail"][0]["type"] == "extra_forbidden"

    # O que já acabou some da leitura e sai na próxima gravação.
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None
        user.unavailability = [
            *user.unavailability,
            {"id": str(uuid.uuid4()), "start": iso(-9), "end": iso(-2)},
        ]
        await db.commit()
    me = (await client.get(f"{settings.API_PREFIX}/me/profile", headers=world.tech.headers)).json()
    assert [p["id"] for p in me["unavailability"]] == [second_id]
    r = await patch(client, world, unavailability=[])
    assert r.status_code == 200 and r.json()["unavailability"] == []
    async with maker() as db:
        user = await db.get(User, world.tech.user.id)
        assert user is not None and user.unavailability == []
    # O período que acabou não aparece no histórico (só o que o técnico tirou).
    assert (await history(client, world))[0]["changes"] == [
        {
            "field": "unavailability",
            "from": f"{today + timedelta(days=20):%d/%m/%Y}",
            "to": None,
        }
    ]
