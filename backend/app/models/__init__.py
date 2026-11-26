"""Importa todos os modelos para registrar as tabelas no metadata (usado pelo Alembic)."""

from app.models.access import AccessProfile
from app.models.account_token import AccountToken
from app.models.asset import Asset
from app.models.catalog import (
    Category,
    ServiceArea,
    ServiceType,
    Skill,
    SlaPolicy,
    TechnicianTool,
    UnproductiveReason,
    ViolationReason,
)
from app.models.customer import Customer, Location
from app.models.email_outbox import EmailOutbox
from app.models.expense import SystemSetting, TicketExpense
from app.models.forms import FormTemplate, TicketForm
from app.models.invoice import TechnicianInvoice
from app.models.legacy import LegacyRef
from app.models.offer import TicketOffer
from app.models.onboarding import OnboardingInvite, TechnicianApplication
from app.models.part_request import TicketPartRequest
from app.models.payout import TicketPayout
from app.models.payout_method import TechnicianPayoutMethod
from app.models.project import Project
from app.models.quote import Quote, QuoteItemCatalog
from app.models.repair import RepairEvent, RepairOrder, RepairPhoto
from app.models.sync import DeviceToken, SyncOperation
from app.models.technician_document import TechnicianDocument
from app.models.technician_favorite import TechnicianFavorite
from app.models.technician_level import TechnicianLevel, TechnicianLevelWaiver
from app.models.technician_rating import TechnicianRating
from app.models.ticket import (
    Ticket,
    TicketAttachment,
    TicketComment,
    TicketEvent,
    TicketWorklog,
)
from app.models.tracking import LocationPing, TechnicianShift
from app.models.user import Team, User
from app.models.user_change import UserChange

__all__ = [
    "AccessProfile",
    "AccountToken",
    "Asset",
    "Category",
    "Customer",
    "DeviceToken",
    "EmailOutbox",
    "FormTemplate",
    "LegacyRef",
    "Location",
    "OnboardingInvite",
    "Project",
    "Quote",
    "QuoteItemCatalog",
    "RepairEvent",
    "RepairOrder",
    "RepairPhoto",
    "ServiceArea",
    "ServiceType",
    "Skill",
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
    "TicketOffer",
    "TicketPartRequest",
    "TicketPayout",
    "TicketWorklog",
    "TechnicianDocument",
    "TechnicianFavorite",
    "TechnicianInvoice",
    "TechnicianLevel",
    "TechnicianLevelWaiver",
    "TechnicianPayoutMethod",
    "TechnicianRating",
    "TechnicianTool",
    "UnproductiveReason",
    "TechnicianApplication",
    "TechnicianShift",
    "LocationPing",
    "User",
    "UserChange",
    "ViolationReason",
]
