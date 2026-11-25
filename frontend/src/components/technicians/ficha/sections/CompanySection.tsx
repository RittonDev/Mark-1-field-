"use client";

import { Field, Input } from "@/components/ui";
import { PROFILE_LIMITS } from "@/lib/constants";
import { isValidCnpj, maskCnpj } from "@/lib/onboarding";
import type { Technician } from "@/lib/types";
import { fichaLabel } from "../FichaNav";
import { SectionCard, SectionForm } from "../SectionCard";
import { type SectionErrors, useSectionForm } from "../useSectionForm";

interface CompanyForm {
  document: string;
  name: string;
  tradeName: string;
}

/** CNPJ como a API guarda: sem pontuação e em maiúsculas (aceita o alfanumérico). */
const cleanCnpj = (text: string) => text.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

const read = (t: Technician): CompanyForm => ({
  document: maskCnpj(t.company_document ?? ""),
  name: t.company_name ?? "",
  tradeName: t.company_trade_name ?? "",
});

const body = (v: CompanyForm) => ({
  company_document: cleanCnpj(v.document) || null,
  company_name: v.name.trim() || null,
  company_trade_name: v.tradeName.trim() || null,
});

function validate(v: CompanyForm): SectionErrors {
  const cnpj = cleanCnpj(v.document);
  if (cnpj) return isValidCnpj(cnpj) ? {} : { document: "CNPJ inválido." };
  // Razão social e nome fantasia vão com o CNPJ.
  return v.name.trim() || v.tradeName.trim() ? { document: "Informe o CNPJ." } : {};
}

/** Dados empresariais (opcionais): CNPJ ou MEI, razão social e nome fantasia. A central muda sem pedir senha. */
export function CompanySection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const label = fichaLabel("dados-empresariais");
  const form = useSectionForm({ tech, label, read, body, validate, savedTitle: "Dados empresariais salvos" });
  const { value, set, errors } = form;

  return (
    <SectionCard title={label}>
      <SectionForm form={form} canEdit={canEdit}>
        <Field label="CNPJ" error={errors.document} className="sm:max-w-xs">
          <Input
            value={value.document}
            onChange={(e) => set("document", maskCnpj(e.target.value))}
            placeholder="00.000.000/0000-00"
            autoComplete="off"
            autoCapitalize="characters"
            aria-invalid={errors.document ? true : undefined}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Razão social">
            <Input value={value.name} onChange={(e) => set("name", e.target.value)} maxLength={PROFILE_LIMITS.companyName} autoComplete="off" />
          </Field>
          <Field label="Nome fantasia">
            <Input
              value={value.tradeName}
              onChange={(e) => set("tradeName", e.target.value)}
              maxLength={PROFILE_LIMITS.companyName}
              autoComplete="off"
            />
          </Field>
        </div>
      </SectionForm>
    </SectionCard>
  );
}
