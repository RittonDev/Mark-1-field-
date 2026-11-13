"use client";

import { useEffect } from "react";

/** Último recurso: até o layout raiz falhou. Sem depender do CSS do app (estilos na própria tag). */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          background: "#f0f2f5",
          color: "#1b1f26",
          padding: 16,
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 6px" }}>O Maxx Field não carregou</h1>
          <p style={{ fontSize: 14, color: "#5d6676", margin: "0 0 16px" }}>
            Nada do que já foi salvo se perdeu. Tente de novo em instantes.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              height: 36,
              padding: "0 14px",
              border: 0,
              borderRadius: 8,
              background: "#2447ff",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Tentar de novo
          </button>
          {error.digest ? (
            <p style={{ fontFamily: "monospace", fontSize: 12, color: "#8b93a1", marginTop: 12 }}>código {error.digest}</p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
