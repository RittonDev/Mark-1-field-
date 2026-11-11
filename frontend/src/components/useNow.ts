"use client";

import { useEffect, useState } from "react";

/** Relógio que atualiza a cada `intervalMs` (contagens regressivas de SLA). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
