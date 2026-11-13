"use client";

import { Check, Copy, MessageCircle } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Dialog, SectionTitle, Textarea } from "@/components/ui";
import { PRIORITY } from "@/lib/constants";
import { dayKey, formatDateTime, formatTime } from "@/lib/format";
import type { TicketDetail } from "@/lib/types";
import { copyText, whatsappUrl } from "@/lib/whatsapp";
import { LongTextNote, MessageList, TemplatesLink } from "./MessagesPanel";

/** Onde é o atendimento: o endereço da OS, quando informado; senão, o da loja. */
function serviceAddress(t: TicketDetail): string {
  if (t.service_address?.trim()) return t.service_address.trim();
  const loc = t.location;
  const city = loc?.city ? `${loc.city}${loc.state ? `-${loc.state}` : ""}` : null;
  return [loc?.address_line, city].filter(Boolean).join(", ");
}

/** Mapa do atendimento: endereço da OS (outro lugar que não a loja) por busca; a loja pelas coordenadas. */
function mapsUrl(t: TicketDetail, address: string): string | null {
  const loc = t.location;
  if (!t.service_address?.trim() && loc?.latitude != null && loc?.longitude != null) {
    return `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
  }
  return address ? `https://maps.google.com/?q=${encodeURIComponent(address)}` : null;
}

/** "13/11/2026 10:00 às 12:00" (ou com a data do fim, quando a visita vira o dia). */
function schedule(t: TicketDetail): string | null {
  if (!t.scheduled_start) return null;
  const start = formatDateTime(t.scheduled_start);
  if (!t.scheduled_end) return start;
  const sameDay = dayKey(t.scheduled_start) === dayKey(t.scheduled_end);
  return `${start} às ${sameDay ? formatTime(t.scheduled_end) : formatDateTime(t.scheduled_end)}`;
}

/**
 * Resumo da OS para o grupo de WhatsApp dos técnicos (a comunicação com eles é por lá). Leva só o que o
 * técnico precisa para ir: cliente, endereço e mapa, horário, escopo e o recado da visita. O contato da
 * loja fica de fora (quem fala com a loja é a central), como no app do técnico.
 */
export function ticketWhatsAppText(t: TicketDetail): string {
  const loc = t.location;
  const address = serviceAddress(t);
  const maps = mapsUrl(t, address);
  const when = schedule(t);
  const required = t.forms.filter((f) => f.required).map((f) => f.name);
  const lines = [
    `*${t.code} · ${t.title}*`,
    `Prioridade: ${PRIORITY[t.priority].code} ${PRIORITY[t.priority].label}`,
    t.service_type ? `Tipo: ${t.service_type.name}` : null,
    t.customer ? `Cliente: ${t.customer.name}${loc ? ` · ${loc.name}` : ""}` : loc ? `Local: ${loc.name}` : null,
    address ? `Endereço: ${address}` : null,
    maps ? `Mapa: ${maps}` : null,
    when ? `Agendado: ${when}` : null,
    t.assignee ? `Técnico: ${t.assignee.name}` : "Técnico: a definir",
    "",
    "*Escopo*",
    t.description?.trim() || "(sem descrição)",
    t.visit_note?.trim() ? `\n*Observação da visita*\n${t.visit_note.trim()}` : null,
    required.length ? `\nFormulário obrigatório no app: ${required.join(", ")}` : null,
    t.signature_required ? "Colher a assinatura do responsável no local ao finalizar (depois dos formulários)." : null,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

/** WhatsApp da OS: os textos prontos (modelos de /textos) e o resumo da OS para o grupo dos técnicos. */
export function WhatsAppShare({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const { toast } = useToast();
  const summaryId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => ticketWhatsAppText(ticket));
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      toast({ title: "Resumo da OS copiado", description: "Cole no grupo dos técnicos.", tone: "success" });
      window.setTimeout(() => setCopied(false), 2000);
      return;
    }
    toast({ title: "Não foi possível copiar", description: "Selecione o texto e copie com Ctrl+C.", tone: "error" });
    field.current?.select();
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="WhatsApp da OS"
      description={`${ticket.code} · ${ticket.title}`}
      footer={
        <>
          <Button onClick={copy}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copiado" : "Copiar resumo"}
          </Button>
          <a href={whatsappUrl(null, text)} target="_blank" rel="noreferrer" className={buttonClassName("primary")}>
            <MessageCircle className="size-4" />
            Abrir no WhatsApp
          </a>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <SectionTitle aside={<TemplatesLink />}>Textos prontos</SectionTitle>
          <p className="text-xs text-ink-muted">Avisos do dia a dia já preenchidos com os dados da OS: clique para copiar e cole no grupo.</p>
          <MessageList ticketId={ticket.id} />
        </section>
        <section className="flex flex-col gap-2">
          <SectionTitle>
            <label htmlFor={summaryId}>Resumo da OS para o grupo</label>
          </SectionTitle>
          <p className="text-xs text-ink-muted">Confira e ajuste o texto. Ao abrir o WhatsApp, escolha o grupo dos técnicos.</p>
          <Textarea
            id={summaryId}
            ref={field}
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="text-sm leading-relaxed"
          />
          <LongTextNote text={text} />
        </section>
      </div>
    </Dialog>
  );
}
