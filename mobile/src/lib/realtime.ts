// WebSocket /api/v1/ws?token=… (docs/MOBILE_SYNC.md §4):
// ping a cada 25 s, reconexão com backoff exponencial e, no fechamento 4401,
// renova o access token antes de reconectar. Os eventos não carregam a OS inteira:
// quem consome faz um novo pull.
//
// Conexão "zumbi" (a rede caiu sem fechar o socket: expiração no NAT, troca de Wi-Fi para dados):
// sem nenhuma mensagem (hello, pong ou evento) até 15 s depois de um ping, o socket é refeito.

import { refreshSession } from "./api";
import { wsUrlFor } from "./config";
import { session } from "./session";
import type { RealtimeEvent } from "./types";

export type RealtimeState = "off" | "connecting" | "online";

const PING_MS = 25_000;
/** Sem resposta a um ping neste tempo: a conexão morreu sem avisar. */
const PONG_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const AUTH_FAILED = 4401;
/** Fechamento pelo próprio app ao achar a conexão morta (faixa de códigos livre do protocolo). */
const STALE = 4000;
/** Token recusado de novo mesmo depois de renovado: desiste até o app voltar à tela. */
const MAX_AUTH_FAILURES = 3;
/** Falhas seguidas: deixa de mostrar "conectando" (o sync segue pelo intervalo de segurança). */
const QUIET_AFTER_FAILURES = 5;

interface Handlers {
  onEvent: (event: RealtimeEvent) => void;
  onOpen: () => void;
  onState: (state: RealtimeState) => void;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Falhas seguidas de conexão (zera quando abre). */
  private attempt = 0;
  /** Fechamentos 4401 seguidos (zera quando abre ou quando o app volta à tela). */
  private authFailures = 0;
  private wanted = false;

  constructor(private readonly handlers: Handlers) {}

  start() {
    this.wanted = true;
    this.authFailures = 0;
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

  /**
   * Rede voltou ou app voltou ao primeiro plano: tenta já, sem esperar o backoff. Com `force`
   * (troca de rede), um socket aberto é testado com um ping e refeito se não responder.
   */
  reconnectNow({ force = false }: { force?: boolean } = {}) {
    if (!this.wanted) return;
    if (this.socket) {
      if (force) this.probe(this.socket);
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.attempt = 0;
    this.connect();
  }

  private clearConnectionTimers() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
  }

  private clearTimers() {
    this.clearConnectionTimers();
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** Ping com prazo: sem nenhuma mensagem até PONG_TIMEOUT_MS, o socket é dado como morto. */
  private probe(socket: WebSocket) {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "ping" }));
    } catch {
      this.recycle(socket);
      return;
    }
    if (this.pongTimer !== undefined) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined;
      this.recycle(socket);
    }, PONG_TIMEOUT_MS);
  }

  /** Conexão morta sem aviso: larga este socket (o fechamento atrasado dele é ignorado) e reconecta. */
  private recycle(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clearConnectionTimers();
    try {
      socket.close(STALE, "sem resposta");
    } catch {
      // já fechado
    }
    if (this.wanted) this.scheduleReconnect(false);
  }

  private connect() {
    if (!this.wanted) return;
    const { accessToken, apiUrl } = session.get();
    if (!accessToken) {
      this.handlers.onState("off");
      return;
    }
    if (this.attempt <= QUIET_AFTER_FAILURES) this.handlers.onState("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${wsUrlFor(apiUrl)}?token=${encodeURIComponent(accessToken)}`);
    } catch {
      // Endereço do servidor inválido: tenta de novo mais tarde, como uma falha de conexão.
      this.scheduleReconnect(false);
      return;
    }
    this.socket = socket;
    let closed = false;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.authFailures = 0;
      this.handlers.onState("online");
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.probe(socket), PING_MS);
      this.handlers.onOpen();
    };

    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      // Qualquer mensagem (hello, pong, evento) prova que a conexão está viva.
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
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
      this.clearConnectionTimers();
      if (!this.wanted) return;
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
    if (authFailed) {
      this.authFailures += 1;
      if (this.authFailures >= MAX_AUTH_FAILURES) {
        // O servidor recusa até o token renovado: para até o app voltar à tela (o sync segue sem tempo real).
        this.handlers.onState("off");
        return;
      }
    }
    this.attempt += 1;
    // Muitas falhas seguidas (proxy que bloqueia WebSocket): a faixa fica neutra, a tentativa continua.
    this.handlers.onState(this.attempt > QUIET_AFTER_FAILURES ? "off" : "connecting");
    // Primeira recusa do token: renova e reconecta na hora. Depois, espera como qualquer falha.
    const delay = authFailed && this.authFailures === 1 ? 0 : Math.min(1000 * 2 ** (this.attempt - 1), MAX_BACKOFF_MS);
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
