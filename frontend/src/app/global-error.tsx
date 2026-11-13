"use client";

import { useEffect } from "react";
import { isStaleBuildError, reloadOnce } from "@/lib/reload";

// Sem o CSS do app: cores próprias nos dois temas (o escuro segue o sistema; sem o script de tema aqui).
const STYLES = `
.mf-ge{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:16px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#1b1f26}
.mf-ge main{max-width:420px;text-align:center}
.mf-ge h1{font-size:18px;font-weight:700;letter-spacing:-0.02em;margin:0 0 6px}
.mf-ge p{font-size:14px;line-height:1.5;color:#525a68;margin:0 0 16px}
.mf-ge .actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.mf-ge button,.mf-ge a{display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:8px;font:inherit;
  font-size:14px;font-weight:600;text-decoration:none;cursor:pointer}
.mf-ge button{border:0;background:#2447ff;color:#fff}
.mf-ge a{border:1px solid #d4d8de;background:#fff;color:#1b1f26}
.mf-ge :focus-visible{outline:2px solid #1a36d6;outline-offset:2px}
.mf-ge .code{font-family:ui-monospace,monospace;font-size:12px;color:#646b7a;margin:12px 0 0}
@media (prefers-color-scheme: dark){
  .mf-ge{background:#08090b;color:#ececf0}
  .mf-ge p{color:#9ba1ac}
  .mf-ge button{background:#3d5af7}
  .mf-ge a{border-color:#3a3e46;background:#141519;color:#ececf0}
  .mf-ge :focus-visible{outline-color:#5470ff}
  .mf-ge .code{color:#838995}
}`;

/**
 * Último recurso: até o layout raiz falhou. Se a causa é uma versão nova publicada com a página aberta,
 * recarrega sozinho uma vez e oferece "Atualizar".
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = isStaleBuildError(error);

  useEffect(() => {
    if (stale) reloadOnce();
    else console.error(error);
  }, [error, stale]);

  return (
    <html lang="pt-BR">
      <head>
        <title>{stale ? "Versão nova · Maxx Field" : "Erro · Maxx Field"}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body className="mf-ge">
        <main role="alert">
          {stale ? (
            <>
              <h1>Há uma versão nova do Maxx Field</h1>
              <p>Atualize a página para continuar. Nada do que já foi salvo se perdeu.</p>
              <div className="actions">
                <button type="button" onClick={() => window.location.reload()}>
                  Atualizar
                </button>
              </div>
            </>
          ) : (
            <>
              <h1>O Maxx Field não carregou</h1>
              <p>Nada do que já foi salvo se perdeu. Tente de novo em instantes.</p>
              <div className="actions">
                <button type="button" onClick={reset}>
                  Tentar de novo
                </button>
                {/* Link comum (não o do Next): recarrega a página inteira a partir do início. */}
                <a href="/">Voltar ao início</a>
              </div>
              {error.digest ? <p className="code">código {error.digest}</p> : null}
            </>
          )}
        </main>
      </body>
    </html>
  );
}
