import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { readable, tint, useStyles, useTheme, type Palette } from "../theme/theme";

export { tint };

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export function Button({
  title,
  onPress,
  variant = "secondary",
  loading = false,
  disabled = false,
  compact = false,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const palette = {
    primary: { bg: c.primary, pressed: c.primaryPressed, fg: c.onPrimary, border: c.primary },
    secondary: { bg: c.surface, pressed: c.surface2, fg: c.ink, border: c.lineStrong },
    danger: { bg: c.surface, pressed: c.dangerSoft, fg: c.danger, border: tint(c.danger, "66") },
    ghost: { bg: "transparent", pressed: c.primarySoft, fg: c.primary, border: "transparent" },
  }[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        {
          backgroundColor: pressed ? palette.pressed : palette.bg,
          borderColor: palette.border,
          opacity: inactive ? 0.5 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={palette.fg} /> : null}
      <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: palette.fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Badge({ label, color }: { label: string; color: string }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const fg = readable(color, c);
  return (
    <View style={[styles.badge, { backgroundColor: tint(fg, c.scheme === "dark" ? "26" : "14"), borderColor: tint(fg, "40") }]}>
      <View style={[styles.badgeDot, { backgroundColor: fg }]} />
      <Text style={[styles.badgeText, { color: fg }]} numberOfLines={1}>
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

export function Input(props: TextInputProps) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <TextInput
      placeholderTextColor={c.placeholder}
      selectionColor={c.primary}
      {...props}
      style={[styles.input, props.multiline && styles.inputMultiline, props.style]}
    />
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
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, active && styles.segmentActive]}
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

export function EmptyState({ title, description }: { title: string; description?: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {description ? <Text style={styles.emptyText}>{description}</Text> : null}
    </View>
  );
}

export function ErrorBox({ message }: { message: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.errorBox} accessibilityRole="alert">
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {right}
    </View>
  );
}

export function InfoRow({ label, value, onPress }: { label: string; value: ReactNode; onPress?: () => void }) {
  const styles = useStyles(makeStyles);
  const content = (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      {typeof value === "string" ? (
        <Text style={[styles.infoValue, onPress && styles.infoLink]} selectable>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="link">
      {content}
    </Pressable>
  ) : (
    content
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    button: {
      minHeight: 46,
      paddingHorizontal: 16,
      borderRadius: 12,
      borderWidth: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    buttonCompact: { minHeight: 36, paddingHorizontal: 12, borderRadius: 10 },
    buttonText: { fontSize: 15, fontWeight: "600", letterSpacing: 0.1 },
    buttonTextCompact: { fontSize: 14 },
    card: {
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      padding: 16,
      shadowColor: c.shadow,
      shadowOpacity: c.scheme === "dark" ? 0 : 0.04,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: c.scheme === "dark" ? 0 : 1,
    },
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      borderRadius: 999,
      borderWidth: 1,
      paddingHorizontal: 8,
      paddingVertical: 3,
      alignSelf: "flex-start",
    },
    badgeDot: { width: 6, height: 6, borderRadius: 3 },
    badgeText: { fontSize: 12, fontWeight: "600" },
    field: { gap: 6 },
    label: { fontSize: 13, fontWeight: "600", color: c.ink },
    required: { color: c.danger },
    hint: { fontSize: 12, color: c.inkMuted, lineHeight: 17 },
    fieldError: { fontSize: 12, color: c.danger },
    input: {
      minHeight: 46,
      borderWidth: 1,
      borderColor: c.lineStrong,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: c.ink,
      backgroundColor: c.surface,
    },
    inputMultiline: { minHeight: 92, textAlignVertical: "top" },
    switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    switchLabel: { fontSize: 14, color: c.ink, fontWeight: "500" },
    segmented: { flexDirection: "row", backgroundColor: c.segment, borderRadius: 12, padding: 3 },
    segment: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: "center" },
    segmentActive: {
      backgroundColor: c.surface,
      shadowColor: c.shadow,
      shadowOpacity: c.scheme === "dark" ? 0 : 0.08,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
      elevation: c.scheme === "dark" ? 0 : 1,
    },
    segmentText: { fontSize: 13, fontWeight: "600", color: c.inkMuted },
    segmentTextActive: { color: c.ink },
    segmentCount: { fontWeight: "500", color: c.inkSubtle },
    empty: { alignItems: "center", paddingVertical: 40, paddingHorizontal: 24, gap: 6 },
    emptyTitle: { fontSize: 16, fontWeight: "600", color: c.ink, textAlign: "center" },
    emptyText: { fontSize: 14, color: c.inkMuted, textAlign: "center", lineHeight: 20 },
    errorBox: { backgroundColor: c.dangerSoft, borderColor: tint(c.danger, "44"), borderWidth: 1, borderRadius: 12, padding: 12 },
    errorText: { color: c.danger, fontSize: 13, lineHeight: 18 },
    sectionTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
    sectionTitle: { fontSize: 12, fontWeight: "700", color: c.inkMuted, textTransform: "uppercase", letterSpacing: 0.6 },
    infoRow: { paddingVertical: 6, gap: 2 },
    infoLabel: { fontSize: 12, color: c.inkMuted },
    infoValue: { fontSize: 15, color: c.ink },
    infoLink: { color: c.primary },
  });
