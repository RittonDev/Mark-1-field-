// WebSocket /api/v1/ws?token=… (docs/MOBILE_SYNC.md §4):
// ping a cada 25 s, reconexão com backoff exponencial e, no fechamento 4401,
// renova o access token antes de reconectar. Os eventos não carregam a OS inteira:
// quem consome faz um novo pull.

import { refreshSession } from "./api";
import { wsUrlFor } from "./config";
import { session } from "./session";
import type { RealtimeEvent } from "./types";

export type RealtimeState = "off" | "connecting" | "online";

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;
const AUTH_FAILED = 4401;

interface Handlers {
  onEvent: (event: RealtimeEvent) => void;
  onOpen: () => void;
  onState: (state: RealtimeState) => void;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private wanted = false;

  constructor(private readonly handlers: Handlers) {}

  start() {
    this.wanted = true;
    if (!this.socket && this.retryTimer === undefined) this.connect();
  }

  stop() {
    this.wanted = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "cliente encerrou");
    this.handlers.onState("off");
  }

  /** Rede voltou ou app voltou ao primeiro plano: tenta já, sem esperar o backoff. */
  reconnectNow() {
    if (!this.wanted || this.socket) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.attempt = 0;
    this.connect();
  }

  private clearTimers() {
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.pingTimer = undefined;
    this.retryTimer = undefined;
  }

  private connect() {
    if (!this.wanted) return;
    const { accessToken, apiUrl } = session.get();
    if (!accessToken) {
      this.handlers.onState("off");
      return;
    }
    this.handlers.onState("connecting");
    const socket = new WebSocket(`${wsUrlFor(apiUrl)}?token=${encodeURIComponent(accessToken)}`);
    this.socket = socket;
    let closed = false;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.handlers.onState("online");
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
      }, PING_MS);
      this.handlers.onOpen();
    };

    socket.onmessage = (message) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(String(message.data)) as RealtimeEvent;
      } catch {
        return;
      }
      if (event.type?.startsWith("ticket.")) this.handlers.onEvent(event);
    };

    const handleClose = (code: number) => {
      // No RN o erro pode vir seguido de close: trata uma vez só.
      if (closed) return;
      closed = true;
      if (this.socket !== socket) return;
      this.socket = null;
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
      if (!this.wanted) return;
      this.handlers.onState("connecting");
      this.scheduleReconnect(code === AUTH_FAILED);
    };

    socket.onclose = (event) => handleClose(event.code);
    socket.onerror = () => {
      handleClose(1006);
      try {
        socket.close();
      } catch {
        // já fechado
      }
    };
  }

  private scheduleReconnect(authFailed: boolean) {
    const delay = authFailed ? 0 : Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.attempt += 1;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = undefined;
      if (authFailed) {
        const result = await refreshSession();
        if (result === "invalid") {
          this.stop();
          return;
        }
        if (result === "offline") {
          this.scheduleReconnect(false);
          return;
        }
      }
      this.connect();
    }, delay);
  }
}
