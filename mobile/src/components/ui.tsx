import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState, type ReactNode, type Ref } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View,
  type LayoutRectangle,
  type StyleProp,
  type TextInputInstance,
  type TextStyle,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { haptic } from "../lib/haptics";
import { brandFont } from "../theme/fonts";
import { BRAND, RADIUS, readable, statusFill, tint, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon, type IconName } from "./Icon";
import { PressableScale, SPRING } from "./motion";
import { MAX_FONT_SCALE, Text } from "./Text";

export { tint };

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

/** Botão compacto tem 36 pt de altura: a área de toque cresce até 44+ sem mudar o desenho. */
const COMPACT_HIT_SLOP = { top: 6, bottom: 6, left: 4, right: 4 } as const;

export function Button({
  title,
  onPress,
  variant = "secondary",
  loading = false,
  disabled = false,
  compact = false,
  icon,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const palette = {
    primary: { bg: c.primaryFill, pressed: c.primaryFillPressed, fg: c.onPrimary, border: c.primaryFill },
    secondary: { bg: c.surface, pressed: c.surface2, fg: c.ink, border: c.lineStrong },
    danger: { bg: c.surface, pressed: c.dangerSoft, fg: c.danger, border: tint(c.danger, "55") },
    ghost: { bg: "transparent", pressed: c.primarySoft, fg: c.brandInk, border: "transparent" },
  }[variant];
  const inactive = disabled || loading;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      onPress={onPress}
      disabled={inactive}
      hitSlop={compact ? COMPACT_HIT_SLOP : undefined}
      style={[
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: palette.bg, borderColor: palette.border, opacity: inactive ? 0.5 : 1 },
        variant === "primary" && c.elevation ? { boxShadow: c.elevation } : null,
        style,
      ]}
      pressedStyle={{ backgroundColor: palette.pressed }}
    >
      {loading ? <ActivityIndicator color={palette.fg} size="small" /> : icon ? <Icon name={icon} size={18} color={palette.fg} /> : null}
      <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: palette.fg }]}>{title}</Text>
    </PressableScale>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.card, style]}>{children}</View>;
}

/**
 * Selo (status, pagamento, aviso). Como o Pill da web: fundo e borda com a cor diluída e o texto
 * misturado à tinta do tema até 4,5:1 (`readable`), legível no sol; o ponto mantém a cor pura.
 */
export function Badge({ label, color }: { label: string; color: string }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const fill = statusFill(color, c);
  const dark = c.scheme === "dark";
  return (
    <View style={[styles.badge, { backgroundColor: tint(fill, dark ? "24" : "17"), borderColor: tint(fill, dark ? "40" : "38") }]}>
      <View style={[styles.badgeDot, { backgroundColor: fill }]} />
      <Text style={[styles.badgeText, { color: readable(color, c) }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
    </View>
  );
}

export function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      {children}
      {error ? <Text style={styles.fieldError}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

/**
 * Campo de texto. `icon` à esquerda e `right` (ex.: mostrar senha) à direita são opcionais; `ref` vai
 * direto ao TextInput (para o "próximo" do teclado focar o campo seguinte). Sem `accessibilityLabel`,
 * o leitor de tela lê o placeholder.
 */
export function Input({
  icon,
  right,
  ref,
  ...props
}: TextInputProps & { icon?: IconName; right?: ReactNode; ref?: Ref<TextInputInstance> }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const fontFamily = brandFont("400");
  const frame = [styles.inputFrame, focused && styles.inputFocused, props.multiline && styles.inputMultiline];
  const input = (
    <TextInput
      ref={ref}
      placeholderTextColor={c.placeholder}
      selectionColor={c.primary}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      accessibilityLabel={props.accessibilityLabel ?? props.placeholder}
      {...props}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
      style={[
        styles.input,
        fontFamily ? { fontFamily } : null,
        icon || right ? styles.inputBare : frame,
        // Na web o foco já aparece na moldura; sem o contorno padrão do navegador.
        Platform.OS === "web" ? ({ outlineStyle: "none" } as unknown as TextStyle) : null,
        props.multiline && styles.inputMultiline,
        props.style,
      ]}
    />
  );
  if (!icon && !right) return input;
  return (
    <View style={[frame, styles.inputRow]}>
      {icon ? <Icon name={icon} size={18} color={focused ? c.primary : c.inkSubtle} /> : null}
      {input}
      {right}
    </View>
  );
}

export function SwitchRow({
  label,
  value,
  onValueChange,
  hint,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  hint?: string;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.switchRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.switchLabel}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: c.primary, false: c.lineStrong }} />
    </View>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/**
 * Pílula animada atrás da opção ativa: mede cada opção e desliza (mola) até a escolhida.
 * Usada no Segmented e na barra de abas.
 */
export function usePill<T extends string>(value: T) {
  const reduced = useReducedMotion();
  const [layouts, setLayouts] = useState<Partial<Record<T, LayoutRectangle>>>({});
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  const target = layouts[value];

  useEffect(() => {
    if (!target) return;
    // Primeira medida (ou movimento reduzido): posiciona sem animar.
    if (reduced || width.get() === 0) {
      x.set(target.x);
      width.set(target.width);
    } else {
      x.set(withSpring(target.x, SPRING));
      width.set(withSpring(target.width, SPRING));
    }
  }, [target, reduced, x, width]);

  const pillStyle = useAnimatedStyle(() => ({ width: width.get(), transform: [{ translateX: x.get() }] }));
  const measure = (key: T) => (layout: LayoutRectangle) => setLayouts((prev) => ({ ...prev, [key]: layout }));
  return { pillStyle, measure, ready: Boolean(target) };
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const styles = useStyles(makeStyles);
  const { pillStyle, measure, ready } = usePill(value);
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      <Animated.View style={[styles.segmentPill, pillStyle, !ready && { opacity: 0 }]} />
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onLayout={(e) => measure(option.value)(e.nativeEvent.layout)}
            onPress={() => {
              if (!active) haptic.select();
              onChange(option.value);
            }}
            hitSlop={4}
            style={styles.segment}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>
              {option.label}
              {option.count !== undefined ? <Text style={styles.segmentCount}>{`  ${option.count}`}</Text> : null}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: IconName;
  /** Saída do vazio (ex.: "Ver agenda"). */
  action?: { label: string; onPress: () => void };
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.empty}>
      {icon ? (
        <View style={styles.emptyIcon}>
          <Icon name={icon} size={22} color={c.inkMuted} />
        </View>
      ) : null}
      <Text style={styles.emptyTitle}>{title}</Text>
      {description ? <Text style={styles.emptyText}>{description}</Text> : null}
      {action ? <Button compact variant="ghost" title={action.label} onPress={action.onPress} style={styles.emptyAction} /> : null}
    </View>
  );
}

export function ErrorBox({ message }: { message: string }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.errorBox} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <Icon name="alert" size={16} color={c.danger} />
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

/** Aviso neutro (informação, não erro): ex.: "Sua sessão expirou" no login. */
export function InfoBox({ message, icon = "alert" }: { message: string; icon?: IconName }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.infoBox} accessibilityLiveRegion="polite">
      <Icon name={icon} size={16} color={c.inkMuted} />
      <Text style={styles.infoBoxText}>{message}</Text>
    </View>
  );
}

/**
 * Título de bloco. Padrão: rótulo em caixa alta (negrito, ink-muted). Com `accent`, título de cartão
 * em negrito com a barra de 3 px da marca (azul → ciano), como o CardHeader da web.
 */
export function SectionTitle({ children, right, accent = false }: { children: ReactNode; right?: ReactNode; accent?: boolean }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.sectionTitleRow}>
      {accent ? (
        <View style={styles.sectionAccentRow}>
          <LinearGradient colors={[BRAND.blue, BRAND.cyan]} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={styles.sectionAccentBar} />
          <Text style={styles.sectionTitleAccent} accessibilityRole="header">
            {children}
          </Text>
        </View>
      ) : (
        <Text style={styles.sectionTitle}>{children}</Text>
      )}
      {right}
    </View>
  );
}

export function InfoRow({ label, value, onPress }: { label: string; value: ReactNode; onPress?: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const content = (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      {typeof value === "string" ? (
        <Text style={[styles.infoValue, onPress && styles.infoLink]} selectable={!onPress}>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
  if (!onPress) return content;
  // Linha que abre algo: área de toque de 44 pt, fundo ao pressionar e a seta indicando a navegação.
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={typeof value === "string" ? `${label}: ${value}` : label}
      style={({ pressed }) => [styles.infoPressable, pressed && { backgroundColor: c.surface2 }]}
    >
      <View style={{ flex: 1 }}>{content}</View>
      <Icon name="chevronRight" size={18} color={c.inkSubtle} />
    </Pressable>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    button: {
      minHeight: 48,
      paddingHorizontal: 16,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    buttonCompact: { minHeight: 36, paddingHorizontal: 12 },
    buttonText: { fontSize: 15, fontWeight: "600", letterSpacing: 0.1 },
    buttonTextCompact: { fontSize: 14 },
    card: {
      backgroundColor: c.surface,
      borderRadius: RADIUS.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      padding: 16,
      boxShadow: c.elevation,
    },
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderRadius: RADIUS.chip,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 8,
      paddingVertical: 4,
      alignSelf: "flex-start",
    },
    badgeDot: { width: 6, height: 6, borderRadius: 3 },
    badgeText: { fontSize: 12, fontWeight: "600" },
    field: { gap: 8 },
    label: { fontSize: 13, fontWeight: "600", color: c.ink },
    required: { color: c.danger },
    hint: { fontSize: 12, color: c.inkMuted, lineHeight: 17 },
    fieldError: { fontSize: 12, color: c.danger },
    inputFrame: {
      minHeight: 48,
      borderWidth: 1,
      borderColor: c.lineStrong,
      borderRadius: RADIUS.control,
      backgroundColor: c.surface,
    },
    inputFocused: { borderColor: c.primary, boxShadow: `0px 0px 0px 3px ${c.primarySoft}` },
    inputRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
    input: { paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, color: c.ink },
    inputBare: { flex: 1, paddingHorizontal: 0, borderWidth: 0, minHeight: 46 },
    inputMultiline: { minHeight: 92, textAlignVertical: "top" },
    switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    switchLabel: { fontSize: 14, color: c.ink, fontWeight: "500" },
    segmented: { flexDirection: "row", backgroundColor: c.segment, borderRadius: RADIUS.control + 2, padding: 4 },
    segmentPill: {
      position: "absolute",
      top: 4,
      bottom: 4,
      left: 0,
      borderRadius: RADIUS.control - 2,
      backgroundColor: c.surface,
      borderWidth: c.scheme === "dark" ? StyleSheet.hairlineWidth : 0,
      borderColor: c.lineStrong,
      boxShadow: c.elevation,
    },
    segment: {
      flex: 1,
      minHeight: 40,
      paddingVertical: 8,
      borderRadius: RADIUS.control - 2,
      alignItems: "center",
      justifyContent: "center",
    },
    segmentText: { fontSize: 13, fontWeight: "600", color: c.inkMuted },
    segmentTextActive: { color: c.ink },
    segmentCount: { fontWeight: "500", color: c.inkSubtle, fontVariant: ["tabular-nums"] },
    empty: { alignItems: "center", paddingVertical: 40, paddingHorizontal: 24, gap: 8 },
    emptyIcon: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.surface3,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 4,
    },
    emptyTitle: { fontSize: 16, fontWeight: "600", color: c.ink, textAlign: "center" },
    emptyText: { fontSize: 14, color: c.inkMuted, textAlign: "center", lineHeight: 20 },
    emptyAction: { marginTop: 4 },
    errorBox: {
      flexDirection: "row",
      gap: 8,
      alignItems: "flex-start",
      backgroundColor: c.dangerSoft,
      borderColor: tint(c.danger, "40"),
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: RADIUS.control,
      padding: 12,
    },
    errorText: { color: c.danger, fontSize: 13, lineHeight: 18, flex: 1 },
    infoBox: {
      flexDirection: "row",
      gap: 8,
      alignItems: "flex-start",
      backgroundColor: c.surface2,
      borderColor: c.line,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: RADIUS.control,
      padding: 12,
    },
    infoBoxText: { color: c.ink, fontSize: 13, lineHeight: 18, flex: 1 },
    sectionTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 },
    sectionTitle: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    sectionAccentRow: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
    sectionAccentBar: { width: 3, height: 14, borderRadius: 2 },
    sectionTitleAccent: { fontSize: 14, fontWeight: "700", color: c.ink, flexShrink: 1 },
    infoRow: { paddingVertical: 6, gap: 2 },
    infoPressable: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 44,
      marginHorizontal: -8,
      paddingHorizontal: 8,
      borderRadius: RADIUS.control,
    },
    infoLabel: { fontSize: 12, color: c.inkMuted },
    infoValue: { fontSize: 15, color: c.ink },
    infoLink: { color: c.brandInk },
  });
