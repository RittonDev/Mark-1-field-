// Contrato de sincronização mobile (backend/app/schemas/sync.py, docs/MOBILE_SYNC.md).
// Os tipos de domínio vêm de ./types.ts, copiado de frontend/src/lib/types.ts.

import type {
  Comment,
  FormAnswer,
  PartRequest,
  ISODate,
  TicketDetail,
  TicketTransitionPayload,
  TicketUpdatePayload,
  UUID,
  Worklog,
} from "./types";

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

/**
 * Respostas de um formulário da OS (merge parcial; null ou "" remove a resposta).
 * Com `complete`, o servidor valida obrigatórios e fotos mínimas; se faltar algo a operação é
 * recusada e NADA é gravado (o app então reenvia as respostas sem `complete`).
 */
export interface FormAnswersPayload {
  form_id: UUID;
  answers: Record<string, FormAnswer | null>;
  complete: boolean;
}

/** Visita improdutiva: o técnico foi ao local e não conseguiu atender (POST /tickets/{id}/unproductive). */
export interface UnproductivePayload {
  reason_id: UUID;
  note?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * Pedido de peça em campo (POST /tickets/{id}/part-requests ou operação `part_request` do sync).
 * As fotos sobem antes como anexo comum e entram aqui pelos ids.
 */
export interface PartRequestPayload {
  description: string;
  quantity: number;
  unit?: string | null;
  note?: string | null;
  attachment_ids?: UUID[];
  /** Id gerado no aparelho: reenviar o mesmo pedido não duplica (client_op_id). */
  client_id?: string | null;
}

export type SyncOperation =
  | { type: "transition"; payload: TicketTransitionPayload }
  | { type: "comment"; payload: CommentCreatePayload }
  | { type: "worklog"; payload: WorklogCreatePayload }
  | { type: "update"; payload: TicketUpdatePayload }
  | { type: "form_answers"; payload: FormAnswersPayload }
  | { type: "unproductive"; payload: UnproductivePayload }
  | { type: "part_request"; payload: PartRequestPayload };

export type SyncOpType = SyncOperation["type"];

export interface SyncOperationIn {
  client_op_id: string;
  type: SyncOpType;
  ticket_id: UUID;
  payload: SyncOperation["payload"];
  client_timestamp?: ISODate;
}

/**
 * Corpo de POST /sync/push. `sent_at` é o relógio do aparelho na hora do envio: com ele o servidor
 * acha a hora real de uma ação feita sem sinal mesmo com o relógio do celular errado
 * (hora real ≈ recebido_em − (sent_at − client_timestamp)). Servidor sem suporte ignora o campo.
 */
export interface SyncPushRequest {
  operations: SyncOperationIn[];
  sent_at?: ISODate;
}

/**
 * `duplicate`: o `client_op_id` já tinha sido processado (reenvio depois de uma resposta perdida).
 * Com `error`, aquele processamento tinha sido recusado: para o app é uma recusa, não um sucesso.
 */
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

/** Pedido de peça como o app exibe: `pending` = ainda na fila do aparelho (id = client_op_id). */
export type LocalPartRequest = PartRequest & { pending?: boolean };
