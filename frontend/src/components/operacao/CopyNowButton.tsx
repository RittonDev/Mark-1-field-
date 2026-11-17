"use client";

// "Copiar texto" das linhas de Atividades do dia e Minha fila: um clique copia o texto do momento da OS
// para o grupo do WhatsApp (atividade confirmada, técnico a caminho, encerrada com o link do relatório...).
// Só busca os textos no clique: uma tela com dezenas de visitas não faz uma leitura por linha ao abrir,
// nem de novo a cada volta do WhatsApp para a aba (o CopyGroupTextButton do painel da OS lê ao aparecer).

import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Copy, Loader2, MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Dialog, Textarea } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import {
  copyText,
  GROUP_TEXT_COPIED,
  GROUP_TEXT_FRESH_MS,
  type GroupText,
  groupTextsQuery,
  WHATSAPP_TEXT_LIMIT,
  whatsappUrl,
} from "@/lib/whatsapp";

/** Tempo do "Copiado" no botão depois de copiar. */
const COPIED_MS = 2000;

/** WhatsApp sem número (a pessoa escolhe o grupo). O texto longo demais para ir no endereço abre vazio. */
const shareUrl = (text: string) => whatsappUrl(null, text.length <= WHATSAPP_TEXT_LIMIT ? text : "");

export function CopyNowButton({ ticketId, code, className }: { ticketId: string; code: string; className?: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // O navegador não deixou copiar (ex.: http na rede do escritório): o texto aparece para o Ctrl+C.
  const [manual, setManual] = useState<GroupText | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Aproveita uma leitura de até 1 min atrás (ex.: o diálogo de textos ao lado); senão, lê agora.
      const list = await queryClient.fetchQuery({ ...groupTextsQuery(ticketId), staleTime: GROUP_TEXT_FRESH_MS });
      const message = list.find((m) => m.suggested);
      if (!message) {
        toast({
          title: "Nenhum texto combina com a situação da OS agora",
          description: `${code}: escolha o texto no ícone de textos, ao lado.`,
        });
        return;
      }
      if (await copyText(message.text)) {
        setCopied(true);
        toast({
          title: GROUP_TEXT_COPIED,
          description: `${message.name} · ${code}`,
          tone: "success",
          action: {
            label: "Abrir no WhatsApp",
            onClick: () => window.open(shareUrl(message.text), "_blank", "noopener,noreferrer"),
          },
        });
      } else {
        setManual(message);
      }
    } catch (error) {
      toast({ title: `Não foi possível buscar o texto da ${code}`, description: errorMessage(error), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const Icon = busy ? Loader2 : copied ? Check : Copy;
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // Numa linha de lista que abre a OS ao clicar, o clique fica só no botão.
          e.preventDefault();
          e.stopPropagation();
          void run();
        }}
        aria-busy={busy || undefined}
        // O nome começa pelo que está escrito no botão e diz de qual OS é (as linhas têm um botão cada).
        aria-label={`${copied ? "Copiado o texto" : "Copiar texto"} da ${code}`}
        title="Copia o texto do momento da OS para colar no grupo do WhatsApp"
        className={buttonClassName("secondary", "sm", className)}
      >
        <Icon aria-hidden className={clsx("size-3.5", busy && "animate-spin")} />
        {copied ? "Copiado" : "Copiar texto"}
      </button>
      {manual ? <ManualCopyDialog message={manual} code={code} onClose={() => setManual(null)} /> : null}
    </>
  );
}

/** O navegador não deixou copiar: o texto aparece selecionado para o Ctrl+C, com o WhatsApp à mão. */
function ManualCopyDialog({ message, code, onClose }: { message: GroupText; code: string; onClose: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    area.current?.focus();
    area.current?.select();
  }, []);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${message.name} · ${code}`}
      description="O navegador não deixou copiar sozinho. O texto já está selecionado: copie com Ctrl+C e cole no grupo do WhatsApp."
      footer={
        <>
          <a href={shareUrl(message.text)} target="_blank" rel="noreferrer" className={buttonClassName("secondary")}>
            <MessageCircle className="size-4" />
            Abrir no WhatsApp
          </a>
          <Button variant="primary" onClick={onClose}>
            Fechar
          </Button>
        </>
      }
    >
      <Textarea ref={area} readOnly rows={8} value={message.text} aria-label={`Texto ${message.name}`} className="text-sm leading-relaxed" />
    </Dialog>
  );
}
