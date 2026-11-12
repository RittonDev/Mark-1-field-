"use client";

import { CheckCircle2, Navigation, ShieldCheck } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Logo } from "@/components/Brand";

const QUERY = "(prefers-reduced-motion: reduce)";

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(QUERY);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}

// Rotas no "mapa" (coordenadas do viewBox, dentro do grupo inclinado).
const ROUTE_A = "M 160 800 L 160 560 L 360 560 L 360 320 L 560 320";
const ROUTE_B = "M 660 940 L 660 680 L 460 680 L 460 440 L 260 440 L 260 200";

function Vehicle({ path, begin, color }: { path: string; begin: string; color: string }) {
  return (
    <g opacity="0">
      <circle r="11" fill={color} opacity="0.25" />
      <circle r="6" fill="#ffffff" stroke={color} strokeWidth="3" />
      <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.85;1" dur="7s" begin={begin} repeatCount="indefinite" />
      <animateMotion
        path={path}
        dur="7s"
        begin={begin}
        repeatCount="indefinite"
        keyPoints="0;1;1"
        keyTimes="0;0.45;1"
        calcMode="spline"
        keySplines="0.65 0 0.35 1; 0 0 1 1"
      />
    </g>
  );
}

/** Painel da marca na tela de login: mapa de rotas em movimento e recortes reais do produto. */
export function LoginArt() {
  const reduced = useReducedMotion();
  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-[28px] bg-[#2447ff] text-white shadow-pop dark:bg-[#1f3be0]">
      {/* Luz suave nos cantos (profundidade, sem "bolhas"). */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(110%_70%_at_100%_0%,rgb(118_246_198/0.22),transparent_55%),radial-gradient(90%_60%_at_0%_100%,rgb(0_183_223/0.30),transparent_60%)]"
      />
      <svg aria-hidden viewBox="0 0 800 900" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full">
        <g transform="rotate(-14 400 450)" fill="none" strokeLinecap="round" strokeLinejoin="round">
          {/* Quadras e ruas. */}
          {[60, 160, 260, 360, 460, 560, 660, 760].map((x) => (
            <line key={`v${x}`} x1={x} y1={-160} x2={x} y2={1060} stroke="#ffffff" strokeOpacity="0.09" strokeWidth="1.5" />
          ))}
          {[80, 200, 320, 440, 560, 680, 800].map((y) => (
            <line key={`h${y}`} x1={-160} y1={y} x2={960} y2={y} stroke="#ffffff" strokeOpacity="0.09" strokeWidth="1.5" />
          ))}
          <path d="M -60 330 C 180 280, 300 540, 520 480 S 800 300, 900 370" stroke="#ffffff" strokeOpacity="0.07" strokeWidth="18" />
          <path d="M -80 860 L 900 110" stroke="#ffffff" strokeOpacity="0.06" strokeWidth="10" />
          {/* Rotas dos técnicos. */}
          <path d={ROUTE_A} className="mf-route" stroke="#76f6c6" strokeWidth="4" style={{ ["--len" as string]: 900 }} />
          <path
            d={ROUTE_B}
            className="mf-route"
            stroke="#5fe0ff"
            strokeWidth="4"
            style={{ ["--len" as string]: 1160, animationDelay: "1.8s" }}
          />
          {reduced ? null : (
            <>
              <Vehicle path={ROUTE_A} begin="0s" color="#76f6c6" />
              <Vehicle path={ROUTE_B} begin="1.8s" color="#5fe0ff" />
            </>
          )}
          {/* Destinos. */}
          {[
            [560, 320, "#76f6c6"],
            [260, 200, "#5fe0ff"],
          ].map(([x, y, c]) => (
            <g key={`${x}-${y}`}>
              <circle cx={x} cy={y} r="16" fill={c as string} className="mf-ring" />
              <circle cx={x} cy={y} r="9" fill="#ffffff" stroke={c as string} strokeWidth="4" />
            </g>
          ))}
        </g>
      </svg>

      <div className="relative flex items-center justify-between p-8">
        <span className="rounded-xl bg-white px-3 py-2 shadow-elev-2">
          <Logo tone="dark" />
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/12 px-3 py-1 text-xs font-medium text-white/90 ring-1 ring-white/20 backdrop-blur">
          <span className="size-1.5 rounded-full bg-[#76f6c6]" />
          Operação em tempo real
        </span>
      </div>

      {/* Recortes do produto flutuando sobre o mapa. */}
      <div className="relative flex-1">
        <div className="absolute top-[6%] right-[7%] w-64 animate-float rounded-2xl bg-surface p-4 text-ink shadow-pop" style={{ animationDuration: "6s" }}>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-ink-subtle">OS-000231</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-500/15 dark:text-sky-300">
              <Navigation className="size-3" />
              Em deslocamento
            </span>
          </div>
          <p className="mt-2 text-sm font-semibold">PDV 3 sem rede</p>
          <p className="text-xs text-ink-muted">Loja 27 · Shopping Morumbi</p>
          <div className="mt-3 flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-full bg-brand-soft text-[10px] font-semibold text-brand-ink">CS</span>
            <span className="text-xs text-ink-muted">Carlos Souza</span>
            <span className="ml-auto text-xs font-semibold tabular-nums">chega 14:35</span>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="mf-eta brand-gradient h-full w-full rounded-full" />
          </div>
        </div>

        <div className="absolute top-[40%] left-[7%] w-52 animate-float rounded-2xl bg-surface p-4 text-ink shadow-pop" style={{ animationDuration: "7s", animationDelay: "-2s" }}>
          <p className="text-xs text-ink-muted">SLA no prazo · 30 dias</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">98,2%</p>
          <div className="mt-3 flex h-10 items-end gap-1.5">
            {[54, 62, 58, 71, 66, 80, 92].map((h, i) => (
              <span
                key={i}
                className={`flex-1 rounded-t-[3px] ${i === 6 ? "bg-brand" : "bg-brand/25"}`}
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        </div>

        <div className="absolute right-[10%] bottom-[8%] w-60 animate-float rounded-2xl bg-surface p-4 text-ink shadow-pop" style={{ animationDuration: "6.5s", animationDelay: "-4s" }}>
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <CheckCircle2 className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">Assinatura coletada</p>
              <p className="text-xs text-ink-muted">Relatório enviado ao cliente com as fotos do antes e depois.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="relative p-8 pt-4">
        <h2 className="max-w-md text-[28px] leading-[1.15] font-semibold tracking-[-0.02em]">
          Do chamado à assinatura do cliente, em tempo real.
        </h2>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-white/80">
          Despacho, rastreamento, formulários e relatórios da sua operação de campo em um só lugar.
        </p>
        <p className="mt-6 inline-flex items-center gap-2 text-xs text-white/70">
          <ShieldCheck className="size-4" />
          Login corporativo Microsoft · dados tratados conforme a LGPD
        </p>
      </div>
    </div>
  );
}
