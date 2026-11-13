"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Download, FileSpreadsheet } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, ErrorBox, Field, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { downloadCsv } from "@/lib/download";
import { useCustomers } from "@/lib/queries";

interface Row {
  line: number;
  customer: string;
  name: string;
  city: string | null;
  action: "create" | "update" | "error";
  new_customer: boolean;
  errors: string[];
}

interface Result {
  dry_run: boolean;
  rows: Row[];
  created: number;
  updated: number;
  errors: number;
  customers_created: number;
}

const TEMPLATE = [
  ["cliente", "cnpj_cliente", "codigo", "local", "cnpj", "endereco", "bairro", "cidade", "uf", "cep", "latitude", "longitude", "contato", "telefone", "observacoes"],
  ["Rede Exemplo", "11.222.333/0001-81", "L012", "Loja 12 - Centro", "", "Rua Exemplo, 100", "Centro", "São Paulo", "SP", "01001-000", "-23,5505", "-46,6333", "Gerente da loja", "(11) 3000-0000", "Acesso pela doca"],
];

/** Importa a base de locais por planilha, com prévia linha a linha antes de gravar. */
export function LocationImportDialog({
  customerId: initialCustomer,
  onClose,
}: {
  customerId?: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const customers = useCustomers();
  const [customerId, setCustomerId] = useState(initialCustomer ?? "");
  const [file, setFile] = useState<File | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => {
      const body = new FormData();
      body.append("file", file as File);
      const qs = new URLSearchParams({ dry_run: String(dryRun) });
      if (customerId) qs.set("customer_id", customerId);
      return api.upload<Result>(`/locations/import?${qs}`, body);
    },
    onSuccess: (r) => {
      if (r.dry_run) return;
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
    },
  });
  const result = run.data;
  const done = result && !result.dry_run;
  const total = result ? result.created + result.updated : 0;

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="Importar locais"
      description="Planilha CSV ou Excel (XLSX) com a sua base de filiais, lojas e unidades."
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            {result?.dry_run ? (
              <Button variant="primary" loading={run.isPending} disabled={total === 0} onClick={() => run.mutate(false)}>
                Importar {total} local(is)
              </Button>
            ) : (
              <Button variant="primary" loading={run.isPending} disabled={!file} onClick={() => run.mutate(true)}>
                Ver prévia
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {!done ? (
          <>
            <Field label="Cliente" hint="Todos os locais são deste cliente. Em branco: o cliente vem das colunas da planilha (e é criado se não existir).">
              <Select
                value={customerId}
                onChange={(e) => {
                  setCustomerId(e.target.value);
                  run.reset();
                }}
              >
                <option value="">Pela planilha (colunas cliente / cnpj_cliente)</option>
                {(customers.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2">
                <FileSpreadsheet className="size-4" />
                {file ? file.name : "Escolher arquivo"}
                <input
                  type="file"
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="sr-only"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    run.reset();
                  }}
                />
              </label>
              <Button variant="ghost" onClick={() => downloadCsv("modelo-locais.csv", TEMPLATE)}>
                <Download className="size-4" />
                Baixar modelo
              </Button>
            </div>
            <p className="text-xs text-ink-muted">
              O local é reconhecido pelo código, depois pelo CNPJ, depois pelo nome: se já existir, é atualizado só com o que
              veio preenchido. Coordenadas aceitam vírgula (Excel). Nada é gravado antes de você confirmar a prévia.
            </p>
          </>
        ) : null}

        {result ? (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Count label={result.dry_run ? "Novos" : "Criados"} value={result.created} className="bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300" />
              <Count label={result.dry_run ? "Serão atualizados" : "Atualizados"} value={result.updated} className="bg-sky-50 text-sky-800 dark:bg-sky-500/10 dark:text-sky-300" />
              {result.customers_created ? (
                <Count label="Clientes novos" value={result.customers_created} className="bg-violet-50 text-violet-800 dark:bg-violet-500/10 dark:text-violet-300" />
              ) : null}
              <Count label="Com erro (ignorados)" value={result.errors} className="bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300" />
            </div>
            <div className="max-h-72 overflow-auto rounded-lg border border-line">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface-2 text-ink-muted">
                  <tr>
                    <th className="px-2 py-1.5 font-semibold">Linha</th>
                    <th className="px-2 py-1.5 font-semibold">Cliente</th>
                    <th className="px-2 py-1.5 font-semibold">Local</th>
                    <th className="px-2 py-1.5 font-semibold">Resultado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.rows.map((r) => (
                    <tr key={r.line}>
                      <td className="px-2 py-1.5 text-ink-muted tabular-nums">{r.line}</td>
                      <td className="px-2 py-1.5 text-ink">
                        {r.customer || "—"}
                        {r.new_customer ? <span className="ml-1 text-violet-700 dark:text-violet-300">(novo)</span> : null}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="block font-semibold text-ink">{r.name || "—"}</span>
                        {r.city ? <span className="text-ink-muted">{r.city}</span> : null}
                      </td>
                      <td className="px-2 py-1.5">
                        {r.action === "error" ? (
                          <span className="text-red-600 dark:text-red-400">{r.errors.join(" · ")}</span>
                        ) : r.action === "create" ? (
                          <span className="text-emerald-700 dark:text-emerald-400">Novo</span>
                        ) : (
                          <span className="text-sky-700 dark:text-sky-400">Atualizar</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {run.error ? <ErrorBox message={errorMessage(run.error)} /> : null}
      </div>
    </Dialog>
  );
}

function Count({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <span className={clsx("rounded-lg px-3 py-1.5", className)}>
      {label}: <strong className="tabular-nums">{value}</strong>
    </span>
  );
}
