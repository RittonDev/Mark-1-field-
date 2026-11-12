import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { STATUS } from "../../lib/constants";
import { addressOf, callPhone, copyText, navigateWith } from "../../lib/device-actions";
import { formatShort } from "../../lib/format";
import { haptic } from "../../lib/haptics";
import { cachedRecurrence, isOnline, refreshRecurrence, useSyncStatus } from "../../lib/sync";
import type { LocalTicket } from "../../lib/syncTypes";
import { showToast } from "../../lib/toast";
import type { TicketDetail } from "../../lib/types";
import { RADIUS, tint, useStyles, useTheme, type Palette } from "../../theme/theme";
import { ActionSheet } from "../ActionSheet";
import { Icon, type IconName } from "../Icon";
import { PressableScale } from "../motion";
import { Text } from "../Text";
import { Card } from "../ui";

type Recurrence = NonNullable<TicketDetail["recurrence"]>;

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

/** Reincidência: outras OS na mesma loja nos últimos 30 dias, para o técnico saber o histórico antes de chegar. */
export function RecurrenceCard({ ticket }: { ticket: LocalTicket }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const [all, setAll] = useState(false);
  const online = isOnline(useSyncStatus());
  const [loaded, setLoaded] = useState<{ id: string; value: Recurrence | null } | null>(null);
  const hasLocation = Boolean(ticket.location);

  // Não vem no sync: a última guardada no aparelho e, com rede, a atual de GET /tickets/{id}.
  useEffect(() => {
    if (!hasLocation) return;
    let alive = true;
    void cachedRecurrence(ticket.id).then((value) => {
      if (alive && value) setLoaded((prev) => (prev?.id === ticket.id ? prev : { id: ticket.id, value }));
    });
    if (online) {
      refreshRecurrence(ticket.id).then(
        (value) => {
          if (alive) setLoaded({ id: ticket.id, value });
        },
        () => undefined, // sem permissão ou fora do ar: fica a guardada
      );
    }
    return () => {
      alive = false;
    };
  }, [ticket.id, online, hasLocation]);

  const recurrence = ticket.recurrence ?? (loaded?.id === ticket.id ? loaded.value : null);
  const count = recurrence?.count_30d ?? ticket.recurrence_30d ?? 0;
  if (count < 1) return null;
  const previous = recurrence?.previous ?? [];
  const shown = all ? previous : previous.slice(0, 3);
  return (
    <Card style={{ gap: 10 }}>
      <View style={[styles.recChip, { backgroundColor: tint(c.warning, "14"), borderColor: tint(c.warning, "40") }]}>
        <Icon name="repeat" size={16} color={c.warning} strokeWidth={2} />
        <Text style={[styles.recChipText, { color: c.warning }]}>
          Reincidência: {count === 1 ? "1 OS nesta loja" : `${count} OS nesta loja`} em 30 dias
        </Text>
      </View>
      {shown.map((p) => (
        <View key={p.id} style={styles.recRow}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.recTitle} numberOfLines={2}>
              <Text style={styles.recCode}>{p.code}</Text> · {p.title}
            </Text>
            <Text style={styles.recMeta}>
              {formatShort(p.created_at)}
              {p.status ? ` · ${STATUS[p.status]?.label ?? p.status}` : ""}
            </Text>
          </View>
        </View>
      ))}
      {previous.length > 3 ? (
        <PressableScale onPress={() => setAll((v) => !v)} accessibilityRole="button" hitSlop={6}>
          <Text style={styles.link}>{all ? "Mostrar menos" : `Ver as ${previous.length}`}</Text>
        </PressableScale>
      ) : null}
    </Card>
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
    recChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      alignSelf: "flex-start",
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: RADIUS.chip,
      borderWidth: StyleSheet.hairlineWidth,
    },
    recChipText: { fontSize: 13, fontWeight: "700" },
    recRow: {
      flexDirection: "row",
      gap: 10,
      paddingVertical: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    recTitle: { fontSize: 14, color: c.ink, lineHeight: 19 },
    recCode: { fontWeight: "700", fontVariant: ["tabular-nums"] },
    recMeta: { fontSize: 12, color: c.inkSubtle, fontVariant: ["tabular-nums"] },
    link: { fontSize: 13, fontWeight: "600", color: c.brandInk },
  });
