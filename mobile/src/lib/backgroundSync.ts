// Sincronização com o app fora da tela: OS nova, oferta nova, reagendamento e cancelamento chegam como
// notificação do sistema (a rodada avisa pela notifications.ts) e os lembretes da visita se acertam com a
// agenda nova. Dois gatilhos:
// - jornada aberta num build instalado: a localização em segundo plano mantém o app vivo, e a cada lote de
//   posições (trackingTask.ts) roda uma rodada, no máximo a cada ~3 min;
// - tarefa periódica do sistema (expo-background-task), a cada 15 min ou mais, quando o sistema deixar
//   (WorkManager no Android; no iOS, o BGTaskScheduler decide e roda raramente).
// Não roda com o app fechado pelo usuário nem no Expo Go (a tarefa periódica precisa de um build instalado).
//
// A tarefa é definida no escopo do módulo, na carga do app (importado pelo index.ts, a entrada), para o
// sistema achá-la quando acordar o app sem tela. Na web, backgroundSync.web.ts não faz nada.

import { isRunningInExpoGo } from "expo";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { AppState } from "react-native";
import { canUseMobile } from "./access";
import { mustChangePassword } from "./account";
import { ensureNotificationsReady, syncLocalAlerts } from "./notifications";
import { offersChanged } from "./offers";
import { session } from "./session";
import { loadFieldRules, requestSync } from "./sync";

export const BACKGROUND_SYNC_TASK = "maxxfield-sync";

/** Intervalo mínimo da tarefa periódica (minutos; o sistema não aceita menos que 15). */
const PERIODIC_MINUTES = 15;
/** Na jornada, a rodada com o app fora da tela sai no máximo a cada 3 min (bateria e dados). */
const JOURNEY_INTERVAL_MS = 3 * 60_000;

/** Situação da sincronização em segundo plano (Conta): ativa, restrita pelo celular ou indisponível. */
export type BackgroundSyncStatus = "active" | "restricted" | "unavailable";

let lastRoundAt = 0;
let round: Promise<void> | null = null;

/**
 * Uma rodada com o app fora da tela: sync completo (envio, download, ofertas) e os alertas locais. A sessão é lida
 * do armazenamento se o app acordou sem tela. Não roda sem técnico, com senha provisória ou com o app na tela (aí
 * a sincronização normal cuida). Não lança erro.
 */
export function runBackgroundRound(): Promise<void> {
  round ??= backgroundRound().finally(() => {
    round = null;
  });
  return round;
}

async function backgroundRound() {
  try {
    if (session.get().status === "loading") await session.load((user) => canUseMobile(user.role));
    const { status, user } = session.get();
    if (status !== "signedIn" || !user || mustChangePassword(user) || AppState.currentState === "active") return;
    lastRoundAt = Date.now();
    await ensureNotificationsReady();
    await loadFieldRules();
    // Sem o tempo real (que para fora da tela), um aviso de oferta pode ter se perdido: confere a lista.
    offersChanged();
    await requestSync();
    await syncLocalAlerts();
  } catch (error) {
    console.warn("Falha na sincronização em segundo plano", error);
  }
}

/** Jornada com o app fora da tela: a cada lote de posições, uma rodada se a última tem 3 min ou mais. */
export function maybeBackgroundSync(): Promise<void> {
  if (AppState.currentState === "active" || Date.now() - lastRoundAt < JOURNEY_INTERVAL_MS) return Promise.resolve();
  return runBackgroundRound();
}

if (!TaskManager.isTaskDefined(BACKGROUND_SYNC_TASK)) {
  TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
    try {
      // Com o app na tela, a sincronização normal já roda (tempo real e intervalo de segurança).
      if (AppState.currentState !== "active") await runBackgroundRound();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

/** Liga a tarefa periódica (início da sessão). No Expo Go ela não existe; sem o sistema deixar, fica de fora. */
export async function registerBackgroundSync(): Promise<void> {
  if (isRunningInExpoGo()) return;
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: PERIODIC_MINUTES });
  } catch (error) {
    console.warn("Sincronização em segundo plano indisponível", error);
  }
}

/** Desliga a tarefa periódica (saiu da conta). */
export async function unregisterBackgroundSync(): Promise<void> {
  if (isRunningInExpoGo()) return;
  try {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
  } catch (error) {
    console.warn("Falha ao desligar a sincronização em segundo plano", error);
  }
}

export async function backgroundSyncStatus(): Promise<BackgroundSyncStatus> {
  if (isRunningInExpoGo()) return "unavailable";
  try {
    // iOS: "Atualização em 2º plano" desligada ou modo de pouca energia.
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return "restricted";
    return (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) ? "active" : "unavailable";
  } catch {
    return "unavailable";
  }
}
