import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dismissToast, useToasts } from "../lib/toast";
import { colors } from "./ui";

const TONE = { info: colors.ink, success: colors.success, error: colors.danger };

export function ToastHost() {
  const toasts = useToasts();
  const insets = useSafeAreaInsets();
  if (!toasts.length) return null;
  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: insets.bottom + 16 }]}>
      {toasts.map((toast) => (
        <Pressable
          key={toast.id}
          onPress={() => dismissToast(toast.id)}
          accessibilityRole="alert"
          style={[styles.toast, { borderLeftColor: TONE[toast.tone] }]}
        >
          <Text style={styles.title}>{toast.title}</Text>
          {toast.description ? <Text style={styles.description}>{toast.description}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: "absolute", left: 16, right: 16, gap: 8 },
  toast: {
    backgroundColor: "#0f172a",
    borderRadius: 10,
    borderLeftWidth: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  title: { color: "#fff", fontSize: 14, fontWeight: "600" },
  description: { color: "#cbd5e1", fontSize: 13, marginTop: 2 },
});
