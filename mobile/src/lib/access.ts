// Canal de acesso do app (backend/app/core/access.py): o celular é só dos técnicos de campo.
// Analistas e gestores usam o navegador. GET /meta expõe o mesmo em `access_channels.mobile`.

import type { UserRole } from "./types";

export const MOBILE_CHANNEL = "mobile" as const;

export const MOBILE_ROLES: UserRole[] = ["technician"];

/** Mesmo texto de CHANNEL_DENIED_MESSAGE["mobile"] no backend (usado quando a recusa é local). */
export const MOBILE_DENIED_MESSAGE =
  "O app é exclusivo para técnicos de campo. Analistas e gestores acessam pelo navegador.";

export const canUseMobile = (role: UserRole) => MOBILE_ROLES.includes(role);
