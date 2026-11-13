"use client";

import clsx from "clsx";
import {
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  WifiOff,
  XCircle,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { useConfirm } from "@/components/Confirm";
import { Button, buttonClassName, Card, Checkbox, ErrorBox, Field, Input, LoadingBlock, Select, Textarea } from "@/components/ui";
import { ApiError, errorMessage, request } from "@/lib/api";
import { formatDate } from "@/lib/format";
import {
  isValidCnpj,
  isValidCpf,
  maskCep,
  maskCnpj,
  maskCpf,
  maskPhone,
  PRIVACY_NOTICE,
  resizePhoto,
  UFS,
  useOnboardingCatalog,
} from "@/lib/onboarding";

const STEPS = ["Seus dados", "Atuação", "Região e disponibilidade", "Acesso e privacidade"];

/** Nome de cada campo para o técnico (a API devolve o nome técnico) e a etapa em que ele está. */
const FIELDS: Record<string, { label: string; step: number }> = {
  full_name: { label: "Nome completo", step: 0 },
  email: { label: "E-mail", step: 0 },
  phone: { label: "Celular", step: 0 },
  document: { label: "CPF", step: 0 },
  birth_date: { label: "Data de nascimento", step: 0 },
  postal_code: { label: "CEP", step: 0 },
  address: { label: "Endereço", step: 0 },
  city: { label: "Cidade", step: 0 },
  state: { label: "UF", step: 0 },
  photo: { label: "Foto", step: 0 },
  service_areas: { label: "Áreas de atuação", step: 1 },
  years_experience: { label: "Anos de experiência", step: 1 },
  company_document: { label: "CNPJ / MEI", step: 1 },
  skills: { label: "Skills", step: 1 },
  certifications: { label: "Certificações e cursos", step: 1 },
  tools: { label: "Ferramentas próprias", step: 1 },
  coverage_area: { label: "Região que você atende", step: 2 },
  availability: { label: "Disponibilidade", step: 2 },
  has_vehicle: { label: "Veículo", step: 2 },
  vehicle_type: { label: "Tipo de veículo", step: 2 },
  has_driver_license: { label: "CNH", step: 2 },
  notes: { label: "Observações", step: 2 },
  password: { label: "Senha", step: 3 },
  privacy_consent: { label: "Aviso de privacidade", step: 3 },
};

/** O que está errado e em qual campo (para marcar, levar até ele e anunciar). */
interface Problem {
  field: string | null;
  message: string;
}

interface ValidationIssue {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
  ctx?: Record<string, unknown>;
}

/** Mensagem do Pydantic em português simples (sem nomes técnicos nem inglês). */
function translateIssue(issue: ValidationIssue): { text: string; withLabel: boolean } {
  const ctx = issue.ctx ?? {};
  const msg = (issue.msg ?? "").replace(/^Value error, /, "");
  switch (issue.type) {
    case "missing":
      return { text: "obrigatório", withLabel: true };
    case "string_too_short":
      return { text: `mínimo de ${ctx.min_length} caracteres`, withLabel: true };
    case "string_too_long":
      return { text: `máximo de ${ctx.max_length} caracteres`, withLabel: true };
    case "too_short":
      return { text: `escolha pelo menos ${ctx.min_length}`, withLabel: true };
    case "too_long":
      return { text: `no máximo ${ctx.max_length}`, withLabel: true };
    case "less_than_equal":
      return { text: `no máximo ${ctx.le}`, withLabel: true };
    case "greater_than_equal":
      return { text: `no mínimo ${ctx.ge}`, withLabel: true };
    case "int_parsing":
    case "int_type":
    case "int_from_float":
      return { text: "use um número inteiro", withLabel: true };
    case "date_parsing":
    case "date_from_datetime_parsing":
    case "date_type":
      return { text: "data inválida", withLabel: true };
    case "literal_error":
      return { text: "opção inválida", withLabel: true };
    case "value_error":
      // E-mail recusado pelo validador vem em inglês; os nossos ("CPF inválido") já vêm em português.
      return /valid email/i.test(msg) ? { text: "e-mail inválido", withLabel: true } : { text: msg || "inválido", withLabel: false };
    default:
      return { text: "inválido", withLabel: true };
  }
}

/** Erro da API para a pessoa: o primeiro campo recusado (para levar até ele) e a mensagem em português. */
function apiProblem(error: unknown): Problem {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return { field: null, message: "Sem internet. Confira o sinal e toque em “Enviar ficha” de novo." };
    }
    if (Array.isArray(error.detail)) {
      const issues = error.detail as ValidationIssue[];
      const fieldOf = (issue: ValidationIssue) =>
        (issue.loc ?? []).find((p): p is string => typeof p === "string" && p in FIELDS) ?? null;
      const message = issues
        .map((issue) => {
          const field = fieldOf(issue);
          const { text, withLabel } = translateIssue(issue);
          return field && withLabel ? `${FIELDS[field].label}: ${text}` : text;
        })
        .join(" · ");
      return { field: issues.map(fieldOf).find(Boolean) ?? null, message };
    }
    if (typeof error.detail === "string" && error.detail) {
      return { field: /e-mail/i.test(error.detail) ? "email" : null, message: error.detail };
    }
    if (error.status >= 500) {
      return { field: null, message: "O servidor não respondeu agora. Espere um pouco e toque em “Enviar ficha” de novo." };
    }
  }
  return { field: null, message: errorMessage(error) };
}

/** Idade completa na data de hoje (null quando a data não é válida). */
function ageToday(birth: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const today = new Date();
  let age = today.getFullYear() - year;
  if (today.getMonth() + 1 < month || (today.getMonth() + 1 === month && today.getDate() < day)) age -= 1;
  return age;
}

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

/*
 * Rascunho neste aparelho: o navegador do celular descarta a aba quando a pessoa vai ao WhatsApp ou à
 * câmera, e a ficha voltava em branco. Fica 24 h, sem senha e sem foto, e some ao enviar. A chave é
 * fixa: se o link expirar no meio, um link novo abre a ficha já preenchida.
 */
const DRAFT_KEY = "mf-cadastro-tecnico";
const DRAFT_TTL_MS = 24 * 3_600_000;
const DRAFT_FIELDS = [
  "full_name",
  "email",
  "phone",
  "document",
  "birth_date",
  "postal_code",
  "address",
  "city",
  "state",
  "service_areas",
  "years_experience",
  "skills",
  "certifications",
  "tools",
  "company_document",
  "coverage_area",
  "availability",
  "has_vehicle",
  "vehicle_type",
  "has_driver_license",
  "notes",
] as const satisfies readonly (keyof FormState)[];
const SKILL_LEVELS = ["basico", "intermediario", "avancado"];

function hasContent(form: FormState): boolean {
  return DRAFT_FIELDS.some((key) => JSON.stringify(form[key]) !== JSON.stringify(EMPTY[key]));
}

/** Rascunho salvo (validado campo a campo: o que estiver fora do formato fica vazio). */
function loadDraft(): { form: FormState; step: number } | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { savedAt?: number; step?: number; form?: Record<string, unknown> };
    if (!saved.savedAt || Date.now() - saved.savedAt > DRAFT_TTL_MS || !saved.form) {
      window.localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    const form: FormState = { ...EMPTY };
    const target = form as unknown as Record<string, unknown>;
    for (const key of DRAFT_FIELDS) {
      const value = saved.form[key];
      const base = EMPTY[key];
      if (key === "skills") {
        if (Array.isArray(value)) {
          form.skills = value
            .filter((s): s is { name?: unknown; level?: unknown } => !!s && typeof s === "object")
            .slice(0, 30)
            .map((s) => ({
              name: typeof s.name === "string" ? s.name : "",
              level: typeof s.level === "string" && SKILL_LEVELS.includes(s.level) ? s.level : "intermediario",
            }));
        }
      } else if (Array.isArray(base) ? Array.isArray(value) && value.every((v) => typeof v === "string") : typeof value === typeof base) {
        target[key] = value;
      }
    }
    const step = Math.min(Math.max(Math.trunc(Number(saved.step) || 0), 0), STEPS.length - 1);
    return { form, step };
  } catch {
    return null;
  }
}

function saveDraft(form: FormState, step: number) {
  try {
    if (!hasContent(form)) {
      window.localStorage.removeItem(DRAFT_KEY);
      return;
    }
    const data = Object.fromEntries(DRAFT_FIELDS.map((key) => [key, form[key]]));
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), step, form: data }));
  } catch {
    // Sem armazenamento (aba anônima, bloqueio): a ficha funciona, só sem rascunho.
  }
}

function clearDraft() {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Idem.
  }
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none",
        // No escuro, o azul forte: o branco sobre o azul da marca ficava abaixo de 4,5:1.
        active ? "border-brand bg-brand text-white dark:border-brand-strong dark:bg-brand-strong" : "border-line bg-surface text-ink hover:border-brand",
      )}
    >
      {active ? <Check className="size-3.5" /> : null}
      {children}
    </button>
  );
}

type LinkCheck = "loading" | "valid" | "invalid" | "error";

function scrollTop() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

export default function TechnicianSignupPage() {
  const { token } = useParams<{ token: string }>();
  const catalog = useOnboardingCatalog();
  const confirm = useConfirm();
  const [check, setCheck] = useState<LinkCheck>("loading");
  // Nova tentativa de abrir o link (sem internet ou servidor fora do ar no primeiro acesso).
  const [attempt, setAttempt] = useState(0);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  // O link expirou enquanto a pessoa preenchia: os dados ficam no rascunho para um link novo.
  const [expiredWhileFilling, setExpiredWhileFilling] = useState(false);
  const [draft] = useState(loadDraft);
  const [step, setStep] = useState(draft?.step ?? 0);
  const [form, setForm] = useState<FormState>(draft?.form ?? EMPTY);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [protocol, setProtocol] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const stepRef = useRef<HTMLParagraphElement>(null);
  const focusStepRef = useRef(false);

  useEffect(() => {
    let alive = true;
    request<{ valid: boolean; expires_at?: string | null }>(`/public/onboarding/${encodeURIComponent(token)}`, { auth: false })
      .then((r) => {
        if (!alive) return;
        setCheck(r.valid ? "valid" : "invalid");
        setExpiresAt(r.expires_at ?? null);
      })
      .catch((error) => {
        // 4xx: o link não serve. Sem internet (0) ou erro do servidor (5xx): dá para tentar de novo.
        if (alive) setCheck(error instanceof ApiError && error.status >= 400 && error.status < 500 ? "invalid" : "error");
      });
    return () => {
      alive = false;
    };
  }, [token, attempt]);

  // Rascunho neste aparelho enquanto a pessoa preenche (some depois do envio).
  useEffect(() => {
    if (protocol) return;
    const id = window.setTimeout(() => saveDraft(form, step), 600);
    return () => window.clearTimeout(id);
  }, [form, step, protocol]);

  // Etapa nova: o foco vai para o título da etapa (o leitor de tela anuncia onde a pessoa está).
  useEffect(() => {
    if (!focusStepRef.current) return;
    focusStepRef.current = false;
    stepRef.current?.focus({ preventScroll: true });
  }, [step]);

  // Problema num campo: marca, leva até ele e põe o foco ali.
  useEffect(() => {
    const field = problem?.field;
    const root = formRef.current;
    if (!field || !root) return;
    const target =
      root.querySelector<HTMLElement>(`[name="${field}"]`) ??
      root.querySelector<HTMLElement>(`[data-field="${field}"] input, [data-field="${field}"] button`);
    target?.focus();
  }, [problem]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggle = (key: "service_areas" | "availability", value: string) =>
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
    }));
  /** Marca o campo com problema para o leitor de tela (aponta para a mensagem). */
  const invalid = (field: string) =>
    problem?.field === field ? { "aria-invalid": true as const, "aria-describedby": "form-problem" } : {};

  function validate(index: number): Problem | null {
    const fail = (field: string, message: string): Problem => ({ field, message });
    if (index === 0) {
      const name = form.full_name.trim();
      if (name.length < 5 || name.split(/\s+/).length < 2) return fail("full_name", "Informe seu nome completo (nome e sobrenome).");
      if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) return fail("email", "Informe um e-mail válido: ele será o seu login no app.");
      if (form.phone.replace(/\D/g, "").length < 10) return fail("phone", "Informe o celular com DDD.");
      if (!isValidCpf(form.document)) return fail("document", "CPF inválido: confira os números.");
      if (form.birth_date) {
        const age = ageToday(form.birth_date);
        if (age === null || age > 100 || age < 0) return fail("birth_date", "Confira a data de nascimento.");
        if (age < 18) return fail("birth_date", "É preciso ter 18 anos ou mais para se cadastrar.");
      }
      const cep = form.postal_code.replace(/\D/g, "");
      if (cep && cep.length !== 8) return fail("postal_code", "CEP inválido: use os 8 números.");
      if (form.city.trim().length < 2) return fail("city", "Informe a cidade.");
      if (!form.state) return fail("state", "Escolha a UF.");
    }
    if (index === 1) {
      if (form.service_areas.length === 0) return fail("service_areas", "Escolha pelo menos uma área de atuação.");
      const yearsText = form.years_experience.trim();
      if (yearsText) {
        const years = Number(yearsText);
        if (!Number.isInteger(years) || years < 0 || years > 60) {
          return fail("years_experience", "Anos de experiência: use um número de 0 a 60.");
        }
      }
      if (form.company_document.trim() && !isValidCnpj(form.company_document)) {
        return fail("company_document", "CNPJ inválido: confira os números (ou deixe em branco).");
      }
    }
    if (index === 2 && form.coverage_area.trim().length < 2) return fail("coverage_area", "Informe a região que você atende.");
    if (index === 3) {
      if (form.password.length < 8) return fail("password", "A senha precisa ter pelo menos 8 caracteres.");
      if (form.password !== form.password2) return fail("password2", "As senhas não conferem.");
      if (!form.privacy_consent) return fail("privacy_consent", "Para enviar, aceite o aviso de privacidade.");
    }
    return null;
  }

  function goTo(index: number) {
    focusStepRef.current = true;
    setStep(index);
    scrollTop();
  }

  function next() {
    const found = validate(step);
    setProblem(found);
    if (!found) goTo(step + 1);
  }

  function back() {
    setProblem(null);
    goTo(step - 1);
  }

  async function submit() {
    // Confere todas as etapas (um rascunho antigo pode ter pulado alguma) e leva até a primeira com problema.
    for (let index = 0; index < STEPS.length; index++) {
      const found = validate(index);
      if (found) {
        setStep(index);
        setProblem(found);
        return;
      }
    }
    setProblem(null);
    setSubmitting(true);
    try {
      const res = await request<{ protocol: string }>(`/public/onboarding/${encodeURIComponent(token)}`, {
        method: "POST",
        auth: false,
        body: {
          full_name: form.full_name.trim(),
          email: form.email.trim(),
          phone: form.phone,
          document: form.document,
          birth_date: form.birth_date || null,
          postal_code: form.postal_code.trim() || null,
          address: form.address.trim() || null,
          city: form.city.trim(),
          state: form.state,
          photo: form.photo,
          service_areas: form.service_areas,
          years_experience: form.years_experience.trim() ? Number(form.years_experience) : null,
          skills: form.skills.filter((s) => s.name.trim().length >= 2).map((s) => ({ ...s, name: s.name.trim() })),
          certifications: form.certifications.trim() || null,
          tools: form.tools.trim() || null,
          company_document: form.company_document.trim() || null,
          coverage_area: form.coverage_area.trim(),
          availability: form.availability,
          has_vehicle: form.has_vehicle,
          vehicle_type: form.has_vehicle ? form.vehicle_type : null,
          has_driver_license: form.has_driver_license,
          notes: form.notes.trim() || null,
          password: form.password,
          privacy_consent: form.privacy_consent,
        },
      });
      clearDraft();
      setProtocol(res.protocol);
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        // O rascunho continua salvo: com um link novo, a ficha volta preenchida.
        saveDraft(form, step);
        setExpiredWhileFilling(true);
        setCheck("invalid");
        return;
      }
      const found = apiProblem(error);
      const target = found.field ? FIELDS[found.field]?.step : undefined;
      if (target !== undefined && target !== step) setStep(target);
      setProblem(found);
    } finally {
      setSubmitting(false);
    }
  }

  const restart = async () => {
    const ok = await confirm({
      tone: "danger",
      title: "Apagar o que você preencheu?",
      description: "Os dados saem deste aparelho e a ficha volta para o começo.",
      confirmLabel: "Apagar e recomeçar",
    });
    if (!ok) return;
    clearDraft();
    setForm(EMPTY);
    setProblem(null);
    goTo(0);
  };

  const cat = catalog.data;
  const last = step === STEPS.length - 1;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="mx-auto flex max-w-2xl items-center justify-between px-4 pt-6">
        <Logo />
        <ThemeToggle />
      </header>
      <div className="brand-gradient mx-auto mt-3 h-1 max-w-2xl rounded-full" />
      <main className="mx-auto max-w-2xl px-4 py-6">
        {protocol ? (
          <Panel
            icon={<CheckCircle2 className="size-10 text-brand" />}
            title="Ficha enviada!"
            text={`Protocolo ${protocol}. A equipe analisa o seu cadastro e te avisa pelo WhatsApp como instalar o app. Seu login será ${form.email.trim().toLowerCase()}, com a senha que você criou.`}
          />
        ) : check === "loading" || (catalog.isLoading && check === "valid") ? (
          <LoadingBlock />
        ) : check === "invalid" ? (
          expiredWhileFilling ? (
            <Panel
              icon={<XCircle className="size-10 text-red-600 dark:text-red-400" />}
              title="O link expirou enquanto você preenchia"
              text="Peça um novo link à equipe da Maxx Field. Seus dados ficam salvos neste aparelho por 24 horas: ao abrir o link novo, a ficha volta preenchida (só a senha e a foto você informa de novo)."
            />
          ) : (
            <Panel
              icon={<XCircle className="size-10 text-red-600 dark:text-red-400" />}
              title="Link indisponível"
              text="Este link de cadastro expirou, foi cancelado ou já foi usado. Peça um novo link à equipe da Maxx Field."
            />
          )
        ) : check === "error" ? (
          <Panel
            icon={<WifiOff className="size-10 text-ink-muted" />}
            title="Sem conexão"
            text="Não conseguimos abrir a ficha agora. Confira a internet do celular e tente de novo."
            action={
              <Button
                variant="primary"
                onClick={() => {
                  setCheck("loading");
                  setAttempt((n) => n + 1);
                }}
              >
                Tentar de novo
              </Button>
            }
          />
        ) : catalog.error && !cat ? (
          <Panel
            icon={<WifiOff className="size-10 text-ink-muted" />}
            title="Não foi possível carregar a ficha"
            text="Confira a internet do celular e tente de novo."
            action={
              <Button variant="primary" loading={catalog.isFetching} onClick={() => void catalog.refetch()}>
                Tentar de novo
              </Button>
            }
          />
        ) : (
          <form
            ref={formRef}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (submitting) return;
              if (last) void submit();
              else next();
            }}
          >
            <Card className="overflow-hidden">
              <div className="border-b border-line px-5 py-4">
                <h1 className="text-lg font-bold tracking-[-0.02em] text-ink">Cadastro de técnico parceiro</h1>
                <p ref={stepRef} tabIndex={-1} className="mt-0.5 text-sm text-ink-muted outline-none">
                  Etapa {step + 1} de {STEPS.length}: {STEPS[step]}
                </p>
                {expiresAt ? <p className="mt-0.5 text-xs text-ink-muted">Link válido até {formatDate(expiresAt)}.</p> : null}
                <div className="mt-3 flex gap-1.5" aria-hidden>
                  {STEPS.map((s, i) => (
                    <span key={s} className={clsx("h-1.5 flex-1 rounded-full", i <= step ? "brand-gradient" : "bg-surface-3")} />
                  ))}
                </div>
              </div>

              {/* No celular, campos com letra de 16 px e mais altos: abaixo disso o iPhone dá zoom em cada campo. */}
              <div className="flex flex-col gap-4 px-5 py-5 [&_input:not([type=checkbox])]:h-11 [&_input]:text-base [&_select]:h-11 [&_select]:text-base [&_textarea]:text-base sm:[&_input:not([type=checkbox])]:h-9 sm:[&_input]:text-sm sm:[&_select]:h-9 sm:[&_select]:text-sm sm:[&_textarea]:text-sm">
              {step === 0 ? (
                <>
                  <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm">
                    <p className="flex items-start gap-2 text-ink">
                      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" />
                      Usamos seus dados só para avaliar o cadastro e, se você for aprovado, para os atendimentos.
                    </p>
                    <details className="mt-1.5 pl-6">
                      <summary className="cursor-pointer rounded text-xs font-semibold text-brand-ink underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none">
                        Ler o aviso de privacidade
                      </summary>
                      <PrivacyNotice className="mt-2" />
                    </details>
                  </div>
                  <div data-field="photo">
                    <PhotoPicker value={form.photo} onChange={(v) => set("photo", v)} name={form.full_name} />
                  </div>
                  <Field label="Nome completo" required>
                    <Input
                      name="full_name"
                      value={form.full_name}
                      onChange={(e) => set("full_name", e.target.value)}
                      autoComplete="name"
                      {...invalid("full_name")}
                    />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="E-mail" required hint="Será o seu login no app.">
                      <Input
                        name="email"
                        type="email"
                        value={form.email}
                        onChange={(e) => set("email", e.target.value)}
                        autoComplete="email"
                        inputMode="email"
                        autoCapitalize="none"
                        {...invalid("email")}
                      />
                    </Field>
                    <Field label="Celular (WhatsApp)" required>
                      <Input
                        name="phone"
                        value={form.phone}
                        onChange={(e) => set("phone", maskPhone(e.target.value))}
                        inputMode="tel"
                        autoComplete="tel-national"
                        placeholder="(11) 90000-0000"
                        {...invalid("phone")}
                      />
                    </Field>
                    <Field label="CPF" required>
                      <Input
                        name="document"
                        value={form.document}
                        onChange={(e) => set("document", maskCpf(e.target.value))}
                        inputMode="numeric"
                        placeholder="000.000.000-00"
                        {...(problem?.field === "document"
                          ? invalid("document")
                          : { "aria-invalid": form.document.length === 14 && !isValidCpf(form.document) })}
                      />
                    </Field>
                    <Field label="Data de nascimento" hint="É preciso ter 18 anos ou mais.">
                      <Input
                        name="birth_date"
                        type="date"
                        value={form.birth_date}
                        onChange={(e) => set("birth_date", e.target.value)}
                        autoComplete="bday"
                        {...invalid("birth_date")}
                      />
                    </Field>
                    <Field label="CEP">
                      <Input
                        name="postal_code"
                        value={form.postal_code}
                        onChange={(e) => set("postal_code", maskCep(e.target.value))}
                        inputMode="numeric"
                        autoComplete="postal-code"
                        placeholder="00000-000"
                        {...invalid("postal_code")}
                      />
                    </Field>
                    <Field label="Endereço">
                      <Input
                        name="address"
                        value={form.address}
                        onChange={(e) => set("address", e.target.value)}
                        autoComplete="street-address"
                        maxLength={255}
                        {...invalid("address")}
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-[1fr_6rem] gap-4">
                    <Field label="Cidade" required>
                      <Input
                        name="city"
                        value={form.city}
                        onChange={(e) => set("city", e.target.value)}
                        autoComplete="address-level2"
                        maxLength={120}
                        {...invalid("city")}
                      />
                    </Field>
                    <Field label="UF" required>
                      <Select
                        name="state"
                        value={form.state}
                        onChange={(e) => set("state", e.target.value)}
                        autoComplete="address-level1"
                        {...invalid("state")}
                      >
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
                  <Group label="Em que você atende?" required hint="Escolha todas as áreas em que tem experiência." field="service_areas">
                    <div className="flex flex-wrap gap-2">
                      {cat.service_areas.map((a) => (
                        <Chip key={a.key} active={form.service_areas.includes(a.key)} onClick={() => toggle("service_areas", a.key)}>
                          {a.label}
                        </Chip>
                      ))}
                    </div>
                  </Group>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Anos de experiência">
                      <Input
                        name="years_experience"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={60}
                        step={1}
                        value={form.years_experience}
                        onChange={(e) => set("years_experience", e.target.value)}
                        {...invalid("years_experience")}
                      />
                    </Field>
                    <Field label="CNPJ / MEI" hint="Se você emite nota.">
                      <Input
                        name="company_document"
                        value={form.company_document}
                        onChange={(e) => set("company_document", maskCnpj(e.target.value))}
                        placeholder="00.000.000/0000-00"
                        autoCapitalize="characters"
                        {...invalid("company_document")}
                      />
                    </Field>
                  </div>
                  <Group label="Skills" hint="Equipamentos, marcas e sistemas que você domina." field="skills">
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
                            className="shrink-0 rounded-md p-2.5 text-ink-muted hover:bg-surface-2 hover:text-red-700 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none dark:hover:text-red-400"
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
                      name="coverage_area"
                      rows={2}
                      value={form.coverage_area}
                      onChange={(e) => set("coverage_area", e.target.value)}
                      placeholder="Ex.: Guarulhos, Zona Leste e Centro de São Paulo"
                      maxLength={1000}
                      {...invalid("coverage_area")}
                    />
                  </Field>
                  <Group label="Disponibilidade" field="availability">
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
                        name="password"
                        type="password"
                        value={form.password}
                        onChange={(e) => set("password", e.target.value)}
                        autoComplete="new-password"
                        maxLength={128}
                        {...invalid("password")}
                      />
                    </Field>
                    <Field label="Confirme a senha" required>
                      <Input
                        name="password2"
                        type="password"
                        value={form.password2}
                        onChange={(e) => set("password2", e.target.value)}
                        autoComplete="new-password"
                        maxLength={128}
                        {...invalid("password2")}
                      />
                    </Field>
                  </div>
                  <section className="rounded-lg border border-line" aria-labelledby="privacy-title">
                    <h2 id="privacy-title" className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-bold text-ink">
                      <ShieldCheck className="size-4 text-brand" />
                      Aviso de privacidade (LGPD)
                    </h2>
                    <PrivacyNotice className="max-h-64 overflow-y-auto px-3 py-2" />
                  </section>
                  <div data-field="privacy_consent">
                    <Checkbox
                      label="Li o aviso de privacidade e concordo com o tratamento dos meus dados para a homologação e o cadastro na base técnica."
                      checked={form.privacy_consent}
                      onChange={(v) => set("privacy_consent", v)}
                    />
                  </div>
                </>
              ) : null}

              {problem ? (
                <div role="alert" id="form-problem">
                  <ErrorBox message={problem.message} />
                </div>
              ) : null}
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
                <Button onClick={back} disabled={step === 0 || submitting} className={step === 0 ? "invisible" : ""}>
                  <ChevronLeft className="size-4" />
                  Voltar
                </Button>
                {last ? (
                  <Button variant="primary" type="submit" loading={submitting}>
                    Enviar ficha
                  </Button>
                ) : (
                  <Button variant="primary" type="submit">
                    Continuar
                    <ChevronRight className="size-4" />
                  </Button>
                )}
              </div>
            </Card>
            {hasContent(form) ? (
              <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-ink-muted">
                Rascunho salvo neste aparelho por 24 horas (sem a senha e a foto).
                <button
                  type="button"
                  onClick={restart}
                  className="rounded font-medium text-ink underline underline-offset-2 hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                >
                  Apagar e recomeçar
                </button>
              </p>
            ) : null}
          </form>
        )}
        <p className="mt-6 text-center text-xs text-ink-muted">Maxx Field · seus dados são protegidos conforme a LGPD</p>
      </main>
    </div>
  );
}

function Panel({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      {icon}
      <h1 className="text-lg font-bold tracking-[-0.02em] text-ink">{title}</h1>
      <p className="max-w-md text-sm text-ink-muted">{text}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </Card>
  );
}

/** O aviso de privacidade (LGPD), na primeira etapa (para ler antes de preencher) e junto do aceite. */
function PrivacyNotice({ className }: { className?: string }) {
  return (
    <dl className={clsx("space-y-2 text-sm", className)}>
      {PRIVACY_NOTICE.map((item) => (
        <div key={item.title}>
          <dt className="font-semibold text-ink">{item.title}</dt>
          <dd className="text-ink-muted">{item.body}</dd>
        </div>
      ))}
    </dl>
  );
}

function PhotoPicker({ value, onChange, name }: { value: string | null; onChange: (v: string | null) => void; name: string }) {
  const [error, setError] = useState<string | null>(null);
  // Reduzir uma foto de 12 MP leva um instante: o botão avisa e não aceita outro toque.
  const [preparing, setPreparing] = useState(false);
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
        {/* Sem "capture": o celular oferece câmera ou galeria (antes abria direto a câmera da frente). */}
        <label
          className={clsx(
            buttonClassName("secondary"),
            "cursor-pointer self-start has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/45",
            preparing && "pointer-events-none opacity-60",
          )}
        >
          {preparing ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
          {preparing ? "Preparando foto…" : value ? "Trocar foto" : "Adicionar foto"}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={preparing}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setError(null);
              setPreparing(true);
              try {
                onChange(await resizePhoto(file));
              } catch {
                setError("Não foi possível usar esta imagem. Tente outra foto.");
              } finally {
                setPreparing(false);
              }
            }}
          />
        </label>
        <span className="text-xs text-ink-muted">Foto do rosto, de frente (opcional). Aparece para o cliente na visita.</span>
        {value ? (
          <button
            type="button"
            className="self-start rounded text-xs text-red-700 hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none dark:text-red-400"
            onClick={() => onChange(null)}
          >
            Remover foto
          </button>
        ) : null}
        {error ? (
          <span role="alert" className="text-xs text-red-700 dark:text-red-400">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Como o Field, mas para grupos de controles (chips, listas): um <label> ativaria o primeiro. */
function Group({
  label,
  hint,
  required,
  field,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  /** Campo da ficha (para levar a pessoa até o grupo quando há um problema nele). */
  field?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5" data-field={field}>
      <legend className="mb-1.5 text-xs font-semibold text-ink/80">
        {label}
        {required ? <span className="text-red-600 dark:text-red-400"> *</span> : null}
      </legend>
      {children}
      {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
    </fieldset>
  );
}
