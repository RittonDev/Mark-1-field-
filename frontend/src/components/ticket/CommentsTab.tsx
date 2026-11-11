"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Lock, MessageSquare, Send } from "lucide-react";
import { useState } from "react";
import { Button, Checkbox, EmptyState, ErrorBox, LoadingBlock, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isStaff } from "@/lib/constants";
import { formatDateTime, initials } from "@/lib/format";
import type { Comment, UUID } from "@/lib/types";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

export function CommentsTab({ ticketId }: { ticketId: UUID }) {
  const { user } = useAuth();
  const staff = isStaff(user?.role);
  const invalidate = useInvalidateTicket(ticketId);
  const onError = useTicketErrorHandler(ticketId);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);

  const comments = useQuery({
    queryKey: ["ticket", ticketId, "comments"],
    queryFn: () => api.get<Comment[]>(`/tickets/${ticketId}/comments`),
  });

  const create = useMutation({
    mutationFn: () => api.post<Comment>(`/tickets/${ticketId}/comments`, { body: body.trim(), is_internal: internal }),
    onSuccess: () => {
      setBody("");
      invalidate();
    },
    onError,
  });

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
            <li
              key={c.id}
              className={clsx(
                "rounded-lg border p-3",
                c.is_internal
                  ? "border-amber-200 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/30"
                  : "border-line bg-surface",
              )}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <div className="flex size-6 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-ink-muted">
                  {initials(c.author?.name)}
                </div>
                <span className="text-sm font-medium text-ink">{c.author?.name ?? "Sistema"}</span>
                {c.is_internal ? (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                    <Lock className="size-3" />
                    Nota interna
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
          if (body.trim()) create.mutate();
        }}
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder={internal ? "Nota visível apenas para a equipe técnica" : "Escreva um acompanhamento"}
        />
        <div className="flex items-center justify-between gap-2">
          {staff ? (
            <Checkbox label="Nota interna (não visível ao solicitante)" checked={internal} onChange={setInternal} />
          ) : (
            <span />
          )}
          <Button type="submit" variant="primary" size="sm" disabled={!body.trim()} loading={create.isPending}>
            {create.isPending ? null : <Send className="size-3.5" />}
            Enviar
          </Button>
        </div>
      </form>
    </div>
  );
}
