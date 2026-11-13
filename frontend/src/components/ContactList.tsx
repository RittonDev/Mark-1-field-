"use client";

import clsx from "clsx";
import { Copy, Mail, MessageCircle, Phone, Smartphone, Star } from "lucide-react";
import { useToast } from "@/components/Toaster";
import type { ContactEntry } from "@/lib/types";

const LABEL: Record<string, string> = {
  work: "trabalho",
  personal: "pessoal",
  mobile: "celular",
  home: "residencial",
};

const digits = (v: string) => v.replace(/\D/g, "");

/** Telefone com DDI 55 já embutido ou não: monta o link do WhatsApp para celular. */
function whatsappLink(value: string): string {
  const d = digits(value);
  return `https://wa.me/${d.startsWith("55") && d.length > 11 ? d : `55${d}`}`;
}

function formatPhone(value: string): string {
  let d = digits(value);
  if (d.startsWith("55") && d.length > 11) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return value;
}

/** Todos os contatos do cadastro, com atalhos para copiar, ligar, e-mail e WhatsApp. */
export function ContactList({ contacts, empty = "Nenhum contato cadastrado." }: { contacts?: ContactEntry[] | null; empty?: string }) {
  const { toast } = useToast();
  const list = [...(contacts ?? [])].sort((a, b) => Number(b.primary) - Number(a.primary) || a.kind.localeCompare(b.kind));
  if (!list.length) return <p className="text-sm text-ink-subtle">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {list.map((c, i) => {
        const isPhone = c.kind === "phone";
        const mobile = isPhone && (c.label === "mobile" || digits(c.value).replace(/^55/, "").length === 11);
        const Icon = isPhone ? (mobile ? Smartphone : Phone) : Mail;
        const shown = isPhone ? formatPhone(c.value) : c.value;
        return (
          <li key={`${c.kind}-${c.value}-${i}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-subtle">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-ink">
                <span className="truncate">{shown}</span>
                {c.primary ? <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" aria-label="principal" /> : null}
              </p>
              <p className="truncate text-xs text-ink-subtle">
                {[c.name, c.label ? LABEL[c.label] ?? c.label : null].filter(Boolean).join(" · ") || (isPhone ? "telefone" : "e-mail")}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1">
              {isPhone ? (
                <>
                  {mobile ? (
                    <a
                      href={whatsappLink(c.value)}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md p-1.5 text-emerald-600 transition-colors hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
                      aria-label={`WhatsApp ${shown}`}
                      title="WhatsApp"
                    >
                      <MessageCircle className="size-4" />
                    </a>
                  ) : null}
                  <a href={`tel:${digits(c.value)}`} className="rounded-md p-1.5 text-ink-subtle hover:bg-surface-2 hover:text-ink" aria-label={`Ligar ${shown}`} title="Ligar">
                    <Phone className="size-4" />
                  </a>
                </>
              ) : (
                <a href={`mailto:${c.value}`} className="rounded-md p-1.5 text-ink-subtle hover:bg-surface-2 hover:text-ink" aria-label={`E-mail para ${c.value}`} title="Enviar e-mail">
                  <Mail className="size-4" />
                </a>
              )}
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(c.value);
                  toast({ title: "Contato copiado", description: shown, tone: "success" });
                }}
                className={clsx("rounded-md p-1.5 text-ink-subtle hover:bg-surface-2 hover:text-ink")}
                aria-label={`Copiar ${shown}`}
                title="Copiar"
              >
                <Copy className="size-4" />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
