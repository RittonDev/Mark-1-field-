"use client";

import { Check, Copy, MessageCircle } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, Textarea } from "@/components/ui";
import { PRIORITY } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { TicketDetail } from "@/lib/types";

/** Texto da OS para o grupo de WhatsApp dos técnicos (a comunicação com eles é por lá). */
export function ticketWhatsAppText(t: TicketDetail): string {
  const loc = t.location;
  const address = [t.service_address, loc?.address_line, loc?.city && `${loc.city}${loc.state ? `-${loc.state}` : ""}`]
    .filter(Boolean)
    .join(", ");
  const maps =
    loc?.latitude != null && loc?.longitude != null
      ? `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`
      : address
        ? `https://maps.google.com/?q=${encodeURIComponent(address)}`
        : null;
  const required = t.forms.filter((f) => f.required).map((f) => f.name);
  const lines = [
    `*${t.code} · ${t.title}*`,
    `Prioridade: ${PRIORITY[t.priority].code} ${PRIORITY[t.priority].label}`,
    t.customer ? `Cliente: ${t.customer.name}${loc ? ` · ${loc.name}` : ""}` : null,
    address ? `Endereço: ${address}` : null,
    maps ? `Mapa: ${maps}` : null,
    t.scheduled_start ? `Agendado: ${formatDateTime(t.scheduled_start)}` : null,
    t.assignee ? `Técnico: ${t.assignee.name}` : "Técnico: a definir",
    t.requester_name || t.requester_contact ? `Contato no local: ${[t.requester_name, t.requester_contact].filter(Boolean).join(" · ")}` : null,
    "",
    "*Escopo*",
    t.description || "(sem descrição)",
    required.length ? `\nFormulário obrigatório no app: ${required.join(", ")}` : null,
    t.signature_required ? "Colher assinatura do responsável no local ao finalizar." : null,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export function WhatsAppShare({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const [text, setText] = useState(() => ticketWhatsAppText(ticket));
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="Enviar para o grupo do WhatsApp"
      description="Confira o texto. Ao abrir o WhatsApp, escolha o grupo dos técnicos."
      footer={
        <>
          <Button
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            }}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copiado" : "Copiar texto"}
          </Button>
          <a href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
            <Button variant="primary">
              <MessageCircle className="size-4" />
              Abrir WhatsApp
            </Button>
          </a>
        </>
      }
    >
      <Textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" />
    </Dialog>
  );
}
