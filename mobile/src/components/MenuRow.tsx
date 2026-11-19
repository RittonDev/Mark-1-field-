// Linhas de menu do Perfil e das Configurações: ícone, rótulo, resumo à direita, pílula e seta. MenuGroup é o cartão de
// um grupo, com o título acima e o traço fino entre as linhas. Cor só quando é problema: o resumo fica cinza, em âmbar
// (sem chave PIX, sem celular) ou em vermelho (ações recusadas); a pílula é sempre neutra.

import { Children, isValidElement, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon, SVG_HIDDEN, type IconName } from "./Icon";
import { Text } from "./Text";
import { Card } from "./ui";

export interface MenuRowProps {
  icon: IconName;
  label: string;
  /** Resumo à direita, numa linha, cortado com "…" ("Ouro", "Seg a sex · manhã e tarde"); some com null ou "". */
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
      <Text style={[styles.label, danger && { color: c.danger }]} numberOfLines={2}>
        {label}
      </Text>
      {danger ? null : trailing ? (
        <View style={styles.trailing} {...SVG_HIDDEN}>
          {trailing}
        </View>
      ) : shownValue ? (
        <Text style={[styles.value, { color: toneColor }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {shownValue}
        </Text>
      ) : null}
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
    label: { flex: 1, fontSize: 15, fontWeight: "600", color: c.ink },
    value: { flexShrink: 1, maxWidth: "50%", fontSize: 14, fontWeight: "500", textAlign: "right" },
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
