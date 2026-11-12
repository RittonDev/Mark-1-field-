// Confirmações e avisos. No aparelho, Alert nativo; na pré-visualização web o Alert do
// react-native-web não faz nada, então usa window.confirm / window.alert.

import { Alert, Platform } from "react-native";

export function confirmAction(
  title: string,
  message: string,
  { confirmText, cancelText = "Cancelar", destructive = false }: { confirmText: string; cancelText?: string; destructive?: boolean },
): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelText, style: "cancel", onPress: () => resolve(false) },
        { text: confirmText, style: destructive ? "destructive" : "default", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function notify(title: string, message: string) {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}
