"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/components/Confirm";
import {
  ContactsEditor,
  contactDrafts,
  contactsInvalid,
  contactsPayload,
  sameContacts,
  type ContactDraft,
} from "@/components/ContactList";
import { cleanDocument, documentError, maskZip, UFS } from "@/components/LocationDialog";
import { useToast } from "@/components/Toaster";
import { Button, Checkbox, Dialog, ErrorBox, Field, Input, SectionTitle, Select, Textarea } from "@/components/ui";
import { ApiError, api, errorMessage } from "@/lib/api";
import { formatDocument } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import type { ContactEntry, Customer } from "@/lib/types";

type FormState = {
  name: string;
  document: string;
  notes: string;
  is_active: boolean;
  address_line: string;
  district: string;
  city: string;
  state: string;
  zip_code: string;
};

function initialForm(customer: Customer | null): FormState {
  return {
    name: customer?.name ?? "",
    document: customer?.document ? formatDocument(customer.document) : "",
    notes: customer?.notes ?? "",
    is_active: customer?.is_active ?? true,
    address_line: customer?.address_line ?? "",
    district: customer?.district ?? "",
    city: customer?.city ?? "",
    state: (customer?.state ?? "").toUpperCase(),
    zip_code: maskZip(customer?.zip_code ?? ""),
  };
}

/** Contatos do cliente: a lista completa ou, no cadastro antigo, o e-mail e o telefone únicos. */
export function customerContacts(customer: Customer | null): ContactEntry[] {
  if (!customer) return [];
  if (customer.contacts?.length) return customer.contacts;
  return [
    ...(customer.email ? [{ kind: "email" as const, value: customer.email, name: null, label: null, primary: true }] : []),
    ...(customer.phone ? [{ kind: "phone" as const, value: customer.phone, name: null, label: null, primary: true }] : []),
  ];
}

/** Os campos como a API recebe (texto em branco vira null). */
function bodyOf(form: FormState): Record<string, unknown> {
  const valueOf = (v: string) => v.trim() || null;
  return {
    name: form.name.trim(),
    document: cleanDocument(form.document) || null,
    notes: valueOf(form.notes),
    is_active: form.is_active,
    address_line: valueOf(form.address_line),
    district: valueOf(form.district),
    city: valueOf(form.city),
    state: form.state || null,
    zip_code: valueOf(form.zip_code),
  };
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-medium text-red-600 dark:text-red-400">{children}</span>;
}

/**
 * Cadastro do cliente (a empresa, a matriz): cria ou edita os dados, todos os contatos e o endereço
 * da matriz. As lojas (filiais) ficam em Locais. As etiquetas vêm do Field Control e não se editam aqui.
 */
export function CustomerDialog({ customer, onClose }: { customer: Customer | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [initial] = useState(() => initialForm(customer));
  const [form, setForm] = useState<FormState>(initial);
  const [initialContacts] = useState<ContactDraft[]>(() => contactDrafts(customerContacts(customer)));
  const [contacts, setContacts] = useState<ContactDraft[]>(initialContacts);
  const [tried, setTried] = useState(false);
  const [docTouched, setDocTouched] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // O CPF/CNPJ é único: avisa enquanto digita que o cliente já existe (e leva até ele).
  const clean = cleanDocument(form.document);
  const docError = documentError(form.document);
  const lookup = useDebounced(!docError && (clean.length === 11 || clean.length === 14) ? clean : "", 300);
  const twins = useQuery({
    queryKey: ["customers", "document", lookup],
    queryFn: () => api.get<Customer[]>("/customers", { q: lookup }),
    enabled: Boolean(lookup),
    staleTime: 30_000,
  });
  const twin = lookup === clean ? (twins.data?.find((c) => c.document === clean && c.id !== customer?.id) ?? null) : null;

  const errors = {
    name: form.name.trim().length < 2 ? "Dê um nome com pelo menos 2 letras." : null,
    document: docError ?? (twin ? "Já existe um cliente com este documento." : null),
  };
  const invalid = Object.values(errors).some(Boolean) || contactsInvalid(contacts);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || !sameContacts(contacts, initialContacts);

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      customer ? api.patch<Customer>(`/customers/${customer.id}`, payload) : api.post<Customer>("/customers", payload),
    onSuccess: (saved) => {
      queryClient.setQueryData(["customer", saved.id], saved);
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast({ title: `Cliente ${saved.name} ${customer ? "atualizado" : "cadastrado"}`, tone: "success" });
      onClose();
      // Cliente novo: abre a ficha dele, onde se cadastram as lojas.
      if (!customer) router.push(`/clientes/${saved.id}`);
    },
  });
  const duplicateError = mutation.error instanceof ApiError && mutation.error.status === 409;

  const submit = () => {
    setTried(true);
    if (invalid) return;
    const body = bodyOf(form);
    if (!customer) {
      delete body.is_active;
      mutation.mutate({ ...body, contacts: contactsPayload(contacts) });
      return;
    }
    // Só o que mudou. O e-mail e o telefone únicos a API tira do contato principal de cada tipo.
    const before = bodyOf(initial);
    const changed = Object.fromEntries(Object.entries(body).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])));
    if (!sameContacts(contacts, initialContacts)) changed.contacts = contactsPayload(contacts);
    if (Object.keys(changed).length === 0) {
      onClose();
      return;
    }
    mutation.mutate(changed);
  };

  const requestClose = async () => {
    if (
      dirty &&
      !(await confirm({
        title: "Descartar alterações?",
        description: "O que você preencheu neste cliente não será salvo.",
        tone: "danger",
        confirmLabel: "Descartar",
        cancelLabel: "Continuar editando",
      }))
    ) {
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={() => void requestClose()}
      title={customer ? "Editar cliente" : "Novo cliente"}
      description="A empresa (matriz). As filiais e lojas são cadastradas em Locais."
      footer={
        <>
          <Button onClick={() => void requestClose()}>Cancelar</Button>
          <Button variant="primary" type="submit" form="customer-form" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="customer-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-6"
      >
        <section className="flex flex-col gap-3">
          <SectionTitle>Dados</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-6">
            <Field label="Razão social / nome" required className="sm:col-span-4">
              <Input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                maxLength={200}
                aria-invalid={tried && errors.name ? true : undefined}
              />
              {tried && errors.name ? <FieldError>{errors.name}</FieldError> : null}
            </Field>
            <Field label="CNPJ / CPF" className="sm:col-span-2">
              <Input
                value={form.document}
                onChange={(e) => set("document", e.target.value)}
                onBlur={() => {
                  setDocTouched(true);
                  if (clean && !docError) set("document", formatDocument(clean));
                }}
                placeholder="00.000.000/0000-00"
                maxLength={20}
                aria-invalid={(tried || docTouched || twin) && errors.document ? true : undefined}
              />
              {(tried || docTouched) && docError ? <FieldError>{docError}</FieldError> : null}
            </Field>
          </div>
          {twin ? (
            <p className="text-xs font-medium text-red-600 dark:text-red-400" role="alert">
              Já existe um cliente com este {clean.length === 11 ? "CPF" : "CNPJ"}:{" "}
              <Link href={`/clientes/${twin.id}`} className="underline underline-offset-2" onClick={onClose}>
                {twin.name}
              </Link>
              .
            </p>
          ) : null}
          <Field label="Observações">
            <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          {customer ? (
            <div className="flex flex-col gap-1">
              <Checkbox label="Cliente ativo" checked={form.is_active} onChange={(v) => set("is_active", v)} />
              <p className="pl-6 text-xs text-ink-subtle">
                Inativo sai da lista de clientes (aparece ao desmarcar “Somente ativos”). Lojas e histórico continuam.
              </p>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle aside={<span className="text-xs text-ink-subtle">O principal de cada tipo é o do cadastro</span>}>
            Contatos
          </SectionTitle>
          <ContactsEditor value={contacts} onChange={setContacts} showErrors={tried} />
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle>Endereço da matriz</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-6">
            <Field label="Endereço" className="sm:col-span-4">
              <Input
                value={form.address_line}
                onChange={(e) => set("address_line", e.target.value)}
                placeholder="Rua, número e complemento"
                maxLength={255}
              />
            </Field>
            <Field label="Bairro" className="sm:col-span-2">
              <Input value={form.district} onChange={(e) => set("district", e.target.value)} maxLength={120} />
            </Field>
            <Field label="Cidade" className="sm:col-span-3">
              <Input value={form.city} onChange={(e) => set("city", e.target.value)} maxLength={120} />
            </Field>
            <Field label="UF" className="sm:col-span-1">
              <Select value={form.state} onChange={(e) => set("state", e.target.value)}>
                <option value="">—</option>
                {UFS.map((uf) => (
                  <option key={uf} value={uf}>
                    {uf}
                  </option>
                ))}
                {form.state && !UFS.includes(form.state) ? <option value={form.state}>{form.state}</option> : null}
              </Select>
            </Field>
            <Field label="CEP" className="sm:col-span-2">
              <Input
                value={form.zip_code}
                onChange={(e) => set("zip_code", maskZip(e.target.value))}
                inputMode="numeric"
                placeholder="00000-000"
                maxLength={9}
              />
            </Field>
          </div>
        </section>

        {tried && invalid ? <ErrorBox message="Confira os campos marcados antes de salvar." /> : null}
        {mutation.error ? (
          <ErrorBox
            message={duplicateError ? "Já existe um cliente com este CPF/CNPJ. Procure-o na lista de clientes." : errorMessage(mutation.error)}
          />
        ) : null}
      </form>
    </Dialog>
  );
}
