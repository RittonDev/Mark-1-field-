"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Camera, Loader2 } from "lucide-react";
import { useConfirm } from "@/components/Confirm";
import { useToast } from "@/components/Toaster";
import { buttonClassName } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { resizePhotoBlob } from "@/lib/onboarding";
import type { Technician } from "@/lib/types";
import { refreshTechnicianViews } from "../../refresh";
import { TechAvatar } from "../../TechAvatar";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";

/** Foto do perfil: trocar e remover só com Editar (grava na hora, sem Salvar). */
export function PhotoSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const photo = useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return api.delete<Technician>(`/technicians/${tech.id}/photo`);
      // A foto do celular (4 a 10 MB) é reduzida aqui mesmo: chega com poucos KB e passa no limite de 2 MB.
      const blob = await resizePhotoBlob(file);
      const body = new FormData();
      body.append("file", new File([blob], "foto.jpg", { type: "image/jpeg" }));
      return api.upload<Technician>(`/technicians/${tech.id}/photo`, body);
    },
    onSuccess: (saved, file) => {
      queryClient.setQueryData(["technicians", "one", saved.id], saved);
      refreshTechnicianViews(queryClient);
      // Remover tira também a foto que veio do Field Control.
      toast({ title: file ? "Foto atualizada" : "Foto removida", tone: "success" });
    },
    onError: (e) => toast({ title: errorMessage(e), tone: "error" }),
  });

  return (
    <SectionCard title={fichaLabel("foto")}>
      <div className="flex flex-wrap items-center gap-5">
        <TechAvatar tech={tech} size="xl" />
        {canEdit ? (
          <div className="flex flex-col gap-2">
            <label
              className={clsx(
                buttonClassName("secondary", "md"),
                "cursor-pointer self-start has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/45",
                photo.isPending && "pointer-events-none opacity-60",
              )}
            >
              {photo.isPending ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
              {photo.isPending ? "Enviando foto…" : tech.avatar_url ? "Trocar foto" : "Adicionar foto"}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                disabled={photo.isPending}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) photo.mutate(file);
                }}
              />
            </label>
            {tech.avatar_url && !photo.isPending ? (
              <button
                type="button"
                className="self-start rounded text-xs text-red-700 hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none dark:text-red-400"
                onClick={async () => {
                  const ok = await confirm({
                    tone: "danger",
                    title: "Remover a foto?",
                    description: "O técnico fica com as iniciais no lugar da foto.",
                    confirmLabel: "Remover",
                  });
                  if (ok) photo.mutate(null);
                }}
              >
                Remover foto
              </button>
            ) : null}
            <span className="text-xs text-ink-muted">Foto do rosto, de frente.</span>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
