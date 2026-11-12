// Pré-visualização no navegador: redesenha os traços num <canvas> e devolve um data URL PNG.

import type { RefObject } from "react";
import { INK, STROKE_WIDTH, type PadHandle, type Stroke } from "../components/SignaturePad";

export async function exportSignature(
  _view: RefObject<PadHandle | null>,
  strokes: Stroke[],
  size: { width: number; height: number },
): Promise<string> {
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponível");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.strokeStyle = INK;
  ctx.lineWidth = STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    if (!stroke.length) continue;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
    if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.1, stroke[0].y + 0.1);
    ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}
