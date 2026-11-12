from fastapi import APIRouter

from app.api.routes import (
    activities,
    auth,
    catalog,
    customers,
    dashboard,
    expenses,
    forms,
    onboarding,
    projects,
    quotes,
    repairs,
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
    forms,
    expenses,
    quotes,
    projects,
    repairs,
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
