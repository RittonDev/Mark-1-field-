"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Eye, FileText, Mail, MessageCircle, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Dialog, isTopLayer } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { ReportLink, TicketDetail } from "@/lib/types";
import { copyText, whatsappUrl } from "@/lib/whatsapp";
import { pdfPath, previewPath, ReportLinkCard, reportMessage } from "./ReportLinkCard";

type Action = "email" | "whatsapp" | "copy" | "open" | "pdf";

const ITEMS: { key: Action; label: string; icon: typeof Mail }[] = [
  { key: "email", label: "Compartilhar por e-mail", icon: Mail },
  { key: "whatsapp", label: "Compartilhar via WhatsApp", icon: MessageCircle },
  { key: "copy", label: "Copiar link", icon: Copy },
  { key: "open", label: "Abrir relatório", icon: Eye },
  { key: "pdf", label: "Baixar PDF", icon: Download },
];

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
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const ensure = useMutation({
    mutationFn: () => api.post<ReportLink>(`/tickets/${ticket.id}/report-link`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id], exact: true });
      // Sem link ativo, só chega aqui depois de "Desativar": o link novo é outro.
      toast({ title: "Novo link criado", description: "O link anterior continua desativado.", tone: "success" });
    },
  });

  // Menu de teclado: abre com o foco no primeiro item; setas, Home e End andam; Esc fecha e devolve o foco.
  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      const node = menu.current;
      if (e.defaultPrevented || !node || !isTopLayer(node)) return;
      const list = items();
      const index = list.indexOf(document.activeElement as HTMLElement);
      const focus = (i: number) => {
        e.preventDefault();
        list[(i + list.length) % list.length]?.focus();
      };
      if (e.key === "Escape") {
        // O preventDefault avisa o painel da OS: o Esc fecha só o menu.
        e.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      } else if (e.key === "ArrowDown") focus(index + 1);
      else if (e.key === "ArrowUp") focus(index < 0 ? -1 : index - 1);
      else if (e.key === "Home") focus(0);
      else if (e.key === "End") focus(-1);
      else if (e.key === "Tab") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** Link do relatório (depois de "Desativar", um novo é criado na hora). */
  async function link(): Promise<ReportLink | null> {
    if (ticket.report_link) return ticket.report_link;
    try {
      return await ensure.mutateAsync();
    } catch (error) {
      toast({ title: "Não foi possível criar o link do relatório", description: errorMessage(error), tone: "error" });
      return null;
    }
  }

  async function run(action: Action) {
    setOpen(false);
    trigger.current?.focus();
    const current = await link();
    if (!current) return;
    const message = reportMessage(ticket, current.url);
    if (action === "email") {
      const subject = `Relatório da ${ticket.code} · ${ticket.title}`;
      window.location.assign(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`);
    } else if (action === "whatsapp") {
      window.open(whatsappUrl(null, message), "_blank", "noopener");
    } else if (action === "copy") {
      if (await copyText(current.url)) {
        toast({ title: "Link do relatório copiado", description: "Cole na conversa com o cliente.", tone: "success" });
      } else {
        // Sem acesso à área de transferência: o link fica selecionável no "Gerenciar link".
        toast({ title: "Não foi possível copiar", description: "Copie o link na janela que abriu (Ctrl+C).", tone: "error" });
        setManage(true);
      }
    } else if (action === "open") {
      window.open(previewPath(current), "_blank", "noopener");
    } else {
      window.open(pdfPath(current), "_blank", "noopener");
    }
  }

  return (
    <div ref={wrap} className="relative">
      <button
        ref={trigger}
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
          ref={menu}
          role="menu"
          aria-label="Link do relatório da atividade"
          className="absolute right-0 bottom-full z-30 mb-2 w-72 animate-pop overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-pop"
        >
          <div role="presentation" className="px-4 pt-1.5 pb-2">
            <p className="text-sm font-bold text-ink">Link do relatório da atividade</p>
            {!ticket.report_link ? (
              <p className="mt-0.5 text-xs text-ink-muted">Link desativado: ao escolher uma opção, um link novo é criado.</p>
            ) : null}
          </div>
          {ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => void run(item.key)}
              disabled={ensure.isPending}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-ink transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-60"
            >
              <item.icon className="size-[18px] text-ink-muted" />
              {item.label}
            </button>
          ))}
          <div role="separator" className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setOpen(false);
              setManage(true);
            }}
            className="flex w-full items-center gap-3 px-4 py-2 text-left text-xs text-ink-muted transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
          >
            <Settings2 className="size-4" />
            Gerenciar link (trocar ou desativar)
          </button>
        </div>
      ) : null}
      {manage ? (
        <Dialog
          open
          onClose={() => setManage(false)}
          title={`Relatório do cliente · ${ticket.code}`}
          description="O andamento e, concluída, a solução, as fotos, o checklist e a assinatura. O cliente abre pelo link e baixa em PDF."
        >
          <ReportLinkCard ticket={ticket} bare />
        </Dialog>
      ) : null}
    </div>
  );
}
