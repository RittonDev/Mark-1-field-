import { memo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { addressOf, copyText, navigateWith, openInMaps } from "../../lib/device-actions";
import { haptic } from "../../lib/haptics";
import type { LocalTicket } from "../../lib/syncTypes";
import { showToast } from "../../lib/toast";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { ActionSheet, type SheetAction } from "../ActionSheet";
import { Icon, type IconName } from "../Icon";
import { PressableScale } from "../motion";
import { Text } from "../Text";

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

/**
 * Atalhos do atendimento: rota (Google Maps, Waze ou o app do aparelho) e copiar o endereço. Sem
 * "Ligar": o técnico é terceiro e não recebe o contato da loja (quem fala com a loja é a central).
 * A folha de rota é da tela da OS (`onRoute`), que também a abre pela barra e pelo endereço.
 */
export const QuickActions = memo(function QuickActions({ ticket, onRoute }: { ticket: LocalTicket; onRoute: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const address = routeAddress(ticket);
  if (!hasRoute(ticket)) return null;

  const items: { key: string; icon: IconName; label: string; hint?: string; onPress: () => void }[] = [
    { key: "nav", icon: "navigate", label: "Rota", hint: "no app de mapas", onPress: onRoute },
    ...(address ? [{ key: "copy", icon: "copy" as IconName, label: "Copiar", hint: "o endereço", onPress: () => void copyAddress(address) }] : []),
  ];

  return (
    <View style={styles.row}>
      {items.map((item) => (
        <PressableScale
          key={item.key}
          onPress={item.onPress}
          accessibilityRole="button"
          accessibilityLabel={[item.label, item.hint].filter(Boolean).join(", ")}
          style={styles.tile}
          pressedStyle={{ backgroundColor: c.surface3 }}
        >
          <View style={styles.tileIcon}>
            <Icon name={item.icon} size={18} color={c.brandInk} strokeWidth={2} />
          </View>
          <Text style={styles.tileLabel} numberOfLines={1}>
            {item.label}
          </Text>
          {item.hint ? (
            <Text style={styles.tileHint} numberOfLines={1}>
              {item.hint}
            </Text>
          ) : null}
        </PressableScale>
      ))}
    </View>
  );
});

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: "row", gap: 8 },
    tile: {
      flex: 1,
      alignItems: "center",
      gap: 2,
      paddingVertical: 10,
      paddingHorizontal: 6,
      borderRadius: RADIUS.control,
      backgroundColor: c.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      minHeight: 48,
    },
    tileIcon: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: c.primarySoft,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 4,
    },
    tileLabel: { fontSize: 14, fontWeight: "700", color: c.ink },
    tileHint: { fontSize: 12, color: c.inkMuted, maxWidth: "100%" },
  });
