"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronDown, ChevronRight, MapPin, Plus, Search } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { useDebounced } from "@/lib/hooks";
import { useCustomers, useLocations } from "@/lib/queries";
import type { Customer, Location, UUID } from "@/lib/types";

function NewCustomerDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({ name: "", document: "", email: "", phone: "", notes: "" });
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const mutation = useMutation({
    mutationFn: () =>
      api.post<Customer>("/customers", {
        name: form.name.trim(),
        document: form.document.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        notes: form.notes.trim() || null,
      }),
    onSuccess: (customer) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast({ title: `Cliente ${customer.name} cadastrado`, tone: "success" });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Novo cliente"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="new-customer" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="new-customer"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Razão social / nome" required className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} required minLength={2} />
        </Field>
        <Field label="CNPJ / CPF">
          <Input value={form.document} onChange={(e) => set("document", e.target.value)} maxLength={20} />
        </Field>
        <Field label="Telefone">
          <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="E-mail" className="sm:col-span-2">
          <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Observações" className="sm:col-span-2">
          <Textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        {mutation.error ? (
          <div className="sm:col-span-2">
            <ErrorBox message={errorMessage(mutation.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

function NewLocationDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: "",
    address_line: "",
    district: "",
    city: "",
    state: "",
    zip_code: "",
    latitude: "",
    longitude: "",
    contact_name: "",
    contact_phone: "",
  });
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));

  const mutation = useMutation({
    mutationFn: () =>
      api.post<Location>(`/customers/${customer.id}/locations`, {
        name: form.name.trim(),
        address_line: form.address_line.trim() || null,
        district: form.district.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim().toUpperCase() || null,
        zip_code: form.zip_code.trim() || null,
        latitude: num(form.latitude),
        longitude: num(form.longitude),
        contact_name: form.contact_name.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
      }),
    onSuccess: (location) => {
      queryClient.invalidateQueries({ queryKey: ["locations", customer.id] });
      toast({ title: `Local ${location.name} cadastrado`, tone: "success" });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Novo local de atendimento"
      description={customer.name}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="new-location" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="new-location"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="grid gap-4 sm:grid-cols-6"
      >
        <Field label="Nome do local" required className="sm:col-span-6">
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Ex.: Matriz - 2º andar"
            required
            minLength={2}
          />
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
        <Field label="Latitude" className="sm:col-span-3">
          <Input value={form.latitude} onChange={(e) => set("latitude", e.target.value)} placeholder="-23.5505" />
        </Field>
        <Field label="Longitude" className="sm:col-span-3">
          <Input value={form.longitude} onChange={(e) => set("longitude", e.target.value)} placeholder="-46.6333" />
        </Field>
        <Field label="Contato no local" className="sm:col-span-3">
          <Input value={form.contact_name} onChange={(e) => set("contact_name", e.target.value)} />
        </Field>
        <Field label="Telefone do contato" className="sm:col-span-3">
          <Input value={form.contact_phone} onChange={(e) => set("contact_phone", e.target.value)} />
        </Field>
        {mutation.error ? (
          <div className="sm:col-span-6">
            <ErrorBox message={errorMessage(mutation.error)} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

function LocationsPanel({ customer, canEdit }: { customer: Customer; canEdit: boolean }) {
  const locations = useLocations(customer.id);
  const [adding, setAdding] = useState(false);
  return (
    <div className="bg-surface-2 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">Locais de atendimento</h3>
        {canEdit ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Novo local
          </Button>
        ) : null}
      </div>
      {locations.isLoading ? (
        <LoadingBlock />
      ) : locations.error ? (
        <ErrorBox message={errorMessage(locations.error)} />
      ) : (locations.data ?? []).length === 0 ? (
        <p className="py-3 text-sm text-ink-muted">Nenhum local cadastrado.</p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2">
          {locations.data?.map((l) => (
            <li key={l.id} className="rounded-lg border border-line bg-surface p-3 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-ink">
                <MapPin className="size-3.5 text-ink-muted" />
                {l.name}
                {!l.is_active ? <span className="text-xs font-normal text-ink-muted">(inativo)</span> : null}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                {[l.address_line, l.district, l.city && `${l.city}${l.state ? `/${l.state}` : ""}`, l.zip_code]
                  .filter(Boolean)
                  .join(" · ") || "Sem endereço"}
              </p>
              {l.contact_name || l.contact_phone ? (
                <p className="mt-1 text-xs text-ink-muted">
                  Contato: {[l.contact_name, l.contact_phone].filter(Boolean).join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {adding ? <NewLocationDialog customer={customer} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

export default function CustomersPage() {
  const { user } = useAuth();
  const canEdit = canManageTickets(user?.role);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<UUID | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim());
  const customers = useCustomers(q || undefined);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Clientes"
        description="Empresas atendidas e seus locais de atendimento"
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Novo cliente
            </Button>
          ) : null
        }
      />
      <Card>
        <div className="border-b border-line p-3">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar cliente"
              className="pl-9"
            />
          </div>
        </div>
        {customers.isLoading ? (
          <LoadingBlock />
        ) : customers.error ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(customers.error)} />
          </div>
        ) : (customers.data ?? []).length === 0 ? (
          <EmptyState icon={<Building2 className="size-8" />} title="Nenhum cliente encontrado" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-8" />
                <Th>Cliente</Th>
                <Th>CNPJ / CPF</Th>
                <Th>Contato</Th>
                <Th>Situação</Th>
              </tr>
            </thead>
            <tbody>
              {customers.data?.map((c) => {
                const open = expanded === c.id;
                return [
                  <tr
                    key={c.id}
                    onClick={() => setExpanded(open ? null : c.id)}
                    className="cursor-pointer hover:bg-surface-2"
                  >
                    <Td>
                      {open ? (
                        <ChevronDown className="size-4 text-ink-muted" />
                      ) : (
                        <ChevronRight className="size-4 text-ink-muted" />
                      )}
                    </Td>
                    <Td className="font-medium">{c.name}</Td>
                    <Td className="font-mono text-xs">{c.document ?? "—"}</Td>
                    <Td className="text-xs text-ink-muted">{[c.email, c.phone].filter(Boolean).join(" · ") || "—"}</Td>
                    <Td>
                      {c.is_active ? (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400">Ativo</span>
                      ) : (
                        <span className="text-xs text-ink-muted">Inativo</span>
                      )}
                    </Td>
                  </tr>,
                  open ? (
                    <tr key={`${c.id}-locations`}>
                      <td colSpan={5} className="border-b border-line p-0">
                        <LocationsPanel customer={c} canEdit={canEdit} />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {creating ? <NewCustomerDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
