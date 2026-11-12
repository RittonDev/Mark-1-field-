from fastapi import APIRouter

from app.api.routes import (
    activities,
    auth,
    catalog,
    client_report,
    customers,
    dashboard,
    expenses,
    forms,
    messages,
    onboarding,
    projects,
    queues,
    quotes,
    repairs,
    reports,
    schedule,
    sync,
    technicians,
    tickets,
    tracking,
    users,
    ws,
)

api_router = APIRouter()
for module in (
    auth,
    catalog,
    users,
    technicians,
    customers,
    tickets,
    queues,
    client_report,
    forms,
    expenses,
    quotes,
    projects,
    repairs,
    reports,
    messages,
    activities,
    tracking,
    schedule,
    onboarding,
    dashboard,
    sync,
    ws,
):
    api_router.include_router(module.router)
api_router.include_router(onboarding.public)
api_router.include_router(quotes.public)
api_router.include_router(client_report.public)
