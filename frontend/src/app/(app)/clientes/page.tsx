"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, MapPin, Plus, Search } from "lucide-react";
import Link from "next/link";
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
import { formatDate, formatDocument } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCustomers } from "@/lib/queries";
import type { Customer } from "@/lib/types";

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
      description="A empresa (matriz). As filiais e lojas são cadastradas em Locais."
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
          <Input
            value={form.document}
            onChange={(e) => set("document", e.target.value)}
            placeholder="00.000.000/0000-00"
            maxLength={20}
          />
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

export default function CustomersPage() {
  const { user } = useAuth();
  const canEdit = canManageTickets(user?.role);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim());
  const customers = useCustomers(q || undefined);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Clientes"
        description="Empresas atendidas, com o histórico resumido das OS. Filiais e lojas ficam em Locais."
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
              placeholder="Buscar por nome ou CNPJ"
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
                <Th>Cliente</Th>
                <Th>CNPJ / CPF</Th>
                <Th className="text-right">Locais</Th>
                <Th className="text-right">OS abertas</Th>
                <Th className="text-right">Total de OS</Th>
                <Th>Última OS</Th>
                <Th>Contato</Th>
                <Th>Situação</Th>
              </tr>
            </thead>
            <tbody>
              {customers.data?.map((c) => (
                <tr key={c.id} className="hover:bg-surface-2">
                  <Td className="font-medium">{c.name}</Td>
                  <Td className="font-mono text-xs whitespace-nowrap">{formatDocument(c.document)}</Td>
                  <Td className="text-right">
                    <Link
                      href={`/locais?customer_id=${c.id}`}
                      className="inline-flex items-center gap-1 text-brand hover:underline"
                    >
                      <MapPin className="size-3.5" />
                      {c.locations_count}
                    </Link>
                  </Td>
                  <Td className="text-right">
                    {c.open_tickets > 0 ? (
                      <Link
                        href={`/chamados?customer_id=${c.id}&open_only=true`}
                        className="font-medium text-brand hover:underline"
                      >
                        {c.open_tickets}
                      </Link>
                    ) : (
                      <span className="text-ink-muted">0</span>
                    )}
                  </Td>
                  <Td className="text-right">{c.total_tickets}</Td>
                  <Td className="text-xs whitespace-nowrap text-ink-muted">{formatDate(c.last_ticket_at)}</Td>
                  <Td className="text-xs text-ink-muted">{[c.email, c.phone].filter(Boolean).join(" · ") || "—"}</Td>
                  <Td>
                    {c.is_active ? (
                      <span className="text-xs text-emerald-600 dark:text-emerald-400">Ativo</span>
                    ) : (
                      <span className="text-xs text-ink-muted">Inativo</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating ? <NewCustomerDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
