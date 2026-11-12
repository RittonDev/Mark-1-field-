import uuid

import pytest

from app.core.enums import Impact, TicketPriority, TicketStatus, Urgency, UserRole
from app.services.errors import WorkflowError
from app.services.workflow import (
    STATUS_INFO,
    TRANSITIONS,
    compute_priority,
    user_can_transition,
    validate_transition,
)

S = TicketStatus


def test_every_status_has_metadata_and_transitions() -> None:
    assert set(STATUS_INFO) == set(TicketStatus)
    assert set(TRANSITIONS) == set(TicketStatus)
    for targets in TRANSITIONS.values():
        assert set(targets) <= set(TicketStatus)


def test_final_statuses_are_terminal() -> None:
    for status, info in STATUS_INFO.items():
        if info.final:
            assert TRANSITIONS[status] == ()


def test_every_status_reachable_from_new() -> None:
    seen, frontier = {S.NEW}, [S.NEW]
    while frontier:
        for nxt in TRANSITIONS[frontier.pop()]:
            if nxt not in seen:
                seen.add(nxt)
                frontier.append(nxt)
    assert seen == set(TicketStatus)


def _validate(frm: S, to: S, **kw: object) -> None:
    args = {
        "has_assignee": True,
        "has_schedule": True,
        "note": "motivo",
        "resolution_notes": "solução",
    }
    args.update(kw)
    validate_transition(from_status=frm, to_status=to, **args)  # type: ignore[arg-type]


def test_rejects_transition_not_in_map() -> None:
    with pytest.raises(WorkflowError, match="não permitida"):
        _validate(S.NEW, S.RESOLVED)


def test_field_statuses_require_assignee() -> None:
    with pytest.raises(WorkflowError, match="Atribua"):
        _validate(S.ASSIGNED, S.IN_PROGRESS, has_assignee=False)


def test_schedule_requires_date() -> None:
    with pytest.raises(WorkflowError, match="scheduled_start"):
        _validate(S.ASSIGNED, S.SCHEDULED, has_schedule=False)


def test_resolve_requires_solution() -> None:
    with pytest.raises(WorkflowError, match="solução"):
        _validate(S.IN_PROGRESS, S.RESOLVED, resolution_notes="  ")


@pytest.mark.parametrize("to", [S.CANCELLED, S.REOPENED])
def test_cancel_and_reopen_require_reason(to: S) -> None:
    frm = S.NEW if to == S.CANCELLED else S.RESOLVED
    with pytest.raises(WorkflowError, match="motivo"):
        _validate(frm, to, note=None)


def test_priority_matrix() -> None:
    assert compute_priority(Impact.HIGH, Urgency.HIGH) == TicketPriority.CRITICAL
    assert compute_priority(Impact.MEDIUM, Urgency.MEDIUM) == TicketPriority.MEDIUM
    assert compute_priority(Impact.LOW, Urgency.LOW) == TicketPriority.LOW


def _can(
    role: UserRole,
    frm: S,
    to: S,
    *,
    is_requester: bool = True,
    assignee: bool = False,
    same_team: bool = False,
) -> bool:
    me, team = uuid.uuid4(), uuid.uuid4()
    return user_can_transition(
        role=role,
        user_id=me,
        user_team_id=team,
        ticket_assignee_id=me if assignee else uuid.uuid4(),
        ticket_team_id=team if same_team else uuid.uuid4(),
        ticket_requester_id=me if is_requester else uuid.uuid4(),
        from_status=frm,
        to_status=to,
    )


def test_requester_permissions() -> None:
    assert _can(UserRole.REQUESTER, S.NEW, S.CANCELLED)
    assert not _can(UserRole.REQUESTER, S.ASSIGNED, S.CANCELLED)
    assert _can(UserRole.REQUESTER, S.RESOLVED, S.CLOSED)
    assert _can(UserRole.REQUESTER, S.RESOLVED, S.REOPENED)
    assert not _can(UserRole.REQUESTER, S.ASSIGNED, S.IN_PROGRESS)
    assert not _can(UserRole.REQUESTER, S.RESOLVED, S.CLOSED, is_requester=False)


def test_technician_needs_assignment_or_team() -> None:
    assert _can(UserRole.TECHNICIAN, S.ASSIGNED, S.IN_PROGRESS, assignee=True)
    assert _can(UserRole.TECHNICIAN, S.ASSIGNED, S.IN_PROGRESS, same_team=True)
    assert not _can(UserRole.TECHNICIAN, S.ASSIGNED, S.IN_PROGRESS)


def test_analyst_manages_any_ticket() -> None:
    assert _can(UserRole.ANALYST, S.ASSIGNED, S.IN_PROGRESS)
    assert _can(UserRole.ANALYST, S.RESOLVED, S.CLOSED, is_requester=False)
    assert _can(UserRole.SUPERVISOR, S.ASSIGNED, S.IN_PROGRESS)
