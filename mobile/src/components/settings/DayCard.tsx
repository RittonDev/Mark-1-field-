// Um dia da Disponibilidade: o cabeçalho (nome do dia e os turnos marcados) abre e fecha os 4 turnos do dia, em fichas
// de 2 colunas. Dia com turno fica azul-claro com borda azul. Num dia útil com turno, quando outro dia útil está
// diferente, aparece "Copiar para os dias úteis".

import { Pressable, StyleSheet, View } from "react-native";
import { DAY_PERIOD, DAY_PERIOD_ORDER, dayPeriodsText, WEEKDAY } from "../../lib/constants";
import { daySpoken } from "../../lib/techProfileForm";
import type { DayPeriod, Weekday } from "../../lib/types";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { PressableScale } from "../motion";
import { Text } from "../Text";
import { ChoiceChips, type ChoiceOption } from "./ChoiceChips";

const PERIOD_OPTIONS: ChoiceOption<DayPeriod>[] = DAY_PERIOD_ORDER.map((period) => ({
  value: period,
  label: DAY_PERIOD[period].label,
  sublabel: DAY_PERIOD[period].hours,
  spoken: `${DAY_PERIOD[period].label}, ${DAY_PERIOD[period].spoken}`,
}));

/** O botão compacto tem 36 pt de altura: a área de toque cresce até 44+ sem mudar o desenho (como o Button). */
const COMPACT_HIT_SLOP = { top: 6, bottom: 6, left: 4, right: 4 } as const;

export function DayCard({
  day,
  periods,
  expanded,
  onToggleExpanded,
  onTogglePeriod,
  onCopy,
}: {
  day: Weekday;
  /** Os turnos marcados do dia, na ordem. */
  periods: DayPeriod[];
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Um toque numa ficha: marca ou desmarca aquele turno. */
  onTogglePeriod: (period: DayPeriod) => void;
  /** "Copiar para os dias úteis" (sem ele, o botão não aparece). */
  onCopy?: () => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const marked = periods.length > 0;
  const dayName = WEEKDAY[day].label;

  return (
    <View style={[styles.card, marked ? styles.cardOn : styles.cardOff]}>
      <Pressable
        onPress={onToggleExpanded}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={daySpoken(day, periods)}
        accessibilityHint="Mostra os turnos do dia"
        style={({ pressed }) => [styles.header, pressed && styles.headerPressed]}
      >
        <View style={styles.headerText}>
          <Text style={[styles.day, marked && { color: c.brandInk }]}>{dayName}</Text>
          <Text style={[styles.periods, !marked && { color: c.inkSubtle }]}>{marked ? dayPeriodsText(periods) : "Sem turnos"}</Text>
        </View>
        <Icon name={expanded ? "chevronUp" : "chevronDown"} size={18} color={c.inkSubtle} />
      </Pressable>

      {expanded ? (
        <View style={styles.body}>
          <ChoiceChips
            shape="tile"
            multi
            options={PERIOD_OPTIONS}
            value={periods}
            accessibilityLabel={`Turnos de ${dayName.toLowerCase()}`}
            onChange={(next) => {
              // Cada toque marca ou desmarca uma ficha: o turno que mudou.
              const list = Array.isArray(next) ? next : [next];
              const toggled = DAY_PERIOD_ORDER.find((period) => list.includes(period) !== periods.includes(period));
              if (toggled) onTogglePeriod(toggled);
            }}
          />
          {onCopy ? (
            <PressableScale
              onPress={onCopy}
              hitSlop={COMPACT_HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel={`Copiar os turnos de ${dayName.toLowerCase()} para os dias úteis`}
              style={styles.copy}
              pressedStyle={{ backgroundColor: c.surface2 }}
            >
              <Icon name="copy" size={18} color={c.ink} />
              <Text style={styles.copyText}>Copiar para os dias úteis</Text>
            </PressableScale>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    card: { borderRadius: RADIUS.card, borderWidth: 1.5, overflow: "hidden" },
    cardOn: { backgroundColor: c.primarySoft, borderColor: c.primary },
    cardOff: { backgroundColor: c.surface, borderColor: c.line },
    header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, minHeight: 56 },
    headerPressed: { opacity: 0.7 },
    headerText: { flex: 1, gap: 2 },
    day: { fontSize: 15, fontWeight: "700", color: c.ink },
    periods: { fontSize: 13, color: c.inkMuted },
    body: { paddingHorizontal: 14, paddingBottom: 14, gap: 12 },
    copy: {
      alignSelf: "flex-start",
      minHeight: 36,
      paddingHorizontal: 12,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    copyText: { fontSize: 14, fontWeight: "600", color: c.ink },
  });
