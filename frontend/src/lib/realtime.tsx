"use client";

import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/Toaster";
import { refreshSessionResult, WS_URL } from "./api";
import { STATUS } from "./constants";
import { todayISO } from "./format";
import { sessionStore } from "./session";
import type { LiveTechnician, RealtimeEvent, TicketStatus, TrackingHistory, UUID } from "./types";

export type ConnectionState = "connecting" | "online" | "offline";

const RealtimeContext = createContext<ConnectionState>("offline");

const PING_MS = 25_000;
/** Sem nenhuma mensagem (nem o pong) por mais que isso depois do ping: conexão "meio aberta", refaz. */
const PONG_GRACE_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
/** Depois de tantas tentativas seguidas sem conectar, a conexão conta como fora (e não "reconectando"). */
const OFFLINE_AFTER_ATTEMPTS = 3;
/** Rajada de eventos (fechamento automático, técnico sincronizando fotos): espera 300 ms de calma, até 1,5 s. */
const FLUSH_IDLE_MS = 300;
const FLUSH_MAX_MS = 1_500;
/** Quem estava buscando na hora do evento busca de novo depois (a resposta podia ser de antes da mudança). */
const FOLLOW_UP_MS = 1_500;
/** Avisos chegam juntos em 1,5 s; com mais de 2, viram um aviso só. No máximo um por OS a cada 10 s. */
const NOTICE_WAIT_MS = 1_500;
const NOTICE_PER_TICKET_MS = 10_000;
const FEED_LIMIT = 30;
/** Ponto novo muito depois do anterior: o técnico estava sem sinal e mandou o intervalo junto; relê o dia. */
const HISTORY_GAP_MS = 3 * 60_000;

// ------------------------------------------------------------------ avisos

/** Aviso que merece a atenção de quem está na central (os demais eventos só atualizam a tela). */
export interface RealtimeNotice {
  id: string;
  /** OS do aviso (abre no painel lateral). */
  ticketId?: UUID;
  code?: string;
  title: string;
  description?: string;
  tone?: "info" | "success" | "error";
  /** Tela do aviso sem OS (ex.: /homologacao). */
  href?: string;
  /** Quando chegou (ISO). */
  at: string;
}

type NoticeDraft = Omit<RealtimeNotice, "id" | "at">;

interface RealtimeFeed {
  /** Últimos avisos, o mais recente primeiro. */
  items: RealtimeNotice[];
  unread: number;
  markAllRead: () => void;
}

const FeedContext = createContext<RealtimeFeed>({ items: [], unread: 0, markAllRead: () => {} });

const ControlContext = createContext<{ reconnect: () => void }>({ reconnect: () => {} });

const OPEN_TICKET_EVENT = "mf:open-ticket";
const OPEN_FEED_EVENT = "mf:open-feed";

/** Pede para abrir a OS no painel lateral (quem atende é a barra de cima da central). */
export function requestOpenTicket(ticketId: UUID) {
  window.dispatchEvent(new CustomEvent<UUID>(OPEN_TICKET_EVENT, { detail: ticketId }));
}

/** Atende os pedidos de abrir OS (ex.: o "Abrir" de um aviso). Devolve a função que para de ouvir. */
export function onOpenTicketRequest(handler: (ticketId: UUID) => void): () => void {
  const listener = (event: Event) => {
    const id = (event as CustomEvent<UUID>).detail;
    if (id) handler(id);
  };
  window.addEventListener(OPEN_TICKET_EVENT, listener);
  return () => window.removeEventListener(OPEN_TICKET_EVENT, listener);
}

/** Pede para abrir a lista de avisos (o sino da barra de cima). */
export function requestOpenFeed() {
  window.dispatchEvent(new Event(OPEN_FEED_EVENT));
}

export function onOpenFeedRequest(handler: () => void): () => void {
  window.addEventListener(OPEN_FEED_EVENT, handler);
  return () => window.removeEventListener(OPEN_FEED_EVENT, handler);
}

// Mudanças de status que pedem ação da central; as demais (agendado, em deslocamento...) só atualizam a tela.
const NOTICE_STATUSES: TicketStatus[] = ["resolved", "on_hold_customer", "on_hold_vendor", "cancelled", "reopened"];

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/**
 * Curadoria: só vira aviso o que alguém da central precisa ver. Salvar formulário, foto, assinatura,
 * apontamento, troca de técnico e o que o Sistema faz sozinho (fechamento automático) só atualizam a tela.
 */
function noticeFor(event: RealtimeEvent, userId: string): NoticeDraft | null {
  const code = event.ticket_code ?? "OS";
  const ticketId = event.ticket_id;
  const data = event.data ?? {};
  // Sem autor é o Sistema; o que eu mesmo fiz não precisa de aviso.
  const byOther = !!event.actor_id && event.actor_id !== userId;
  const by = event.actor_name ? ` por ${event.actor_name}` : "";
  switch (event.type) {
    case "ticket.created":
      return byOther ? { ticketId, code, title: `${code} aberta${by}`, description: text(data.title) } : null;
    case "ticket.status_changed": {
      const status = event.status;
      if (!byOther || !status || !NOTICE_STATUSES.includes(status)) return null;
      return {
        ticketId,
        code,
        title: `${code} → ${STATUS[status]?.label ?? status}${by}`,
        tone: status === "resolved" ? "success" : "info",
      };
    }
    case "ticket.comment_added":
      if (!byOther || data.internal === true) return null;
      return { ticketId, code, title: `Novo acompanhamento em ${code}${by}`, description: text(data.preview) };
    case "ticket.updated": {
      // Só a OS que outra pessoa passou para a minha fila (o analista responsável).
      const fields = Array.isArray(data.fields) ? data.fields : [];
      if (!byOther || !fields.includes("owner_id")) return null;
      const me = sessionStore.get()?.user;
      const mine = data.to_id ? data.to_id === userId : !!me?.name && data.to_name === me.name;
      if (!mine) return null;
      return {
        ticketId,
        code,
        title: `${code} entrou na sua fila`,
        description: event.actor_name ? `Passada por ${event.actor_name}` : undefined,
      };
    }
    case "quote.decided": {
      const approved = (event as { status?: string }).status === "approved";
      return {
        ticketId,
        code,
        title: `${code}: orçamento ${approved ? "aprovado" : "recusado"} pelo cliente`,
        description: event.name ?? undefined,
        tone: approved ? "success" : "error",
      };
    }
    case "part_request.created":
      return { ticketId, code, title: `${code}: o técnico pediu peça`, description: "Monte o orçamento para o cliente aprovar." };
    case "onboarding.submitted":
      return { title: `Nova ficha de homologação: ${event.name ?? "técnico"}`, href: "/homologacao" };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ o que cada evento desatualiza

// Telas que listam OS ou dependem delas, além da própria OS: só as abertas buscam de novo.
const ALL_EXTRA = ["expenses", "payouts", "quotes", "repairs", "reports", "projects", "project", "customer", "location", "technicians"];
const EXTRA_BY_FIELD: Record<string, string[]> = {
  expenses: ["expenses", "reports"],
  quotes: ["quotes"],
  part_requests: ["quotes"],
  times: ["reports", "payouts"],
  unproductive: ["reports", "payouts"],
  forms: [],
  signature: [],
  owner_id: [],
};

function extraKeysFor(event: RealtimeEvent): string[] {
  switch (event.type) {
    case "ticket.comment_added":
    case "ticket.attachment_added":
    case "ticket.attachment_updated":
    case "ticket.attachment_removed":
      return [];
    case "ticket.worklog_added":
      return ["reports"];
    case "ticket.part_request_decided":
      return ["quotes"];
    case "ticket.assigned":
    case "ticket.helpers_changed":
      return ["payouts", "technicians", "reports"];
    case "ticket.updated": {
      const fields = event.data?.fields;
      if (!Array.isArray(fields) || fields.length === 0) return ALL_EXTRA;
      const keys = new Set<string>();
      for (const field of fields) for (const key of EXTRA_BY_FIELD[String(field)] ?? ALL_EXTRA) keys.add(key);
      return [...keys];
    }
    default:
      // Criada, mudou de status ou um evento novo: tudo o que pode mostrar a OS.
      return ALL_EXTRA;
  }
}

/**
 * Posição nova de um técnico: move o marcador e estende o trajeto do dia no cache, sem recarregar o
 * mapa nem o histórico inteiro (chega a cada poucos segundos por técnico). Jornada aberta ou
 * encerrada recarrega.
 */
function applyTrackingEvent(queryClient: QueryClient, event: RealtimeEvent, invalidate: (key: QueryKey) => void) {
  const userId = event.user_id;
  if (!userId) return;
  if (event.type !== "technician.location" || event.latitude == null || event.longitude == null) {
    invalidate(["tracking"]);
    return;
  }
  const latitude = event.latitude;
  const longitude = event.longitude;
  const recordedAt = event.recorded_at ?? new Date().toISOString();
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
          latitude,
          longitude,
          recorded_at: recordedAt,
        },
      };
    }),
  );
  if (stale) invalidate(["tracking", "live"]);
  const today = todayISO();
  let gap = false;
  queryClient.setQueriesData<TrackingHistory>({ queryKey: ["tracking", "history", userId] }, (history) => {
    if (!history || history.date !== today) return history;
    const last = history.points[history.points.length - 1];
    if (last) {
      const elapsed = Date.parse(recordedAt) - Date.parse(last.recorded_at);
      // Repetido ou fora de ordem (lote sincronizado depois): o trajeto fica como está.
      if (!(elapsed > 0)) return history;
      if (elapsed > HISTORY_GAP_MS) {
        gap = true;
        return history;
      }
    }
    return { ...history, points: [...history.points, { latitude, longitude, recorded_at: recordedAt, speed_mps: null }] };
  });
  if (gap) invalidate(["tracking", "history", userId]);
}

interface StoredFeed {
  items: RealtimeNotice[];
  /** Até quando (ms) a pessoa já viu os avisos. */
  readAt: number;
}

const feedKey = (userId: string) => `mf:avisos:${userId}`;

/** Avisos guardados na aba (sobrevivem ao F5 e somem ao fechar a aba). */
function readFeed(userId: string): StoredFeed {
  if (typeof window === "undefined") return { items: [], readAt: 0 };
  try {
    const raw = window.sessionStorage.getItem(feedKey(userId));
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredFeed>) : null;
    if (parsed && Array.isArray(parsed.items)) {
      return {
        items: parsed.items.filter((n) => n && typeof n.title === "string" && typeof n.at === "string").slice(0, FEED_LIMIT),
        readAt: typeof parsed.readAt === "number" ? parsed.readAt : 0,
      };
    }
  } catch {
    // Sem storage ou valor estragado: começa vazio.
  }
  return { items: [], readAt: 0 };
}

function writeFeed(userId: string, feed: StoredFeed) {
  try {
    window.sessionStorage.setItem(feedKey(userId), JSON.stringify(feed));
  } catch {
    // Sem storage: os avisos valem só até recarregar.
  }
}

/** "OS-000231, OS-000232 e OS-000240" ou "OS-000231, OS-000232, OS-000240 e mais 3". */
function listCodes(codes: string[]): string {
  if (codes.length <= 3) return codes.length === 1 ? codes[0] : `${codes.slice(0, -1).join(", ")} e ${codes[codes.length - 1]}`;
  return `${codes.slice(0, 3).join(", ")} e mais ${codes.length - 3}`;
}

/**
 * Mantém um WebSocket com a API enquanto houver sessão. Reconecta com backoff (e na hora quando a
 * internet volta ou a aba volta a ficar visível), confere o pong, junta as invalidações de uma rajada
 * de eventos e mostra só os avisos que pedem atenção, com "Abrir" para a OS.
 * `quiet` (portal do cliente): só mantém a tela atualizada, sem avisos.
 */
export function RealtimeProvider({
  userId,
  quiet = false,
  children,
}: {
  userId: string;
  quiet?: boolean;
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  const [state, setState] = useState<ConnectionState>("connecting");
  const [feed, setFeed] = useState<StoredFeed>(() => readFeed(userId));
  const toastRef = useRef(toast);
  const routerRef = useRef(router);
  const reconnectRef = useRef<() => void>(() => {});
  const pushNoticeRef = useRef<(draft: NoticeDraft) => void>(() => {});

  useEffect(() => {
    toastRef.current = toast;
    routerRef.current = router;
  }, [toast, router]);

  useEffect(() => {
    writeFeed(userId, feed);
  }, [userId, feed]);

  // Avisos: entram na lista do sino e viram toast, agrupados e no máximo um por OS a cada 10 s.
  useEffect(() => {
    if (quiet) return;
    let pending: RealtimeNotice[] = [];
    let timer: number | undefined;
    let seq = 0;
    const lastByTicket = new Map<string, number>();

    const actionFor = (notice: RealtimeNotice) => {
      const { ticketId, href } = notice;
      if (ticketId) return { label: "Abrir", onClick: () => requestOpenTicket(ticketId) };
      if (href) return { label: "Ver", onClick: () => routerRef.current.push(href) };
      return undefined;
    };

    const flush = () => {
      timer = undefined;
      const items = pending;
      pending = [];
      if (items.length <= 2) {
        for (const notice of items) {
          toastRef.current({ title: notice.title, description: notice.description, tone: notice.tone, action: actionFor(notice) });
        }
        return;
      }
      const codes = Array.from(new Set(items.map((n) => n.code).filter((c): c is string => !!c)));
      toastRef.current({
        title: `${items.length} avisos novos`,
        description: codes.length ? listCodes(codes) : undefined,
        action: { label: "Ver avisos", onClick: requestOpenFeed },
      });
    };

    pushNoticeRef.current = (draft) => {
      const now = Date.now();
      seq += 1;
      const notice: RealtimeNotice = { ...draft, id: `${now}-${seq}`, at: new Date(now).toISOString() };
      setFeed((current) => ({ ...current, items: [notice, ...current.items].slice(0, FEED_LIMIT) }));
      if (draft.ticketId) {
        if (now - (lastByTicket.get(draft.ticketId) ?? 0) < NOTICE_PER_TICKET_MS) return;
        lastByTicket.set(draft.ticketId, now);
      }
      pending.push(notice);
      if (timer === undefined) timer = window.setTimeout(flush, NOTICE_WAIT_MS);
    };
    return () => {
      window.clearTimeout(timer);
      pushNoticeRef.current = () => {};
    };
  }, [quiet]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let pingTimer: number | undefined;
    let retryTimer: number | undefined;
    let attempt = 0;
    let stopped = false;
    // Já conectou alguma vez: a próxima conexão é uma volta, e o que mudou no meio-tempo precisa ser relido.
    let hadConnection = false;
    let lastMessageAt = 0;

    // ---- invalidações juntas: uma rajada de eventos vira uma busca por tela aberta
    const pendingKeys = new Map<string, QueryKey>();
    const followUp = new Map<string, QueryKey>();
    let flushTimer: number | undefined;
    let followUpTimer: number | undefined;
    let firstPendingAt = 0;

    const flushKeys = () => {
      flushTimer = undefined;
      firstPendingAt = 0;
      const keys = [...pendingKeys.values()];
      pendingKeys.clear();
      // A chave mais curta já cobre as mais longas (["tracking"] cobre ["tracking", "live"]).
      const covered = (key: QueryKey) =>
        keys.some((other) => other.length < key.length && other.every((part, i) => part === key[i]));
      for (const queryKey of keys) {
        if (covered(queryKey)) continue;
        // Sem cancelar a busca em andamento (ela terminaria cancelada a cada evento de uma rajada); quem
        // estava buscando busca de novo logo depois, porque a resposta podia ser de antes da mudança.
        if (queryClient.isFetching({ queryKey }) > 0) followUp.set(JSON.stringify(queryKey), queryKey);
        void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
      }
      if (followUp.size > 0 && followUpTimer === undefined) {
        followUpTimer = window.setTimeout(() => {
          followUpTimer = undefined;
          const again = [...followUp.values()];
          followUp.clear();
          for (const queryKey of again) void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
        }, FOLLOW_UP_MS);
      }
    };

    const invalidate = (queryKey: QueryKey) => {
      pendingKeys.set(JSON.stringify(queryKey), queryKey);
      const now = Date.now();
      if (!firstPendingAt) firstPendingAt = now;
      window.clearTimeout(flushTimer);
      flushTimer = window.setTimeout(flushKeys, Math.max(0, Math.min(FLUSH_IDLE_MS, firstPendingAt + FLUSH_MAX_MS - now)));
    };

    const handle = (event: RealtimeEvent) => {
      const type = event.type ?? "";
      if (type.startsWith("technician.")) {
        applyTrackingEvent(queryClient, event, invalidate);
        return;
      }
      if (type === "quote.decided") {
        invalidate(["quotes"]);
      } else if (type === "onboarding.submitted") {
        invalidate(["onboarding"]);
      } else if (type === "part_request.created") {
        invalidate(["tickets"]);
        invalidate(["quotes"]);
      } else if (type.startsWith("ticket.")) {
        for (const key of ["tickets", "solicitacoes", "dashboard", "assignable", "portal", ...extraKeysFor(event)]) invalidate([key]);
        invalidate(["tracking", "live"]);
      } else {
        return;
      }
      if (event.ticket_id) invalidate(["ticket", event.ticket_id]);
      const notice = noticeFor(event, userId);
      if (notice) pushNoticeRef.current(notice);
    };

    // ---- conexão
    const setDown = () => setState(attempt >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "connecting");

    const scheduleReconnect = (authFailed: boolean) => {
      if (stopped) return;
      window.clearTimeout(retryTimer);
      // Backoff exponencial com sorteio: as abas não voltam todas no mesmo segundo depois de um deploy.
      const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS) * (0.5 + Math.random());
      attempt += 1;
      retryTimer = window.setTimeout(async () => {
        retryTimer = undefined;
        if (authFailed) {
          const result = await refreshSessionResult();
          if (stopped) return;
          if (result === "denied") {
            // A sessão acabou de verdade: o layout leva ao login, que explica.
            sessionStore.set(null, "expired");
            return;
          }
          if (result === "unavailable") {
            // Rede ou API fora: a sessão continua e a renovação é tentada de novo depois.
            scheduleReconnect(true);
            setDown();
            return;
          }
        }
        connect();
      }, delay);
    };

    const lost = (ws: WebSocket, authFailed: boolean) => {
      window.clearInterval(pingTimer);
      if (socket === ws) socket = null;
      if (stopped) return;
      scheduleReconnect(authFailed);
      setDown();
    };

    const connect = () => {
      if (stopped) return;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      const token = sessionStore.get()?.accessToken;
      if (!token) return;
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      socket = ws;

      ws.onopen = () => {
        lastMessageAt = Date.now();
        window.clearInterval(pingTimer);
        pingTimer = window.setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastMessageAt > PING_MS + PONG_GRACE_MS) {
            // Conexão "meio aberta" (Wi-Fi trocou, notebook acordou): não espera o fechamento educado.
            ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
            ws.close();
            lost(ws, false);
            return;
          }
          ws.send(JSON.stringify({ type: "ping" }));
        }, PING_MS);
      };

      ws.onmessage = (message) => {
        lastMessageAt = Date.now();
        let event: RealtimeEvent;
        try {
          event = JSON.parse(message.data as string) as RealtimeEvent;
        } catch {
          return;
        }
        if (event.type === "hello") {
          // O servidor abre o socket antes de validar o token: conectado de verdade é só agora.
          attempt = 0;
          setState("online");
          if (hadConnection) void queryClient.invalidateQueries();
          hadConnection = true;
          return;
        }
        if (event.type === "pong") return;
        handle(event);
      };

      // 4401/1008: token recusado pelo servidor (vencido ou revogado).
      ws.onclose = (closeEvent) => lost(ws, closeEvent.code === 4401 || closeEvent.code === 1008);
      ws.onerror = () => ws.close();
    };

    // Internet de volta ou aba visível de novo (notebook acordou): tenta já, sem esperar o backoff.
    const reconnectNow = () => {
      if (stopped || (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN))) return;
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };
    reconnectRef.current = () => {
      attempt = 0;
      reconnectNow();
    };
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisible);

    connect();

    return () => {
      stopped = true;
      window.clearInterval(pingTimer);
      window.clearTimeout(retryTimer);
      window.clearTimeout(flushTimer);
      window.clearTimeout(followUpTimer);
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisible);
      reconnectRef.current = () => {};
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [queryClient, userId]);

  const markAllRead = useCallback(() => {
    const now = Date.now();
    setFeed((current) => ({ ...current, readAt: now }));
  }, []);
  const unread = useMemo(() => feed.items.filter((n) => Date.parse(n.at) > feed.readAt).length, [feed]);
  const feedValue = useMemo(() => ({ items: feed.items, unread, markAllRead }), [feed.items, unread, markAllRead]);
  const control = useMemo(() => ({ reconnect: () => reconnectRef.current() }), []);

  return (
    <RealtimeContext.Provider value={state}>
      <ControlContext.Provider value={control}>
        <FeedContext.Provider value={feedValue}>{children}</FeedContext.Provider>
      </ControlContext.Provider>
    </RealtimeContext.Provider>
  );
}

export function useConnectionState(): ConnectionState {
  return useContext(RealtimeContext);
}

/** "Tentar agora": reconecta o tempo real na hora, sem esperar a próxima tentativa. */
export function useRealtimeControl() {
  return useContext(ControlContext);
}

/** Avisos recentes da central (o sino da barra de cima). */
export function useRealtimeFeed(): RealtimeFeed {
  return useContext(FeedContext);
}
