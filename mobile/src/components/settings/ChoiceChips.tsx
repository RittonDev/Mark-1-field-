// Fichas de escolha das Configurações: tipo da chave PIX, nível da aptidão e da formação, turnos do dia. "pill" são
// fichas em linha que quebram; "tile" é uma grade de 2 colunas com rótulo e sub-rótulo (os turnos: "Manhã", "06h–12h"),
// que vira uma coluna só com a fonte do sistema acima de 1,2 (a fonte continua crescendo e "Madrugada" não quebra no
// meio). Sem `multi`, um grupo de rádio (o toque devolve o valor tocado); com `multi`, caixas de marcar (o toque devolve
// a lista nova, na ordem das opções). O estado não depende só da cor: a ficha marcada ganha o check.

import type { ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";

/** Acima desta escala da fonte, as fichas "tile" ficam uma por linha (em meia largura, o rótulo quebraria no meio). */
const TILE_ONE_COLUMN_SCALE = 1.2;

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  sublabel?: string;
  /** Como o leitor de tela fala ("Manhã, das 6h ao meio-dia"); sem ele, o rótulo. */
  spoken?: string;
}

/** Os valores marcados, como lista (o valor único vira uma lista de um). */
function selectedOf<T extends string>(value: T | null | T[]): T[] {
  if (Array.isArray(value)) return value;
  return value === null ? [] : [value];
}

export function ChoiceChips<T extends string>({
  options,
  multi = false,
  value,
  onChange,
  accessibilityLabel,
  shape = "pill",
  disabled = false,
}: {
  options: ChoiceOption<T>[];
  multi?: boolean;
  value: T | null | T[];
  /** multi: a lista nova; senão o valor tocado. */
  onChange: (next: T | T[]) => void;
  accessibilityLabel: string;
  /** Padrão "pill". */
  shape?: "pill" | "tile";
  disabled?: boolean;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const { fontScale } = useWindowDimensions();
  const current = selectedOf(value);
  const chosen = new Set<T>(current);

  function press(option: T) {
    if (!multi) {
      onChange(option);
      return;
    }
    const next = new Set(chosen);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    // Na ordem das opções; um valor que não está nas opções continua na lista, no fim.
    const known = new Set(options.map((o) => o.value));
    onChange([...options.filter((o) => next.has(o.value)).map((o) => o.value), ...current.filter((v) => !known.has(v))]);
  }

  function chip(option: ChoiceOption<T>): ReactNode {
    const on = chosen.has(option.value);
    const tile = shape === "tile";
    return (
      <Pressable
        key={option.value}
        onPress={() => press(option.value)}
        disabled={disabled}
        accessibilityRole={multi ? "checkbox" : "radio"}
        accessibilityState={{ checked: on, disabled }}
        accessibilityLabel={option.spoken ?? option.label}
        style={({ pressed }) => [
          tile ? styles.tile : styles.pill,
          on && (tile ? styles.tileOn : styles.pillOn),
          pressed && { backgroundColor: on ? (tile ? c.primaryFillPressed : c.primarySoft) : c.surface2 },
          disabled && styles.disabled,
        ]}
      >
        {tile ? (
          <>
            <Text style={[styles.tileLabel, on && { color: c.onPrimary }]}>{option.label}</Text>
            {option.sublabel ? <Text style={[styles.tileSub, on && { color: c.onPrimary }]}>{option.sublabel}</Text> : null}
            {on ? (
              <View style={styles.tileCheck}>
                <Icon name="check" size={14} color={c.onPrimary} strokeWidth={2.4} />
              </View>
            ) : null}
          </>
        ) : (
          <>
            {multi && on ? <Icon name="check" size={14} color={c.brandInk} strokeWidth={2.4} /> : null}
            <Text style={[styles.pillText, on && { color: c.brandInk }]}>{option.label}</Text>
          </>
        )}
      </Pressable>
    );
  }

  const groupProps = { accessibilityRole: multi ? undefined : ("radiogroup" as const), accessibilityLabel };

  if (shape === "tile") {
    const perRow = fontScale > TILE_ONE_COLUMN_SCALE ? 1 : 2;
    const rows: ChoiceOption<T>[][] = [];
    for (let i = 0; i < options.length; i += perRow) rows.push(options.slice(i, i + perRow));
    return (
      <View style={styles.tiles} {...groupProps}>
        {rows.map((row) => (
          <View key={row.map((o) => o.value).join("|")} style={styles.tileRow}>
            {row.map(chip)}
            {/* Linha incompleta (a última, em 2 colunas): a ficha fica com meia largura, como as outras. */}
            {row.length < perRow ? <View style={styles.tileSpacer} /> : null}
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.pills} {...groupProps}>
      {options.map(chip)}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    pills: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    pill: {
      minHeight: 44,
      minWidth: 48,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: RADIUS.chip,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
    },
    pillOn: { borderColor: c.primary, backgroundColor: c.primarySoft },
    pillText: { fontSize: 15, fontWeight: "600", color: c.ink },
    tiles: { gap: 8 },
    tileRow: { flexDirection: "row", gap: 8 },
    tile: {
      flex: 1,
      minHeight: 56,
      paddingVertical: 10,
      paddingLeft: 12,
      // espaço do check no canto
      paddingRight: 28,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
      justifyContent: "center",
      gap: 2,
    },
    tileOn: { borderColor: c.primaryFill, backgroundColor: c.primaryFill },
    tileSpacer: { flex: 1 },
    tileLabel: { fontSize: 15, fontWeight: "600", color: c.ink },
    tileSub: { fontSize: 12, color: c.inkMuted, fontVariant: ["tabular-nums"] },
    tileCheck: { position: "absolute", top: 8, right: 8 },
    disabled: { opacity: 0.5 },
  });
