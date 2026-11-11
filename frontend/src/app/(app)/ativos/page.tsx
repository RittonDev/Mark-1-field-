"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, Plus, Search } from "lucide-react";
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
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ASSET_TYPE } from "@/lib/constants";
import { useDebounced } from "@/lib/hooks";
import { useCustomers, useLocations } from "@/lib/queries";
import type { Asset, AssetType } from "@/lib/types";

function NewAssetDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const customers = useCustomers();
  const [form, setForm] = useState({
    customer_id: "",
    location_id: "",
    asset_type: "printer" as AssetType,
    name: "",
    brand: "",
    model: "",
    serial_number: "",
    asset_tag: "",
    ip_address: "",
    mac_address: "",
    notes: "",
  });
  const locations = useLocations(form.customer_id || null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const opt = (v: string) => v.trim() || null;

  const mutation = useMutation({
    mutationFn: () =>
      api.post<Asset>("/assets", {
        customer_id: form.customer_id,
        location_id: form.location_id || null,
        asset_type: form.asset_type,
        name: form.name.trim(),
        brand: opt(form.brand),
        model: opt(form.model),
        serial_number: opt(form.serial_number),
        asset_tag: opt(form.asset_tag),
        ip_address: opt(form.ip_address),
        mac_address: opt(form.mac_address),
        notes: opt(form.notes),
      }),
    onSuccess: (asset) => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      toast({ title: `Ativo ${asset.name} cadastrado`, tone: "success" });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Novo ativo"
      description="Impressora, computador, equipamento de rede ou CFTV"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" type="submit" form="new-asset" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="new-asset"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Cliente" required>
          <Select
            value={form.customer_id}
            onChange={(e) => setForm((f) => ({ ...f, customer_id: e.target.value, location_id: "" }))}
            required
          >
            <option value="">Selecione...</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Local">
          <Select
            value={form.location_id}
            disabled={!form.customer_id}
            onChange={(e) => set("location_id", e.target.value)}
          >
            <option value="">Sem local definido</option>
            {locations.data?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tipo" required>
          <Select value={form.asset_type} onChange={(e) => set("asset_type", e.target.value as AssetType)}>
            {Object.entries(ASSET_TYPE).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Nome / identificação" required>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Ex.: Impressora RH 2º andar"
            required
            minLength={2}
          />
        </Field>
        <Field label="Marca">
          <Input value={form.brand} onChange={(e) => set("brand", e.target.value)} />
        </Field>
        <Field label="Modelo">
          <Input value={form.model} onChange={(e) => set("model", e.target.value)} />
        </Field>
        <Field label="Nº de série">
          <Input value={form.serial_number} onChange={(e) => set("serial_number", e.target.value)} />
        </Field>
        <Field label="Patrimônio">
          <Input value={form.asset_tag} onChange={(e) => set("asset_tag", e.target.value)} />
        </Field>
        <Field label="Endereço IP">
          <Input value={form.ip_address} onChange={(e) => set("ip_address", e.target.value)} placeholder="192.168.0.10" />
        </Field>
        <Field label="MAC">
          <Input value={form.mac_address} onChange={(e) => set("mac_address", e.target.value)} maxLength={17} />
        </Field>
        <Field label="Observações" className="sm:col-span-2">
          <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
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

export default function AssetsPage() {
  const customers = useCustomers();
  const [customerId, setCustomerId] = useState("");
  const [assetType, setAssetType] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim());

  const assets = useQuery({
    queryKey: ["assets", "list", customerId, assetType, q],
    queryFn: () =>
      api.get<Asset[]>("/assets", {
        customer_id: customerId || undefined,
        asset_type: assetType || undefined,
        q: q || undefined,
      }),
  });

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Ativos"
        description="Inventário de equipamentos atendidos (impressoras, computadores, rede, CFTV)"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            Novo ativo
          </Button>
        }
      />
      <Card>
        <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nome, série, patrimônio, IP"
              className="pl-9"
            />
          </div>
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Todos os clientes</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select value={assetType} onChange={(e) => setAssetType(e.target.value)}>
            <option value="">Todos os tipos</option>
            {Object.entries(ASSET_TYPE).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        {assets.isLoading ? (
          <LoadingBlock />
        ) : assets.error ? (
          <div className="p-4">
            <ErrorBox message={errorMessage(assets.error)} />
          </div>
        ) : (assets.data ?? []).length === 0 ? (
          <EmptyState icon={<HardDrive className="size-8" />} title="Nenhum ativo encontrado" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Ativo</Th>
                <Th>Tipo</Th>
                <Th>Cliente / local</Th>
                <Th>Série / patrimônio</Th>
                <Th>IP</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {assets.data?.map((a) => (
                <tr key={a.id} className="hover:bg-surface-2">
                  <Td>
                    <p className="font-medium">{a.name}</p>
                    {a.brand || a.model ? (
                      <p className="text-xs text-ink-muted">{[a.brand, a.model].filter(Boolean).join(" ")}</p>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">{ASSET_TYPE[a.asset_type]}</Td>
                  <Td>
                    <p>{a.customer.name}</p>
                    {a.location ? <p className="text-xs text-ink-muted">{a.location.name}</p> : null}
                  </Td>
                  <Td className="text-xs">
                    {a.serial_number ? <p>S/N {a.serial_number}</p> : null}
                    {a.asset_tag ? <p className="text-ink-muted">Pat. {a.asset_tag}</p> : null}
                    {!a.serial_number && !a.asset_tag ? "—" : null}
                  </Td>
                  <Td className="font-mono text-xs">{a.ip_address ?? "—"}</Td>
                  <Td className="text-right">
                    <Link href={`/chamados?asset_id=${a.id}`} className="text-xs font-medium text-brand hover:underline">
                      Ver chamados
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating ? <NewAssetDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
