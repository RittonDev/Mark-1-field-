// Canais de acesso (espelha backend/app/core/access.py):
// navegador = analistas, gestores e o portal do solicitante; celular = técnicos de campo.

import { sessionStore } from "./session";
import type { UserRole } from "./types";

export const WEB_ROLES: UserRole[] = ["admin", "supervisor", "analyst", "requester"];

export const WEB_DENIED_MESSAGE =
  "Técnicos de campo acessam pelo app Maxx Field no celular (Android ou iOS).";

export const canUseWeb = (role: UserRole | undefined) => !!role && WEB_ROLES.includes(role);

/** Tela inicial depois do login: a fila do analista; o usuário do cliente vai para o portal. */
export const homePath = (role: UserRole | undefined) =>
  role === "requester" ? "/portal" : "/minha-fila";

// ------------------------------------------------------------------ volta ao link depois do login

const isUnder = (path: string, base: string) =>
  path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`) || path.startsWith(`${base}#`);

/**
 * Endereço para onde voltar depois de entrar (?next=), só se for seguro: uma tela deste mesmo site,
 * nunca o próprio login, e do lado certo para o perfil (o cliente só no portal; a equipe nunca nele).
 * Qualquer outra coisa (outro site, "//site", "/\site") é descartada e a pessoa vai para o início.
 */
export function safeNextPath(raw: string | null | undefined, role: UserRole | undefined): string | null {
  if (!raw || !role || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (isUnder(url.pathname, "/login")) return null;
  const portal = isUnder(url.pathname, "/portal");
  if (role === "requester") return portal ? path : null;
  return portal ? null : path;
}

// O login Microsoft passa pela API e pela Microsoft: o endereço de volta espera na aba.
const NEXT_KEY = "mf:next";

/** Guarda o endereço de volta antes de sair para o login Microsoft (null apaga). */
export function rememberLoginNext(path: string | null) {
  try {
    if (path) window.sessionStorage.setItem(NEXT_KEY, path);
    else window.sessionStorage.removeItem(NEXT_KEY);
  } catch {
    // Sem armazenamento: depois do login a pessoa vai para o início.
  }
}

/** Endereço de volta guardado antes do login Microsoft (sem apagar). */
export function peekLoginNext(): string | null {
  try {
    return window.sessionStorage.getItem(NEXT_KEY);
  } catch {
    return null;
  }
}

/** Endereço de volta guardado antes do login Microsoft; lido uma vez só. */
export function takeLoginNext(): string | null {
  const value = peekLoginNext();
  rememberLoginNext(null);
  return value;
}

/**
 * Endereço do login para quem ficou sem sessão. Quem abriu um link (a OS mandada no WhatsApp, uma lista
 * filtrada) volta para ele depois de entrar; quem clicou em Sair, não. Sessão vencida: o login explica.
 * Técnico que abriu a central no navegador: o login orienta a usar o app.
 */
export function loginPath(): string {
  const reason = sessionStore.endReason();
  if (reason === "channel") return "/login?acesso=app";
  const params = new URLSearchParams();
  if (reason !== "logout") {
    const here = `${window.location.pathname}${window.location.search}`;
    if (here !== "/" && here !== "/minha-fila" && here !== "/portal") params.set("next", here);
    if (reason === "expired") params.set("motivo", "expirou");
  }
  const query = params.toString();
  return query ? `/login?${query}` : "/login";
}
