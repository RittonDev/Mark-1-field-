"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Ban, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, ErrorBox, Input, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { AuthorizationChannel, TicketDetail } from "@/lib/types";

export const AUTH_CHANNEL: Record<AuthorizationChannel, string> = {
  whatsapp: "WhatsApp",
  email: "E-mail",
  phone: "Telefone",
  portal: "Portal do cliente",
  maxxcon: "Central Maxxcon",
  other: "Outro",
};

/**
 * Autorização do cliente para a visita (cada chamado é cobrado): enquanto pendente,
 * o técnico não inicia o deslocamento e o prazo de chegada não começa a contar.
 */
export function AuthorizationCard({ ticket }: { ticket: TicketDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const status = ticket.authorization_status ?? "not_required";
  const [editing, setEditing] = useState(false);
  const [byName, setByName] = useState(ticket.authorized_by_name ?? ticket.requester_name ?? "");
  const [channel, setChannel] = useState<AuthorizationChannel>(ticket.authorization_channel ?? "whatsapp");
  const [reference, setReference] = useState(ticket.authorization_ref ?? "");
  const record = useMutation({
    mutationFn: (next: "authorized" | "denied") =>
      api.post<TicketDetail>(`/tickets/${ticket.id}/authorization`, {
        status: next,
        by_name: byName.trim() || null,
        channel,
        reference: reference.trim() || null,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["ticket", ticket.id], updated);
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      setEditing(false);
      toast({
        title: updated.authorization_status === "authorized" ? "Visita autorizada: o prazo de chegada começou" : "Visita registrada como não autorizada",
        tone: updated.authorization_status === "authorized" ? "success" : "info",
      });
    },
  });

  if (!ticket.can_assign || status === "not_required") return null;
  const open = editing || status === "pending";

  return (
    <div
      className={clsx(
        "animate-enter rounded-xl border p-4",
        status === "pending" && "border-amber-200 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10",
        status === "denied" && "border-red-200 bg-red-50/70 dark:border-red-500/30 dark:bg-red-500/10",
        status === "authorized" && "border-line bg-surface",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          {status === "authorized" ? (
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : status === "denied" ? (
            <Ban className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400" />
          ) : (
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <div>
            <p className="text-sm font-semibold text-ink">
              {status === "authorized"
                ? "Visita autorizada pelo cliente"
                : status === "denied"
                  ? "Cliente não autorizou a visita"
                  : "Aguardando autorização do cliente"}
            </p>
            <p className="text-xs text-ink-muted">
              {status === "authorized"
                ? [
                    ticket.authorized_by_name ? `por ${ticket.authorized_by_name}` : null,
                    ticket.authorization_channel ? `via ${AUTH_CHANNEL[ticket.authorization_channel]}` : null,
                    ticket.authorized_at ? `em ${formatDateTime(ticket.authorized_at)}` : null,
                    ticket.authorization_ref ? `chamado do cliente ${ticket.authorization_ref}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "Cada chamado é cobrado: o técnico só inicia o deslocamento depois do OK do cliente."}
            </p>
          </div>
        </div>
        {!open ? (
          <button type="button" onClick={() => setEditing(true)} className="text-xs text-ink-muted hover:text-ink">
            Alterar
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Input value={byName} onChange={(e) => setByName(e.target.value)} placeholder="Quem autorizou (nome)" aria-label="Quem autorizou" />
          <Select value={channel} onChange={(e) => setChannel(e.target.value as AuthorizationChannel)} aria-label="Canal">
            {Object.entries(AUTH_CHANNEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Nº do chamado do cliente" aria-label="Número do chamado do cliente" />
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <Button size="sm" variant="primary" loading={record.isPending && record.variables === "authorized"} onClick={() => record.mutate("authorized")}>
              <ShieldCheck className="size-3.5" />
              Registrar autorização
            </Button>
            <Button size="sm" variant="ghost" loading={record.isPending && record.variables === "denied"} onClick={() => record.mutate("denied")}>
              Cliente não autorizou
            </Button>
            {editing && status !== "pending" ? (
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {record.error ? (
        <div className="mt-3">
          <ErrorBox message={errorMessage(record.error)} />
        </div>
      ) : null}
    </div>
  );
}
