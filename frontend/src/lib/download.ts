// Gera e baixa um CSV no navegador (abre certo no Excel brasileiro: ";" e UTF-8 com BOM).

// Texto que o Excel leria como fórmula (=, +, -, @, tab, retorno), exceto número puro como "-12,5".
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+([.,]\d+)?$/;

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const escape = (v: string | number | null | undefined) => {
    let s = v == null ? "" : String(v);
    // Nomes e textos vêm de fora (ficha pública do técnico, cadastro do cliente): com o apóstrofo na
    // frente, "=HYPERLINK(...)" aparece como texto em vez de virar fórmula ao abrir no Excel.
    if (typeof v === "string" && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = "﻿" + rows.map((r) => r.map(escape).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
