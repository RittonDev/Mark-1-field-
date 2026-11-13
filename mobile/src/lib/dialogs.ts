// Confirmações e avisos. No aparelho, Alert nativo; na pré-visualização web o Alert do
// react-native-web não faz nada, então usa window.confirm / window.alert.

import { Alert, Linking, Platform } from "react-native";

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

/**
 * Permissão negada de vez (o sistema não pergunta mais): explica e oferece abrir as configurações
 * do app. Resolve true quando o técnico foi para as configurações.
 */
export function askOpenSettings(title: string, message: string): Promise<boolean> {
  if (Platform.OS === "web") {
    notify(title, message);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: "Agora não", style: "cancel", onPress: () => resolve(false) },
        {
          text: "Abrir configurações",
          onPress: () => {
            void Linking.openSettings().catch(() => undefined);
            resolve(true);
          },
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
