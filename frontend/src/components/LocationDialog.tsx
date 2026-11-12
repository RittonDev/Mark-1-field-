"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Checkbox, Dialog, ErrorBox, Field, Input, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDocument } from "@/lib/format";
import { useCustomers } from "@/lib/queries";
import type { Location, UUID } from "@/lib/types";

type FormState = {
  customer_id: string;
  name: string;
  code: string;
  document: string;
  address_line: string;
  district: string;
  city: string;
  state: string;
  zip_code: string;
  latitude: string;
  longitude: string;
  contact_name: string;
  contact_phone: string;
  notes: string;
  is_active: boolean;
};

function initial(location: Location | null, customerId: UUID | null): FormState {
  const s = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  return {
    customer_id: location?.customer_id ?? customerId ?? "",
    name: s(location?.name),
    code: s(location?.code),
    document: location?.document ? formatDocument(location.document) : "",
    address_line: s(location?.address_line),
    district: s(location?.district),
    city: s(location?.city),
    state: s(location?.state),
    zip_code: s(location?.zip_code),
    latitude: s(location?.latitude),
    longitude: s(location?.longitude),
    contact_name: s(location?.contact_name),
    contact_phone: s(location?.contact_phone),
    notes: s(location?.notes),
    is_active: location?.is_active ?? true,
  };
}

/** Cria ou edita um local de atendimento (filial). Sem `location`, cria; `customerId` pré-seleciona o cliente. */
export function LocationDialog({
  location,
  customerId = null,
  onClose,
}: {
  location: Location | null;
  customerId?: UUID | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const customers = useCustomers();
  const [form, setForm] = useState<FormState>(() => initial(location, customerId));
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));
  const text = (v: string) => v.trim() || null;
  const editing = location !== null;

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        code: text(form.code),
        document: text(form.document),
        address_line: text(form.address_line),
        district: text(form.district),
        city: text(form.city),
        state: text(form.state.toUpperCase()),
        zip_code: text(form.zip_code),
        latitude: num(form.latitude),
        longitude: num(form.longitude),
        contact_name: text(form.contact_name),
        contact_phone: text(form.contact_phone),
        notes: text(form.notes),
      };
      return editing
        ? api.patch<Location>(`/locations/${location.id}`, { ...body, is_active: form.is_active })
        : api.post<Location>(`/customers/${form.customer_id}/locations`, body);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast({ title: `Local ${saved.name} ${editing ? "atualizado" : "cadastrado"}`, tone: "success" });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={editing ? "Editar local" : "Novo local de atendimento"}
      description="Filial, loja ou unidade onde o técnico atende. Pode ter CNPJ próprio."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="location-form" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="location-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="grid gap-4 sm:grid-cols-6"
      >
        <Field label="Cliente" required className="sm:col-span-6">
          <Select
            value={form.customer_id}
            onChange={(e) => set("customer_id", e.target.value)}
            required
            disabled={editing}
          >
            <option value="">Selecione o cliente...</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Nome do local" required className="sm:col-span-4">
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Ex.: Loja 41 - Outlet Brasília"
            required
            minLength={2}
          />
        </Field>
        <Field label="Código" className="sm:col-span-2">
          <Input value={form.code} onChange={(e) => set("code", e.target.value)} placeholder="LJ-41" maxLength={40} />
        </Field>
        <Field label="CNPJ / CPF da filial" className="sm:col-span-3">
          <Input
            value={form.document}
            onChange={(e) => set("document", e.target.value)}
            placeholder="00.000.000/0000-00"
            maxLength={20}
          />
        </Field>
        <Field label="Contato no local" className="sm:col-span-3">
          <Input value={form.contact_name} onChange={(e) => set("contact_name", e.target.value)} />
        </Field>
        <Field label="Endereço" className="sm:col-span-4">
          <Input value={form.address_line} onChange={(e) => set("address_line", e.target.value)} />
        </Field>
        <Field label="Bairro" className="sm:col-span-2">
          <Input value={form.district} onChange={(e) => set("district", e.target.value)} />
        </Field>
        <Field label="Cidade" className="sm:col-span-3">
          <Input value={form.city} onChange={(e) => set("city", e.target.value)} />
        </Field>
        <Field label="UF" className="sm:col-span-1">
          <Input value={form.state} onChange={(e) => set("state", e.target.value)} maxLength={2} />
        </Field>
        <Field label="CEP" className="sm:col-span-2">
          <Input value={form.zip_code} onChange={(e) => set("zip_code", e.target.value)} />
        </Field>
        <Field label="Latitude" className="sm:col-span-2">
          <Input value={form.latitude} onChange={(e) => set("latitude", e.target.value)} placeholder="-23.5505" />
        </Field>
        <Field label="Longitude" className="sm:col-span-2">
          <Input value={form.longitude} onChange={(e) => set("longitude", e.target.value)} placeholder="-46.6333" />
        </Field>
        <Field label="Telefone do contato" className="sm:col-span-2">
          <Input value={form.contact_phone} onChange={(e) => set("contact_phone", e.target.value)} />
        </Field>
        <Field label="Observações" className="sm:col-span-6">
          <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        {editing ? (
          <div className="sm:col-span-6">
            <Checkbox label="Local ativo" checked={form.is_active} onChange={(v) => set("is_active", v)} />
          </div>
        ) : null}
        {mutation.error ? (
          <div className="sm:col-span-6">
            <ErrorBox message={errorMessage(mutation.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
