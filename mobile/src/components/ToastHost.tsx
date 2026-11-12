import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dismissToast, useToasts } from "../lib/toast";
import { useStyles, useTheme, type Palette } from "../theme/theme";

export function ToastHost() {
  const toasts = useToasts();
  const insets = useSafeAreaInsets();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  if (!toasts.length) return null;
  const tone = { info: c.primary, success: c.success, error: c.danger };
  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: insets.bottom + 16 }]}>
      {toasts.map((toast) => (
        <Pressable
          key={toast.id}
          onPress={() => dismissToast(toast.id)}
          accessibilityRole="alert"
          style={[styles.toast, { borderLeftColor: tone[toast.tone] }]}
        >
          <Text style={styles.title}>{toast.title}</Text>
          {toast.description ? <Text style={styles.description}>{toast.description}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    host: { position: "absolute", left: 16, right: 16, gap: 8, alignItems: "center" },
    toast: {
      width: "100%",
      maxWidth: 520,
      backgroundColor: c.toast,
      borderRadius: 12,
      borderLeftWidth: 4,
      paddingHorizontal: 14,
      paddingVertical: 12,
      shadowColor: "#000",
      shadowOpacity: 0.2,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 4,
    },
    title: { color: c.toastInk, fontSize: 14, fontWeight: "600" },
    description: { color: c.toastMuted, fontSize: 13, marginTop: 2, lineHeight: 18 },
  });
