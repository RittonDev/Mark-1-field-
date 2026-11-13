"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Info, Lock, MessageSquare, Send } from "lucide-react";
import { useState } from "react";
import { Button, EmptyState, ErrorBox, Kbd, LoadingBlock, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, initials } from "@/lib/format";
import type { Comment, UUID } from "@/lib/types";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

const MAX_BODY = 10000;

/**
 * Acompanhamentos da OS: o registro da central. Ninguém de fora vê (o técnico e o cliente falam com
 * a central pelo WhatsApp), então não existe "nota interna": todo acompanhamento já é interno.
 */
export function CommentsTab({ ticketId }: { ticketId: UUID }) {
  const invalidate = useInvalidateTicket(ticketId, { lists: false, parts: ["comments"] });
  const onError = useTicketErrorHandler(ticketId);
  const [body, setBody] = useState("");

  const comments = useQuery({
    queryKey: ["ticket", ticketId, "comments"],
    queryFn: () => api.get<Comment[]>(`/tickets/${ticketId}/comments`),
  });

  const create = useMutation({
    mutationFn: () => api.post<Comment>(`/tickets/${ticketId}/comments`, { body: body.trim(), is_internal: false }),
    onSuccess: () => {
      setBody("");
      invalidate();
    },
    onError,
  });

  const send = () => {
    if (body.trim() && !create.isPending) create.mutate();
  };
  const items = [...(comments.data ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));

  return (
    <div className="flex flex-col gap-4">
      {comments.isLoading ? (
        <LoadingBlock />
      ) : comments.error ? (
        <ErrorBox message={errorMessage(comments.error)} />
      ) : items.length === 0 ? (
        <EmptyState icon={<MessageSquare className="size-7" />} title="Nenhum acompanhamento ainda" />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((c) => (
            <li key={c.id} className="rounded-lg border border-line bg-surface p-3">
              <div className="mb-1.5 flex items-center gap-2">
                <div className="flex size-6 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-ink-muted">
                  {initials(c.author?.name)}
                </div>
                <span className="text-sm font-semibold text-ink">{c.author?.name ?? "Sistema"}</span>
                {/* Notas antigas marcadas como internas, de quando havia a opção. */}
                {c.is_internal ? (
                  <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted ring-1 ring-line ring-inset">
                    <Lock className="size-3" />
                    interna
                  </span>
                ) : null}
                <span className="ml-auto text-xs text-ink-muted">{formatDateTime(c.created_at)}</span>
              </div>
              <p className="text-sm whitespace-pre-wrap text-ink">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
      >
        <p className="flex items-start gap-1.5 text-xs text-ink-muted">
          <Info className="mt-px size-3.5 shrink-0" />
          Fica só na central: o técnico e o cliente não veem. Fale com eles pelo WhatsApp.
        </p>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={3}
          maxLength={MAX_BODY}
          placeholder="Escreva um acompanhamento (o que foi combinado, com quem falou, próximo passo)"
          aria-label="Novo acompanhamento"
        />
        <div className="flex items-center justify-end gap-3">
          {body.length > MAX_BODY - 1000 ? (
            <span className="mr-auto text-[11px] text-ink-subtle tabular-nums">
              {body.length.toLocaleString("pt-BR")} / {MAX_BODY.toLocaleString("pt-BR")}
            </span>
          ) : null}
          <span className="hidden items-center gap-1 text-[11px] text-ink-subtle sm:inline-flex">
            <Kbd>Ctrl</Kbd>
            <Kbd>Enter</Kbd>
            envia
          </span>
          <Button type="submit" variant="primary" size="sm" disabled={!body.trim()} loading={create.isPending}>
            {create.isPending ? null : <Send className="size-3.5" />}
            Enviar
          </Button>
        </div>
      </form>
    </div>
  );
}
