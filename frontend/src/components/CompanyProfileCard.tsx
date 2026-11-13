"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import Image from "next/image";
import { useId, useState } from "react";
import { FieldError, useLeaveGuard } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, ErrorBox, Field, Input, LoadingBlock } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
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

/** Dados da empresa: aparecem no cabeçalho do orçamento e do relatório que o cliente recebe. */
export function CompanyProfileCard({ readOnly = false }: { readOnly?: boolean }) {
  const profile = useQuery({
    queryKey: ["settings", "company"],
    queryFn: () => api.get<CompanyProfile>("/settings/company"),
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
  const [showDocumentError, setShowDocumentError] = useState(false);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const cnpj = cleanDocument(form.document);
  const documentValid = !cnpj || isValidCnpj(cnpj);
  const documentProblem = documentValid ? undefined : "CNPJ inválido: confira os 14 caracteres e os dígitos verificadores.";
  const normalized = (f: typeof form) =>
    JSON.stringify({
      name: f.name.trim(),
      document: cleanDocument(f.document),
      email: f.email.trim(),
      phone: f.phone.trim(),
      address: f.address.trim(),
      website: f.website.trim(),
    });
  const dirty = normalized(form) !== normalized(start);
  useLeaveGuard(dirty && !readOnly, "Os dados da empresa alterados ainda não foram salvos.");

  const save = useMutation({
    mutationFn: () =>
      api.put<CompanyProfile>("/settings/company", {
        name: form.name.trim(),
        document: cnpj || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
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
          if (!documentValid) {
            setShowDocumentError(true);
            return;
          }
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
        <Field label="Endereço" className="sm:col-span-2">
          <Input
            value={form.address}
            onChange={set("address")}
            maxLength={300}
            placeholder="Rua, número - bairro - cidade - UF, CEP"
            disabled={readOnly}
          />
        </Field>
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
            {form.address.trim() ? <p>Endereço: {form.address.trim()}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
