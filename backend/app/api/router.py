from fastapi import APIRouter

from app.api.routes import (
    access,
    activities,
    auth,
    catalog,
    client_report,
    company,
    customers,
    dashboard,
    expenses,
    field,
    forms,
    home,
    invoices,
    messages,
    my_profile,
    offers,
    onboarding,
    parts,
    payouts,
    portal,
    projects,
    queues,
    quotes,
    repairs,
    reports,
    schedule,
    sync,
    technician_favorites,
    technician_levels,
    technicians,
    tickets,
    tracking,
    users,
    ws,
)

api_router = APIRouter()
for module in (
    auth,
    access,
    home,
    catalog,
    users,
    technician_favorites,  # antes de technicians: /technicians/favorites/...
    # Elo dos técnicos: /technicians/{id}/level, /technicians/{id}/stats,
    # /technicians/levels/refresh, /me/level, /me/stats e /me/history.
    technician_levels,
    technicians,
    customers,
    tickets,
    parts,
    payouts,
    # Ofertas de OS: /tickets/{id}/offers (dois segmentos depois do id, sem choque com as rotas
    # da OS) e /me/offers (ao lado de /me/earnings).
    offers,
    # Notas fiscais dos técnicos: /me/invoices (app) e /technician-invoices (Pagamentos).
    invoices,
    # Meu cadastro do técnico: /me/profile e /me/profile/photo.
    my_profile,
    portal,
    queues,
    client_report,
    forms,
    expenses,
    company,
    field,
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
