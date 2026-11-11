// Contrato de sincronização mobile (backend/app/schemas/sync.py, docs/MOBILE_SYNC.md).
// Os tipos de domínio vêm de ./types.ts, copiado de frontend/src/lib/types.ts.

import type { Comment, ISODate, TicketDetail, TicketTransitionPayload, TicketUpdatePayload, UUID, Worklog } from "./types";

export interface SyncPullResponse {
  server_time: ISODate;
  has_more: boolean;
  tickets: TicketDetail[];
  comments: Comment[];
  worklogs: Worklog[];
  revoked_ticket_ids: UUID[];
}

export interface CommentCreatePayload {
  body: string;
  is_internal: boolean;
}

export interface WorklogCreatePayload {
  description: string;
  started_at: ISODate;
  ended_at?: ISODate | null;
  minutes?: number | null;
  latitude?: number | null;
  longitude?: number | null;
}

export type SyncOperation =
  | { type: "transition"; payload: TicketTransitionPayload }
  | { type: "comment"; payload: CommentCreatePayload }
  | { type: "worklog"; payload: WorklogCreatePayload }
  | { type: "update"; payload: TicketUpdatePayload };

export type SyncOpType = SyncOperation["type"];

export interface SyncOperationIn {
  client_op_id: string;
  type: SyncOpType;
  ticket_id: UUID;
  payload: SyncOperation["payload"];
  client_timestamp?: ISODate;
}

export type SyncResultStatus = "applied" | "duplicate" | "rejected" | "conflict";

export interface SyncOperationResult {
  client_op_id: string;
  status: SyncResultStatus;
  error: string | null;
  ticket: TicketDetail | null;
}

export interface SyncPushResponse {
  server_time: ISODate;
  results: SyncOperationResult[];
}

/** Operação guardada na fila local (tabela `outbox`). */
export type OutboxOp = SyncOperation & {
  seq: number;
  client_op_id: string;
  ticket_id: UUID;
  client_timestamp: ISODate;
  attempts: number;
  last_error: string | null;
};

/** OS como o app exibe: estado do servidor + operações ainda não enviadas. */
export type LocalTicket = TicketDetail & { pending_ops: number };
