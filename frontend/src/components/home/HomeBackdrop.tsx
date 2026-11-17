"use client";

import clsx from "clsx";
import { memo, useEffect, useRef } from "react";
import { createBackdropEngine, readPalette } from "@/components/home/backdrop/engine";
import { useMediaQuery } from "@/components/useMediaQuery";

/** Semente do céu: o mesmo desenho a cada visita. */
const SEED = 0x2447ff;
/** Para depois de 3 min sem uso (checado a cada 15 s) e volta no próximo movimento. */
const IDLE_MS = 180_000;
const IDLE_CHECK_MS = 15_000;
const ACTIVITY = ["pointermove", "pointerdown", "keydown", "wheel", "scroll", "focusin"] as const;
const ACTIVITY_OPTIONS = { passive: true, capture: true } as const;
/** Painel da OS, Dialog, Ctrl+K e menu do celular: o véu desfocado não pode ser refeito a cada quadro. */
const MODAL = '[aria-modal="true"]';
const MODAL_CHECK_MS = 200;
/** A Início releu os dados (tempo real ou atualização): solta uma sinapse. */
const DATA_EVENT = "mf:inicio:dados";

type ConnectionNavigator = Navigator & { connection?: { saveData?: boolean } };

/**
 * Fundo animado da Início (galáxia neural), atrás da folha e preso logo abaixo da barra do topo. Decorativo:
 * aria-hidden, sem foco nem clique, some na impressão, em cores forçadas e em alto contraste. Anima só com
 * movimento permitido, tela de 768 px ou mais, aba visível, nenhum painel aberto e alguém usando a tela;
 * fora isso fica no último quadro (estático com "reduzir movimento", tela estreita ou economia de dados).
 * `paused`: a pessoa parou pelo botão "Animação".
 */
function HomeBackdrop({ paused }: { paused: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)", true);
  const narrow = useMediaQuery("(max-width: 767.98px)", true);
  const flags = useRef({ paused, reduced, narrow });
  const sync = useRef<(() => void) | null>(null);

  // Declarado antes do efeito de montagem: na montagem roda primeiro, e o sync() ainda não existe.
  useEffect(() => {
    flags.current = { paused, reduced, narrow };
    sync.current?.();
  }, [paused, reduced, narrow]);

  useEffect(() => {
    const boxEl = box.current;
    const canvasEl = canvas.current;
    if (!boxEl || !canvasEl) return;
    const saveData = (navigator as ConnectionNavigator).connection?.saveData === true;
    const engine = createBackdropEngine(canvasEl, { seed: SEED, density: flags.current.narrow || saveData ? 0.5 : 1 });
    engine.setPalette(readPalette());

    let settled = false;
    let hidden = document.visibilityState === "hidden";
    let modal = document.querySelector(MODAL) !== null;
    let idle = false;
    let lastActivity = performance.now();
    let width = 0;
    let height = 0;
    let modalTimer = 0;
    let idleHandle = 0;
    let settleTimer = 0;

    // Anima só com tudo liberado; senão fica no último quadro (estático, com metade da densidade no celular).
    const run = () => {
      const state = flags.current;
      const animate =
        settled && !state.paused && !state.reduced && !state.narrow && !saveData && !hidden && !modal && !idle && !engine.degraded;
      if (!animate) engine.stop();
      engine.setDensity(state.narrow || saveData ? 0.5 : 1);
      if (animate) engine.start();
    };
    sync.current = run;

    const dpr = () => Math.min(window.devicePixelRatio || 1, 1.5);
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      width = rect.width;
      height = rect.height;
      engine.resize(width, height, dpr());
      run();
    });
    resizeObserver.observe(boxEl);
    // Zoom ou janela em outra tela: o dpr muda sem o tamanho em px CSS mudar.
    const onResize = () => {
      engine.resize(width, height, dpr());
      run();
    };

    const themeObserver = new MutationObserver(() => engine.setPalette(readPalette()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const checkModal = () => {
      modalTimer = 0;
      const open = document.querySelector(MODAL) !== null;
      if (open === modal) return;
      modal = open;
      run();
    };
    const modalObserver = new MutationObserver(() => {
      if (!modalTimer) modalTimer = window.setTimeout(checkModal, MODAL_CHECK_MS);
    });
    modalObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal"] });

    const onVisibility = () => {
      hidden = document.visibilityState === "hidden";
      run();
    };
    const onActivity = () => {
      lastActivity = performance.now();
      if (!idle) return;
      idle = false;
      run();
    };
    const idleTimer = window.setInterval(() => {
      if (idle || performance.now() - lastActivity < IDLE_MS) return;
      idle = true;
      run();
    }, IDLE_CHECK_MS);
    const onData = () => engine.pulse();

    document.addEventListener("visibilitychange", onVisibility);
    for (const type of ACTIVITY) window.addEventListener(type, onActivity, ACTIVITY_OPTIONS);
    window.addEventListener(DATA_EVENT, onData);
    window.addEventListener("resize", onResize);

    // O laço só começa quando a tela assenta, para não disputar com a carga dos dados.
    const settle = () => {
      idleHandle = 0;
      settleTimer = 0;
      settled = true;
      run();
    };
    if (typeof window.requestIdleCallback === "function") idleHandle = window.requestIdleCallback(settle, { timeout: 800 });
    else settleTimer = window.setTimeout(settle, 300);

    return () => {
      sync.current = null;
      if (idleHandle) window.cancelIdleCallback(idleHandle);
      window.clearTimeout(settleTimer);
      window.clearTimeout(modalTimer);
      window.clearInterval(idleTimer);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      modalObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const type of ACTIVITY) window.removeEventListener(type, onActivity, ACTIVITY_OPTIONS);
      window.removeEventListener(DATA_EVENT, onData);
      window.removeEventListener("resize", onResize);
      engine.destroy();
    };
  }, []);

  return (
    <div
      aria-hidden
      // --topbar-h: a altura real da barra do topo (Shell). No md+ a camada desce também pelo recuo de baixo da
      // folha (py-2 + borda): sem isso, no fim da rolagem o sticky subiria 9 px para baixo da barra.
      className={clsx(
        "pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-clip print:hidden forced-colors:hidden contrast-more:hidden",
        "h-[max(100%,calc(100lvh_-_var(--topbar-h,57px)))] md:h-[max(calc(100%_+_9px),calc(100lvh_-_var(--topbar-h,57px)))]",
      )}
    >
      <div
        ref={box}
        className="mf-galaxy-mask sticky top-[var(--topbar-h,57px)] h-[calc(100lvh_-_var(--topbar-h,57px))] [contain:strict]"
      >
        <div className="mf-galaxy-glow absolute inset-0" />
        <canvas ref={canvas} className="absolute inset-0 block size-full opacity-0 transition-opacity duration-400 ease-out" />
      </div>
    </div>
  );
}

export default memo(HomeBackdrop);
