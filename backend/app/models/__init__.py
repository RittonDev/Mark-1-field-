"""Importa todos os modelos para registrar as tabelas no metadata (usado pelo Alembic)."""

from app.models.asset import Asset
from app.models.catalog import Category, ServiceType, SlaPolicy, ViolationReason
from app.models.customer import Customer, Location
from app.models.onboarding import OnboardingInvite, TechnicianApplication
from app.models.sync import DeviceToken, SyncOperation
from app.models.ticket import (
    Ticket,
    TicketAttachment,
    TicketComment,
    TicketEvent,
    TicketWorklog,
)
from app.models.tracking import LocationPing, TechnicianShift
from app.models.user import Team, User

__all__ = [
    "Asset",
    "Category",
    "Customer",
    "DeviceToken",
    "Location",
    "OnboardingInvite",
    "ServiceType",
    "SlaPolicy",
    "SyncOperation",
    "Team",
    "Ticket",
    "TicketAttachment",
    "TicketComment",
    "TicketEvent",
    "TicketWorklog",
    "TechnicianApplication",
    "TechnicianShift",
    "LocationPing",
    "User",
    "ViolationReason",
]
