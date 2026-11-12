from app.core.enums import UserRole
from app.services.realtime import should_deliver


def event(**audience: object) -> dict:
    base = {
        "assignee_id": None,
        "previous_assignee_id": None,
        "team_id": None,
        "requester_id": None,
        "created_by_id": None,
        "internal": False,
    }
    base.update(audience)
    return {"type": "ticket.updated", "audience": base}


def test_managers_and_analysts_receive_everything() -> None:
    for role in (UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.ANALYST):
        assert should_deliver(user_id="x", role=role, team_id=None, event=event(team_id="t9"))


def test_technician_gets_own_team_and_open_queue() -> None:
    def deliver(**aud: object) -> bool:
        return should_deliver(
            user_id="me", role=UserRole.TECHNICIAN, team_id="t1", event=event(**aud)
        )

    assert deliver(assignee_id="me", team_id="t2")
    assert deliver(team_id="t1", assignee_id="other")
    assert deliver()  # fila geral: sem grupo e sem analista
    assert deliver(previous_assignee_id="me", assignee_id="other", team_id="t2")
    assert not deliver(team_id="t2", assignee_id="other")


def test_requester_never_sees_internal() -> None:
    def deliver(**aud: object) -> bool:
        return should_deliver(
            user_id="me", role=UserRole.REQUESTER, team_id=None, event=event(**aud)
        )

    assert deliver(requester_id="me")
    assert not deliver(requester_id="me", internal=True)
    assert not deliver(requester_id="other")
