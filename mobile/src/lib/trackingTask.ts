// Tarefa de segundo plano do rastreamento. Precisa ser definida no escopo do módulo, na
// abertura do app (importada pelo _layout), para o sistema achá-la quando acordar o app
// com novas posições — inclusive com o app fechado.

import type { LocationObject } from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { handleLocations, TRACKING_TASK } from "./tracking";

if (Platform.OS !== "web" && !TaskManager.isTaskDefined(TRACKING_TASK)) {
  TaskManager.defineTask<{ locations: LocationObject[] }>(TRACKING_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    try {
      await handleLocations(data.locations);
    } catch (e) {
      console.warn("Falha ao registrar posições da jornada", e);
    }
  });
}
