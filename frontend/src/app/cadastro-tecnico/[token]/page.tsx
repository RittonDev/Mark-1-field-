"use client";

import clsx from "clsx";
import { Camera, Check, CheckCircle2, ChevronLeft, ChevronRight, Plus, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { Button, Checkbox, ErrorBox, Field, Input, LoadingBlock, Select, Textarea } from "@/components/ui";
import { ApiError, errorMessage, request } from "@/lib/api";
import {
  isValidCpf,
  maskCpf,
  maskPhone,
  PRIVACY_NOTICE,
  resizePhoto,
  useOnboardingCatalog,
} from "@/lib/onboarding";

const UFS = "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" ");

const STEPS = ["Seus dados", "Atuação", "Região e disponibilidade", "Acesso e privacidade"];

const FIELD_LABEL: Record<string, string> = {
  full_name: "Nome completo",
  email: "E-mail",
  phone: "Celular",
  document: "CPF",
  city: "Cidade",
  state: "UF",
  company_document: "CNPJ",
  service_areas: "Áreas de atuação",
  coverage_area: "Região de atendimento",
  password: "Senha",
  privacy_consent: "Aviso de privacidade",
  photo: "Foto",
};

interface Skill {
  name: string;
  level: string;
}

interface FormState {
  full_name: string;
  email: string;
  phone: string;
  document: string;
  birth_date: string;
  postal_code: string;
  address: string;
  city: string;
  state: string;
  photo: string | null;
  service_areas: string[];
  years_experience: string;
  skills: Skill[];
  certifications: string;
  tools: string;
  company_document: string;
  coverage_area: string;
  availability: string[];
  has_vehicle: boolean;
  vehicle_type: string;
  has_driver_license: boolean;
  notes: string;
  password: string;
  password2: string;
  privacy_consent: boolean;
}

const EMPTY: FormState = {
  full_name: "",
  email: "",
  phone: "",
  document: "",
  birth_date: "",
  postal_code: "",
  address: "",
  city: "",
  state: "",
  photo: null,
  service_areas: [],
  years_experience: "",
  skills: [{ name: "", level: "intermediario" }],
  certifications: "",
  tools: "",
  company_document: "",
  coverage_area: "",
  availability: [],
  has_vehicle: false,
  vehicle_type: "carro",
  has_driver_license: false,
  notes: "",
  password: "",
  password2: "",
  privacy_consent: false,
};

/** Mensagem da API com o nome do campo em português (o técnico não vê nomes técnicos). */
function apiMessage(error: unknown): string {
  if (error instanceof ApiError && Array.isArray(error.detail)) {
    return (error.detail as { loc?: (string | number)[]; msg?: string }[])
      .map((d) => {
        const field = String(d.loc?.[d.loc.length - 1] ?? "");
        const msg = (d.msg ?? "inválido").replace(/^Value error, /, "");
        return FIELD_LABEL[field] ? `${FIELD_LABEL[field]}: ${msg}` : msg;
      })
      .join(" · ");
  }
  return errorMessage(error);
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
        active ? "border-brand bg-brand text-white" : "border-line bg-surface text-ink hover:border-brand",
      )}
    >
      {active ? <Check className="size-3.5" /> : null}
      {children}
    </button>
  );
}

export default function TechnicianSignupPage() {
  const { token } = useParams<{ token: string }>();
  const catalog = useOnboardingCatalog();
  const [check, setCheck] = useState<"loading" | "valid" | "invalid">("loading");
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    request<{ valid: boolean }>(`/public/onboarding/${encodeURIComponent(token)}`, { auth: false })
      .then((r) => alive && setCheck(r.valid ? "valid" : "invalid"))
      .catch(() => alive && setCheck("invalid"));
    return () => {
      alive = false;
    };
  }, [token]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggle = (key: "service_areas" | "availability", value: string) =>
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
    }));

  function validate(index: number): string | null {
    if (index === 0) {
      if (form.full_name.trim().split(/\s+/).length < 2) return "Informe seu nome completo.";
      if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) return "Informe um e-mail válido.";
      if (form.phone.replace(/\D/g, "").length < 10) return "Informe o celular com DDD.";
      if (!isValidCpf(form.document)) return "CPF inválido.";
      if (!form.city.trim() || !form.state) return "Informe cidade e UF.";
    }
    if (index === 1 && form.service_areas.length === 0) return "Escolha pelo menos uma área de atuação.";
    if (index === 2 && form.coverage_area.trim().length < 2) return "Informe a região que você atende.";
    if (index === 3) {
      if (form.password.length < 8) return "A senha precisa ter pelo menos 8 caracteres.";
      if (form.password !== form.password2) return "As senhas não conferem.";
      if (!form.privacy_consent) return "Para enviar, aceite o aviso de privacidade.";
    }
    return null;
  }

  function next() {
    const problem = validate(step);
    setStepError(problem);
    if (!problem) {
      setStep((s) => s + 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  async function submit() {
    const problem = validate(3);
    setStepError(problem);
    if (problem) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await request<{ protocol: string }>(`/public/onboarding/${encodeURIComponent(token)}`, {
        method: "POST",
        auth: false,
        body: {
          full_name: form.full_name,
          email: form.email,
          phone: form.phone,
          document: form.document,
          birth_date: form.birth_date || null,
          postal_code: form.postal_code || null,
          address: form.address || null,
          city: form.city,
          state: form.state,
          photo: form.photo,
          service_areas: form.service_areas,
          years_experience: form.years_experience ? Number(form.years_experience) : null,
          skills: form.skills.filter((s) => s.name.trim().length >= 2).map((s) => ({ ...s, name: s.name.trim() })),
          certifications: form.certifications || null,
          tools: form.tools || null,
          company_document: form.company_document || null,
          coverage_area: form.coverage_area,
          availability: form.availability,
          has_vehicle: form.has_vehicle,
          vehicle_type: form.has_vehicle ? form.vehicle_type : null,
          has_driver_license: form.has_driver_license,
          notes: form.notes || null,
          password: form.password,
          privacy_consent: form.privacy_consent,
        },
      });
      setProtocol(res.protocol);
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) setCheck("invalid");
      setSubmitError(apiMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  const cat = catalog.data;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="mx-auto flex max-w-2xl items-center justify-between px-4 pt-6">
        <Logo />
        <ThemeToggle />
      </header>
      <div className="brand-gradient mx-auto mt-3 h-1 max-w-2xl rounded-full" />
      <main className="mx-auto max-w-2xl px-4 py-6">
        {check === "loading" || catalog.isLoading ? (
          <LoadingBlock />
        ) : check === "invalid" && !protocol ? (
          <Panel
            icon={<XCircle className="size-10 text-red-500" />}
            title="Link indisponível"
            text="Este link de cadastro expirou, foi cancelado ou já foi usado. Peça um novo link à equipe da Maxx Field."
          />
        ) : protocol ? (
          <Panel
            icon={<CheckCircle2 className="size-10 text-emerald-500" />}
            title="Ficha enviada!"
            text={`Protocolo ${protocol}. Nossa equipe vai analisar seu cadastro. Quando for aprovado, baixe o app Maxx Field e entre com o e-mail ${form.email.trim().toLowerCase()} e a senha que você criou.`}
          />
        ) : (
          <div className="rounded-xl border border-line bg-surface shadow-xs">
            <div className="border-b border-line px-5 py-4">
              <h1 className="text-lg font-semibold text-ink">Cadastro de técnico parceiro</h1>
              <p className="mt-0.5 text-sm text-ink-muted">
                Etapa {step + 1} de {STEPS.length}: {STEPS[step]}
              </p>
              <div className="mt-3 flex gap-1.5" aria-hidden>
                {STEPS.map((s, i) => (
                  <span key={s} className={clsx("h-1.5 flex-1 rounded-full", i <= step ? "brand-gradient" : "bg-surface-2")} />
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-4 px-5 py-5">
              {step === 0 ? (
                <>
                  <PhotoPicker value={form.photo} onChange={(v) => set("photo", v)} name={form.full_name} />
                  <Field label="Nome completo" required>
                    <Input value={form.full_name} onChange={(e) => set("full_name", e.target.value)} autoComplete="name" />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="E-mail" required hint="Será o seu login no app.">
                      <Input
                        type="email"
                        value={form.email}
                        onChange={(e) => set("email", e.target.value)}
                        autoComplete="email"
                        inputMode="email"
                      />
                    </Field>
                    <Field label="Celular (WhatsApp)" required>
                      <Input
                        value={form.phone}
                        onChange={(e) => set("phone", maskPhone(e.target.value))}
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="(11) 90000-0000"
                      />
                    </Field>
                    <Field label="CPF" required>
                      <Input
                        value={form.document}
                        onChange={(e) => set("document", maskCpf(e.target.value))}
                        inputMode="numeric"
                        placeholder="000.000.000-00"
                        aria-invalid={form.document.length === 14 && !isValidCpf(form.document)}
                      />
                    </Field>
                    <Field label="Data de nascimento">
                      <Input type="date" value={form.birth_date} onChange={(e) => set("birth_date", e.target.value)} />
                    </Field>
                    <Field label="CEP">
                      <Input
                        value={form.postal_code}
                        onChange={(e) => set("postal_code", e.target.value)}
                        inputMode="numeric"
                        autoComplete="postal-code"
                      />
                    </Field>
                    <Field label="Endereço">
                      <Input
                        value={form.address}
                        onChange={(e) => set("address", e.target.value)}
                        autoComplete="street-address"
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-[1fr_6rem] gap-4">
                    <Field label="Cidade" required>
                      <Input value={form.city} onChange={(e) => set("city", e.target.value)} autoComplete="address-level2" />
                    </Field>
                    <Field label="UF" required>
                      <Select value={form.state} onChange={(e) => set("state", e.target.value)}>
                        <option value="">—</option>
                        {UFS.map((uf) => (
                          <option key={uf} value={uf}>
                            {uf}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                </>
              ) : null}

              {step === 1 && cat ? (
                <>
                  <Group label="Em que você atende?" required hint="Escolha todas as áreas em que tem experiência.">
                    <div className="flex flex-wrap gap-2">
                      {cat.service_areas.map((a) => (
                        <Chip key={a.key} active={form.service_areas.includes(a.key)} onClick={() => toggle("service_areas", a.key)}>
                          {a.label}
                        </Chip>
                      ))}
                    </div>
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Anos de experiência">
                      <Input
                        type="number"
                        min={0}
                        max={60}
                        value={form.years_experience}
                        onChange={(e) => set("years_experience", e.target.value)}
                      />
                    </Field>
                    <Field label="CNPJ / MEI" hint="Se você emite nota.">
                      <Input value={form.company_document} onChange={(e) => set("company_document", e.target.value)} />
                    </Field>
                  </div>
                  <Group label="Skills" hint="Equipamentos, marcas e sistemas que você domina.">
                    <div className="flex flex-col gap-2">
                      <datalist id="skill-suggestions">
                        {cat.skill_suggestions.map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                      {form.skills.map((skill, i) => (
                        <div key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_10rem_auto]">
                          <Input
                            className="col-span-2 sm:col-span-1"
                            list="skill-suggestions"
                            value={skill.name}
                            placeholder="Ex.: DVR/NVR Intelbras"
                            aria-label={`Skill ${i + 1}`}
                            onChange={(e) =>
                              set(
                                "skills",
                                form.skills.map((s, j) => (j === i ? { ...s, name: e.target.value } : s)),
                              )
                            }
                          />
                          <Select
                            value={skill.level}
                            aria-label={`Nível da skill ${i + 1}`}
                            onChange={(e) =>
                              set(
                                "skills",
                                form.skills.map((s, j) => (j === i ? { ...s, level: e.target.value } : s)),
                              )
                            }
                          >
                            {cat.skill_levels.map((l) => (
                              <option key={l.key} value={l.key}>
                                {l.label}
                              </option>
                            ))}
                          </Select>
                          <button
                            type="button"
                            onClick={() => set("skills", form.skills.filter((_, j) => j !== i))}
                            className="shrink-0 rounded-md p-2 text-ink-muted hover:bg-surface-2 hover:text-red-600"
                            aria-label={`Remover skill ${i + 1}`}
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      ))}
                      {form.skills.length < 30 ? (
                        <Button
                          className="self-start"
                          onClick={() => set("skills", [...form.skills, { name: "", level: "intermediario" }])}
                        >
                          <Plus className="size-4" />
                          Adicionar skill
                        </Button>
                      ) : null}
                    </div>
                  </Group>
                  <Field label="Certificações e cursos">
                    <Textarea rows={2} value={form.certifications} onChange={(e) => set("certifications", e.target.value)} />
                  </Field>
                  <Field label="Ferramentas próprias" hint="Ex.: alicate de crimpagem, testador de cabos, máquina de fusão.">
                    <Textarea rows={2} value={form.tools} onChange={(e) => set("tools", e.target.value)} />
                  </Field>
                </>
              ) : null}

              {step === 2 && cat ? (
                <>
                  <Field label="Região que você atende" required hint="Cidades, bairros ou zonas.">
                    <Textarea
                      rows={2}
                      value={form.coverage_area}
                      onChange={(e) => set("coverage_area", e.target.value)}
                      placeholder="Ex.: Guarulhos, Zona Leste e Centro de São Paulo"
                    />
                  </Field>
                  <Group label="Disponibilidade">
                    <div className="flex flex-wrap gap-2">
                      {cat.availability.map((a) => (
                        <Chip key={a.key} active={form.availability.includes(a.key)} onClick={() => toggle("availability", a.key)}>
                          {a.label}
                        </Chip>
                      ))}
                    </div>
                  </Group>
                  <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
                    <Checkbox label="Tenho veículo próprio para os atendimentos" checked={form.has_vehicle} onChange={(v) => set("has_vehicle", v)} />
                    {form.has_vehicle ? (
                      <Select value={form.vehicle_type} onChange={(e) => set("vehicle_type", e.target.value)} aria-label="Tipo de veículo">
                        {cat.vehicle_types.map((v) => (
                          <option key={v.key} value={v.key}>
                            {v.label}
                          </option>
                        ))}
                      </Select>
                    ) : null}
                    <Checkbox label="Tenho CNH válida" checked={form.has_driver_license} onChange={(v) => set("has_driver_license", v)} />
                  </div>
                  <Field label="Observações">
                    <Textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
                  </Field>
                </>
              ) : null}

              {step === 3 ? (
                <>
                  <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink">
                    Seu login no app será <strong>{form.email.trim().toLowerCase() || "o e-mail informado"}</strong>. Crie uma
                    senha:
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Senha" required hint="Mínimo de 8 caracteres.">
                      <Input
                        type="password"
                        value={form.password}
                        onChange={(e) => set("password", e.target.value)}
                        autoComplete="new-password"
                      />
                    </Field>
                    <Field label="Confirme a senha" required>
                      <Input
                        type="password"
                        value={form.password2}
                        onChange={(e) => set("password2", e.target.value)}
                        autoComplete="new-password"
                      />
                    </Field>
                  </div>
                  <section className="rounded-lg border border-line" aria-labelledby="privacy-title">
                    <h2 id="privacy-title" className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-semibold text-ink">
                      <ShieldCheck className="size-4 text-brand" />
                      Aviso de privacidade (LGPD)
                    </h2>
                    <dl className="max-h-64 space-y-2 overflow-y-auto px-3 py-2 text-sm">
                      {PRIVACY_NOTICE.map((item) => (
                        <div key={item.title}>
                          <dt className="font-medium text-ink">{item.title}</dt>
                          <dd className="text-ink-muted">{item.body}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                  <Checkbox
                    label="Li o aviso de privacidade e concordo com o tratamento dos meus dados para a homologação e o cadastro na base técnica."
                    checked={form.privacy_consent}
                    onChange={(v) => set("privacy_consent", v)}
                  />
                  {submitError ? <ErrorBox message={submitError} /> : null}
                </>
              ) : null}

              {stepError ? <ErrorBox message={stepError} /> : null}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
              <Button onClick={() => setStep((s) => s - 1)} disabled={step === 0} className={step === 0 ? "invisible" : ""}>
                <ChevronLeft className="size-4" />
                Voltar
              </Button>
              {step < STEPS.length - 1 ? (
                <Button variant="primary" onClick={next}>
                  Continuar
                  <ChevronRight className="size-4" />
                </Button>
              ) : (
                <Button variant="primary" onClick={submit} loading={submitting}>
                  Enviar ficha
                </Button>
              )}
            </div>
          </div>
        )}
        <p className="mt-6 text-center text-xs text-ink-muted">Maxx Field · seus dados são protegidos conforme a LGPD</p>
      </main>
    </div>
  );
}

function Panel({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface px-6 py-10 text-center shadow-xs">
      {icon}
      <h1 className="text-lg font-semibold text-ink">{title}</h1>
      <p className="max-w-md text-sm text-ink-muted">{text}</p>
    </div>
  );
}

function PhotoPicker({ value, onChange, name }: { value: string | null; onChange: (v: string | null) => void; name: string }) {
  const [error, setError] = useState<string | null>(null);
  const initialsText = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className="flex items-center gap-4">
      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-surface-2 text-xl font-semibold text-ink-muted">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element -- prévia local (data URL)
          <img src={value} alt="Sua foto" className="size-full object-cover" />
        ) : (
          initialsText || <Camera className="size-6" />
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="inline-flex cursor-pointer items-center gap-2 self-start rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2">
          <Camera className="size-4" />
          {value ? "Trocar foto" : "Adicionar foto"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="user"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setError(null);
              try {
                onChange(await resizePhoto(file));
              } catch {
                setError("Não foi possível usar esta imagem.");
              }
            }}
          />
        </label>
        <span className="text-xs text-ink-muted">Foto do rosto, de frente (opcional). Aparece para o cliente na visita.</span>
        {value ? (
          <button type="button" className="self-start text-xs text-red-600 hover:underline" onClick={() => onChange(null)}>
            Remover foto
          </button>
        ) : null}
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
      </div>
    </div>
  );
}

/** Como o Field, mas para grupos de controles (chips, listas): um <label> ativaria o primeiro. */
function Group({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-xs font-medium text-ink-muted">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </legend>
      {children}
      {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
    </fieldset>
  );
}
