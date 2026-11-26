"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import Image from "next/image";
import { useId, useRef, useState } from "react";
import { CepField } from "@/components/CepField";
import { FieldError, useLeaveGuard } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, ErrorBox, Field, Input, LoadingBlock } from "@/components/ui";
import { cepFromLine, cepIncomplete, companyCepAfterEdit, companyLineToSave } from "@/lib/address";
import { api, errorMessage } from "@/lib/api";
import { CEP_TEXT } from "@/lib/constants";
import { formatDocument } from "@/lib/format";
import type { CompanyProfile } from "@/lib/types";

// Dígitos verificadores do CNPJ, inclusive o alfanumérico (a mesma conta de
// backend/app/core/documents.py: valor ASCII - 48 de cada caractere).
const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, ...CNPJ_W1];

function cnpjDigit(chars: string, weights: number[]): number {
  const total = weights.reduce((sum, w, i) => sum + (chars.charCodeAt(i) - 48) * w, 0);
  const rest = total % 11;
  return rest < 2 ? 0 : 11 - rest;
}

function isValidCnpj(value: string): boolean {
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(value) || new Set(value).size === 1) return false;
  const first = cnpjDigit(value, CNPJ_W1);
  const second = cnpjDigit(`${value.slice(0, 12)}${first}`, CNPJ_W2);
  return value.endsWith(`${first}${second}`);
}

/** CNPJ como a API guarda: sem pontuação e em maiúsculas. */
const cleanDocument = (v: string) => v.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

/** O endereço numa linha (o mesmo limite da API). */
const ADDRESS_MAX = 300;

/** Dados da empresa: aparecem no cabeçalho do orçamento e do relatório que o cliente recebe. */
export function CompanyProfileCard({ readOnly = false }: { readOnly?: boolean }) {
  const profile = useQuery({
    queryKey: ["settings", "company"],
    queryFn: () => api.get<CompanyProfile>("/settings/company"),
    // Voltar para a aba no meio da edição não relê: outra versão salva recriaria o formulário e apagaria o digitado.
    refetchOnWindowFocus: false,
  });
  return (
    <Card>
      <CardHeader
        title="Dados da empresa"
        description="Aparecem no cabeçalho do orçamento e do relatório de atendimento enviados ao cliente."
      />
      {profile.isLoading ? (
        <LoadingBlock rows={2} />
      ) : profile.error ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <ErrorBox message={errorMessage(profile.error)} />
          <Button size="sm" loading={profile.isFetching} onClick={() => profile.refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : profile.data ? (
        <ProfileForm key={JSON.stringify(profile.data)} initial={profile.data} readOnly={readOnly} />
      ) : null}
    </Card>
  );
}

function ProfileForm({ initial, readOnly }: { initial: CompanyProfile; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const documentErrorId = useId();
  const [start] = useState(() => ({
    name: initial.name ?? "",
    // Guardado sem pontuação; na tela, formatado.
    document: initial.document ? formatDocument(initial.document) : "",
    email: initial.email ?? "",
    phone: initial.phone ?? "",
    address: initial.address ?? "",
    website: initial.website ?? "",
  }));
  const [form, setForm] = useState(start);
  // O CEP não é gravado à parte: ajuda a montar a linha do endereço (e vai para o fim dela). Começa com o que está nela e
  // acompanha o CEP que a pessoa escreve na própria linha.
  const [cep, setCep] = useState(() => cepFromLine(start.address));
  // "CEP inválido" aparece depois de sair do campo ou de tentar salvar.
  const [cepTouched, setCepTouched] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const [showDocumentError, setShowDocumentError] = useState(false);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const cnpj = cleanDocument(form.document);
  const documentValid = !cnpj || isValidCnpj(cnpj);
  const documentProblem = documentValid ? undefined : "CNPJ inválido: confira os 14 caracteres e os dígitos verificadores.";
  // CEP começado e incompleto: não entra na linha e trava o Salvar (como em Clientes e Locais).
  const cepError = cepIncomplete(cep) ? CEP_TEXT.invalid : null;
  // O endereço que vai ser gravado: com o CEP completo no fim da linha, até os 300 caracteres dela.
  const address = companyLineToSave(form.address, cep, ADDRESS_MAX);
  const normalized = (f: typeof form) =>
    JSON.stringify({
      name: f.name.trim(),
      document: cleanDocument(f.document),
      email: f.email.trim(),
      phone: f.phone.trim(),
      address: f.address.trim(),
      website: f.website.trim(),
    });
  const dirty = normalized({ ...form, address }) !== normalized(start);
  useLeaveGuard(dirty && !readOnly, "Os dados da empresa alterados ainda não foram salvos.");

  const save = useMutation({
    mutationFn: () =>
      api.put<CompanyProfile>("/settings/company", {
        name: form.name.trim(),
        document: cnpj || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        address: address.trim() || null,
        website: form.website.trim() || null,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings", "company"], data);
      toast({ title: "Dados da empresa salvos", description: "Valem para os próximos orçamentos e relatórios.", tone: "success" });
    },
  });

  return (
    <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!documentValid) setShowDocumentError(true);
          if (cepError) setCepTouched(true);
          if (!documentValid || cepError) return;
          if (dirty) save.mutate();
        }}
      >
        <Field label="Nome da empresa" required>
          <Input value={form.name} onChange={set("name")} minLength={2} maxLength={160} required disabled={readOnly} />
        </Field>
        <Field label="CNPJ">
          <Input
            value={form.document}
            onChange={set("document")}
            onBlur={() => {
              setShowDocumentError(!documentValid);
              // Válido: mostra no formato de sempre (00.000.000/0000-00).
              if (cnpj && documentValid) setForm((f) => ({ ...f, document: formatDocument(cnpj) }));
            }}
            maxLength={20}
            placeholder="00.000.000/0000-00"
            disabled={readOnly}
            aria-invalid={showDocumentError && documentProblem ? true : undefined}
            aria-describedby={showDocumentError && documentProblem ? documentErrorId : undefined}
          />
          {showDocumentError && documentProblem ? <FieldError id={documentErrorId}>{documentProblem}</FieldError> : null}
        </Field>
        <Field label="E-mail de atendimento">
          <Input type="email" value={form.email} onChange={set("email")} maxLength={255} disabled={readOnly} />
        </Field>
        <Field label="Telefone">
          <Input value={form.phone} onChange={set("phone")} maxLength={40} inputMode="tel" disabled={readOnly} />
        </Field>
        <div className="grid gap-4 sm:col-span-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <CepField
            mode="company"
            value={cep}
            onChange={setCep}
            address={{ line: form.address }}
            onApply={(next) => setForm((f) => ({ ...f, address: next.line }))}
            focusRef={addressRef}
            disabled={readOnly}
            error={cepTouched ? cepError : null}
            inputProps={{ onBlur: () => setCepTouched(true) }}
          />
          <Field label="Endereço">
            <Input
              ref={addressRef}
              value={form.address}
              onChange={(e) => {
                const line = e.target.value;
                // CEP mudado (ou apagado) na linha: o campo vai junto, e o salvar não troca de volta.
                setCep((current) => companyCepAfterEdit(form.address, line, current));
                setForm((f) => ({ ...f, address: line }));
              }}
              maxLength={ADDRESS_MAX}
              placeholder="Rua, número - bairro - cidade - UF"
              disabled={readOnly}
            />
          </Field>
        </div>
        <Field label="Site" hint="Fica guardado para referência; não sai no orçamento nem no relatório.">
          <Input value={form.website} onChange={set("website")} maxLength={200} placeholder="https://" disabled={readOnly} />
        </Field>
        {readOnly ? null : (
          <div className="flex flex-wrap items-end justify-end gap-3">
            {dirty ? <span className="pb-2 text-xs font-semibold text-ink-muted">Alterações não salvas</span> : null}
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
              <Save className="size-4" />
              Salvar
            </Button>
          </div>
        )}
        {save.error ? (
          <div className="sm:col-span-2">
            <ErrorBox message={errorMessage(save.error)} />
          </div>
        ) : null}
      </form>
      {/* Prévia de como sai no topo do orçamento (mesmos tamanhos da página do cliente). */}
      <div className="rounded-xl border border-dashed border-line-strong p-4">
        <p className="mb-3 text-[11px] font-bold tracking-wide text-ink-muted uppercase">Prévia no orçamento</p>
        <div className="flex items-start gap-4">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-line bg-white">
            <Image src="/brand/maxxfield-mark.png" alt="" width={36} height={18} />
          </span>
          <div className="min-w-0 text-xs leading-relaxed text-ink-muted">
            <p className="text-base font-semibold text-ink">{form.name.trim() || "Nome da empresa"}</p>
            {cnpj ? <p>CNPJ: {formatDocument(cnpj)}</p> : null}
            {form.email.trim() ? <p className="truncate">E-mail: {form.email.trim()}</p> : null}
            {form.phone.trim() ? <p>Telefone: {form.phone.trim()}</p> : null}
            {address.trim() ? <p>Endereço: {address.trim()}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
