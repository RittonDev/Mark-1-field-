"use client";

import { Eraser } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui";

interface Point {
  x: number;
  y: number;
}

const INK = "#1a2b6d";
const LINE_WIDTH = 2.2;
/** Folga da borda quando a assinatura é reduzida para caber (o traço não encosta no limite). */
const EDGE = 6;

/** Ajusta o bitmap ao tamanho do quadro na tela (e à densidade da tela) e pinta o fundo branco. */
function prepare(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
  const { width, height } = canvas.getBoundingClientRect();
  const ctx = canvas.getContext("2d");
  if (!ctx || !width || !height) return null;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  return { ctx, width, height };
}

/** Escala que faz os traços caberem no quadro: reduz quando ele estreita (celular girado), nunca amplia. */
function fitScale(strokes: Point[][], width: number, height: number): number {
  let maxX = 0;
  let maxY = 0;
  for (const stroke of strokes) {
    for (const p of stroke) {
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!maxX && !maxY) return 1;
  return Math.min(1, (width - EDGE) / Math.max(maxX, 1), (height - EDGE) / Math.max(maxY, 1));
}

/** Um toque vira ponto; um arrasto, a linha pelos pontos (na escala atual). */
function drawStroke(ctx: CanvasRenderingContext2D, stroke: Point[], scale: number) {
  const [first, ...rest] = stroke;
  if (!first) return;
  if (!rest.length) {
    ctx.beginPath();
    ctx.arc(first.x * scale, first.y * scale, LINE_WIDTH / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first.x * scale, first.y * scale);
  for (const p of rest) ctx.lineTo(p.x * scale, p.y * scale);
  ctx.stroke();
}

/**
 * Quadro de assinatura (dedo, caneta ou mouse). Devolve um PNG em data URL, com fundo branco para a
 * assinatura ficar legível também no modo escuro e no PDF. Os traços ficam guardados: se o quadro muda
 * de tamanho (celular girado para assinar deitado, janela redimensionada), a assinatura é redesenhada no
 * lugar certo, reduzida se não couber. Um dedo por vez: o segundo é ignorado.
 */
export function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Traços em px do quadro na escala 1; `scale` é a escala em que estão desenhados agora.
  const strokes = useRef<Point[][]>([]);
  const scale = useRef(1);
  // Ponteiro que está assinando (o toque de um segundo dedo não risca nem desvia o traço).
  const pointer = useRef<number | null>(null);
  const [empty, setEmpty] = useState(true);
  const hintId = useId();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let painted = "";
    const repaint = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const size = `${Math.round(width)}x${Math.round(height)}@${window.devicePixelRatio || 1}`;
      if (size === painted) return;
      painted = size;
      const board = prepare(canvas);
      if (!board) return;
      scale.current = fitScale(strokes.current, board.width, board.height);
      for (const stroke of strokes.current) drawStroke(board.ctx, stroke, scale.current);
    };
    repaint();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(repaint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  /** Ponto do evento na escala 1 (como fica guardado). */
  const point = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / scale.current, y: (e.clientY - rect.top) / scale.current };
  };

  const finish = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    if (strokes.current.length && canvasRef.current) onChange(canvasRef.current.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    strokes.current = [];
    scale.current = 1;
    pointer.current = null;
    if (canvas) prepare(canvas);
    setEmpty(true);
    onChange(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Quadro de assinatura: desenhe com o dedo ou o mouse"
        aria-describedby={hintId}
        className="h-36 w-full cursor-crosshair touch-none rounded-lg border border-line bg-white"
        onPointerDown={(e) => {
          if (pointer.current !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
          const ctx = e.currentTarget.getContext("2d");
          if (!ctx) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pointer.current = e.pointerId;
          const stroke = [point(e)];
          strokes.current.push(stroke);
          drawStroke(ctx, stroke, scale.current);
          setEmpty(false);
        }}
        onPointerMove={(e) => {
          if (pointer.current !== e.pointerId) return;
          const stroke = strokes.current[strokes.current.length - 1];
          const ctx = e.currentTarget.getContext("2d");
          const last = stroke?.[stroke.length - 1];
          if (!ctx || !last) return;
          const p = point(e);
          ctx.beginPath();
          ctx.moveTo(last.x * scale.current, last.y * scale.current);
          ctx.lineTo(p.x * scale.current, p.y * scale.current);
          ctx.stroke();
          stroke.push(p);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      />
      <div className="flex items-center justify-between gap-2">
        <span id={hintId} aria-live="polite" className="text-xs text-ink-muted">
          {empty ? "Assine no quadro acima" : "Assinatura registrada"}
        </span>
        <Button size="sm" variant="ghost" onClick={clear} disabled={empty}>
          <Eraser className="size-3.5" />
          Limpar
        </Button>
      </div>
    </div>
  );
}
