// Assinatura → PNG. No aparelho, captura a View da área de assinatura (react-native-view-shot).
// Na pré-visualização web: signatureImage.web.ts redesenha os traços num <canvas>.

import type { RefObject } from "react";
import type { PadHandle } from "../components/SignaturePad";
import { captureRef } from "react-native-view-shot";
import type { Stroke } from "../components/SignaturePad";

export async function exportSignature(
  view: RefObject<PadHandle | null>,
  _strokes: Stroke[],
  _size: { width: number; height: number },
): Promise<string> {
  if (!view.current) throw new Error("Área de assinatura indisponível");
  return captureRef(view, { format: "png", quality: 1, result: "tmpfile" });
}
