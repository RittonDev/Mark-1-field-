"use client";

import { Pause, Play } from "lucide-react";
import { writeBackdropStopped } from "@/components/home/backdropPref";
import { Button } from "@/components/ui";

/** Liga e desliga o movimento do fundo da Início; a escolha fica salva neste navegador. */
export function BackdropToggle({ stopped }: { stopped: boolean }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      aria-pressed={!stopped}
      title={stopped ? "Retomar a animação do fundo" : "Pausar a animação do fundo"}
      onClick={() => writeBackdropStopped(!stopped)}
    >
      {stopped ? <Play aria-hidden className="size-3.5" /> : <Pause aria-hidden className="size-3.5" />}
      <span className="sr-only sm:not-sr-only">Animação</span>
    </Button>
  );
}
