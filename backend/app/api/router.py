from fastapi import APIRouter

from app.api.routes import (
    activities,
    auth,
    catalog,
    customers,
    dashboard,
    sync,
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
    customers,
    tickets,
    activities,
    tracking,
    dashboard,
    sync,
    ws,
):
    api_router.include_router(module.router)
