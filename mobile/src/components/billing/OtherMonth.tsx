// Faturamento > "Outro mês": abre qualquer mês, do primeiro que o servidor aceita até o atual, inclusive os que não têm
// cartão na aba (sem valores, fora dos 12 meses). A folha tem ‹ Mês de AAAA › e o botão que abre o mês
// (/faturamento/AAAA-MM, com os valores e as notas fiscais dele); o mês abre depois que a folha sai.

import { useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { competenceLabel, monthTitle } from "../../lib/constants";
import { FIRST_MONTH } from "../../lib/earnings";
import { haptic } from "../../lib/haptics";
import { monthKeyOf, shiftMonth } from "../../lib/invoices";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { BottomSheet } from "../ActionSheet";
import { Icon } from "../Icon";
import { PressableScale } from "../motion";
import { Text } from "../Text";
import { Button } from "../ui";

/** `onOpen` recebe o mês escolhido ("AAAA-MM") quando a folha termina de sair. */
export function OtherMonth({ onOpen }: { onOpen: (month: string) => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const [visible, setVisible] = useState(false);
  // O mês atual de quando a folha abriu (o app pode ficar aberto na virada do mês).
  const [current, setCurrent] = useState(() => monthKeyOf(new Date()));
  const [month, setMonth] = useState(current);
  // O mês a abrir quando a folha sair (null: fechou sem escolher).
  const chosen = useRef<string | null>(null);

  const title = monthTitle(month);
  const isFirst = month <= FIRST_MONTH;
  const isCurrent = month >= current;

  function show() {
    const now = monthKeyOf(new Date());
    chosen.current = null;
    setCurrent(now);
    setMonth(now);
    setVisible(true);
  }

  function step(delta: number) {
    const next = shiftMonth(month, delta);
    if (next < FIRST_MONTH || next > current) return;
    haptic.select();
    setMonth(next);
  }

  function open() {
    chosen.current = month;
    setVisible(false);
  }

  // Depois que a folha sai: no iPhone, a tela nova não disputa com o Modal saindo.
  function afterClose() {
    const target = chosen.current;
    chosen.current = null;
    if (target) onOpen(target);
  }

  return (
    <>
      <Pressable
        onPress={show}
        accessibilityRole="button"
        accessibilityLabel="Outro mês"
        accessibilityHint="Escolhe um mês para abrir"
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.surface2 }]}
      >
        <View style={styles.icon}>
          <Icon name="calendar" size={20} color={c.inkMuted} />
        </View>
        <Text style={styles.label}>Outro mês</Text>
        <Icon name="chevronRight" size={18} color={c.inkSubtle} />
      </Pressable>

      <BottomSheet visible={visible} title="Outro mês" onClose={() => setVisible(false)} onClosed={afterClose}>
        <View style={styles.body}>
          <View style={styles.monthNav}>
            <Pressable
              onPress={() => step(-1)}
              disabled={isFirst}
              accessibilityRole="button"
              accessibilityLabel="Mês anterior"
              accessibilityState={{ disabled: isFirst }}
              hitSlop={4}
              style={({ pressed }) => [styles.navButton, isFirst && styles.navDisabled, pressed && { backgroundColor: c.surface3 }]}
            >
              <Icon name="chevronLeft" size={20} color={c.ink} />
            </Pressable>
            <Text style={styles.monthLabel} accessibilityLabel={`Mês: ${title}`} accessibilityLiveRegion="polite">
              {title}
            </Text>
            <Pressable
              onPress={() => step(1)}
              disabled={isCurrent}
              accessibilityRole="button"
              accessibilityLabel="Próximo mês"
              accessibilityState={{ disabled: isCurrent }}
              hitSlop={4}
              style={({ pressed }) => [styles.navButton, isCurrent && styles.navDisabled, pressed && { backgroundColor: c.surface3 }]}
            >
              <Icon name="chevronRight" size={20} color={c.ink} />
            </Pressable>
          </View>
          <Button title={`Abrir ${competenceLabel(month)}`} variant="primary" onPress={open} />
        </View>
        <PressableScale
          onPress={() => setVisible(false)}
          style={styles.cancel}
          pressedStyle={{ backgroundColor: c.surface3 }}
          accessibilityRole="button"
        >
          <Text style={styles.cancelText}>Fechar</Text>
        </PressableScale>
      </BottomSheet>
    </>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 56,
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.elevation,
    },
    icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: c.surface2 },
    label: { flex: 1, fontSize: 15, fontWeight: "600", color: c.ink },
    body: { gap: 12, paddingHorizontal: 4, paddingTop: 4, paddingBottom: 8 },
    monthNav: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      padding: 2,
    },
    navButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: RADIUS.control },
    navDisabled: { opacity: 0.35 },
    monthLabel: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "700", color: c.ink },
    cancel: { paddingVertical: 14, borderRadius: RADIUS.control, alignItems: "center", backgroundColor: c.surface2 },
    cancelText: { fontSize: 15, fontWeight: "600", color: c.ink },
  });
