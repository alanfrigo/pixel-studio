"use client";

import { useState } from "react";
import { apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
import { FurniturePanel } from "./furniture-panel";
import { IsoPanel } from "./iso-panel";
import { KitPanel } from "./kit-panel";
import { ObjectsPanel } from "./objects-panel";
import { ParallaxPanel } from "./parallax-panel";
import { RoomsPanel } from "./rooms-panel";
import { ScenePanel } from "./scene-panel";
import type { Profile, ScenesCatalog } from "./scenes-client";

export type ScenesTab = "scene" | "parallax" | "rooms" | "furniture" | "kit" | "iso" | "objects";
const TABS: [ScenesTab, string][] = [
  ["scene", "Cena ilustrada"],
  ["parallax", "Paralaxe"],
  ["rooms", "Salas"],
  ["furniture", "Móveis e áreas ocultas"],
  ["kit", "Kit → mapa"],
  ["iso", "Isométrico com personagem"],
  ["objects", "Props"],
];

/**
 * Cenas, salas e móveis (06 §cenas, salas e texturas como saídas próprias).
 * Cada saída tem contrato próprio: imagem plana não é mapa; planos de
 * paralaxe são arquivos próprios; sala tem planta/portas; móveis viram props.
 * Tudo publica revisões candidatas, aprovadas pelo fluxo existente.
 */
export function ScenesStudio({ projectId, initialTab }: { projectId: string; initialTab: ScenesTab }) {
  const [tab, setTab] = useState<ScenesTab>(initialTab);
  const { data, error, refresh } = usePoll(
    async () => {
      const [catalog, { profiles }] = await Promise.all([apiFetch<ScenesCatalog>(`/projects/${projectId}/scenes`), apiFetch<{ profiles: Profile[] }>("/settings/providers")]);
      return { catalog, profiles };
    },
    { active: () => false, slowMs: 60_000 },
  );
  return (
    <>
      <h1>Cenas, salas e móveis</h1>
      <div className="row" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "" : "secondary"} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <button type="button" className="secondary" onClick={refresh}>
          Recarregar
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? (
        <p className="muted">Carregando…</p>
      ) : tab === "scene" ? (
        <ScenePanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      ) : tab === "parallax" ? (
        <ParallaxPanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      ) : tab === "rooms" ? (
        <RoomsPanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      ) : tab === "furniture" ? (
        <FurniturePanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      ) : tab === "kit" ? (
        <KitPanel projectId={projectId} catalog={data.catalog} refresh={refresh} />
      ) : tab === "iso" ? (
        <IsoPanel projectId={projectId} catalog={data.catalog} />
      ) : (
        <ObjectsPanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      )}
    </>
  );
}
