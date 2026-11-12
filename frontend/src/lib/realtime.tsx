"use client";

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toaster";
import { refreshSession, WS_URL } from "./api";
import { STATUS } from "./constants";
import { sessionStore } from "./session";
import type { LiveTechnician, RealtimeEvent } from "./types";

export type ConnectionState = "connecting" | "online" | "offline";

const RealtimeContext = createContext<ConnectionState>("offline");

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

function describe(event: RealtimeEvent): string | null {
  const code = event.ticket_code ?? "OS";
  const by = event.actor_name ? ` por ${event.actor_name}` : "";
  switch (event.type) {
    case "ticket.created":
      return `Nova ${code} aberta${by}`;
    case "ticket.status_changed":
      return `${code} → ${event.status ? STATUS[event.status]?.label ?? event.status : "novo status"}${by}`;
    case "ticket.assigned":
      return `${code} teve o responsável alterado${by}`;
    case "ticket.comment_added":
      return `Novo acompanhamento em ${code}${by}`;
    case "ticket.worklog_added":
      return `Apontamento registrado em ${code}${by}`;
    case "ticket.attachment_added":
      return `Anexo adicionado em ${code}${by}`;
    case "ticket.updated":
      return `${code} foi editada${by}`;
    default:
      return null;
  }
}

/**
 * Posição nova de um técnico: move o marcador no cache, sem recarregar o mapa todo
 * (chega a cada poucos segundos por técnico). Jornada aberta/encerrada recarrega.
 */
function applyTrackingEvent(queryClient: QueryClient, event: RealtimeEvent) {
  const userId = event.user_id;
  if (!userId) return;
  if (event.type !== "technician.location" || event.latitude == null || event.longitude == null) {
    queryClient.invalidateQueries({ queryKey: ["tracking"] });
    return;
  }
  let stale = false;
  queryClient.setQueriesData<LiveTechnician[]>({ queryKey: ["tracking", "live"] }, (rows) =>
    rows?.map((tech) => {
      if (tech.id !== userId) return tech;
      // Voltou o sinal ou o primeiro ponto da jornada: o estado muda, então relê da API.
      if (tech.state === "no_signal" || !tech.last_position) stale = true;
      return {
        ...tech,
        last_position: {
          ...(tech.last_position ?? { accuracy_m: null, speed_mps: null, heading: null, battery_pct: null, is_mock: false }),
          latitude: event.latitude!,
          longitude: event.longitude!,
          recorded_at: event.recorded_at ?? new Date().toISOString(),
        },
      };
    }),
  );
  if (stale) queryClient.invalidateQueries({ queryKey: ["tracking", "live"] });
  queryClient.invalidateQueries({ queryKey: ["tracking", "history", userId] });
}

/**
 * Mantém um WebSocket com a API enquanto houver sessão: reconecta com backoff,
 * envia ping a cada 25s e invalida o cache do react-query a cada evento de OS.
 */
export function RealtimeProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [state, setState] = useState<ConnectionState>("connecting");
  const toastRef = useRef(toast);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let pingTimer: number | undefined;
    let retryTimer: number | undefined;
    let attempt = 0;
    let stopped = false;

    const scheduleReconnect = (authFailed: boolean) => {
      if (stopped) return;
      const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
      attempt += 1;
      retryTimer = window.setTimeout(async () => {
        if (authFailed && !(await refreshSession())) return; // sessão expirou: o layout redireciona
        setState("connecting");
        connect();
      }, delay);
    };

    const connect = () => {
      if (stopped) return;
      const token = sessionStore.get()?.accessToken;
      if (!token) return;
      socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

      socket.onopen = () => {
        attempt = 0;
        setState("online");
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, PING_MS);
      };

      socket.onmessage = (message) => {
        let event: RealtimeEvent;
        try {
          event = JSON.parse(message.data as string) as RealtimeEvent;
        } catch {
          return;
        }
        if (event.type?.startsWith("technician.")) {
          applyTrackingEvent(queryClient, event);
          return;
        }
        if (event.type === "quote.decided") {
          queryClient.invalidateQueries({ queryKey: ["quotes"] });
          if (event.ticket_id) queryClient.invalidateQueries({ queryKey: ["ticket", event.ticket_id] });
          const approved = (event as { status?: string }).status === "approved";
          toastRef.current({
            title: `${event.ticket_code ?? "OS"}: orçamento ${approved ? "aprovado" : "recusado"} pelo cliente`,
            description: event.name ?? undefined,
            tone: approved ? "success" : "error",
          });
          return;
        }
        if (event.type === "onboarding.submitted") {
          queryClient.invalidateQueries({ queryKey: ["onboarding"] });
          toastRef.current({ title: `Nova ficha de homologação: ${event.name ?? "técnico"}` });
          return;
        }
        if (!event.type?.startsWith("ticket.")) return;
        queryClient.invalidateQueries({ queryKey: ["tracking", "live"] });
        queryClient.invalidateQueries({ queryKey: ["tickets"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        queryClient.invalidateQueries({ queryKey: ["assignable"] });
        if (event.ticket_id) queryClient.invalidateQueries({ queryKey: ["ticket", event.ticket_id] });
        if (event.actor_id && event.actor_id === userId) return;
        const text = describe(event);
        if (text) toastRef.current({ title: text });
      };

      socket.onclose = (closeEvent) => {
        window.clearInterval(pingTimer);
        socket = null;
        if (stopped) return;
        setState("offline");
        // 4401/1008: token recusado pelo servidor.
        scheduleReconnect(closeEvent.code === 4401 || closeEvent.code === 1008);
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      stopped = true;
      window.clearInterval(pingTimer);
      window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [queryClient, userId]);

  return <RealtimeContext.Provider value={state}>{children}</RealtimeContext.Provider>;
}

export function useConnectionState(): ConnectionState {
  return useContext(RealtimeContext);
}
