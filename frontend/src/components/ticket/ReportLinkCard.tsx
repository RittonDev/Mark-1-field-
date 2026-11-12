"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, ExternalLink, FileCheck2, Link2Off, MessageCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, ErrorBox } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatShort } from "@/lib/format";
import type { ReportLink, TicketDetail } from "@/lib/types";

/** Link público do relatório da OS concluída: o cliente vê o resumo, as evidências e baixa o PDF. */
export function ReportLinkCard({ ticket }: { ticket: TicketDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const finished = ticket.status === "resolved" || ticket.status === "closed";
  const link = ticket.report_link ?? null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
  const create = useMutation({
    mutationFn: () => api.post<ReportLink>(`/tickets/${ticket.id}/report-link`),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: () => api.post<ReportLink>(`/tickets/${ticket.id}/report-link/rotate`),
    onSuccess: () => {
      refresh();
      toast({ title: "Novo link gerado", description: "O link anterior parou de funcionar.", tone: "success" });
    },
  });
  const revoke = useMutation({
    mutationFn: () => api.delete(`/tickets/${ticket.id}/report-link`),
    onSuccess: () => {
      refresh();
      toast({ title: "Link desativado", tone: "success" });
    },
  });

  if (!ticket.can_assign || (!finished && !link)) return null;

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link.url);
    setCopied(true);
    toast({ title: "Link do relatório copiado", description: "Cole na conversa com o cliente.", tone: "success" });
    window.setTimeout(() => setCopied(false), 2000);
  };
  const error = create.error ?? rotate.error ?? revoke.error;

  return (
    <Card className="animate-enter overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <FileCheck2 className="size-4 text-emerald-600 dark:text-emerald-400" />
            Relatório para o cliente
          </span>
        }
        description="Resumo do atendimento com a solução, as fotos, o checklist e a assinatura. O cliente abre pelo link e baixa em PDF."
      />
      <div className="flex flex-col gap-3 p-4">
        {!finished ? (
          <p className="text-sm text-ink-muted">A OS foi reaberta: o link volta a mostrar o relatório quando ela for concluída.</p>
        ) : null}
        {link ? (
          <>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 py-1.5 pr-1.5 pl-3">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-muted" title={link.url}>
                {link.url}
              </span>
              <Button size="sm" variant="primary" onClick={copy}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copiado" : "Copiar"}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a href={link.path} target="_blank" rel="noreferrer">
                <Button size="sm">
                  <ExternalLink className="size-3.5" />
                  Ver como o cliente
                </Button>
              </a>
              <a href={`${link.path}?pdf=1`} target="_blank" rel="noreferrer">
                <Button size="sm">
                  <Download className="size-3.5" />
                  Baixar PDF
                </Button>
              </a>
              <a
                href={`https://wa.me/?text=${encodeURIComponent(`Relatório do atendimento ${ticket.code}: ${link.url}`)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Button size="sm">
                  <MessageCircle className="size-3.5" />
                  WhatsApp
                </Button>
              </a>
              <span className="ml-auto text-xs text-ink-subtle">
                {link.views
                  ? `Aberto ${link.views}x pelo cliente${link.last_viewed_at ? ` · último ${formatShort(link.last_viewed_at)}` : ""}`
                  : "Ainda não aberto"}
              </span>
            </div>
            <div className="flex flex-wrap gap-3 border-t border-line pt-3 text-xs">
              <button
                type="button"
                disabled={rotate.isPending}
                onClick={() => window.confirm("Gerar um novo link? O link já enviado para de funcionar.") && rotate.mutate()}
                className="inline-flex items-center gap-1 text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
              >
                <RefreshCw className="size-3.5" />
                Gerar novo link
              </button>
              <button
                type="button"
                disabled={revoke.isPending}
                onClick={() => window.confirm("Desativar o link do relatório?") && revoke.mutate()}
                className="inline-flex items-center gap-1 text-ink-muted transition-colors hover:text-red-600 disabled:opacity-50"
              >
                <Link2Off className="size-3.5" />
                Desativar
              </button>
            </div>
          </>
        ) : (
          <Button variant="primary" className="self-start" loading={create.isPending} onClick={() => create.mutate()}>
            <FileCheck2 className="size-4" />
            Gerar link do relatório
          </Button>
        )}
        {error ? <ErrorBox message={errorMessage(error)} /> : null}
      </div>
    </Card>
  );
}
