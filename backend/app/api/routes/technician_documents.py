"""Documentos do técnico: app, central, download e a ficha pública
(services/technician_documents.py)."""

from fastapi import APIRouter

router = APIRouter(tags=["technician-documents"])
# Arquivos da ficha da homologação já enviada (sem login, pelo upload_token): prefixo próprio, para
# não cair em /public/onboarding/{token}.
public = APIRouter(prefix="/public/onboarding-documents", tags=["onboarding"])
