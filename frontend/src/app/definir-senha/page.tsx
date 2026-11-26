"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Eye, EyeOff, Hourglass, KeyRound, Link2Off, Loader2, Lock, WifiOff } from "lucide-react";
import { useId, useState } from "react";
import { apiText, isOffline, PublicPanel, PublicShell, useHashToken } from "@/components/PublicPage";
import { Button, buttonClassName, Card, ErrorBox, Input } from "@/components/ui";
import { ApiError, apiErrorCode, errorMessage, request } from "@/lib/api";
import type { PasswordResetCheck, PasswordResetDone } from "@/lib/types";

const GONE_TEXT = "Peça outro em “Esqueci minha senha”, no app, ou fale com a central pelo WhatsApp.";
const ACCESS_CUT_TEXT = "Seu acesso ao app está desativado. Fale com a central pelo WhatsApp.";
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/** O acesso ao app foi cortado (410 ACCESS_CUT): o link continua como estava, mas só serve depois que a central liberar. */
function accessCut(error: unknown): boolean {
  return error instanceof ApiError && error.status === 410 && apiErrorCode(error) === "ACCESS_CUT";
}

/** O endereço do app que a API mandou, só http(s). */
function appLink(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** O problema ao salvar, para a caixa de erro acima do botão. */
function saveProblem(error: unknown): string {
  if (isOffline(error) || (error instanceof ApiError && error.status >= 500)) return "Sem conexão. Confira a internet e tente de novo.";
  if (error instanceof ApiError && error.status === 429) return "Muitas tentativas. Espere alguns minutos e tente de novo.";
  return errorMessage(error);
}

/**
 * Criar ou trocar a senha do app pelo link do e-mail (pedido no "Esqueci minha senha" do app, enviado pela central ou o
 * da boas-vindas). Abrir só confere o link e mostra a conta; o link é gasto ao salvar.
 */
export default function SetPasswordPage() {
  const token = useHashToken();
  const check = useQuery({
    queryKey: ["password-reset-check", token],
    queryFn: () => request<PasswordResetCheck>("/auth/password-reset/check", { method: "POST", auth: false, body: { token } }),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const save = useMutation({
    mutationFn: (password: string) =>
      request<PasswordResetDone>("/auth/password-reset", { method: "POST", auth: false, body: { token, password } }),
  });
  const error = check.error;
  const status = error instanceof ApiError ? error.status : 0;
  // O link deixou de valer entre abrir e salvar (vencido, usado em outra aba, acesso cortado).
  const saveGone = save.error instanceof ApiError && save.error.status === 410 ? save.error : null;

  return (
    <PublicShell>
      {token === null ? (
        <PublicPanel
          icon={<Link2Off className="size-10 text-ink-muted" />}
          title="Link incompleto"
          text="Abra de novo o link do e-mail que você recebeu."
        />
      ) : save.data && check.data ? (
        <PublicPanel
          icon={<CheckCircle2 className="size-10 text-brand" />}
          title="Senha definida"
          text={`Entre no app com o seu e-mail e a senha nova.${check.data.kind === "reset" ? " Os acessos abertos foram encerrados." : ""}`}
          action={
            appLink(save.data.app_url ?? check.data.app_url) ? (
              // O app do técnico é outro endereço: abre em outra aba.
              <a
                href={appLink(save.data.app_url ?? check.data.app_url) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClassName("primary", "lg")}
              >
                Abrir o app
              </a>
            ) : undefined
          }
        />
      ) : accessCut(saveGone ?? error) ? (
        <PublicPanel
          icon={<Lock className="size-10 text-ink-muted" />}
          title="Acesso ao app desativado"
          text={apiText(saveGone ?? error, ACCESS_CUT_TEXT)}
        />
      ) : saveGone || status === 410 || status === 422 ? (
        <PublicPanel
          icon={<Link2Off className="size-10 text-ink-muted" />}
          title="Link vencido ou já usado"
          text={saveGone ? apiText(saveGone, GONE_TEXT) : status === 410 ? apiText(error, GONE_TEXT) : GONE_TEXT}
        />
      ) : check.data ? (
        <PasswordForm
          check={check.data}
          saving={save.isPending}
          problem={save.error ? saveProblem(save.error) : null}
          onSave={(password) => save.mutate(password)}
        />
      ) : !error ? (
        <PublicPanel icon={<Loader2 className="size-10 animate-spin text-ink-muted" />} title="Abrindo o link…" />
      ) : status === 429 ? (
        <PublicPanel
          icon={<Hourglass className="size-10 text-ink-muted" />}
          title="Muitas tentativas"
          text="Espere alguns minutos e abra o link de novo."
        />
      ) : (
        <PublicPanel
          icon={<WifiOff className="size-10 text-ink-muted" />}
          title={isOffline(error) ? "Sem conexão" : "Link indisponível agora"}
          text={
            isOffline(error)
              ? "Não conseguimos abrir o link agora. Confira a internet e tente de novo."
              : "Não conseguimos abrir o link agora. Tente de novo em alguns minutos."
          }
          action={
            <Button variant="primary" loading={check.isFetching} onClick={() => void check.refetch()}>
              Tentar de novo
            </Button>
          }
        />
      )}
    </PublicShell>
  );
}

function PasswordForm({
  check,
  saving,
  problem,
  onSave,
}: {
  check: PasswordResetCheck;
  saving: boolean;
  problem: string | null;
  onSave: (password: string) => void;
}) {
  const id = useId();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reveal, setReveal] = useState(false);
  // Os recados aparecem depois do primeiro "Salvar senha".
  const [tried, setTried] = useState(false);
  const tooShort = password.length < PASSWORD_MIN ? "A senha precisa ter pelo menos 8 caracteres." : null;
  const mismatch = !tooShort && password !== confirmation ? "As senhas não conferem." : null;
  const firstError = tried ? tooShort : null;
  const secondError = tried ? mismatch : null;
  const title = check.kind === "create" ? "Criar senha" : "Definir nova senha";

  return (
    <Card className="px-5 py-6">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <KeyRound className="size-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-bold tracking-[-0.02em] text-ink">{title}</h1>
          <p className="truncate text-sm text-ink-muted">Conta {check.email}</p>
        </div>
      </div>
      <form
        noValidate
        className="mt-5 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (tooShort || mismatch || saving) return;
          onSave(password);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-senha`} className="text-xs font-semibold text-ink/80">
            Nova senha
          </label>
          <div className="relative">
            <Input
              id={`${id}-senha`}
              name="password"
              type={reveal ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={PASSWORD_MAX}
              autoFocus
              aria-invalid={firstError ? true : undefined}
              aria-describedby={`${id}-senha-dica`}
              className="h-11 pr-11 text-base sm:text-sm"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? "Ocultar senha" : "Mostrar senha"}
              aria-pressed={reveal}
              className="absolute top-1/2 right-1.5 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            >
              {reveal ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
            </button>
          </div>
          {firstError ? (
            <span id={`${id}-senha-dica`} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
              {firstError}
            </span>
          ) : (
            <span id={`${id}-senha-dica`} className="text-xs text-ink-subtle">
              Mínimo de 8 caracteres.
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-confirma`} className="text-xs font-semibold text-ink/80">
            Confirme a senha
          </label>
          <Input
            id={`${id}-confirma`}
            name="password2"
            type={reveal ? "text" : "password"}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={PASSWORD_MAX}
            aria-invalid={secondError ? true : undefined}
            aria-describedby={secondError ? `${id}-confirma-erro` : undefined}
            className="h-11 text-base sm:text-sm"
          />
          {secondError ? (
            <span id={`${id}-confirma-erro`} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
              {secondError}
            </span>
          ) : null}
        </div>
        {problem ? <ErrorBox message={problem} /> : null}
        <Button type="submit" variant="primary" size="lg" loading={saving} className="w-full">
          Salvar senha
        </Button>
      </form>
    </Card>
  );
}
