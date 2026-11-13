// Rota até o local do atendimento: a folha "Navegar até o local" (Google Maps, Waze, o app de mapas
// do aparelho e copiar o endereço). Sem "Ligar": o técnico é terceiro e não recebe o contato da loja
// (quem fala com a loja é a central). Abre pelo endereço da OS, pela barra fixa e pelos cartões da lista.

import { Platform } from "react-native";
import { addressOf, copyText, navigateWith, openInMaps } from "../../lib/device-actions";
import { haptic } from "../../lib/haptics";
import type { LocalTicket } from "../../lib/syncTypes";
import { showToast } from "../../lib/toast";
import { ActionSheet, type SheetAction } from "../ActionSheet";
import type { IconName } from "../Icon";

type RouteTarget = Pick<LocalTicket, "service_address" | "location">;

/** Endereço que a rota usa: o do atendimento quando a OS tem um; senão o cadastrado da loja. */
export const routeAddress = (ticket: RouteTarget) => ticket.service_address?.trim() || addressOf(ticket.location);

/** Há para onde traçar rota (endereço ou coordenadas da loja). */
export const hasRoute = (ticket: RouteTarget) =>
  Boolean(routeAddress(ticket) || (ticket.location?.latitude !== null && ticket.location?.latitude !== undefined));

async function copyAddress(address: string) {
  haptic.select();
  const ok = await copyText(address);
  showToast(ok ? "Endereço copiado" : "Não foi possível copiar", { tone: ok ? "success" : "error", description: ok ? address : undefined });
}

/** Folha "Navegar até o local": Google Maps, Waze, o app de mapas do aparelho e copiar o endereço. */
export function RouteSheet({ ticket, visible, onClose }: { ticket: RouteTarget; visible: boolean; onClose: () => void }) {
  const address = routeAddress(ticket);
  const actions: SheetAction[] = [
    { key: "google", label: "Google Maps", icon: "navigate", onPress: () => void navigateWith("google", ticket.location, ticket.service_address) },
    { key: "waze", label: "Waze", icon: "navigate", onPress: () => void navigateWith("waze", ticket.location, ticket.service_address) },
    // iPhone: Mapas da Apple; Android: o sistema pergunta qual app de mapas usar.
    {
      key: "system",
      label: Platform.OS === "ios" ? "Mapas da Apple" : "Outro app de mapas",
      icon: "pin",
      onPress: () => void openInMaps(ticket.location, ticket.service_address),
    },
    ...(address ? [{ key: "copy", label: "Copiar endereço", icon: "copy" as IconName, onPress: () => void copyAddress(address) }] : []),
  ];
  return <ActionSheet visible={visible} title="Navegar até o local" onClose={onClose} actions={actions} />;
}
