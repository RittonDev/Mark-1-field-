"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Copy, Download, Eye, FileText, Mail, MessageCircle, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Dialog } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { ReportLink, TicketDetail } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";
import { ReportLinkCard } from "./ReportLinkCard";

/**
 * "Link do relatório da atividade" (como no Field Control): toda OS tem relatório para o cliente. Antes
 * de concluir ele mostra o andamento (agendada, técnico a caminho, em atendimento); concluída, o
 * resultado com fotos, checklist e assinatura.
 */
export function ReportMenu({ ticket, buttonClassName }: { ticket: TicketDetail; buttonClassName?: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const ensure = useMutation({
    mutationFn: () => api.post<ReportLink>(`/tickets/${ticket.id}/report-link`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] }),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** Link do relatório (as OS antigas sem link ganham um na hora). */
  async function link(): Promise<ReportLink | null> {
    if (ticket.report_link) return ticket.report_link;
    try {
      return await ensure.mutateAsync();
    } catch (error) {
      toast({ title: errorMessage(error), tone: "error" });
      return null;
    }
  }

  const message = (url: string) => `Olá! Segue o relatório da ${ticket.code} (${ticket.title}): ${url}`;

  async function run(action: "email" | "whatsapp" | "copy" | "open" | "pdf") {
    setOpen(false);
    const current = await link();
    if (!current) return;
    if (action === "email") {
      const subject = `Relatório da ${ticket.code} · ${ticket.title}`;
      window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message(current.url))}`;
    } else if (action === "whatsapp") {
      window.open(whatsappUrl(null, message(current.url)), "_blank", "noopener");
    } else if (action === "copy") {
      await navigator.clipboard.writeText(current.url);
      toast({ title: "Link do relatório copiado", description: "Cole na conversa com o cliente.", tone: "success" });
    } else if (action === "open") {
      window.open(current.path, "_blank", "noopener");
    } else {
      window.open(`${current.path}?pdf=1`, "_blank", "noopener");
    }
  }

  const items: { key: "email" | "whatsapp" | "copy" | "open" | "pdf"; label: string; icon: typeof Mail }[] = [
    { key: "email", label: "Compartilhar por e-mail", icon: Mail },
    { key: "whatsapp", label: "Compartilhar via WhatsApp", icon: MessageCircle },
    { key: "copy", label: "Copiar link", icon: Copy },
    { key: "open", label: "Abrir relatório", icon: Eye },
    { key: "pdf", label: "Baixar PDF", icon: Download },
  ];

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        className={buttonClassName}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Link do relatório da atividade"
        aria-label="Link do relatório da atividade"
      >
        <FileText className="size-[18px]" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Link do relatório da atividade"
          className="absolute right-0 bottom-full z-30 mb-2 w-72 animate-pop overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-pop"
        >
          <p className="px-4 pt-1.5 pb-2 text-sm font-bold text-ink">Link do relatório da atividade</p>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => void run(item.key)}
              disabled={ensure.isPending}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-ink transition-colors hover:bg-surface-2 disabled:opacity-60"
            >
              <item.icon className="size-[18px] text-ink-muted" />
              {item.label}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setManage(true);
            }}
            className={clsx("flex w-full items-center gap-3 px-4 py-2 text-left text-xs text-ink-muted transition-colors hover:bg-surface-2")}
          >
            <Settings2 className="size-4" />
            Gerenciar link (trocar ou desativar)
          </button>
        </div>
      ) : null}
      {manage ? (
        <Dialog open onClose={() => setManage(false)} title={`Relatório do cliente · ${ticket.code}`}>
          <ReportLinkCard ticket={ticket} />
        </Dialog>
      ) : null}
    </div>
  );
}
