"use client";

import { useConfirm } from "@/components/Confirm";
import { Field, Input } from "@/components/ui";
import { isSendableEmail } from "@/lib/constants";
import { maskPhone } from "@/lib/onboarding";
import { useMailEnabled } from "@/lib/queries";
import type { Technician } from "@/lib/types";
import { fichaLabel } from "../FichaNav";
import { SectionCard, SectionForm } from "../SectionCard";
import { type SectionErrors, useSectionForm } from "../useSectionForm";
import { EmailState } from "./CredentialsSection";

interface ContactForm {
  phone: string;
  phoneSecondary: string;
  email: string;
}

const read = (t: Technician): ContactForm => ({
  phone: t.phone ?? "",
  phoneSecondary: t.phone_secondary ?? "",
  email: t.email,
});

const body = (v: ContactForm) => ({
  phone: v.phone.trim() || null,
  phone_secondary: v.phoneSecondary.trim() || null,
  email: v.email.trim().toLowerCase(),
});

const phoneDigits = (text: string) => text.replace(/\D/g, "").length;

function validate(v: ContactForm): SectionErrors {
  const errors: SectionErrors = {};
  const phone = phoneDigits(v.phone);
  if (phone && phone < 10) errors.phone = "Informe o celular com DDD.";
  const secondary = phoneDigits(v.phoneSecondary);
  if (secondary && secondary < 10) errors.phoneSecondary = "Informe o telefone com DDD.";
  if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) errors.email = "Informe um e-mail válido: é o login do técnico no app.";
  return errors;
}

/**
 * Contato: celular (WhatsApp), telefone secundário e o e-mail de login. Trocar o e-mail aqui troca o login na hora e
 * manda a validação para o e-mail novo (pergunta antes).
 */
export function ContactSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const label = fichaLabel("contato");
  const confirm = useConfirm();
  const mailEnabled = useMailEnabled();
  const form = useSectionForm({
    tech,
    label,
    read,
    body,
    validate,
    savedTitle: "Contato salvo",
    confirm: (changed) =>
      typeof changed.email !== "string"
        ? Promise.resolve(true)
        : confirm({
            title: "Trocar o e-mail de login?",
            // A validação só sai com o envio ligado e para um e-mail que recebe.
            description: `${tech.name} passa a entrar no app com ${changed.email}.${
              mailEnabled !== false && isSendableEmail(changed.email) ? " A validação vai para o e-mail novo." : ""
            }`,
            confirmLabel: "Trocar e-mail",
          }),
    savedDescription: (changed) => {
      if (typeof changed.email !== "string") return undefined;
      if (mailEnabled === false) return "Envio de e-mail desligado: avise pelo WhatsApp.";
      return mailEnabled && isSendableEmail(changed.email) ? `Validação enviada para ${changed.email}.` : undefined;
    },
  });
  const { value, set, errors } = form;

  return (
    <SectionCard title={label}>
      <SectionForm form={form} canEdit={canEdit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Celular (WhatsApp)" error={errors.phone}>
            <Input
              value={value.phone}
              onChange={(e) => set("phone", maskPhone(e.target.value))}
              inputMode="tel"
              placeholder="(11) 90000-0000"
              autoComplete="off"
              aria-invalid={errors.phone ? true : undefined}
            />
          </Field>
          <Field label="Telefone secundário" error={errors.phoneSecondary}>
            <Input
              value={value.phoneSecondary}
              onChange={(e) => set("phoneSecondary", maskPhone(e.target.value))}
              inputMode="tel"
              placeholder="(11) 90000-0000"
              autoComplete="off"
              aria-invalid={errors.phoneSecondary ? true : undefined}
            />
          </Field>
        </div>
        <div className="flex flex-col gap-1.5">
          <Field label="E-mail (login no app)" required error={errors.email}>
            <Input
              type="email"
              value={value.email}
              onChange={(e) => set("email", e.target.value)}
              maxLength={255}
              autoComplete="off"
              aria-invalid={errors.email ? true : undefined}
            />
          </Field>
          {/* A validação é do e-mail gravado (não do que está sendo digitado). */}
          <EmailState tech={tech} />
        </div>
      </SectionForm>
    </SectionCard>
  );
}
