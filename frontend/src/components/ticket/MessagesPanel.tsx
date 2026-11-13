"use client";

// Textos prontos para o WhatsApp (modelos de /textos, já preenchidos com os dados da OS). Só a gestão
// usa: a conversa com os técnicos e com a loja acontece nos grupos do WhatsApp, nunca pelo sistema
// nem pelo app do técnico (a API só devolve os textos para a gestão).

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Copy, MessageCircle, MessageSquareText, Pencil, RotateCcw, Settings2 } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Dialog, EmptyState, ErrorBox, LoadingBlock, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { copyText, WHATSAPP_TEXT_LIMIT, whatsappUrl } from "@/lib/whatsapp";

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

/** Aviso de texto longo: o link do WhatsApp leva o texto inteiro no endereço e pode não abrir. */
export function LongTextNote({ text }: { text: string }) {
  if (text.length <= WHATSAPP_TEXT_LIMIT) return null;
  return (
    <p className="text-xs text-ink-muted">
      Texto longo ({text.length} caracteres): se o WhatsApp não abrir com ele, use <span className="font-semibold text-ink">Copiar</span> e
      cole no grupo.
    </p>
  );
}

/** Link para os modelos dos textos (tela Textos). */
export function TemplatesLink() {
  return (
    <Link href="/textos" className="inline-flex items-center gap-1 rounded text-xs font-medium text-ink-muted hover:text-brand">
      <Settings2 className="size-3.5" />
      Editar modelos
    </Link>
  );
}

/**
 * Um botão por texto pronto: o clique copia o texto já preenchido; o lápis abre para ajustar antes de
 * copiar ou abrir no WhatsApp (o ajuste vale só aqui, o modelo continua o mesmo).
 */
export function MessageList({ ticketId, compact = false }: { ticketId: string; compact?: boolean }) {
  const { toast } = useToast();
  const messages = useMessages(ticketId);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  if (messages.isLoading) return <LoadingBlock rows={2} label="Carregando os textos prontos..." />;
  if (messages.error) return <ErrorBox message={errorMessage(messages.error)} onRetry={() => void messages.refetch()} />;
  const list = messages.data ?? [];
  if (!list.length) {
    return (
      <EmptyState
        size="sm"
        icon={<MessageSquareText />}
        title="Nenhum texto pronto"
        description="Crie os modelos (deslocamento, chegada, atraso, fechamento) uma vez e eles aparecem aqui preenchidos."
        action={
          <Link href="/textos" className={buttonClassName("secondary", "sm")}>
            <Settings2 className="size-3.5" />
            Criar modelos
          </Link>
        }
      />
    );
  }

  const textOf = (m: Rendered) => edited[m.key] ?? m.text;
  const copy = async (m: Rendered) => {
    if (await copyText(textOf(m))) {
      setCopied(m.key);
      toast({ title: `Texto "${m.name}" copiado`, description: "Cole no grupo do WhatsApp.", tone: "success" });
      window.setTimeout(() => setCopied((c) => (c === m.key ? null : c)), 2000);
      return;
    }
    // Sem acesso à área de transferência (ex.: http na rede do escritório): o texto fica aberto e
    // selecionado para o Ctrl+C.
    setOpen(m.key);
    toast({ title: "Não foi possível copiar", description: "Selecione o texto e copie com Ctrl+C.", tone: "error" });
    window.requestAnimationFrame(() => editor.current?.select());
  };

  const current = open ? list.find((x) => x.key === open) : undefined;
  const currentText = current ? textOf(current) : "";

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-2">
        {list.map((m) => {
          const expanded = open === m.key;
          return (
            <li key={m.key} className="inline-flex overflow-hidden rounded-lg border border-line bg-surface shadow-elev-1">
              <button
                type="button"
                onClick={() => copy(m)}
                className="inline-flex h-8 items-center gap-1.5 px-3 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none focus-visible:ring-inset"
                aria-label={`Copiar o texto ${m.name}`}
                title="Copiar o texto pronto"
              >
                {copied === m.key ? <Check className="size-3.5 text-ink" /> : <Copy className="size-3.5 text-ink-muted" />}
                {m.name}
                {edited[m.key] !== undefined ? <span className="text-xs font-normal text-ink-muted">(ajustado)</span> : null}
              </button>
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : m.key)}
                aria-expanded={expanded}
                aria-label={`Ajustar o texto ${m.name}`}
                title="Ajustar texto"
                className={clsx(
                  "inline-flex size-8 items-center justify-center border-l border-line text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none focus-visible:ring-inset",
                  expanded && "bg-surface-2 text-ink",
                )}
              >
                <Pencil className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
      {current ? (
        <div className="flex animate-enter flex-col gap-2 rounded-lg border border-line bg-surface-2/60 p-3">
          <Textarea
            ref={editor}
            rows={compact ? 6 : 5}
            value={currentText}
            onChange={(e) => setEdited((ed) => ({ ...ed, [current.key]: e.target.value }))}
            className="text-sm leading-relaxed"
            aria-label={`Texto ${current.name}`}
          />
          <LongTextNote text={currentText} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => copy(current)}>
              {copied === current.key ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied === current.key ? "Copiado" : "Copiar"}
            </Button>
            <a href={whatsappUrl(null, currentText)} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "sm")}>
              <MessageCircle className="size-3.5" />
              Abrir no WhatsApp
            </a>
            {edited[current.key] !== undefined ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setEdited((ed) => {
                    const next = { ...ed };
                    delete next[current.key];
                    return next;
                  })
                }
              >
                <RotateCcw className="size-3.5" />
                Voltar ao texto padrão
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Botão de ícone para listas (Atividades do dia, Minha fila): abre os textos da OS num diálogo. */
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
        <Dialog
          open
          onClose={() => setOpen(false)}
          size="lg"
          title={`Textos da ${code}`}
          description="Clique para copiar o aviso já preenchido e cole no grupo do WhatsApp."
          footer={
            <>
              <span className="mr-auto">
                <TemplatesLink />
              </span>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Fechar
              </Button>
            </>
          }
        >
          <MessageList ticketId={ticketId} compact />
        </Dialog>
      ) : null}
    </>
  );
}
