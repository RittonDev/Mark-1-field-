"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Copy, Mail, MessageCircle, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { Button, buttonClassName, Checkbox, Dialog, ErrorBox, Field, Input, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { isInternalUrl, maskPhone, shareableInviteUrl } from "@/lib/onboarding";
import type { OnboardingInvite } from "@/lib/types";
import { copyText, whatsappUrl } from "@/lib/whatsapp";
import { useCopy } from "./useCopy";

/** Dados de um link já gerado, para gerar outro igual (mesma identificação e mesmo tipo). */
export interface InvitePreset {
  label: string | null;
  reusable: boolean;
  /** Reutilizável com limite de fichas (vazio: até expirar). */
  maxUses?: number | null;
}

// Limite de fichas de um link reutilizável (o mesmo da API).
const MAX_USES_LIMIT = 5000;

/**
 * Gera o link de cadastro (homologação) e já deixa pronto para mandar pelo WhatsApp ou e-mail. Os
 * parceiros chegam pelo WhatsApp: com o celular, a conversa abre direto na pessoa.
 */
export function InviteDialog({ onClose, preset }: { onClose: () => void; preset?: InvitePreset }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(preset?.label ?? "");
  const [phone, setPhone] = useState("");
  const [reusable, setReusable] = useState(preset?.reusable ?? false);
  const [maxUses, setMaxUses] = useState(preset?.reusable && preset.maxUses ? String(preset.maxUses) : "");
  const [days, setDays] = useState("7");
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<OnboardingInvite>("/onboarding/invites", {
        label: label.trim() || null,
        reusable,
        days_valid: Number(days),
        max_uses: reusable && maxUses ? Number(maxUses) : null,
      }),
    onSuccess: async (invite) => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding", "invites"] });
      // Já vai para a área de transferência: a pessoa só precisa colar na conversa.
      const link = shareableInviteUrl(invite);
      if (link && (await copyText(link))) setCopied(true);
    },
  });
  const created = create.data;
  const url = created ? shareableInviteUrl(created) : null;
  // Endereço da rede interna (localhost, IP do escritório): o técnico no 4G não consegue abrir.
  const internal = !!url && isInternalUrl(url);
  const submit = () => {
    const limit = maxUses.trim();
    if (reusable && limit && !(Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= MAX_USES_LIMIT)) {
      setProblem(`Limite de fichas: use um número de 1 a ${MAX_USES_LIMIT.toLocaleString("pt-BR")} (ou deixe em branco).`);
      return;
    }
    setProblem(null);
    if (!create.isPending) create.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={create.isPending}
      title={url ? "Link de cadastro gerado" : "Convidar técnico"}
      description={
        url
          ? copied
            ? "Link copiado: é só colar na conversa. Enquanto estiver ativo, ele também fica em Homologação › Links de cadastro."
            : "Envie pelo WhatsApp ou por e-mail. Enquanto estiver ativo, ele também fica em Homologação › Links de cadastro."
          : "O técnico abre o link no celular, preenche a ficha e ela chega na Homologação para análise."
      }
      footer={
        url ? (
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" type="submit" form="invite-form" loading={create.isPending}>
              Gerar link
            </Button>
          </>
        )
      }
    >
      {internal ? <InternalLinkNotice className="mb-4" /> : null}
      {created && url ? (
        <InviteLinkPanel
          url={url}
          phone={phone}
          copied={copied}
          onCopied={() => setCopied(true)}
          note={`${validityText(created)}. A ficha enviada aparece na Homologação.`}
        />
      ) : (
        <form
          id="invite-form"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label="Para quem" hint="Para achar o link na lista. Ex.: nome do técnico ou da região.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={160} autoFocus />
          </Field>
          <Field label="Celular (opcional)" hint="Com o número, o WhatsApp abre direto na conversa dele. O número não fica salvo.">
            <Input
              value={phone}
              onChange={(e) => setPhone(maskPhone(e.target.value))}
              inputMode="tel"
              autoComplete="off"
              placeholder="(11) 90000-0000"
            />
          </Field>
          <Field label="Validade">
            <Select value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="3">3 dias</option>
              <option value="7">7 dias</option>
              <option value="15">15 dias</option>
              <option value="30">30 dias</option>
              <option value="90">90 dias</option>
            </Select>
          </Field>
          <Checkbox
            label="Reutilizável (várias pessoas podem usar o mesmo link, ex.: grupo de técnicos)"
            checked={reusable}
            onChange={setReusable}
          />
          {reusable ? (
            <Field
              label="Limite de fichas (opcional)"
              hint="Para um link que circula em grupo aberto: depois do limite, o link para de aceitar fichas."
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_USES_LIMIT}
                step={1}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder="Sem limite"
                className="w-40"
                aria-invalid={problem ? true : undefined}
              />
            </Field>
          ) : null}
          {problem || create.error ? <ErrorBox message={problem ?? errorMessage(create.error)} /> : null}
        </form>
      )}
    </Dialog>
  );
}

/** Para quantas fichas o link vale (lista de links). */
export function inviteUsesLabel(maxUses: number | null): string {
  if (maxUses == null) return "Reutilizável";
  return maxUses === 1 ? "Uso único" : `Reutilizável · até ${maxUses} fichas`;
}

/** "Vale para uma ficha até 20/11/2026 18:00". */
function validityText(invite: OnboardingInvite): string {
  const uses = !invite.max_uses
    ? "Vale para várias pessoas"
    : invite.max_uses === 1
      ? "Vale para uma ficha"
      : `Vale para até ${invite.max_uses} fichas`;
  return `${uses} até ${formatDateTime(invite.expires_at)}`;
}

/** Link de um convite ativo da lista, para copiar e enviar de novo (ex.: a outro grupo de técnicos). */
export function InviteShareDialog({ invite, onClose }: { invite: OnboardingInvite; onClose: () => void }) {
  const url = shareableInviteUrl(invite);
  const [phone, setPhone] = useState("");
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title={invite.label ? `Link de cadastro: ${invite.label}` : "Link de cadastro"}
      description={copied ? "Link copiado: é só colar na conversa." : "Copie e envie pelo WhatsApp ou por e-mail."}
      footer={
        <Button variant="primary" onClick={onClose}>
          Concluir
        </Button>
      }
    >
      {url && isInternalUrl(url) ? <InternalLinkNotice className="mb-4" /> : null}
      {url ? (
        <div className="flex flex-col gap-4">
          <Field label="Celular (opcional)" hint="Com o número, o WhatsApp abre direto na conversa dele. O número não fica salvo.">
            <Input
              value={phone}
              onChange={(e) => setPhone(maskPhone(e.target.value))}
              inputMode="tel"
              autoComplete="off"
              placeholder="(11) 90000-0000"
            />
          </Field>
          <InviteLinkPanel
            url={url}
            phone={phone}
            copied={copied}
            onCopied={() => setCopied(true)}
            note={`${validityText(invite)}. ${invite.use_count === 1 ? "1 ficha recebida" : `${invite.use_count} fichas recebidas`} por este link.`}
          />
        </div>
      ) : (
        <p className="text-sm text-ink-muted">
          Este link é de antes da cópia ficar disponível. Use “Gerar outro igual” para mandar um link novo.
        </p>
      )}
    </Dialog>
  );
}

/** Link pronto para mandar: copiar, WhatsApp (direto na conversa, com o celular) e e-mail. */
function InviteLinkPanel({
  url,
  phone,
  copied,
  onCopied,
  note,
}: {
  url: string;
  phone: string;
  copied: boolean;
  onCopied: () => void;
  note: string;
}) {
  const copy = useCopy();
  const codeRef = useRef<HTMLElement>(null);
  const message = `Olá! Para se cadastrar como técnico parceiro da Maxx Field, preencha a ficha neste link: ${url}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
        <code ref={codeRef} className="min-w-0 flex-1 truncate text-xs text-ink">
          {url}
        </code>
        <Button
          size="sm"
          onClick={async () => {
            if (await copy(url, { select: codeRef.current, title: "Link copiado" })) onCopied();
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copiado" : "Copiar"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={whatsappUrl(phone || null, message)} target="_blank" rel="noreferrer" className={buttonClassName()}>
          <MessageCircle className="size-4" />
          {phone ? "Enviar no WhatsApp dele" : "Enviar por WhatsApp"}
        </a>
        <a
          href={`mailto:?subject=${encodeURIComponent("Cadastro de técnico parceiro — Maxx Field")}&body=${encodeURIComponent(message)}`}
          className={buttonClassName()}
        >
          <Mail className="size-4" />
          Enviar por e-mail
        </a>
      </div>
      <p className="text-xs text-ink-muted">{note}</p>
    </div>
  );
}

/** Aviso do link que só abre na rede da empresa (a central aberta por localhost ou IP interno). */
export function InternalLinkNotice({ className }: { className?: string }) {
  return (
    <p
      className={clsx(
        "flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
        className,
      )}
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        Este link só abre dentro da rede da empresa: no 4G, o técnico não consegue abrir. Peça ao administrador para
        configurar o endereço público da central (WEB_URL na API ou NEXT_PUBLIC_WEB_URL na web) antes de enviar.
      </span>
    </p>
  );
}
