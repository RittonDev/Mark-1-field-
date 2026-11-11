"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toaster";
import { refreshSession, WS_URL } from "./api";
import { STATUS } from "./constants";
import { sessionStore } from "./session";
import type { RealtimeEvent } from "./types";

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
        if (!event.type?.startsWith("ticket.")) return;
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
