"""Importa todos os modelos para registrar as tabelas no metadata (usado pelo Alembic)."""

from app.models.asset import Asset
from app.models.catalog import (
    Category,
    ServiceType,
    SlaPolicy,
    UnproductiveReason,
    ViolationReason,
)
from app.models.customer import Customer, Location
from app.models.expense import SystemSetting, TicketExpense
from app.models.forms import FormTemplate, TicketForm
from app.models.onboarding import OnboardingInvite, TechnicianApplication
from app.models.quote import Quote, QuoteItemCatalog
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
    "FormTemplate",
    "Location",
    "OnboardingInvite",
    "Quote",
    "QuoteItemCatalog",
    "ServiceType",
    "SlaPolicy",
    "SyncOperation",
    "SystemSetting",
    "Team",
    "Ticket",
    "TicketAttachment",
    "TicketComment",
    "TicketEvent",
    "TicketExpense",
    "TicketForm",
    "TicketWorklog",
    "UnproductiveReason",
    "TechnicianApplication",
    "TechnicianShift",
    "LocationPing",
    "User",
    "ViolationReason",
]
