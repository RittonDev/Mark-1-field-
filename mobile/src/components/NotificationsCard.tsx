// Cartão Notificações (Sincronização e Configurações › Notificações): a chave dos lembretes da visita (1 dia, 1h40 e
// 10 min antes), o próximo lembrete, a permissão do celular com o caminho para liberar e, no Android, o alarme exato. O
// estado é relido ao abrir a tela, quando as OS mudam e quando o app volta à tela (a permissão pode ter mudado nas
// configurações do celular). Também: a linha "Push da central" (PushRow), o resumo da linha Notificações das
// Configurações (useNotificationsSummary) e a linha "Em segundo plano" do cartão Sincronização.

import { isRunningInExpoGo } from "expo";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, StyleSheet, View } from "react-native";
import { getDeviceRegistration, refreshPushRegistration } from "../lib/auth";
import { backgroundSyncStatus, type BackgroundSyncStatus } from "../lib/backgroundSync";
import { useDataVersion } from "../lib/changes";
import type { DeviceRegistration } from "../lib/device";
import { relativeDay } from "../lib/field";
import { formatTime } from "../lib/format";
import {
  askNotificationPermission,
  nextVisitReminder,
  notificationState,
  requestExactAlarm,
  setVisitRemindersEnabled,
  syncLocalAlerts,
  visitRemindersEnabled,
  type NotificationState,
} from "../lib/notifications";
import { showToast } from "../lib/toast";
import { Button, Card, InfoRow, SectionTitle, SwitchRow } from "./ui";

interface Snapshot {
  state: NotificationState;
  enabled: boolean;
  /** "Amanhã às 06:20 · OS-000123"; null sem lembrete nos próximos 7 dias. */
  next: string | null;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

async function readSnapshot(): Promise<Snapshot> {
  const [state, enabled, next] = await Promise.all([notificationState(), visitRemindersEnabled(), nextVisitReminder()]);
  const at = next ? new Date(next.fireAt) : null;
  return {
    state,
    enabled,
    next: next && at ? `${capitalize(relativeDay(at, Date.now()))} às ${formatTime(at)} · ${next.code}` : null,
  };
}

const PERMISSION_LABEL: Record<NotificationState["permission"], string> = {
  granted: "Liberada",
  denied: "Bloqueada",
  undetermined: "Ainda não pedida",
  unavailable: "Indisponível nesta versão do app",
};

function blockedToast() {
  showToast("Notificações bloqueadas", {
    tone: "error",
    description: "Libere nas configurações do celular para receber os lembretes.",
  });
}

/** `title`: "Notificações" na Sincronização; "Neste celular" em Configurações › Notificações. */
export function NotificationsCard({ title = "Notificações" }: { title?: string }) {
  const dataVersion = useDataVersion();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // Muda depois de cada ação do cartão: relê o estado.
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  // Permissão na leitura anterior: liberada agora (pelo botão ou nas configurações), agenda os lembretes e
  // registra o aparelho para o push sem esperar a próxima abertura do app.
  const wasGranted = useRef<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void readSnapshot().then(
        (next) => {
          if (!alive) return;
          const granted = next.state.permission === "granted";
          if (granted && wasGranted.current === false) {
            void syncLocalAlerts();
            void refreshPushRegistration();
          }
          wasGranted.current = granted;
          setSnapshot(next);
        },
        (error: unknown) => console.warn("Não foi possível ler o estado das notificações", error),
      );
    };
    load();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") load();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [dataVersion, reload]);

  /** Roda a ação do cartão e relê o estado no fim. */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  }

  function toggle(on: boolean) {
    setSnapshot((current) => (current ? { ...current, enabled: on } : current));
    void run(async () => {
      await setVisitRemindersEnabled(on);
      // Ligar sem a permissão: pede (se o celular ainda deixa pedir).
      const permission = snapshot?.state.permission;
      if (on && (permission === "undetermined" || permission === "denied") && !(await askNotificationPermission())) blockedToast();
    });
  }

  function allow() {
    void run(async () => {
      if (!(await askNotificationPermission())) blockedToast();
    });
  }

  function allowExactAlarm() {
    void run(async () => {
      await requestExactAlarm();
    });
  }

  const state = snapshot?.state ?? null;
  const granted = state?.permission === "granted";
  const blocked = state?.permission === "undetermined" || state?.permission === "denied";
  const exactDenied = granted && state?.exactAlarm === false;

  return (
    <Card style={{ gap: 4 }}>
      <SectionTitle accent>{title}</SectionTitle>
      <SwitchRow
        label="Lembretes das visitas"
        hint="1 dia, 1h40 e 10 min antes do horário da visita"
        value={snapshot?.enabled ?? true}
        onValueChange={toggle}
      />
      {snapshot?.enabled && granted ? <InfoRow label="Próximo lembrete" value={snapshot.next ?? "Nenhum nos próximos 7 dias"} /> : null}
      <InfoRow label="Permissão do celular" value={state ? PERMISSION_LABEL[state.permission] : "Verificando…"} />
      {exactDenied ? <InfoRow label="Horário exato" value="Pode atrasar alguns minutos" /> : null}
      {blocked || exactDenied ? (
        <View style={styles.buttons}>
          {blocked && state?.canAskAgain ? <Button compact title="Permitir notificações" onPress={allow} loading={busy} /> : null}
          {blocked && !state?.canAskAgain ? (
            <Button compact title="Abrir configurações" onPress={() => void Linking.openSettings()} disabled={busy} />
          ) : null}
          {exactDenied ? <Button compact title="Liberar" onPress={allowExactAlarm} loading={busy} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

/** Push da central neste aparelho (as notificações locais, lembretes e avisos, ficam no cartão Notificações). */
function pushLabel(registration: DeviceRegistration | null): string {
  if (!registration) return "Verificando…";
  switch (registration.state) {
    case "registered":
      return registration.push === "live" ? "Ativo neste aparelho" : "Ainda não ligado na central";
    case "unsupported":
      return "Indisponível nesta versão do app";
    case "blocked":
      return "Bloqueado nas notificações do celular";
    case "undetermined":
      return "Notificações ainda não permitidas";
    case "error":
      return "Não foi possível ativar agora";
  }
}

/** A linha "Push da central" (cartão Aparelho da Sincronização e "Avisos da central" em Configurações › Notificações). */
export function PushRow() {
  useDataVersion(); // redesenha quando o registro do aparelho termina
  return <InfoRow label="Push da central" value={pushLabel(getDeviceRegistration())} />;
}

export interface NotificationsSummary {
  /** "Ligadas" | "Desligadas" | "Bloqueadas" | "Indisponíveis"; null enquanto lê. */
  value: string | null;
  /** "warning" só em "Bloqueadas". */
  tone: "muted" | "warning";
}

const READING: NotificationsSummary = { value: null, tone: "muted" };

function summaryOf(state: NotificationState, enabled: boolean): NotificationsSummary {
  if (state.permission === "unavailable") return { value: "Indisponíveis", tone: "muted" };
  if (!enabled) return { value: "Desligadas", tone: "muted" };
  if (state.permission === "granted") return { value: "Ligadas", tone: "muted" };
  return { value: "Bloqueadas", tone: "warning" };
}

/**
 * Resumo da linha Notificações das Configurações. Relê ao abrir e ao voltar para a tela (o técnico mexeu na tela
 * Notificações) e quando o app volta ao primeiro plano (a permissão pode ter mudado nas configurações do celular).
 */
export function useNotificationsSummary(): NotificationsSummary {
  const [summary, setSummary] = useState<NotificationsSummary>(READING);
  // Só a leitura mais recente vale (duas leituras seguidas podem terminar fora de ordem).
  const latest = useRef(0);

  const read = useCallback(() => {
    latest.current += 1;
    const round = latest.current;
    Promise.all([notificationState(), visitRemindersEnabled()]).then(
      ([state, enabled]) => {
        if (round === latest.current) setSummary(summaryOf(state, enabled));
      },
      (error: unknown) => console.warn("Não foi possível ler o estado das notificações", error),
    );
  }, []);

  useFocusEffect(read);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") read();
    });
    return () => sub.remove();
  }, [read]);

  return summary;
}

const BACKGROUND_LABEL: Record<BackgroundSyncStatus, string> = {
  active: "Ativa",
  restricted: "Restrita pelo celular",
  unavailable: "Indisponível nesta versão do app",
};

/**
 * Cartão Sincronização: a sincronização com o app fora da tela (tarefa periódica do sistema). No Expo Go ela não
 * existe: OS nova e oferta só chegam com o app aberto.
 */
export function BackgroundSyncRow() {
  const [status, setStatus] = useState<BackgroundSyncStatus | null>(null);
  const expoGo = isRunningInExpoGo();

  useEffect(() => {
    if (expoGo) return;
    let alive = true;
    const load = () => {
      void backgroundSyncStatus().then((next) => {
        if (alive) setStatus(next);
      });
    };
    load();
    // "Atualização em 2º plano" pode ter mudado nas configurações do celular.
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") load();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [expoGo]);

  const value = expoGo ? "Só com o app aberto" : status ? BACKGROUND_LABEL[status] : "Verificando…";
  return <InfoRow label="Em segundo plano" value={value} />;
}

const styles = StyleSheet.create({
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 8 },
});
