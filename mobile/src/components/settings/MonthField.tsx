// Campo de mês ("AAAA-MM") da Formação: mostra "02/2019" ou "Selecionar mês" e abre uma folha com o ano e os 12 meses.
// Os meses fora de [min, max] (antes de 1950-01, depois do mês atual, ou antes do início no campo Fim) nem podem ser
// escolhidos. Não usa o seletor de data do sistema: o Android não tem um só de mês, e a folha funciona igual na
// pré-visualização web.

import { useState } from "react";
import { Keyboard, Pressable, StyleSheet, View } from "react-native";
import { competenceLabel, monthText } from "../../lib/constants";
import { haptic } from "../../lib/haptics";
import { monthGrid, yearOf, type MonthCell } from "../../lib/techProfileForm";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { BottomSheet } from "../ActionSheet";
import { Icon } from "../Icon";
import { Text } from "../Text";

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

export function MonthField({
  label,
  value,
  onChange,
  min,
  max,
  disabled = false,
  disabledText,
}: {
  /** "Início" ou "Fim": o título da folha e o começo do que o leitor de tela fala. */
  label: string;
  value: string | null;
  onChange: (month: string) => void;
  /** Primeiro e último mês que dá para escolher ("AAAA-MM"). */
  min: string;
  max: string;
  disabled?: boolean;
  /** No lugar do mês quando o campo está desligado ("Em andamento"). */
  disabledText?: string;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => yearOf(value ?? max));
  const firstYear = yearOf(min);
  const lastYear = yearOf(max);

  function openSheet() {
    if (disabled) return;
    Keyboard.dismiss();
    // Abre no ano do mês escolhido (ou no último que vale).
    setYear(clamp(yearOf(value ?? max), firstYear, lastYear));
    setOpen(true);
  }

  function choose(cell: MonthCell) {
    if (cell.disabled) return;
    haptic.select();
    onChange(cell.month);
    setOpen(false);
  }

  const placeholder = disabled && disabledText ? null : value ? null : "Selecionar mês";
  const shown = disabled && disabledText ? disabledText : value ? monthText(value) : null;
  const spokenValue = disabled && disabledText ? disabledText.toLowerCase() : value ? competenceLabel(value) : "selecionar mês";
  const cells = monthGrid(year, min, max, value);
  const rows = [cells.slice(0, 3), cells.slice(3, 6), cells.slice(6, 9), cells.slice(9, 12)];

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${spokenValue}`}
        accessibilityState={{ disabled }}
        onPress={openSheet}
        disabled={disabled}
        style={({ pressed }) => [styles.field, pressed && { backgroundColor: c.surface2 }, disabled && styles.fieldDisabled]}
      >
        <Text style={[styles.fieldText, placeholder ? { color: c.placeholder } : null]} numberOfLines={1}>
          {shown ?? placeholder}
        </Text>
        <Icon name="calendar" size={18} color={c.inkSubtle} />
      </Pressable>

      <BottomSheet visible={open} title={label} onClose={() => setOpen(false)}>
        <View style={styles.body}>
          <View style={styles.yearRow}>
            <YearButton
              icon="chevronLeft"
              label="Ano anterior"
              disabled={year <= firstYear}
              onPress={() => setYear((y) => Math.max(firstYear, y - 1))}
            />
            <Text style={styles.year} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.4}>
              {year}
            </Text>
            <YearButton
              icon="chevronRight"
              label="Próximo ano"
              disabled={year >= lastYear}
              onPress={() => setYear((y) => Math.min(lastYear, y + 1))}
            />
          </View>
          <View style={styles.grid}>
            {rows.map((row) => (
              <View key={row[0].month} style={styles.gridRow}>
                {row.map((cell) => (
                  <Pressable
                    key={cell.month}
                    onPress={() => choose(cell)}
                    disabled={cell.disabled}
                    accessibilityRole="button"
                    accessibilityLabel={cell.spoken}
                    accessibilityState={{ selected: cell.selected, disabled: cell.disabled }}
                    style={({ pressed }) => [
                      styles.cell,
                      cell.selected ? styles.cellOn : pressed ? { backgroundColor: c.surface3 } : null,
                      cell.disabled && styles.cellDisabled,
                    ]}
                  >
                    <Text style={[styles.cellText, cell.selected && { color: c.onPrimary }]} maxFontSizeMultiplier={1.4}>
                      {cell.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
        </View>
      </BottomSheet>
    </>
  );
}

function YearButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: "chevronLeft" | "chevronRight";
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.yearButton, pressed && { backgroundColor: c.surface2 }, disabled && styles.yearButtonDisabled]}
    >
      <Icon name={icon} size={22} color={c.ink} />
    </Pressable>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    field: {
      minHeight: 46,
      borderWidth: 1,
      borderColor: c.lineStrong,
      borderRadius: 10,
      paddingHorizontal: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: c.surface,
    },
    fieldDisabled: { opacity: 0.6 },
    fieldText: { flex: 1, fontSize: 15, color: c.ink, fontVariant: ["tabular-nums"] },
    body: { paddingHorizontal: 4, paddingBottom: 8, gap: 12 },
    yearRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    yearButton: { width: 44, height: 44, borderRadius: RADIUS.control, alignItems: "center", justifyContent: "center" },
    yearButtonDisabled: { opacity: 0.35 },
    year: { fontSize: 17, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    grid: { gap: 8 },
    gridRow: { flexDirection: "row", gap: 8 },
    cell: {
      flex: 1,
      minHeight: 48,
      borderRadius: RADIUS.control,
      backgroundColor: c.surface2,
      alignItems: "center",
      justifyContent: "center",
    },
    cellOn: { backgroundColor: c.primaryFill },
    cellDisabled: { opacity: 0.4 },
    cellText: { fontSize: 15, fontWeight: "600", color: c.ink },
  });
