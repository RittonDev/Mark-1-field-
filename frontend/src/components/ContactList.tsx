"use client";

import { Copy, Mail, MessageCircle, Phone, Plus, Smartphone, Star, X } from "lucide-react";
import { useId, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Input, Select } from "@/components/ui";
import { maskPhone } from "@/lib/onboarding";
import type { ContactEntry } from "@/lib/types";
import { copyText } from "@/lib/whatsapp";

const LABEL: Record<string, string> = {
  mobile: "celular",
  work: "trabalho",
  personal: "pessoal",
  home: "residencial",
};

const digits = (v: string) => v.replace(/\D/g, "");

/** Número nacional (DDD + número): sem o 0 do DDD antigo e sem o DDI 55 quando ele veio junto. */
function national(value: string): string {
  const d = digits(value).replace(/^0+/, "");
  return d.startsWith("55") && d.length > 11 ? d.slice(2) : d;
}

/** O mesmo telefone escrito de jeitos diferentes ("(11) 3333-4444" e "551133334444"). */
export function samePhone(a: string, b: string): boolean {
  return national(a) === national(b);
}

/** Link do WhatsApp para o número (o DDI 55 entra quando falta). */
export function whatsappLink(value: string): string {
  return `https://wa.me/55${national(value)}`;
}

/** Telefone legível: "(11) 99999-8888" ou "(11) 3333-4444"; outro formato (0800, internacional) fica como veio. */
export function formatPhone(value: string): string {
  if (/^0[3589]00/.test(digits(value))) return value;
  const d = national(value);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return value;
}

/**
 * Link para ligar. O número gravado com o DDI ("5511999998888") vai como internacional (+55...):
 * sem o "+", o celular e o softphone discam 5511... como se fosse um número local.
 */
function telLink(value: string): string {
  const d = digits(value);
  return d.startsWith("55") && (d.length === 12 || d.length === 13) ? `tel:+${d}` : `tel:${d}`;
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
        // Celular: 11 números com o DDD (o DDD 55, do RS, não é confundido com o DDI).
        const mobile = isPhone && (c.label === "mobile" || national(c.value).length === 11);
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
                  <a href={telLink(c.value)} className="rounded-md p-1.5 text-ink-subtle hover:bg-surface-2 hover:text-ink" aria-label={`Ligar ${shown}`} title="Ligar">
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
                  const copied = await copyText(shown);
                  toast(
                    copied
                      ? { title: "Contato copiado", description: shown, tone: "success" }
                      : { title: "Não foi possível copiar", description: "Selecione o contato e copie com Ctrl+C.", tone: "error" },
                  );
                }}
                className="rounded-md p-1.5 text-ink-subtle hover:bg-surface-2 hover:text-ink"
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

// --------------------------------------------------------------------------- edição dos contatos

/** Uma linha do editor de contatos, com o texto como está sendo digitado. */
export interface ContactDraft {
  id: string;
  kind: ContactEntry["kind"];
  value: string;
  name: string;
  label: string;
  primary: boolean;
}

let draftSeq = 0;
const draftId = () => `contato-${++draftSeq}`;

const LABEL_OPTIONS: [string, string][] = [
  ["", "Sem rótulo"],
  ["mobile", "Celular"],
  ["work", "Trabalho"],
  ["personal", "Pessoal"],
  ["home", "Residencial"],
];

/** Um principal por tipo: é dele que saem o e-mail e o telefone únicos do cadastro (a API deriva). */
function withPrimaries(list: ContactDraft[]): ContactDraft[] {
  const firstOf = (kind: ContactEntry["kind"]) => {
    const ofKind = list.filter((c) => c.kind === kind);
    return (ofKind.find((c) => c.primary) ?? ofKind[0])?.id;
  };
  const primaries = new Set([firstOf("phone"), firstOf("email")]);
  return list.map((c) => ({ ...c, primary: primaries.has(c.id) }));
}

/** Telefone com a máscara (00) 00000-0000; o internacional (+...) fica como foi digitado. */
function maskContactPhone(value: string): string {
  if (value.trim().startsWith("+")) return value;
  let d = digits(value);
  if (d.length > 11) d = d.replace(/^0+/, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  return maskPhone(d);
}

/** Linhas do editor a partir dos contatos gravados. */
export function contactDrafts(contacts: ContactEntry[] | null | undefined): ContactDraft[] {
  return withPrimaries(
    (contacts ?? []).map((c) => ({
      id: draftId(),
      kind: c.kind === "email" ? "email" : "phone",
      value: c.kind === "email" ? c.value : formatPhone(c.value),
      name: c.name ?? "",
      label: c.label ?? "",
      primary: Boolean(c.primary),
    })),
  );
}

/** O que vai para a API: só as linhas preenchidas (a API normaliza telefone e e-mail). */
export function contactsPayload(drafts: ContactDraft[]): ContactEntry[] {
  return withPrimaries(drafts.filter((d) => d.value.trim())).map((d) => ({
    kind: d.kind,
    value: d.value.trim(),
    name: d.name.trim() || null,
    label: d.label || null,
    primary: d.primary,
  }));
}

/** Mesmos contatos (para saber se a lista mudou e só então enviá-la). */
export function sameContacts(a: ContactDraft[], b: ContactDraft[]): boolean {
  return JSON.stringify(contactsPayload(a)) === JSON.stringify(contactsPayload(b));
}

/** O que está errado na linha (null quando está certa ou em branco). */
export function contactProblem(draft: ContactDraft): string | null {
  const value = draft.value.trim();
  if (!value) return null;
  if (draft.kind === "email") return /^[^\s@]+@[^\s@]+$/.test(value) ? null : "E-mail inválido";
  const count = digits(value).length;
  const enough = value.startsWith("+") ? count >= 8 : count >= 10;
  return enough ? null : "Telefone com DDD: pelo menos 10 números";
}

export const contactsInvalid = (drafts: ContactDraft[]) => drafts.some((d) => contactProblem(d) !== null);

/**
 * Edita a lista completa de contatos (telefones e e-mails com nome e rótulo) e marca o principal de
 * cada tipo. `showErrors` mostra os erros de todas as linhas (depois de tentar salvar).
 */
export function ContactsEditor({
  value,
  onChange,
  showErrors = false,
}: {
  value: ContactDraft[];
  onChange: (next: ContactDraft[]) => void;
  showErrors?: boolean;
}) {
  const group = useId();
  const [touched, setTouched] = useState<string[]>([]);
  const patch = (id: string, changes: Partial<ContactDraft>) =>
    onChange(value.map((c) => (c.id === id ? { ...c, ...changes } : c)));
  const setPrimary = (row: ContactDraft) =>
    onChange(value.map((c) => (c.kind === row.kind ? { ...c, primary: c.id === row.id } : c)));
  const add = (kind: ContactEntry["kind"]) =>
    onChange(withPrimaries([...value, { id: draftId(), kind, value: "", name: "", label: "", primary: false }]));
  const remove = (id: string) => onChange(withPrimaries(value.filter((c) => c.id !== id)));

  return (
    <div className="flex flex-col gap-2">
      {value.length ? (
        <ul className="flex flex-col gap-2">
          {value.map((c) => {
            const phone = c.kind === "phone";
            const what = `${phone ? "Telefone" : "E-mail"} ${value.filter((x) => x.kind === c.kind).indexOf(c) + 1}`;
            const problem = showErrors || touched.includes(c.id) ? contactProblem(c) : null;
            const Icon = phone ? Phone : Mail;
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2/40 p-2">
                <Icon className="size-4 shrink-0 text-ink-subtle" aria-hidden />
                <Input
                  value={c.value}
                  onChange={(e) => patch(c.id, { value: phone ? maskContactPhone(e.target.value) : e.target.value })}
                  onBlur={() => setTouched((t) => (t.includes(c.id) ? t : [...t, c.id]))}
                  type={phone ? "tel" : "email"}
                  inputMode={phone ? "tel" : "email"}
                  placeholder={phone ? "(11) 99999-0000" : "nome@empresa.com.br"}
                  maxLength={phone ? 40 : 255}
                  aria-label={what}
                  aria-invalid={problem ? true : undefined}
                  className="w-auto min-w-0 flex-[1.4_1_11rem]"
                />
                <Input
                  value={c.name}
                  onChange={(e) => patch(c.id, { name: e.target.value })}
                  placeholder="Nome (opcional)"
                  maxLength={160}
                  aria-label={`Nome do contato (${what})`}
                  className="w-auto min-w-0 flex-[1_1_8rem]"
                />
                <Select
                  value={c.label}
                  onChange={(e) => patch(c.id, { label: e.target.value })}
                  aria-label={`Rótulo (${what})`}
                  className="w-36"
                >
                  {LABEL_OPTIONS.map(([v, text]) => (
                    <option key={v} value={v}>
                      {text}
                    </option>
                  ))}
                  {c.label && !LABEL_OPTIONS.some(([v]) => v === c.label) ? <option value={c.label}>{c.label}</option> : null}
                </Select>
                <label className="inline-flex cursor-pointer items-center gap-1.5 px-1 text-xs font-medium text-ink-muted select-none">
                  <input
                    type="radio"
                    name={`${group}-${c.kind}`}
                    checked={c.primary}
                    onChange={() => setPrimary(c)}
                    className="size-3.5 accent-[var(--brand)]"
                  />
                  Principal
                </label>
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  className="ml-auto rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
                  aria-label={`Remover ${what}`}
                  title="Remover"
                >
                  <X className="size-4" />
                </button>
                {problem ? (
                  <p className="basis-full pl-6 text-xs font-medium text-red-600 dark:text-red-400" role="alert">
                    {problem}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-ink-subtle">Nenhum contato cadastrado.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => add("phone")}>
          <Plus className="size-3.5" />
          Telefone
        </Button>
        <Button size="sm" onClick={() => add("email")}>
          <Plus className="size-3.5" />
          E-mail
        </Button>
      </div>
    </div>
  );
}
