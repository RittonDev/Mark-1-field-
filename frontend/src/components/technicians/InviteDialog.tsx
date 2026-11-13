"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Mail, MessageCircle, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { Button, buttonClassName, Checkbox, Dialog, ErrorBox, Field, Input, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { inviteUrl, isInternalUrl, maskPhone } from "@/lib/onboarding";
import type { OnboardingInvite } from "@/lib/types";
import { copyText, whatsappUrl } from "@/lib/whatsapp";
import { useCopy } from "./useCopy";

/** Dados de um link já gerado, para gerar outro igual (o link completo só aparece uma vez). */
export interface InvitePreset {
  label: string | null;
  reusable: boolean;
}

/**
 * Gera o link de cadastro (homologação) e já deixa pronto para mandar pelo WhatsApp ou e-mail. Os
 * parceiros chegam pelo WhatsApp: com o celular, a conversa abre direto na pessoa.
 */
export function InviteDialog({ onClose, preset }: { onClose: () => void; preset?: InvitePreset }) {
  const queryClient = useQueryClient();
  const copy = useCopy();
  const codeRef = useRef<HTMLElement>(null);
  const [label, setLabel] = useState(preset?.label ?? "");
  const [phone, setPhone] = useState("");
  const [reusable, setReusable] = useState(preset?.reusable ?? false);
  const [days, setDays] = useState("7");
  const [copied, setCopied] = useState(false);
  // O endereço do link é o desta tela (ou NEXT_PUBLIC_WEB_URL): aberto pela rede interna, o link não abre no 4G.
  const internal = isInternalUrl(inviteUrl(""));
  const create = useMutation({
    mutationFn: () =>
      api.post<OnboardingInvite>("/onboarding/invites", {
        label: label.trim() || null,
        reusable,
        days_valid: Number(days),
      }),
    onSuccess: async (invite) => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding", "invites"] });
      // O link completo só aparece agora: já vai para a área de transferência.
      if (invite.token && (await copyText(inviteUrl(invite.token)))) setCopied(true);
    },
  });
  const url = create.data?.token ? inviteUrl(create.data.token) : null;
  const message = url
    ? `Olá! Para se cadastrar como técnico parceiro da Maxx Field, preencha a ficha neste link: ${url}`
    : "";

  return (
    <Dialog
      open
      onClose={onClose}
      title={url ? "Link de cadastro gerado" : "Convidar técnico"}
      description={
        url
          ? copied
            ? "O link já foi copiado. Envie agora: ele só aparece nesta tela."
            : "Envie agora: o link completo só aparece nesta tela."
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
      {internal ? (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Este endereço só abre dentro da rede da empresa. Peça ao administrador para configurar o endereço público
            (NEXT_PUBLIC_WEB_URL) antes de enviar.
          </span>
        </p>
      ) : null}
      {url ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
            <code ref={codeRef} className="min-w-0 flex-1 truncate text-xs text-ink">
              {url}
            </code>
            <Button
              size="sm"
              onClick={async () => {
                if (await copy(url, { select: codeRef.current, title: "Link copiado" })) setCopied(true);
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
          <p className="text-xs text-ink-muted">
            {reusable ? "Vale para várias pessoas" : "Vale para uma ficha"} até{" "}
            {create.data ? formatDateTime(create.data.expires_at) : ""}. A ficha enviada aparece na Homologação.
          </p>
        </div>
      ) : (
        <form
          id="invite-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!create.isPending) create.mutate();
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
          {create.error ? <ErrorBox message={errorMessage(create.error)} /> : null}
        </form>
      )}
    </Dialog>
  );
}
