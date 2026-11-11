from fastapi import APIRouter

from app.api.routes import auth, catalog, customers, dashboard, sync, tickets, users, ws

api_router = APIRouter()
for module in (auth, catalog, users, customers, tickets, dashboard, sync, ws):
    api_router.include_router(module.router)
