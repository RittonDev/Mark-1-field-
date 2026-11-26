"use client";

import { useRef } from "react";
import { CepField } from "@/components/CepField";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { CEP_TEXT, PROFILE_LIMITS, sameStreet } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { maskCep, UFS } from "@/lib/onboarding";
import { addressAfterCep, addressNumberText, isLegacyDetail } from "@/lib/technicians";
import type { Technician } from "@/lib/types";
import { fichaLabel } from "../FichaNav";
import { LegacyNote, SectionCard, SectionForm } from "../SectionCard";
import { type SectionErrors, useSectionForm } from "../useSectionForm";

interface AddressForm {
  zip: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  coverage: string;
}

const read = (t: Technician): AddressForm => ({
  zip: maskCep(t.address_zip ?? ""),
  street: t.address_line ?? "",
  number: t.address_number ?? "",
  complement: t.address_complement ?? "",
  district: t.address_district ?? "",
  city: t.home_city ?? "",
  state: t.home_state ?? "",
  coverage: t.coverage_area ?? "",
});

const zipDigits = (text: string) => text.replace(/\D/g, "");

const body = (v: AddressForm) => ({
  address_zip: zipDigits(v.zip) || null,
  address_line: v.street.trim() || null,
  // Como a API grava: em maiúsculas, com "S/N" (o mesmo número escrito de outro jeito não conta como mudança).
  address_number: addressNumberText(v.number) || null,
  address_complement: v.complement.trim() || null,
  address_district: v.district.trim() || null,
  home_city: v.city.trim() || null,
  home_state: v.state || null,
  coverage_area: v.coverage.trim() || null,
});

function validate(v: AddressForm): SectionErrors {
  const zip = zipDigits(v.zip);
  return zip && zip.length !== 8 ? { zip: CEP_TEXT.invalid } : {};
}

/** "Santos-SP". */
const regionText = (city: string | null | undefined, state: string | null | undefined) => [city, state].filter(Boolean).join("-");

/**
 * Endereço em partes, com o CEP que preenche logradouro, bairro, cidade e UF (o digitado fica; diferente, "Usar este
 * endereço"), e a região que atende. Abaixo, só leitura, a região de atuação calculada (histórico de OS ou endereço).
 * Com a API de antes (até a publicação), só leitura: o Logradouro ainda é a linha inteira, e salvar só a rua apagaria o
 * número e o complemento gravados nela (a API antiga descarta os campos novos).
 */
export function AddressSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const label = fichaLabel("endereco");
  const legacy = isLegacyDetail(tech);
  const form = useSectionForm({ tech, label, read, body, validate, savedTitle: "Endereço salvo" });
  const { value, base, set, patch, errors } = form;
  // O CEP achado leva o foco ao Número (CEP geral, sem logradouro: ao Logradouro).
  const numberRef = useRef<HTMLInputElement>(null);
  const streetRef = useRef<HTMLInputElement>(null);
  const states = UFS.includes(value.state) || !value.state ? UFS : [value.state, ...UFS];

  return (
    <SectionCard title={label}>
      {legacy ? <LegacyNote /> : null}
      {/* Com a API de antes, o fieldset travado trava também o CEP (sem digitar, ele não busca). */}
      <SectionForm form={form} canEdit={canEdit && !legacy}>
        <CepField
          label="CEP"
          className="sm:max-w-xs"
          value={value.zip}
          onChange={(masked) => set("zip", masked)}
          mode="parts"
          address={{ street: value.street, district: value.district, city: value.city, state: value.state }}
          // O endereço gravado: campo igual a ele é livre para o CEP.
          opened={{ street: base.street, district: base.district, city: base.city, state: base.state }}
          // Outro logradouro de fato (a mesma rua com outra grafia não conta): número e complemento que não foram
          // digitados agora (os gravados) saem.
          onApply={(next) =>
            // Outra rua de fato (sameStreet: outra grafia não conta; o CEP geral que esvazia a rua também não).
            patch(addressAfterCep(value, base, next, !!next.street.trim() && !sameStreet(next.street, value.street)))
          }
          focusRef={numberRef}
          streetRef={streetRef}
          error={errors.zip}
        />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_12rem]">
          <Field label="Logradouro">
            <Input
              ref={streetRef}
              value={value.street}
              onChange={(e) => set("street", e.target.value)}
              maxLength={255}
              autoComplete="off"
            />
          </Field>
          <Field label="Número">
            <Input
              ref={numberRef}
              value={value.number}
              onChange={(e) => set("number", e.target.value.toUpperCase())}
              maxLength={PROFILE_LIMITS.addressNumber}
              autoComplete="off"
              autoCapitalize="characters"
            />
          </Field>
          <Field label="Complemento">
            <Input
              value={value.complement}
              onChange={(e) => set("complement", e.target.value)}
              maxLength={PROFILE_LIMITS.addressComplement}
              autoComplete="off"
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem]">
          <Field label="Bairro">
            <Input value={value.district} onChange={(e) => set("district", e.target.value)} maxLength={120} autoComplete="off" />
          </Field>
          <Field label="Cidade">
            <Input value={value.city} onChange={(e) => set("city", e.target.value)} maxLength={120} autoComplete="off" />
          </Field>
          <Field label="UF">
            <Select value={value.state} onChange={(e) => set("state", e.target.value)}>
              <option value="">—</option>
              {states.map((uf) => (
                <option key={uf} value={uf}>
                  {uf}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Região que atende">
          <Textarea rows={2} value={value.coverage} onChange={(e) => set("coverage", e.target.value)} maxLength={1000} />
        </Field>
      </SectionForm>
      <p className="text-xs text-ink-muted">
        {tech.base_city
          ? `Região de atuação: ${regionText(tech.base_city, tech.base_state)} ${
              tech.base_source === "history" ? `(pelo histórico, ${tech.base_visits ?? 0} OS)` : "(pelo endereço)"
            }`
          : "Região de atuação ainda não identificada"}
        {tech.last_visit_at ? ` · última visita ${formatDate(tech.last_visit_at)}` : ""}
      </p>
    </SectionCard>
  );
}
