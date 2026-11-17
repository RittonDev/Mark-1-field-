"use client";

// Textos prontos para o grupo do WhatsApp (modelos de /textos, já preenchidos com os dados da OS). Só a
// gestão usa: a conversa com os técnicos e com o cliente acontece nos grupos do WhatsApp, nunca pelo
// sistema nem pelo app do técnico (a API só devolve os textos para a gestão). O texto que combina com o
// momento da OS (atividade confirmada, técnico a caminho, encerrada com o link do relatório...) vem
// primeiro, marcado como "Agora".

import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, ChevronDown, Copy, Loader2, MessageCircle, MessageSquareText, Pencil, RotateCcw, Settings2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Dialog, EmptyState, ErrorBox, LoadingBlock, Skeleton, Textarea } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import {
  copyText,
  GROUP_TEXT_COPIED,
  GROUP_TEXT_FRESH_MS,
  type GroupText,
  groupTextsQuery,
  suggestedFirst,
  WHATSAPP_TEXT_LIMIT,
  whatsappUrl,
} from "@/lib/whatsapp";

type ToastFn = ReturnType<typeof useToast>["toast"];

/** O botão de copiar busca os textos ao aparecer (também em listas): reaproveita a busca por esse tempo. */
const BUTTON_STALE_MS = 30_000;
/** Tempo do "Copiado" no botão depois de copiar. */
const COPIED_MS = 2000;

/**
 * Textos da OS já preenchidos, o sugerido primeiro. Hora, previsão de chegada e técnico mudam: relê ao
 * abrir, e a chave fica sob ["ticket", id], então salvar ou mudar a situação da OS (aqui ou em tempo
 * real) relê os textos.
 */
function useGroupTexts(ticketId: string, staleTime = 0) {
  return useQuery({ ...groupTextsQuery(ticketId), staleTime, select: suggestedFirst });
}

/** Tira o "Copiado" do botão um pouco depois de copiar (`copied`: o que foi copiado, ou vazio). */
function useCopiedReset(copied: string | boolean | null, clear: () => void) {
  const reset = useEffectEvent(clear);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => reset(), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
}

/**
 * Primeira linha comum a todos os textos (o "*OS-000123* · Cliente" dos modelos padrão): sai das
 * prévias, que mostram só o que muda de um texto para outro.
 */
function sharedFirstLine(list: GroupText[]): string | null {
  if (list.length < 2) return null;
  const first = list[0].text.split("\n", 1)[0];
  if (!first.trim()) return null;
  return list.every((m) => m.text.startsWith(`${first}\n`)) ? first : null;
}

/** Sem as marcas de negrito do WhatsApp (*assim*): na tela, só o texto. */
const unbold = (text: string) => text.replace(/\*([^*\n]+)\*/g, "$1");

/** Prévia do texto, sem a primeira linha comum a todos. */
function previewOf(text: string, shared: string | null): string {
  return unbold(shared && text.startsWith(`${shared}\n`) ? text.slice(shared.length + 1) : text).trim();
}

/** WhatsApp sem número (a pessoa escolhe o grupo). O texto longo demais para ir no endereço abre vazio. */
const shareUrl = (text: string) => whatsappUrl(null, text.length <= WHATSAPP_TEXT_LIMIT ? text : "");

const openWhatsApp = (text: string) => {
  window.open(shareUrl(text), "_blank", "noopener,noreferrer");
};

/** Texto longo demais para o link do WhatsApp: vai pela área de transferência ao abrir a conversa. */
async function copyForLongLink(text: string, toast: ToastFn) {
  if (text.length <= WHATSAPP_TEXT_LIMIT) return;
  toast(
    (await copyText(text))
      ? { title: GROUP_TEXT_COPIED, description: "Longo demais para ir pelo link: cole na conversa que abriu.", tone: "info" }
      : { title: "Não foi possível copiar", description: "O texto é longo demais para ir pelo link: copie e cole no grupo.", tone: "error" },
  );
}

/** Marca do texto sugerido para o momento da OS. */
function NowBadge() {
  return (
    <span
      title="Sugerido para a situação atual da OS"
      className="inline-flex shrink-0 items-center rounded-full bg-brand-soft px-1.5 text-[10px] leading-4 font-bold tracking-[0.06em] text-brand-ink uppercase"
    >
      Agora
    </span>
  );
}

/**
 * Copia um texto pronto da OS (`key`, ou o sugerido para agora) e avisa, com o atalho para o WhatsApp.
 * Antes relê os textos quando a versão em tela passou de 1 min. Sem acesso à área de transferência (ex.:
 * http na rede do escritório), abre o texto selecionado para o Ctrl+C (`fallback`, para renderizar).
 */
function useGroupTextCopy(ticketId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [manual, setManual] = useState<GroupText | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = async (key: string | null): Promise<boolean> => {
    setBusy(true);
    try {
      const list = await queryClient.fetchQuery({ ...groupTextsQuery(ticketId), staleTime: GROUP_TEXT_FRESH_MS });
      const message = list.find((m) => (key ? m.key === key : m.suggested));
      if (!message) {
        toast(
          key
            ? { title: "Este texto não está mais nos modelos", description: "Escolha outro em Textos para o grupo.", tone: "error" }
            : { title: "Nenhum texto combina com a situação da OS agora", description: "Escolha o texto em Textos para o grupo." },
        );
        return false;
      }
      if (await copyText(message.text)) {
        toast({
          title: GROUP_TEXT_COPIED,
          description: message.name,
          tone: "success",
          action: { label: "Abrir no WhatsApp", onClick: () => openWhatsApp(message.text) },
        });
        return true;
      }
      setManual(message);
      return false;
    } catch (error) {
      toast({ title: "Não foi possível buscar o texto", description: errorMessage(error), tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const fallback = manual ? <ManualCopyDialog message={manual} onClose={() => setManual(null)} /> : null;
  return { copy, busy, fallback };
}

/** O navegador não deixou copiar: o texto aparece selecionado para o Ctrl+C, com o WhatsApp à mão. */
function ManualCopyDialog({ message, onClose }: { message: GroupText; onClose: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    area.current?.focus();
    area.current?.select();
  }, []);
  return (
    <Dialog
      open
      onClose={onClose}
      title={message.name}
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

// Botão só com o ícone, nas linhas dos textos (o nome vem no aria-label).
const iconButton =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-ink/[0.05] hover:text-ink " +
  "focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none";

/**
 * Os textos prontos da OS, o sugerido para agora primeiro, cada um com a prévia: copiar, abrir no
 * WhatsApp ou ajustar antes (o ajuste vale só aqui, o modelo continua o mesmo).
 */
export function MessageList({ ticketId, compact = false }: { ticketId: string; compact?: boolean }) {
  const { toast } = useToast();
  const messages = useGroupTexts(ticketId);
  const editor = useRef<HTMLTextAreaElement>(null);
  const baseId = useId();
  const [open, setOpen] = useState<string | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  useCopiedReset(copied, () => setCopied(null));

  if (messages.isPending) return <LoadingBlock rows={2} label="Carregando os textos prontos..." />;
  if (!messages.data) return <ErrorBox message={errorMessage(messages.error)} onRetry={() => void messages.refetch()} />;
  const list = messages.data;
  if (!list.length) {
    return (
      <EmptyState
        size="sm"
        icon={<MessageSquareText />}
        title="Nenhum texto pronto"
        description="Crie os modelos (atividade confirmada, técnico em deslocamento, atividade encerrada...) uma vez e eles aparecem aqui preenchidos."
        action={
          <Link href="/textos" className={buttonClassName("secondary", "sm")}>
            <Settings2 className="size-3.5" />
            Criar modelos
          </Link>
        }
      />
    );
  }

  const shared = sharedFirstLine(list);
  const textOf = (m: GroupText) => edited[m.key] ?? m.text;
  const copy = async (m: GroupText) => {
    const text = textOf(m);
    if (await copyText(text)) {
      setCopied(m.key);
      toast({
        title: GROUP_TEXT_COPIED,
        description: m.name,
        tone: "success",
        action: { label: "Abrir no WhatsApp", onClick: () => openWhatsApp(text) },
      });
      return;
    }
    // Sem acesso à área de transferência (ex.: http na rede do escritório): o texto fica aberto e
    // selecionado para o Ctrl+C.
    setOpen(m.key);
    toast({ title: "Não foi possível copiar", description: "Selecione o texto e copie com Ctrl+C.", tone: "error" });
    window.requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.select();
    });
  };
  const restore = (key: string) =>
    setEdited((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

  return (
    <ul className="flex flex-col gap-2">
      {list.map((m) => {
        const text = textOf(m);
        const expanded = open === m.key;
        const done = copied === m.key;
        const adjusted = edited[m.key] !== undefined;
        const editorId = `${baseId}-${m.key}`;
        return (
          <li
            key={m.key}
            className={clsx("overflow-hidden rounded-lg border bg-surface shadow-elev-1", m.suggested ? "border-brand/40" : "border-line")}
          >
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
              <div className="min-w-0 flex-1 basis-56">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-ink">{m.name}</span>
                  {m.suggested ? <NowBadge /> : null}
                  {adjusted ? <span className="text-xs text-ink-muted">(ajustado)</span> : null}
                </p>
                {expanded ? null : (
                  <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed break-words whitespace-pre-line text-ink-muted">
                    {previewOf(text, shared)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" onClick={() => void copy(m)} aria-label={`${done ? "Copiado" : "Copiar"}: ${m.name}`}>
                  {done ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
                  {done ? "Copiado" : "Copiar"}
                </Button>
                <a
                  href={shareUrl(text)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => void copyForLongLink(text, toast)}
                  className={iconButton}
                  aria-label={`Abrir ${m.name} no WhatsApp`}
                  title="Abrir no WhatsApp"
                >
                  <MessageCircle aria-hidden className="size-4" />
                </a>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : m.key)}
                  aria-expanded={expanded}
                  aria-controls={expanded ? editorId : undefined}
                  aria-label={`Ajustar ${m.name}`}
                  title="Ajustar o texto antes de copiar"
                  className={clsx(iconButton, expanded && "bg-ink/[0.05] text-ink")}
                >
                  <Pencil aria-hidden className="size-3.5" />
                </button>
              </div>
            </div>
            {expanded ? (
              <div className="flex animate-enter flex-col gap-2 border-t border-line bg-surface-2/60 p-3">
                <Textarea
                  id={editorId}
                  ref={editor}
                  rows={compact ? 6 : 5}
                  value={text}
                  onChange={(e) => setEdited((current) => ({ ...current, [m.key]: e.target.value }))}
                  className="text-sm leading-relaxed"
                  aria-label={`Texto ${m.name}`}
                />
                <LongTextNote text={text} />
                {adjusted ? (
                  <Button size="sm" variant="ghost" className="self-start" onClick={() => restore(m.key)}>
                    <RotateCcw aria-hidden className="size-3.5" />
                    Voltar ao texto padrão
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Botão de ícone para listas (Atividades do dia, Minha fila): abre os textos para o grupo num diálogo. */
export function MessagesButton({ ticketId, code }: { ticketId: string; code: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-brand"
        aria-label={`Textos para o grupo da ${code}`}
        title="Textos para o grupo do WhatsApp"
      >
        <MessageSquareText className="size-4" />
      </button>
      {open ? (
        <Dialog
          open
          onClose={() => setOpen(false)}
          size="lg"
          title={`Textos para o grupo · ${code}`}
          description="Já preenchidos com os dados da OS, o do momento primeiro. Copie e cole no grupo do WhatsApp."
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
