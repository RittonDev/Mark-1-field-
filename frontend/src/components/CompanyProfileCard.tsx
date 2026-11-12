"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building, Save } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, ErrorBox, Field, Input, LoadingBlock } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { CompanyProfile } from "@/lib/types";

/** Dados da empresa: aparecem no cabeçalho do orçamento e do relatório que o cliente recebe. */
export function CompanyProfileCard() {
  const profile = useQuery({
    queryKey: ["settings", "company"],
    queryFn: () => api.get<CompanyProfile>("/settings/company"),
  });
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Building className="size-4 text-ink-subtle" />
            Dados da empresa
          </span>
        }
        description="Aparecem no cabeçalho do orçamento e do relatório de atendimento enviados ao cliente."
      />
      {profile.isLoading ? (
        <LoadingBlock rows={2} />
      ) : profile.error ? (
        <div className="p-4">
          <ErrorBox message={errorMessage(profile.error)} />
        </div>
      ) : profile.data ? (
        <ProfileForm key={JSON.stringify(profile.data)} initial={profile.data} />
      ) : null}
    </Card>
  );
}

function ProfileForm({ initial }: { initial: CompanyProfile }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: initial.name ?? "",
    document: initial.document ?? "",
    email: initial.email ?? "",
    phone: initial.phone ?? "",
    address: initial.address ?? "",
    website: initial.website ?? "",
  });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const save = useMutation({
    mutationFn: () =>
      api.put<CompanyProfile>("/settings/company", {
        name: form.name.trim(),
        document: form.document.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
        website: form.website.trim() || null,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings", "company"], data);
      toast({ title: "Dados da empresa salvos", tone: "success" });
    },
  });

  return (
    <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Nome da empresa" required>
          <Input value={form.name} onChange={set("name")} minLength={2} maxLength={160} required />
        </Field>
        <Field label="CNPJ">
          <Input value={form.document} onChange={set("document")} maxLength={20} inputMode="numeric" />
        </Field>
        <Field label="E-mail de atendimento">
          <Input type="email" value={form.email} onChange={set("email")} maxLength={255} />
        </Field>
        <Field label="Telefone">
          <Input value={form.phone} onChange={set("phone")} maxLength={40} />
        </Field>
        <Field label="Endereço" className="sm:col-span-2">
          <Input value={form.address} onChange={set("address")} maxLength={300} placeholder="Rua, número - bairro - cidade - UF, CEP" />
        </Field>
        <Field label="Site">
          <Input value={form.website} onChange={set("website")} maxLength={200} placeholder="https://" />
        </Field>
        <div className="flex items-end justify-end">
          <Button type="submit" variant="primary" loading={save.isPending}>
            <Save className="size-4" />
            Salvar
          </Button>
        </div>
        {save.error ? (
          <div className="sm:col-span-2">
            <ErrorBox message={errorMessage(save.error)} />
          </div>
        ) : null}
      </form>
      {/* Prévia de como sai no topo do orçamento. */}
      <div className="rounded-xl border border-dashed border-line-strong p-4">
        <p className="mb-3 text-[11px] font-medium text-ink-subtle">Prévia no orçamento</p>
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-line bg-white">
            <Image src="/brand/maxxfield-mark.png" alt="" width={28} height={14} />
          </span>
          <div className="min-w-0 text-[11px] leading-relaxed text-ink-muted">
            <p className="text-sm font-semibold text-ink">{form.name || "Nome da empresa"}</p>
            {form.email ? <p className="truncate">E-mail: {form.email}</p> : null}
            {form.phone ? <p>Telefone: {form.phone}</p> : null}
            {form.address ? <p>Endereço: {form.address}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
