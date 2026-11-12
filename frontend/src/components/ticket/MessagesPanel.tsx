"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Copy, MessageCircle, MessageSquareText, Settings2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Dialog, ErrorBox, LoadingBlock, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";

interface Rendered {
  key: string;
  name: string;
  text: string;
}

/** Textos da OS já preenchidos (hora, previsão de chegada e técnico mudam: relê ao abrir). */
function useMessages(ticketId: string) {
  return useQuery({
    queryKey: ["ticket", ticketId, "messages"],
    queryFn: () => api.get<Rendered[]>(`/tickets/${ticketId}/messages`),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

function MessageList({ ticketId, compact = false }: { ticketId: string; compact?: boolean }) {
  const { toast } = useToast();
  const messages = useMessages(ticketId);
  const [open, setOpen] = useState<string | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  if (messages.isLoading) return <LoadingBlock />;
  if (messages.error) return <ErrorBox message={errorMessage(messages.error)} />;
  const list = messages.data ?? [];

  const copy = async (m: Rendered) => {
    await navigator.clipboard.writeText(edited[m.key] ?? m.text);
    setCopied(m.key);
    toast({ title: `Texto "${m.name}" copiado`, description: "Cole no grupo do WhatsApp.", tone: "success" });
    setTimeout(() => setCopied((c) => (c === m.key ? null : c)), 2000);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {list.map((m) => (
          <div key={m.key} className="inline-flex overflow-hidden rounded-lg border border-line">
            <button
              type="button"
              onClick={() => copy(m)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
              title={`Copiar: ${m.text}`}
            >
              {copied === m.key ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5 text-ink-muted" />}
              {m.name}
            </button>
            <button
              type="button"
              onClick={() => setOpen(open === m.key ? null : m.key)}
              aria-expanded={open === m.key}
              className={clsx(
                "border-l border-line px-2 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink",
                open === m.key && "bg-surface-2 text-ink",
              )}
              aria-label={`Ver e ajustar ${m.name}`}
            >
              ver
            </button>
          </div>
        ))}
      </div>
      {open
        ? (() => {
            const m = list.find((x) => x.key === open);
            if (!m) return null;
            const text = edited[m.key] ?? m.text;
            return (
              <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/60 p-3">
                <Textarea
                  rows={compact ? 5 : 4}
                  value={text}
                  onChange={(e) => setEdited((ed) => ({ ...ed, [m.key]: e.target.value }))}
                  className="text-sm"
                  aria-label={`Texto ${m.name}`}
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => copy(m)}>
                    <Copy className="size-3.5" />
                    Copiar
                  </Button>
                  <a href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
                    <Button size="sm">
                      <MessageCircle className="size-3.5" />
                      Abrir no WhatsApp
                    </Button>
                  </a>
                  {edited[m.key] !== undefined ? (
                    <Button size="sm" variant="ghost" onClick={() =>
                        setEdited((ed) => {
                          const next = { ...ed };
                          delete next[m.key];
                          return next;
                        })
                      }>
                      Voltar ao texto padrão
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })()
        : null}
    </div>
  );
}

/** Seção da OS: um botão por texto (copia já preenchido). */
export function MessagesCard({ ticketId }: { ticketId: string }) {
  return (
    <Card>
      <CardHeader
        title="Textos para o WhatsApp"
        description="Clique para copiar o aviso já preenchido com os dados da OS e cole no grupo dos técnicos."
        actions={
          <Link href="/textos" className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-brand">
            <Settings2 className="size-3.5" />
            Editar modelos
          </Link>
        }
      />
      <div className="p-4">
        <MessageList ticketId={ticketId} />
      </div>
    </Card>
  );
}

/** Botão de ícone para listas (Atividades do dia): abre os textos da OS num diálogo. */
export function MessagesButton({ ticketId, code }: { ticketId: string; code: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-brand"
        aria-label={`Textos para o WhatsApp da ${code}`}
        title="Textos para o WhatsApp"
      >
        <MessageSquareText className="size-4" />
      </button>
      {open ? (
        <Dialog open onClose={() => setOpen(false)} size="lg" title={`Textos da ${code}`} description="Clique para copiar e cole no grupo do WhatsApp.">
          <MessageList ticketId={ticketId} compact />
        </Dialog>
      ) : null}
    </>
  );
}
