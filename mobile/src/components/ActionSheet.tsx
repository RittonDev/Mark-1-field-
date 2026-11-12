import { Modal, Pressable, StyleSheet, View } from "react-native";
import Animated, { SlideInDown, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";
import { Icon, type IconName } from "./Icon";
import { PressableScale } from "./motion";
import { Text } from "./Text";

export interface SheetAction {
  key: string;
  label: string;
  icon?: IconName;
  tone?: "default" | "danger";
  disabledReason?: string | null;
  right?: React.ReactNode;
  onPress: () => void;
}

/** Folha inferior com as demais ações da OS (o passo principal fica na barra fixa). */
export function ActionSheet({ title, actions, onClose }: { title: string; actions: SheetAction[]; onClose: () => void }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Fechar" />
        <Animated.View
          entering={reduced ? undefined : SlideInDown.springify().damping(22).stiffness(260)}
          style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
        >
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>
          {actions.map((action) => {
            const disabled = Boolean(action.disabledReason);
            const color = action.tone === "danger" ? c.danger : c.ink;
            return (
              <PressableScale
                key={action.key}
                scaleTo={0.98}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityState={{ disabled }}
                onPress={() => {
                  onClose();
                  action.onPress();
                }}
                style={[styles.row, disabled && { opacity: 0.5 }]}
                pressedStyle={{ backgroundColor: c.surface2 }}
              >
                {action.icon ? <Icon name={action.icon} size={20} color={color} /> : null}
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.label, { color }]}>{action.label}</Text>
                  {action.disabledReason ? <Text style={styles.reason}>{action.disabledReason}</Text> : null}
                </View>
                {action.right}
              </PressableScale>
            );
          })}
          <PressableScale onPress={onClose} style={styles.cancel} pressedStyle={{ backgroundColor: c.surface3 }} accessibilityRole="button">
            <Text style={styles.cancelText}>Fechar</Text>
          </PressableScale>
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    root: { flex: 1, justifyContent: "flex-end" },
    backdrop: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: c.scheme === "dark" ? "rgba(0,0,0,0.6)" : "rgba(27,31,38,0.32)",
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: RADIUS.card + 6,
      borderTopRightRadius: RADIUS.card + 6,
      paddingHorizontal: 12,
      paddingTop: 8,
      gap: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
    },
    handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: c.lineStrong, marginBottom: 8 },
    title: {
      fontSize: 12,
      fontWeight: "700",
      color: c.inkMuted,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      paddingHorizontal: 12,
      paddingBottom: 4,
    },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 14, borderRadius: RADIUS.control },
    label: { fontSize: 15, fontWeight: "600" },
    reason: { fontSize: 12, color: c.inkMuted, lineHeight: 16 },
    cancel: { marginTop: 4, paddingVertical: 14, borderRadius: RADIUS.control, alignItems: "center", backgroundColor: c.surface2 },
    cancelText: { fontSize: 15, fontWeight: "600", color: c.ink },
  });
