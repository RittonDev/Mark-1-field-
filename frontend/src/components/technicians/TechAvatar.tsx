"use client";

import clsx from "clsx";
import { useState } from "react";
import { absoluteApiUrl } from "@/lib/api";
import { initials } from "@/lib/format";
import type { Technician } from "@/lib/types";

const SIZE = { md: "size-8 text-xs", lg: "size-16 text-lg", xl: "size-24 text-2xl" } as const;

/**
 * Foto do técnico ou as iniciais: "md" (32 px) nas listas, "lg" (64 px) no cabeçalho da ficha e "xl" (96 px) na seção
 * Foto do perfil.
 */
export function TechAvatar({ tech, size = "md" }: { tech: Pick<Technician, "name" | "avatar_url">; size?: keyof typeof SIZE }) {
  const src = absoluteApiUrl(tech.avatar_url);
  // Foto que não abre (um link antigo do Field Control): ficam as iniciais.
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <span
      className={clsx(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-soft font-semibold text-brand-ink",
        SIZE[size],
      )}
    >
      {src && broken !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(src)}
          className="size-full object-cover"
        />
      ) : (
        initials(tech.name)
      )}
    </span>
  );
}
