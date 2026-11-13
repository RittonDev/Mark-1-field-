import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { addressOf, callPhone, copyText, navigateWith } from "../../lib/device-actions";
import { haptic } from "../../lib/haptics";
import type { LocalTicket } from "../../lib/syncTypes";
import { showToast } from "../../lib/toast";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { ActionSheet } from "../ActionSheet";
import { Icon, type IconName } from "../Icon";
import { PressableScale } from "../motion";
import { Text } from "../Text";

/** Atalhos do atendimento: ligar para a loja, rota no Google Maps/Waze e copiar o endereço. */
export function QuickActions({ ticket }: { ticket: LocalTicket }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const [navOpen, setNavOpen] = useState(false);
  const phone = ticket.location?.contact_phone?.trim() || null;
  const address = ticket.service_address?.trim() || addressOf(ticket.location);
  const hasTarget = Boolean(address || (ticket.location?.latitude !== null && ticket.location?.latitude !== undefined));
  if (!phone && !hasTarget) return null;

  async function copy() {
    if (!address) return;
    haptic.select();
    const ok = await copyText(address);
    showToast(ok ? "Endereço copiado" : "Não foi possível copiar", { tone: ok ? "success" : "error", description: ok ? address : undefined });
  }

  const items: { key: string; icon: IconName; label: string; hint?: string; onPress: () => void }[] = [
    ...(phone
      ? [
          {
            key: "call",
            icon: "phone" as IconName,
            label: "Ligar",
            hint: ticket.location?.contact_name ?? undefined,
            onPress: () => void callPhone(phone),
          },
        ]
      : []),
    ...(hasTarget ? [{ key: "nav", icon: "navigate" as IconName, label: "Rota", hint: "Maps ou Waze", onPress: () => setNavOpen(true) }] : []),
    ...(address ? [{ key: "copy", icon: "copy" as IconName, label: "Copiar", hint: "o endereço", onPress: () => void copy() }] : []),
  ];

  return (
    <>
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
      {navOpen ? (
        <ActionSheet
          title="Navegar até o local"
          onClose={() => setNavOpen(false)}
          actions={[
            { key: "google", label: "Google Maps", icon: "navigate", onPress: () => void navigateWith("google", ticket.location, ticket.service_address) },
            { key: "waze", label: "Waze", icon: "navigate", onPress: () => void navigateWith("waze", ticket.location, ticket.service_address) },
            ...(address ? [{ key: "copy", label: "Copiar endereço", icon: "copy" as IconName, onPress: () => void copy() }] : []),
          ]}
        />
      ) : null}
    </>
  );
}

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
    tileLabel: { fontSize: 13, fontWeight: "700", color: c.ink },
    tileHint: { fontSize: 11, color: c.inkSubtle, maxWidth: "100%" },
  });
