// Linhas de menu do Perfil e das Configurações: ícone, rótulo, resumo à direita, pílula e seta. MenuGroup é o cartão de
// um grupo, com o título acima e o traço fino entre as linhas. Cor só quando é problema: o resumo fica cinza, em âmbar
// (sem chave PIX, sem celular) ou em vermelho (ações recusadas); a pílula é sempre neutra. O rótulo tem a vez: fica com
// a largura dele (até metade da linha, quebrando só entre palavras) e o resumo fica com o resto, cortado com "…"; com a
// fonte do aparelho acima de 1,3, o resumo desce para baixo do rótulo.

import { Children, isValidElement, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon, SVG_HIDDEN, type IconName } from "./Icon";
import { Text } from "./Text";
import { Card } from "./ui";

export interface MenuRowProps {
  icon: IconName;
  label: string;
  /**
   * Resumo à direita (com a fonte grande, embaixo do rótulo), numa linha, cortado com "…" ("Ouro", "Seg a sex · manhã e
   * tarde"); some com null ou "".
   */
  value?: string | null;
  /** Cor do resumo: "muted" (inkMuted, padrão), "warning" (warningInk) ou "danger" (dangerInk). */
  valueTone?: "muted" | "warning" | "danger";
  /** No lugar do resumo (Avatar 28, Skeleton 64×12, ActivityIndicator); decorativo. */
  trailing?: ReactNode;
  /** Pílula neutra antes da seta (itens para enviar); 0 ou null some; acima de 99, "99+". */
  count?: number | null;
  /** "danger": ícone e rótulo em c.danger, sem resumo, sem pílula e sem seta (Sair). */
  variant?: "default" | "danger";
  /** Indicador pequeno no lugar do ícone (saindo). */
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
  /** Sem ele: rótulo, resumo e pílula juntos ("Contato, (11) 98888-7777"; "Sincronização, 3 itens"). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

/** Da margem esquerda ao texto: padding 16 + ícone 20 + espaço 12 (onde começa o traço entre as linhas). */
const TEXT_INSET = 48;

/**
 * Com a fonte do aparelho a partir disto (o "Grande" do Android é 1,3), o resumo desce para baixo do rótulo: os dois
 * numa linha só não cabem.
 */
const STACK_FONT_SCALE = 1.3;

const pillText = (n: number) => (n > 99 ? "99+" : String(n));

export function MenuRow({
  icon,
  label,
  value,
  valueTone = "muted",
  trailing,
  count,
  variant = "default",
  loading = false,
  disabled = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
}: MenuRowProps) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const { fontScale } = useWindowDimensions();
  const danger = variant === "danger";
  const iconColor = danger ? c.danger : c.inkMuted;
  const shownValue = danger ? null : value || null;
  const shownCount = !danger && count && count > 0 ? count : 0;
  const toneColor = valueTone === "warning" ? c.warningInk : valueTone === "danger" ? c.dangerInk : c.inkMuted;
  const spoken =
    accessibilityLabel ??
    [label, trailing ? null : shownValue, shownCount ? (shownCount === 1 ? "1 item" : `${shownCount} itens`) : null]
      .filter(Boolean)
      .join(", ");
  const inactive = disabled || loading;
  // O resumo em texto (o `trailing` fica sempre à direita): com a fonte grande, desce para baixo do rótulo.
  const textValue = trailing ? null : shownValue;
  const stacked = textValue !== null && fontScale >= STACK_FONT_SCALE;
  const labelText = (
    <Text
      style={[styles.label, stacked ? null : textValue ? styles.labelFirst : styles.labelFill, danger && { color: c.danger }]}
      numberOfLines={stacked ? 3 : 2}
    >
      {label}
    </Text>
  );
  const valueText = textValue ? (
    <Text style={[styles.value, !stacked && styles.valueBeside, { color: toneColor }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
      {textValue}
    </Text>
  ) : null;

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.surface2 }, disabled && styles.disabled]}
    >
      <View style={styles.icon}>
        {loading ? <ActivityIndicator size="small" color={iconColor} /> : <Icon name={icon} size={20} color={iconColor} />}
      </View>
      {stacked ? (
        <View style={styles.stack}>
          {labelText}
          {valueText}
        </View>
      ) : (
        <>
          {labelText}
          {danger ? null : trailing ? (
            <View style={styles.trailing} {...SVG_HIDDEN}>
              {trailing}
            </View>
          ) : (
            valueText
          )}
        </>
      )}
      {shownCount ? (
        <View style={styles.pill}>
          <Text style={styles.pillText} maxFontSizeMultiplier={1.2}>
            {pillText(shownCount)}
          </Text>
        </View>
      ) : null}
      {danger ? null : <Icon name="chevronRight" size={18} color={c.inkSubtle} />}
    </Pressable>
  );
}

/** Cartão de um grupo, com o traço fino entre as linhas. `title`: rótulo do grupo acima do cartão. */
export function MenuGroup({ title, children }: { title?: string; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  // toArray ignora os nulos: uma linha que não aparece não deixa traço sobrando.
  const rows = Children.toArray(children);
  return (
    <View style={styles.group}>
      {title ? (
        <Text style={styles.groupTitle} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      <Card style={styles.card}>
        {rows.map((row, index) => (
          <View key={isValidElement(row) && row.key !== null ? row.key : index}>
            {row}
            {index > 0 ? <View style={styles.divider} /> : null}
          </View>
        ))}
      </Card>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    row: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    disabled: { opacity: 0.5 },
    icon: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
    label: { fontSize: 15, fontWeight: "600", color: c.ink },
    // Sem resumo em texto: o rótulo ocupa a linha até a pílula e a seta (o `trailing` fica com a largura dele).
    labelFill: { flex: 1 },
    // Com o resumo ao lado: a largura do rótulo, até metade da linha, sem encolher (não parte palavra no meio) e sem
    // crescer (crescendo os dois, a sobra se dividiria e o resumo seria cortado à toa).
    labelFirst: { flexShrink: 0, maxWidth: "50%" },
    value: { fontSize: 14, fontWeight: "500" },
    // Ao lado do rótulo: o resto da linha, encostado à direita; encolhe com "…".
    valueBeside: { flexGrow: 1, flexShrink: 1, minWidth: 0, textAlign: "right" },
    // Fonte grande: rótulo e, embaixo, o resumo, alinhados à esquerda até a pílula e a seta.
    stack: { flex: 1, gap: 2 },
    trailing: { flexShrink: 0, alignItems: "flex-end", justifyContent: "center" },
    pill: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      paddingHorizontal: 6,
      backgroundColor: c.surface3,
      alignItems: "center",
      justifyContent: "center",
    },
    pillText: { fontSize: 12, fontWeight: "700", color: c.ink, fontVariant: ["tabular-nums"] },
    group: { gap: 8 },
    groupTitle: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    card: { padding: 0, overflow: "hidden" },
    divider: {
      position: "absolute",
      top: 0,
      left: TEXT_INSET,
      right: 0,
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.line,
    },
  });
