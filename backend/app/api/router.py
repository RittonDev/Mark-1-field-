from fastapi import APIRouter

from app.api.routes import (
    activities,
    auth,
    catalog,
    customers,
    dashboard,
    forms,
    onboarding,
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
