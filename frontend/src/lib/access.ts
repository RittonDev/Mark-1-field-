// Canais de acesso (espelha backend/app/core/access.py):
// navegador = analistas, gestores e o portal do solicitante; celular = técnicos de campo.

import type { UserRole } from "./types";

export const WEB_ROLES: UserRole[] = ["admin", "supervisor", "analyst", "requester"];

export const WEB_DENIED_MESSAGE =
  "Técnicos de campo acessam pelo app Maxx Field no celular (Android ou iOS).";

export const canUseWeb = (role: UserRole | undefined) => !!role && WEB_ROLES.includes(role);
