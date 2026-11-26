"use client";

import { Field, Input, Select } from "@/components/ui";
import { ageAt, BIRTH_AGE, isValidRg, normalizeIssuer, normalizeRg, PROFILE_LIMITS, splitIssuer } from "@/lib/constants";
import { todayISO } from "@/lib/format";
import { isValidCpf, maskCpf, UFS } from "@/lib/onboarding";
import { isLegacyDetail, rgIssuerFields } from "@/lib/technicians";
import type { Technician } from "@/lib/types";
import { fichaLabel } from "../FichaNav";
import { LegacyNote, SectionCard, SectionForm } from "../SectionCard";
import { type SectionErrors, useSectionForm } from "../useSectionForm";

interface PersonalForm {
  name: string;
  cpf: string;
  rgNumber: string;
  rgIssuer: string;
  rgState: string;
  birth: string;
}

const read = (t: Technician): PersonalForm => ({
  name: t.name,
  cpf: maskCpf(t.cpf ?? ""),
  rgNumber: t.rg_number ?? "",
  rgIssuer: t.rg_issuer ?? "",
  rgState: t.rg_state ?? "",
  birth: t.birth_date ?? "",
});

const digits = (text: string) => text.replace(/\D/g, "");

/** O órgão emissor e a UF como vão para a API: "SSP/SP" separa em "SSP" e "SP" (a UF do campo, se houver, vale). */
const rgOf = (v: PersonalForm) => rgIssuerFields(splitIssuer(v.rgIssuer), v.rgState);

const body = (v: PersonalForm) => {
  const { rg_issuer, rg_state } = rgOf(v);
  return {
    name: v.name.trim(),
    cpf: digits(v.cpf) || null,
    rg_number: normalizeRg(v.rgNumber).trim() || null,
    rg_issuer,
    rg_state,
    birth_date: v.birth || null,
  };
};

/** As regras da API (schemas/personal.py), com o ponto final das telas. */
function validate(v: PersonalForm): SectionErrors {
  const errors: SectionErrors = {};
  if (v.name.trim().length < 3) errors.name = "Informe o nome do técnico (pelo menos 3 letras).";
  const cpf = digits(v.cpf);
  if (cpf && !isValidCpf(cpf)) errors.cpf = "CPF inválido.";
  const rg = normalizeRg(v.rgNumber).trim();
  const { rg_issuer: issuer, rg_state: state } = rgOf(v);
  if (rg && !isValidRg(rg)) errors.rgNumber = "Confira o número do RG.";
  if (issuer && (issuer.length < 2 || issuer.length > PROFILE_LIMITS.rgIssuer)) errors.rgIssuer = "Confira o órgão emissor.";
  // O RG vai com os três ou nenhum (para tirar, apague os três); a UF pode vir no fim do órgão ("SSP/SP").
  if ((rg || issuer || state) && !(rg && issuer && state)) {
    errors.rg = "Informe o número, o órgão emissor e a UF do RG.";
  }
  if (v.birth) {
    const age = ageAt(v.birth, todayISO());
    if (age === null || age < 0 || age > BIRTH_AGE.max) errors.birth = "Confira a data de nascimento.";
    else if (age < BIRTH_AGE.min) errors.birth = "O cadastro é para maiores de 18 anos: confira a data de nascimento.";
  }
  return errors;
}

/**
 * Dados pessoais: nome, CPF (a central muda e limpa; único), RG com órgão e UF, nascimento. Com a API de antes (até a
 * publicação), só o nome muda: CPF, RG e nascimento ficam travados (ela os descartaria calada).
 */
export function PersonalDataSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const label = fichaLabel("dados-pessoais");
  const legacy = isLegacyDetail(tech);
  const form = useSectionForm({ tech, label, read, body, validate, savedTitle: "Dados pessoais salvos" });
  const { value, set, errors } = form;
  // Campo do RG que falta quando o grupo está incompleto (a UF que veio no fim do órgão conta).
  const rgMissing = (filled: string) => Boolean(errors.rg) && !filled.trim();
  const rgState = rgOf(value).rg_state ?? "";

  return (
    <SectionCard title={label}>
      <SectionForm form={form} canEdit={canEdit}>
        <Field label="Nome completo" required error={errors.name}>
          <Input
            value={value.name}
            onChange={(e) => set("name", e.target.value)}
            maxLength={160}
            autoComplete="off"
            aria-invalid={errors.name ? true : undefined}
          />
        </Field>
        {/* Os campos novos: com a API de antes, travados (o nome acima continua editável). */}
        <fieldset disabled={legacy} className="flex min-w-0 flex-col gap-4">
          {legacy ? <LegacyNote>CPF, RG e nascimento: indisponível no momento.</LegacyNote> : null}
          <Field label="CPF" error={errors.cpf} className="sm:max-w-xs">
            <Input
              value={value.cpf}
              onChange={(e) => set("cpf", maskCpf(e.target.value))}
              inputMode="numeric"
              placeholder="000.000.000-00"
              autoComplete="off"
              aria-invalid={errors.cpf ? true : undefined}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_6rem]">
              <Field label="RG" error={errors.rgNumber}>
                <Input
                  value={value.rgNumber}
                  onChange={(e) => set("rgNumber", normalizeRg(e.target.value))}
                  maxLength={PROFILE_LIMITS.rgNumber}
                  autoComplete="off"
                  autoCapitalize="characters"
                  aria-invalid={errors.rgNumber || rgMissing(value.rgNumber) ? true : undefined}
                />
              </Field>
              {/* Aceita "SSP/SP": ao salvar, o órgão e a UF vão separados (a UF entra no campo dela se estiver vazio). */}
              <Field label="Órgão emissor" error={errors.rgIssuer}>
                <Input
                  value={value.rgIssuer}
                  onChange={(e) => set("rgIssuer", normalizeIssuer(e.target.value))}
                  maxLength={PROFILE_LIMITS.rgIssuer}
                  autoComplete="off"
                  autoCapitalize="characters"
                  aria-invalid={errors.rgIssuer || rgMissing(value.rgIssuer) ? true : undefined}
                />
              </Field>
              <Field label="UF do RG">
                <Select
                  value={value.rgState}
                  onChange={(e) => set("rgState", e.target.value)}
                  aria-invalid={rgMissing(rgState) ? true : undefined}
                >
                  <option value="">—</option>
                  {(UFS.includes(value.rgState) || !value.rgState ? UFS : [value.rgState, ...UFS]).map((uf) => (
                    <option key={uf} value={uf}>
                      {uf}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {errors.rg ? (
              <span role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
                {errors.rg}
              </span>
            ) : null}
          </div>
          <Field label="Data de nascimento" hint="É preciso ter 18 anos ou mais." error={errors.birth} className="sm:max-w-xs">
            <Input
              type="date"
              value={value.birth}
              onChange={(e) => set("birth", e.target.value)}
              max={todayISO()}
              aria-invalid={errors.birth ? true : undefined}
            />
          </Field>
        </fieldset>
      </SectionForm>
    </SectionCard>
  );
}
