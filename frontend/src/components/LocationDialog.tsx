"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/Confirm";
import {
  ContactsEditor,
  contactDrafts,
  contactsInvalid,
  contactsPayload,
  sameContacts,
  samePhone,
  type ContactDraft,
} from "@/components/ContactList";
import { useToast } from "@/components/Toaster";
import { Button, Checkbox, Dialog, ErrorBox, Field, Input, SectionTitle, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDocument } from "@/lib/format";
import { isValidCpf } from "@/lib/onboarding";
import { useCustomers } from "@/lib/queries";
import type { ContactEntry, Location, Page, UUID } from "@/lib/types";

/** As 27 UFs (escolher em vez de digitar: "Sp", "S.P." ou "São Paulo" não entram no cadastro). */
export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB",
  "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

// ---------------------------------------------------------------- CPF/CNPJ, CEP e coordenadas

/** CPF/CNPJ só com letras e números, em maiúsculas (como a API guarda). */
export function cleanDocument(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

const CNPJ_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function cnpjDigit(chars: string, weights: number[]): number {
  const total = weights.reduce((sum, weight, i) => sum + (chars.charCodeAt(i) - 48) * weight, 0);
  const rest = total % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** CNPJ, inclusive o alfanumérico (desde julho de 2026): a mesma conta da API (core/documents.py). */
function isValidCnpj(clean: string): boolean {
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(clean) || new Set(clean).size === 1) return false;
  const first = cnpjDigit(clean, CNPJ_WEIGHTS);
  const second = cnpjDigit(clean.slice(0, 12) + first, [6, ...CNPJ_WEIGHTS]);
  return clean.slice(12) === `${first}${second}`;
}

/** O que há de errado com o CPF/CNPJ digitado (null quando está em branco ou certo). */
export function documentError(value: string): string | null {
  const clean = cleanDocument(value);
  if (!clean) return null;
  if (clean.length === 11 && /^\d+$/.test(clean)) return isValidCpf(clean) ? null : "CPF inválido: confira os números";
  if (clean.length === 14) return isValidCnpj(clean) ? null : "CNPJ inválido: confira os dígitos";
  return "Digite o CPF (11 números) ou o CNPJ (14 caracteres)";
}

/** "CPF" ou "CNPJ", pelo tamanho do documento. */
export function documentKind(document: string | null | undefined): "CPF" | "CNPJ" {
  return document && cleanDocument(document).length === 11 ? "CPF" : "CNPJ";
}

/** CEP com a máscara 00000-000. */
export function maskZip(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

// O retângulo do Brasil e o ponto padrão do geocodificador antigo: os mesmos de backend/app/services/geo.py.
const BRAZIL = { latMin: -34, latMax: 6, lonMin: -74.5, lonMax: -28 };
const BRAZIL_CENTER = { lat: -14.235, lon: -51.9253 };

const isBrazilCenter = (lat: number, lon: number) =>
  Math.abs(lat - BRAZIL_CENTER.lat) < 0.001 && Math.abs(lon - BRAZIL_CENTER.lon) < 0.001;

/** Coordenada que serve para distância e mapa: dentro do Brasil, nem 0,0 nem o centro do país. */
export function validCoords(lat: number | null | undefined, lon: number | null | undefined): boolean {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if ((lat === 0 && lon === 0) || isBrazilCenter(lat, lon)) return false;
  return lat >= BRAZIL.latMin && lat <= BRAZIL.latMax && lon >= BRAZIL.lonMin && lon <= BRAZIL.lonMax;
}

/** Número com vírgula ou ponto decimal ("-23,5505"). Em branco = null; inválido = NaN. */
function coordNumber(text: string): number | null {
  const t = text.replace(/\s/g, "");
  if (!t) return null;
  return /^-?\d{1,3}([.,]\d+)?$/.test(t) ? Number(t.replace(",", ".")) : Number.NaN;
}

/** "lat, long" colado num campo só (Google Maps, planilha) ou um link do Maps: vai para os dois campos. */
function coordPair(text: string): [string, string] | null {
  const raw = text.trim();
  const patterns = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /[?&](?:q|query|ll)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i,
    /^(-?\d{1,3}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)$/,
    /^(-?\d{1,3},\d+)\s*(?:;|,\s|\s)\s*(-?\d{1,3},\d+)$/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return [match[1], match[2]];
  }
  return null;
}

interface CoordCheck {
  latitude: number | null;
  longitude: number | null;
  error: string | null;
  swapped: boolean;
}

function checkCoords(latText: string, lonText: string): CoordCheck {
  const latitude = coordNumber(latText);
  const longitude = coordNumber(lonText);
  const result = (error: string | null, swapped = false): CoordCheck => ({ latitude, longitude, error, swapped });
  if (latitude === null && longitude === null) return result(null);
  if (latitude === null || longitude === null) return result("Preencha a latitude e a longitude, ou deixe as duas em branco.");
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return result("Use números, como -23,5505 e -46,6333.");
  if (validCoords(latitude, longitude)) return result(null);
  if (validCoords(longitude, latitude)) return result("A latitude e a longitude parecem invertidas.", true);
  if (isBrazilCenter(latitude, longitude)) return result("Esse é o ponto padrão do centro do Brasil, não o da loja.");
  return result("Fora do Brasil: a latitude vai de -34 a 6 e a longitude de -74 a -28.");
}

/** Contatos da loja: a lista completa e, se o telefone único (editado à parte) não estiver nela, ele também. */
export function locationContacts(location: Pick<Location, "contacts" | "contact_name" | "contact_phone">): ContactEntry[] {
  const list = location.contacts ?? [];
  const phone = location.contact_phone;
  if (!phone || list.some((c) => c.kind === "phone" && samePhone(c.value, phone))) return list;
  const hasPrimary = list.some((c) => c.kind === "phone" && c.primary);
  return [{ kind: "phone", value: phone, name: location.contact_name, label: null, primary: !hasPrimary }, ...list];
}

// ---------------------------------------------------------------- formulário

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
  notes: string;
  is_active: boolean;
};

const asText = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));

function initialForm(location: Location | null, customerId: UUID | null): FormState {
  return {
    customer_id: location?.customer_id ?? customerId ?? "",
    name: asText(location?.name),
    code: asText(location?.code),
    document: location?.document ? formatDocument(location.document) : "",
    address_line: asText(location?.address_line),
    district: asText(location?.district),
    city: asText(location?.city),
    state: asText(location?.state).toUpperCase(),
    zip_code: maskZip(asText(location?.zip_code)),
    latitude: asText(location?.latitude),
    longitude: asText(location?.longitude),
    notes: asText(location?.notes),
    is_active: location?.is_active ?? true,
  };
}

/** Os campos como a API recebe (texto em branco vira null). */
function bodyOf(form: FormState): Record<string, unknown> {
  const coords = checkCoords(form.latitude, form.longitude);
  const valueOf = (v: string) => v.trim() || null;
  return {
    name: form.name.trim(),
    code: valueOf(form.code),
    document: cleanDocument(form.document) || null,
    address_line: valueOf(form.address_line),
    district: valueOf(form.district),
    city: valueOf(form.city),
    state: form.state || null,
    zip_code: valueOf(form.zip_code),
    latitude: coords.error ? null : coords.latitude,
    longitude: coords.error ? null : coords.longitude,
    notes: valueOf(form.notes),
    is_active: form.is_active,
  };
}

/** Outra loja do mesmo cliente com o mesmo código ou CNPJ (aviso, não bloqueia: há lojas no mesmo CNPJ). */
function useTwin(customerId: string, field: "code" | "document", value: string, selfId: UUID | undefined): Location | null {
  const query = useQuery({
    queryKey: ["locations", "twin", customerId, field, value],
    queryFn: () => api.get<Page<Location>>("/locations", { customer_id: customerId, q: value, page_size: 5 }),
    enabled: Boolean(customerId && value),
    staleTime: 30_000,
  });
  const same = (l: Location) =>
    field === "code" ? (l.code ?? "").toLowerCase() === value.toLowerCase() : l.document === value;
  return query.data?.items.find((l) => l.id !== selfId && same(l)) ?? null;
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-medium text-red-600 dark:text-red-400">{children}</span>;
}

function TwinNotice({ twin, children }: { twin: Location; children: React.ReactNode }) {
  return (
    <p className="text-xs text-amber-700 dark:text-amber-400">
      {children}{" "}
      <a href={`/locais/${twin.id}`} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">
        {twin.code ? `${twin.code} · ` : ""}
        {twin.name}
      </a>
    </p>
  );
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
  const confirm = useConfirm();
  const customers = useCustomers();
  const [initial] = useState<FormState>(() => initialForm(location, customerId));
  const [form, setForm] = useState<FormState>(initial);
  const [initialContacts] = useState<ContactDraft[]>(() => (location ? contactDrafts(locationContacts(location)) : []));
  const [contacts, setContacts] = useState<ContactDraft[]>(initialContacts);
  const [tried, setTried] = useState(false);
  const [docTouched, setDocTouched] = useState(false);
  const [checked, setChecked] = useState({ code: "", document: "" });
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const editing = location !== null;

  const codeTwin = useTwin(form.customer_id, "code", checked.code, location?.id);
  const docTwin = useTwin(form.customer_id, "document", checked.document, location?.id);
  const coords = checkCoords(form.latitude, form.longitude);
  const coordsChanged = form.latitude !== initial.latitude || form.longitude !== initial.longitude;
  const errors = {
    customer: !editing && !form.customer_id ? "Escolha o cliente." : null,
    name: form.name.trim().length < 2 ? "Dê um nome com pelo menos 2 letras." : null,
    document: documentError(form.document),
    coords: coordsChanged ? coords.error : null,
  };
  const invalid = Object.values(errors).some(Boolean) || contactsInvalid(contacts);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || !sameContacts(contacts, initialContacts);
  const showCoordsError = Boolean(errors.coords) && (tried || (form.latitude.trim() !== "" && form.longitude.trim() !== ""));
  const address = [form.address_line, form.district, form.city, form.state, form.zip_code].map((v) => v.trim()).filter(Boolean).join(", ");
  const mapsSearch = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || form.name.trim() || "Brasil")}`;

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      location
        ? api.patch<Location>(`/locations/${location.id}`, payload)
        : api.post<Location>(`/customers/${form.customer_id}/locations`, payload),
    onSuccess: (saved) => {
      // A ficha da loja e a do cliente mostram o que acabou de ser gravado, sem esperar recarregar.
      queryClient.setQueryData(["location", saved.id], saved);
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
      void queryClient.invalidateQueries({ queryKey: ["customer"] });
      toast({ title: `Local ${saved.name} ${editing ? "atualizado" : "cadastrado"}`, tone: "success" });
      onClose();
    },
  });

  const submit = () => {
    setTried(true);
    if (invalid) return;
    const body = bodyOf(form);
    if (!location) {
      delete body.is_active;
      mutation.mutate({ ...body, contacts: contactsPayload(contacts) });
      return;
    }
    // Só o que mudou: quem editou outro campo ao mesmo tempo não perde a alteração.
    const before = bodyOf(initial);
    const changed = Object.fromEntries(
      Object.entries(body).filter(([key, value]) =>
        key === "latitude" || key === "longitude" ? coordsChanged : JSON.stringify(value) !== JSON.stringify(before[key]),
      ),
    );
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
        description: "O que você preencheu neste local não será salvo.",
        tone: "danger",
        confirmLabel: "Descartar",
        cancelLabel: "Continuar editando",
      }))
    ) {
      return;
    }
    onClose();
  };

  const onCoordChange = (key: "latitude" | "longitude", value: string) => {
    const pair = coordPair(value);
    if (pair) setForm((f) => ({ ...f, latitude: pair[0], longitude: pair[1] }));
    else set(key, value);
  };

  return (
    <Dialog
      open
      onClose={() => void requestClose()}
      size="lg"
      title={editing ? "Editar local" : "Novo local de atendimento"}
      description="Filial, loja ou unidade onde o técnico atende. Pode ter CNPJ próprio."
      footer={
        <>
          <Button onClick={() => void requestClose()}>Cancelar</Button>
          <Button variant="primary" type="submit" form="location-form" loading={mutation.isPending}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        id="location-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-6"
      >
        <Field label="Cliente" required>
          <Select
            value={form.customer_id}
            onChange={(e) => set("customer_id", e.target.value)}
            disabled={editing}
            aria-invalid={tried && errors.customer ? true : undefined}
          >
            <option value="">Selecione o cliente...</option>
            {customers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.is_active ? c.name : `${c.name} (inativo)`}
              </option>
            ))}
          </Select>
          {tried && errors.customer ? <FieldError>{errors.customer}</FieldError> : null}
        </Field>

        <section className="flex flex-col gap-3">
          <SectionTitle>Identificação</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-6">
            <Field label="Nome do local" required className="sm:col-span-4">
              <Input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Ex.: Loja 41 - Outlet Brasília"
                maxLength={200}
                aria-invalid={tried && errors.name ? true : undefined}
              />
              {tried && errors.name ? <FieldError>{errors.name}</FieldError> : null}
            </Field>
            <Field label="Código" className="sm:col-span-2">
              <Input
                value={form.code}
                onChange={(e) => set("code", e.target.value)}
                onBlur={() => setChecked((c) => ({ ...c, code: form.code.trim() }))}
                placeholder="LJ-41"
                maxLength={40}
              />
            </Field>
            <Field label="CNPJ / CPF da loja" className="sm:col-span-3">
              <Input
                value={form.document}
                onChange={(e) => set("document", e.target.value)}
                onBlur={() => {
                  setDocTouched(true);
                  const clean = cleanDocument(form.document);
                  if (clean && !documentError(clean)) {
                    set("document", formatDocument(clean));
                    setChecked((c) => ({ ...c, document: clean }));
                  }
                }}
                placeholder="00.000.000/0000-00"
                maxLength={20}
                aria-invalid={(tried || docTouched) && errors.document ? true : undefined}
              />
              {(tried || docTouched) && errors.document ? <FieldError>{errors.document}</FieldError> : null}
            </Field>
          </div>
          {codeTwin && checked.code === form.code.trim() ? (
            <TwinNotice twin={codeTwin}>Já existe uma loja deste cliente com este código:</TwinNotice>
          ) : null}
          {docTwin && checked.document === cleanDocument(form.document) ? (
            <TwinNotice twin={docTwin}>Este CNPJ já está em outra loja deste cliente (pode ser andar ou sala do mesmo prédio):</TwinNotice>
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle>Endereço</SectionTitle>
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
            <Field label="Latitude" className="sm:col-span-2">
              <Input
                value={form.latitude}
                onChange={(e) => onCoordChange("latitude", e.target.value)}
                inputMode="decimal"
                placeholder="-23.5505"
                maxLength={120}
                aria-invalid={showCoordsError ? true : undefined}
              />
            </Field>
            <Field label="Longitude" className="sm:col-span-2">
              <Input
                value={form.longitude}
                onChange={(e) => onCoordChange("longitude", e.target.value)}
                inputMode="decimal"
                placeholder="-46.6333"
                maxLength={120}
                aria-invalid={showCoordsError ? true : undefined}
              />
            </Field>
            <div className="flex items-end pb-2 sm:col-span-2">
              <a
                href={mapsSearch}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                Achar no Google Maps
                <ExternalLink className="size-3" />
              </a>
            </div>
          </div>
          {showCoordsError ? (
            <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-red-600 dark:text-red-400" role="alert">
              {errors.coords}
              {coords.swapped ? (
                <Button size="sm" onClick={() => setForm((f) => ({ ...f, latitude: f.longitude, longitude: f.latitude }))}>
                  <ArrowLeftRight className="size-3.5" />
                  Trocar
                </Button>
              ) : null}
            </p>
          ) : editing && !coordsChanged && coords.error ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
              <span>
                {coords.swapped
                  ? "As coordenadas gravadas parecem invertidas"
                  : coords.latitude === null || coords.longitude === null
                    ? "Falta a latitude ou a longitude"
                    : "As coordenadas gravadas estão fora do Brasil"}
                : a distância dos técnicos usa o centro da cidade. Corrija ou apague.
              </span>
              {coords.swapped ? (
                <Button size="sm" onClick={() => setForm((f) => ({ ...f, latitude: f.longitude, longitude: f.latitude }))}>
                  <ArrowLeftRight className="size-3.5" />
                  Trocar
                </Button>
              ) : null}
            </p>
          ) : (
            <p className="text-xs text-ink-subtle">
              No Google Maps, clique com o botão direito na loja e copie as coordenadas: dá para colar as duas de uma vez em qualquer
              um dos campos.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle aside={<span className="text-xs text-ink-subtle">O telefone principal aparece na OS</span>}>
            Contatos
          </SectionTitle>
          <ContactsEditor value={contacts} onChange={setContacts} showErrors={tried} />
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle>Observações</SectionTitle>
          <Textarea
            rows={2}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="Acesso, horário de funcionamento, com quem falar..."
            aria-label="Observações"
          />
          {editing ? (
            <div className="flex flex-col gap-1">
              <Checkbox label="Local ativo" checked={form.is_active} onChange={(v) => set("is_active", v)} />
              <p className="pl-6 text-xs text-ink-subtle">
                Inativo some da busca da Nova OS e do portal do cliente; o histórico continua.
              </p>
            </div>
          ) : null}
        </section>

        {tried && invalid ? <ErrorBox message="Confira os campos marcados antes de salvar." /> : null}
        {mutation.error ? <ErrorBox message={errorMessage(mutation.error)} /> : null}
      </form>
    </Dialog>
  );
}
