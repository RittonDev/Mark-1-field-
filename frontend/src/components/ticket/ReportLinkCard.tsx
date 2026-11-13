"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, ExternalLink, FileCheck2, Link2Off, Mail, MessageCircle, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Card, CardHeader, ErrorBox } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatShort } from "@/lib/format";
import type { ReportLink, TicketDetail } from "@/lib/types";
import { copyText, whatsappUrl } from "@/lib/whatsapp";

/** Texto que acompanha o link do relatório (WhatsApp e e-mail). */
export function reportMessage(ticket: Pick<TicketDetail, "code" | "title">, url: string): string {
  return `Olá! Segue o relatório da ${ticket.code} (${ticket.title}): ${url}`;
}

/** Aberto pela central: "preview" avisa que não é o cliente abrindo (a contagem de aberturas é dele). */
export const previewPath = (link: ReportLink) => `${link.path}?preview=1`;
export const pdfPath = (link: ReportLink) => `${link.path}?pdf=1&preview=1`;

/**
 * Link público do relatório da OS (toda OS tem): o cliente vê o andamento e, concluída, o resultado e o PDF.
 * `bare`: só o conteúdo, para dentro de um diálogo que já tem o título.
 */
export function ReportLinkCard({ ticket, bare = false }: { ticket: TicketDetail; bare?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [copied, setCopied] = useState(false);
  const urlField = useRef<HTMLInputElement>(null);
  const finished = ticket.status === "resolved" || ticket.status === "closed";
  const link = ticket.report_link ?? null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id], exact: true });
  const create = useMutation({
    mutationFn: () => api.post<ReportLink>(`/tickets/${ticket.id}/report-link`),
    onSuccess: () => {
      void refresh();
      toast({ title: "Link do relatório criado", tone: "success" });
    },
  });
  const rotate = useMutation({
    mutationFn: () => api.post<ReportLink>(`/tickets/${ticket.id}/report-link/rotate`),
    onSuccess: () => {
      void refresh();
      toast({ title: "Novo link gerado", description: "O link anterior parou de funcionar.", tone: "success" });
    },
  });
  const revoke = useMutation({
    mutationFn: () => api.delete(`/tickets/${ticket.id}/report-link`),
    onSuccess: () => {
      void refresh();
      toast({ title: "Link desativado", description: "O cliente não abre mais o relatório por ele.", tone: "success" });
    },
  });

  if (!ticket.can_assign) return null;

  const copy = async () => {
    if (!link) return;
    if (await copyText(link.url)) {
      setCopied(true);
      toast({ title: "Link do relatório copiado", description: "Cole na conversa com o cliente.", tone: "success" });
      window.setTimeout(() => setCopied(false), 2000);
      return;
    }
    toast({ title: "Não foi possível copiar", description: "Selecione o link e copie com Ctrl+C.", tone: "error" });
    urlField.current?.select();
  };
  const error = create.error ?? rotate.error ?? revoke.error;
  const message = link ? reportMessage(ticket, link.url) : "";

  const body = (
    <div className={bare ? "flex flex-col gap-3" : "flex flex-col gap-3 p-4"}>
      {ticket.status === "cancelled" ? (
        <p className="text-sm text-ink-muted">OS cancelada: o cliente vê que o atendimento foi cancelado.</p>
      ) : !finished ? (
        <p className="text-sm text-ink-muted">
          A OS ainda não foi concluída: o cliente vê o andamento (agendada, técnico a caminho, em atendimento) e, ao concluir, o
          resultado com fotos, checklist e assinatura.
        </p>
      ) : null}
      {link ? (
        <>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 py-1.5 pr-1.5 pl-3 focus-within:ring-2 focus-within:ring-brand/45">
            <input
              ref={urlField}
              readOnly
              value={link.url}
              aria-label="Link do relatório para o cliente"
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 truncate bg-transparent text-xs text-ink-muted outline-none"
            />
            <Button size="sm" variant="primary" onClick={copy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copiado" : "Copiar"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a href={whatsappUrl(null, message)} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "sm")}>
              <MessageCircle className="size-3.5" />
              WhatsApp
            </a>
            <a
              href={`mailto:?subject=${encodeURIComponent(`Relatório da ${ticket.code} · ${ticket.title}`)}&body=${encodeURIComponent(message)}`}
              className={buttonClassName("secondary", "sm")}
            >
              <Mail className="size-3.5" />
              E-mail
            </a>
            <a href={previewPath(link)} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "sm")}>
              <ExternalLink className="size-3.5" />
              Ver como o cliente
            </a>
            <a href={pdfPath(link)} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "sm")}>
              <Download className="size-3.5" />
              Baixar PDF
            </a>
            <span className="ml-auto text-xs text-ink-muted">
              {link.views
                ? `Aberto ${link.views}x${link.last_viewed_at ? ` · último ${formatShort(link.last_viewed_at)}` : ""}`
                : "Ainda não aberto"}
            </span>
          </div>
          <div className="flex flex-wrap gap-1 border-t border-line pt-3">
            <Button
              size="sm"
              variant="ghost"
              loading={rotate.isPending}
              onClick={async () =>
                (await confirm({
                  title: "Gerar um novo link do relatório?",
                  description: "O link já enviado ao cliente para de funcionar.",
                  confirmLabel: "Gerar novo link",
                  tone: "danger",
                })) && rotate.mutate()
              }
            >
              {rotate.isPending ? null : <RefreshCw className="size-3.5" />}
              Gerar novo link
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={revoke.isPending}
              onClick={async () =>
                (await confirm({
                  title: "Desativar o link do relatório?",
                  description: "O cliente deixa de conseguir abrir o relatório por esse link.",
                  confirmLabel: "Desativar",
                  tone: "danger",
                })) && revoke.mutate()
              }
            >
              {revoke.isPending ? null : <Link2Off className="size-3.5" />}
              Desativar
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-ink-muted">O link está desativado: o cliente não abre o relatório. Crie um novo para enviar.</p>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? null : <FileCheck2 className="size-4" />}
            Criar novo link do relatório
          </Button>
        </div>
      )}
      {error ? <ErrorBox message={errorMessage(error)} /> : null}
    </div>
  );

  if (bare) return body;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <FileCheck2 className="size-4 text-ink-muted" />
            Relatório para o cliente
          </span>
        }
        description="O andamento e, concluída, a solução, as fotos, o checklist e a assinatura. O cliente abre pelo link e baixa em PDF."
      />
      {body}
    </Card>
  );
}
