"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Media query reativa (evento change do matchMedia). `serverValue` vale no servidor e na hidratação:
 * use o lado seguro (ex.: true para "reduzir movimento", que não anima nada até saber a preferência).
 */
export function useMediaQuery(query: string, serverValue: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const read = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, read, () => serverValue);
}
