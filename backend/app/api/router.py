from fastapi import APIRouter

from app.api.routes import (
    access,
    activities,
    auth,
    catalog,
    cep,
    client_report,
    company,
    customers,
    dashboard,
    expenses,
    field,
    forms,
    home,
    invoices,
    level_rules,
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
    technician_documents,
    technician_favorites,
    technician_levels,
    technician_ratings,
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
    # Documentos do técnico: /me/profile/documents/... (app), /technicians/{id}/documents/...
    # (central) e o download por link assinado (/technician-documents/{id}/download).
    technician_documents,
    # Avaliação do cliente na OS concluída: /tickets/{id}/ratings/... e /technicians/{id}/ratings.
    technician_ratings,
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
    # Configurações › Elo (elo por pontos): /level-rules, /level-rules/approve e
    # /level-rules/history.
    level_rules,
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
# Arquivos da ficha da homologação já enviada (pelo upload_token): /public/onboarding-documents.
api_router.include_router(technician_documents.public)
api_router.include_router(quotes.public)
api_router.include_router(client_report.public)
# Busca de CEP dos formulários de endereço (sem login; logado, o limite é por pessoa).
api_router.include_router(cep.public)
