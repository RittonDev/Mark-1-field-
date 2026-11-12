import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

// Toque nas ações principais do atendimento. Na web não vibra (pré-visualização só).
function run(fn: () => Promise<void>) {
  if (Platform.OS === "web") return;
  fn().catch(() => undefined);
}

export const haptic = {
  /** Troca de aba, seleção. */
  select: () => run(() => Haptics.selectionAsync()),
  /** Passo do atendimento: iniciar deslocamento, check-in. */
  step: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  /** Concluir a OS, assinatura salva. */
  success: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** Ação bloqueada ou recusada. */
  warning: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
};
