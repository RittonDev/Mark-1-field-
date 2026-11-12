"use client";

import { Eraser } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Quadro de assinatura (dedo, caneta ou mouse). Devolve um PNG em data URL, com fundo
 * branco para a assinatura ficar legível também no modo escuro e no PDF.
 */
export function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const hasInk = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1a2b6d";
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { width, height } = canvas.getBoundingClientRect();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    hasInk.current = false;
    setEmpty(true);
    onChange(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <canvas
        ref={canvasRef}
        className="h-36 w-full touch-none rounded-lg border border-line bg-white"
        aria-label="Quadro de assinatura"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          last.current = point(e);
        }}
        onPointerMove={(e) => {
          if (!drawing.current || !last.current) return;
          const ctx = canvasRef.current?.getContext("2d");
          if (!ctx) return;
          const p = point(e);
          ctx.beginPath();
          ctx.moveTo(last.current.x, last.current.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          last.current = p;
          if (!hasInk.current) {
            hasInk.current = true;
            setEmpty(false);
          }
        }}
        onPointerUp={() => {
          drawing.current = false;
          last.current = null;
          if (hasInk.current && canvasRef.current) onChange(canvasRef.current.toDataURL("image/png"));
        }}
      />
      <div className="flex items-center justify-between text-xs text-ink-muted">
        <span>{empty ? "Assine no quadro acima" : "Assinatura registrada"}</span>
        <button type="button" onClick={clear} className="inline-flex items-center gap-1 hover:text-ink">
          <Eraser className="size-3.5" />
          Limpar
        </button>
      </div>
    </div>
  );
}
