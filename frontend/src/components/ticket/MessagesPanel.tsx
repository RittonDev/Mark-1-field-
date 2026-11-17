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

/** Marca do texto sugerido para o momento da OS (também na tela Textos, que explica quando aparece). */
export function NowBadge() {
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

// ------------------------------------------------------------------ menu "Textos para o grupo"

const MENU_WIDTH = 384;
const MENU_GAP = 6;
const VIEW_EDGE = 8;
/** Abre embaixo do botão quando cabe ao menos isso; senão, do lado com mais espaço (ex.: rodapé do painel). */
const MIN_BELOW = 320;

/**
 * Põe o menu (fixo na tela) junto do botão e inteiro dentro da janela: embaixo ou em cima, alinhado pela
 * borda do botão mais perto do meio da tela. Devolve false quando o botão saiu da tela (rolou).
 */
function placeMenu(menu: HTMLElement, anchor: HTMLElement): boolean {
  const rect = anchor.getBoundingClientRect();
  const viewWidth = document.documentElement.clientWidth;
  const viewHeight = window.innerHeight;
  if (rect.bottom < 0 || rect.top > viewHeight) return false;
  const width = Math.min(MENU_WIDTH, viewWidth - VIEW_EDGE * 2);
  const start = rect.left + rect.width / 2 > viewWidth / 2 ? rect.right - width : rect.left;
  const below = viewHeight - rect.bottom - MENU_GAP - VIEW_EDGE;
  const above = rect.top - MENU_GAP - VIEW_EDGE;
  const down = below >= MIN_BELOW || below >= above;
  Object.assign(menu.style, {
    left: `${Math.max(VIEW_EDGE, Math.min(start, viewWidth - width - VIEW_EDGE))}px`,
    width: `${width}px`,
    top: down ? `${rect.bottom + MENU_GAP}px` : "",
    bottom: down ? "" : `${viewHeight - rect.top + MENU_GAP}px`,
    maxHeight: `${Math.max(down ? below : above, 160)}px`,
  });
  return true;
}

// Item do menu: fundo e anel de foco por dentro (a lista rola e cortaria o anel de fora).
const menuItem =
  "flex text-left transition-colors outline-none hover:bg-surface-2 focus-visible:bg-surface-2 " +
  "focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset";

/**
 * "Textos para o grupo": os textos prontos da OS num menu, o sugerido para agora primeiro (marcado
 * "Agora"). O clique copia e o aviso oferece abrir o WhatsApp; o ícone ao lado de cada texto abre o
 * WhatsApp com ele, sem número (a pessoa escolhe o grupo). Só busca os textos ao abrir, então serve
 * também nas listas.
 */
export function GroupTextsMenu({
  ticketId,
  className,
  size = "md",
  label = "Textos para o grupo",
}: {
  ticketId: string;
  className?: string;
  size?: "sm" | "md";
  label?: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { copy, fallback } = useGroupTextCopy(ticketId);
  useCopiedReset(copied, () => setCopied(false));

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  };
  const pick = (m: GroupText) => {
    close(true);
    void copy(m.key).then(setCopied);
  };
  const share = (m: GroupText) => {
    close(false);
    void copyForLongLink(m.text, toast);
  };
  const icon = size === "sm" ? "size-3.5" : "size-4";
  const Icon = copied ? Check : MessageSquareText;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          // Numa linha de lista que abre a OS ao clicar, o clique fica só no botão.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={buttonClassName("secondary", size, className)}
      >
        <Icon aria-hidden className={icon} />
        {label}
        <ChevronDown aria-hidden className={clsx(icon, "text-ink-muted transition-transform duration-150", open && "rotate-180")} />
      </button>
      {open ? (
        <GroupTextsPopover id={menuId} ticketId={ticketId} label={label} anchor={trigger} onPick={pick} onShare={share} onClose={close} />
      ) : null}
      {fallback}
    </>
  );
}

/**
 * A lista do menu, num portal no <body>: não é cortada pela tabela nem pelo painel com rolagem e fica
 * por cima do painel da OS. Teclado como menu: setas, Home e End andam; Esc fecha e devolve o foco ao
 * botão; Tab fecha e segue a partir do botão.
 */
function GroupTextsPopover({
  id,
  ticketId,
  label,
  anchor,
  onPick,
  onShare,
  onClose,
}: {
  id: string;
  ticketId: string;
  label: string;
  anchor: React.RefObject<HTMLButtonElement | null>;
  /** Escolheu um texto para copiar. */
  onPick: (m: GroupText) => void;
  /** Abriu o WhatsApp com o texto (o link segue sozinho). */
  onShare: (m: GroupText) => void;
  /** Fechar; `focusTrigger` devolve o foco ao botão. */
  onClose: (focusTrigger: boolean) => void;
}) {
  const messages = useGroupTexts(ticketId);
  const menu = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const list = messages.data;
  const settled = list !== undefined || messages.isError;
  const dismiss = useEffectEvent(() => onClose(false));
  const onOutside = useEffectEvent((e: MouseEvent) => {
    const target = e.target as Node;
    if (!menu.current?.contains(target) && !anchor.current?.contains(target)) onClose(false);
  });

  // Junto do botão antes de pintar. Rolando a tela (lista, painel) ou mudando o tamanho da janela, o menu
  // acompanha o botão; se o botão sai da tela, fecha.
  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      const node = menu.current;
      const button = anchor.current;
      if (node && button && !placeMenu(node, button)) dismiss();
    };
    const schedule = (e: Event) => {
      // A rolagem da própria lista do menu não muda nada.
      if (e.target instanceof Node && menu.current?.contains(e.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [anchor]);

  useEffect(() => {
    const listener = (e: MouseEvent) => onOutside(e);
    document.addEventListener("mousedown", listener);
    return () => document.removeEventListener("mousedown", listener);
  }, []);

  // Foco no primeiro item (o sugerido) assim que a lista chega; enquanto carrega, no próprio menu.
  useEffect(() => {
    const node = menu.current;
    if (!node) return;
    const active = document.activeElement;
    if (active && active !== node && node.contains(active)) return;
    (node.querySelector<HTMLElement>('[role="menuitem"]') ?? node).focus({ preventScroll: true });
  }, [settled]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === "Escape") {
      // O preventDefault avisa o painel da OS e os diálogos por baixo: o Esc fecha só o menu.
      e.preventDefault();
      onClose(true);
    } else if (e.key === "Tab") {
      // O foco volta ao botão e o Tab segue a partir dele (no painel da OS, o Tab continua preso nele).
      onClose(true);
    } else if (items.length === 0) {
      return;
    } else if (e.key === "ArrowDown") {
      focusAt(index + 1);
    } else if (e.key === "ArrowUp") {
      focusAt(index < 0 ? -1 : index - 1);
    } else if (e.key === "Home") {
      focusAt(0);
    } else if (e.key === "End") {
      focusAt(-1);
    } else if (e.key === " " && document.activeElement instanceof HTMLAnchorElement) {
      // Espaço também ativa os links do menu (WhatsApp, modelos), como nos botões.
      e.preventDefault();
      document.activeElement.click();
    }
  };

  const shared = list ? sharedFirstLine(list) : null;
  const titleId = `${baseId}-titulo`;
  const errorId = `${baseId}-erro`;
  const emptyId = `${baseId}-vazio`;
  const empty = list !== undefined && list.length === 0;

  let body: React.ReactNode;
  if (!settled) {
    body = (
      <div aria-hidden className="flex flex-col gap-4 px-4 py-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    );
  } else if (!list) {
    body = (
      <div role="none" className="flex flex-col items-start gap-2 px-4 py-3">
        <p id={errorId} className="text-sm text-red-700 dark:text-red-300">
          Não foi possível carregar os textos. {errorMessage(messages.error)}
        </p>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-describedby={errorId}
          onClick={() => void messages.refetch()}
          className={clsx(menuItem, "items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink")}
        >
          {messages.isFetching ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <RotateCcw aria-hidden className="size-3.5" />}
          Tentar de novo
        </button>
      </div>
    );
  } else if (empty) {
    body = (
      <p id={emptyId} className="px-4 py-4 text-xs text-ink-muted">
        Nenhum texto pronto ainda. Crie os modelos uma vez e eles aparecem aqui preenchidos com os dados da OS.
      </p>
    );
  } else {
    body = (
      <div role="none" className="divide-y divide-line">
        {list.map((m) => {
          const previewId = `${baseId}-${m.key}`;
          return (
            <div key={m.key} role="none" className="relative flex items-stretch">
              {m.suggested ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-2.5 left-1.5 w-[3px] rounded-full bg-linear-to-b from-brand to-brand-cyan"
                />
              ) : null}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => onPick(m)}
                aria-label={`Copiar ${m.name}${m.suggested ? ", sugerido agora" : ""}`}
                aria-describedby={previewId}
                className={clsx(menuItem, "min-w-0 flex-1 flex-col gap-1 py-2.5 pr-3 pl-4")}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold text-ink">{m.name}</span>
                  {m.suggested ? <NowBadge /> : null}
                  <span aria-hidden className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-ink-muted">
                    <Copy className="size-3.5" />
                    Copiar
                  </span>
                </span>
                <span id={previewId} className="line-clamp-3 text-xs leading-relaxed break-words whitespace-pre-line text-ink-muted">
                  {previewOf(m.text, shared)}
                </span>
              </button>
              <a
                role="menuitem"
                tabIndex={-1}
                href={shareUrl(m.text)}
                target="_blank"
                rel="noreferrer"
                onClick={() => onShare(m)}
                aria-label={`Abrir ${m.name} no WhatsApp`}
                title="Abrir no WhatsApp"
                className={clsx(menuItem, "w-11 shrink-0 items-center justify-center border-l border-line text-ink-muted hover:text-ink")}
              >
                <MessageCircle aria-hidden className="size-4" />
              </a>
            </div>
          );
        })}
      </div>
    );
  }

  return createPortal(
    <div
      ref={menu}
      id={id}
      role="menu"
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-busy={!settled || undefined}
      onKeyDown={onKeyDown}
      // O menu é um portal no <body>, mas o clique ainda "sobe" pela árvore do React até quem o
      // renderiza (ex.: a linha da lista, que abriria a OS). Ele para aqui.
      onClick={(e) => e.stopPropagation()}
      className="fixed z-50 flex animate-pop flex-col overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-pop outline-none"
    >
      <div role="none" className="border-b border-line px-4 py-2.5">
        <p id={titleId} className="text-sm font-bold text-ink">
          {label}
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-muted">{shared ? unbold(shared) : "Clique para copiar e cole no grupo do WhatsApp."}</p>
      </div>
      <div role="none" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {body}
      </div>
      <div role="none" className="border-t border-line p-1">
        <Link
          href="/textos"
          role="menuitem"
          tabIndex={-1}
          onClick={() => onClose(false)}
          aria-describedby={empty ? emptyId : undefined}
          className={clsx(menuItem, "items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-ink-muted hover:text-ink")}
        >
          <Settings2 aria-hidden className="size-3.5" />
          {empty ? "Criar modelos" : "Editar modelos"}
        </Link>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ copiar com um clique

/**
 * Copia com um clique o texto `templateKey` da OS, ou o sugerido para agora (sem `templateKey`), e mostra
 * o "Copiado". Busca os textos ao aparecer: serve para o painel da OS e listas curtas (numa lista longa,
 * o GroupTextsMenu só busca ao abrir). Sem texto que sirva, fica desabilitado e diz por quê.
 */
export function CopyGroupTextButton({
  ticketId,
  templateKey,
  className,
  label = "Copiar texto",
  size = "sm",
}: {
  ticketId: string;
  templateKey?: string;
  className?: string;
  label?: string;
  /** "md": ao lado de botões do tamanho padrão (ex.: o "Abrir OS" da OS recém-criada). */
  size?: "sm" | "md";
}) {
  const messages = useGroupTexts(ticketId, BUTTON_STALE_MS);
  const { copy, busy, fallback } = useGroupTextCopy(ticketId);
  const [copied, setCopied] = useState(false);
  const reasonId = useId();
  useCopiedReset(copied, () => setCopied(false));

  const target = messages.data?.find((m) => (templateKey ? m.key === templateKey : m.suggested));
  // Nome acessível com o texto que será copiado (sem repetir quando o rótulo já diz qual é).
  const name = !target
    ? undefined
    : copied
      ? `Copiado: ${target.name}`
      : label.includes(target.name)
        ? label
        : `${label}: ${target.name}`;
  const failed = !messages.data && messages.isError;
  const reason = messages.isPending
    ? "Carregando o texto..."
    : failed
      ? "Não foi possível carregar os textos: clique para tentar de novo."
      : target
        ? null
        : templateKey
          ? "Este texto não está entre os modelos (veja em Textos do WhatsApp)."
          : "Nenhum texto combina com a situação da OS agora.";
  const unavailable = messages.isPending || (!failed && !target);
  const loading = busy || (messages.isPending && messages.isFetching);
  const Icon = loading ? Loader2 : copied ? Check : Copy;

  const run = async () => {
    if (unavailable || busy) return;
    setCopied(await copy(templateKey ?? null));
  };

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // Numa linha de lista que abre a OS ao clicar, o clique fica só no botão.
          e.stopPropagation();
          void run();
        }}
        aria-disabled={unavailable || undefined}
        aria-busy={busy || undefined}
        aria-label={name}
        aria-describedby={reason ? reasonId : undefined}
        title={target ? `Copia “${target.name}” para colar no grupo do WhatsApp` : (reason ?? undefined)}
        className={buttonClassName(
          "secondary",
          size,
          clsx("aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0", className),
        )}
      >
        <Icon aria-hidden className={clsx(size === "sm" ? "size-3.5" : "size-4", loading && "animate-spin")} />
        {copied ? "Copiado" : label}
      </button>
      {reason ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
      {fallback}
    </>
  );
}
