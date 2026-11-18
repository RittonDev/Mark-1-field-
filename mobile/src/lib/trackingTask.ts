// Tarefa de segundo plano do rastreamento. Precisa ser definida no escopo do módulo, na
// carga do app (importada pelo index.ts, a entrada, e não só pelo _layout: no relançamento sem
// tela do Android as rotas não montam), para o sistema achá-la quando acordar o app com novas
// posições — inclusive com o app fechado.
//
// Com o app fora da tela, a jornada também sincroniza as OS (no máximo a cada ~3 min): OS nova,
// oferta e reagendamento chegam como notificação do sistema (backgroundSync.ts).

import type { LocationObject } from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { maybeBackgroundSync } from "./backgroundSync";
import { handleLocations, TRACKING_TASK } from "./tracking";

if (Platform.OS !== "web" && !TaskManager.isTaskDefined(TRACKING_TASK)) {
  TaskManager.defineTask<{ locations: LocationObject[] }>(TRACKING_TASK, async ({ data, error }) => {
    if (error) {
      // Ex.: permissão retirada ou localização desligada. O cartão da jornada confere e avisa
      // quando o app volta à tela (e a cada ~5 min com ele aberto).
      console.warn("Falha na localização em segundo plano", error.message);
      return;
    }
    if (!data?.locations?.length) return;
    try {
      await handleLocations(data.locations);
    } catch (e) {
      console.warn("Falha ao registrar posições da jornada", e);
    }
    // Não lança erro; com o app na tela não faz nada (a sincronização normal cuida).
    await maybeBackgroundSync();
  });
}
