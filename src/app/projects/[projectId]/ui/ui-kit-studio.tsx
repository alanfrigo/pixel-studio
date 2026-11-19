"use client";

import { useState } from "react";
import { apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
import { useMessages } from "@/i18n/client";
import { commonMessages } from "@/i18n/messages/common";
import { uiKitMessages } from "@/i18n/messages/ui-kit";
import { ComponentsPanel } from "./components-panel";
import { ScreenComposer } from "./screen-composer";
import { StatesPanel } from "./states-panel";
import { TemplatePanel } from "./template-panel";
import { loadCatalog, type Profile } from "./ui-client";

export type KitTab = "template" | "states" | "components" | "screens";
const TABS: KitTab[] = ["template", "states", "components", "screens"];

/**
 * Kit de UI do jogo (07, cartão U3). Gerar template e estados passa por plano
 * com custo antes do envio (rota genérica, rotulada como tal); separar,
 * transformar estados, montar itens de menu e compor telas é local, sem IA.
 */
export function UiKitStudio({ projectId, initialTab }: { projectId: string; initialTab: KitTab }) {
  const m = useMessages(uiKitMessages).studio;
  const c = useMessages(commonMessages);
  const [tab, setTab] = useState<KitTab>(initialTab);
  const { data, error, refresh } = usePoll(
    async () => {
      const [catalog, { profiles }] = await Promise.all([loadCatalog(projectId), apiFetch<{ profiles: Profile[] }>("/settings/providers")]);
      return { catalog, profiles };
    },
    { active: () => false, slowMs: 60_000 },
  );
  return (
    <>
      <h1>{m.title}</h1>
      <p className="muted small">{m.intro}</p>
      <div className="row" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "" : "secondary"} onClick={() => setTab(id)}>
            {m.tabs[id]}
          </button>
        ))}
        <button type="button" className="secondary" onClick={refresh}>
          {m.reload}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data ? (
        <p className="muted">{c.loading}</p>
      ) : tab === "template" ? (
        <TemplatePanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      ) : tab === "states" ? (
        <StatesPanel projectId={projectId} catalog={data.catalog} profiles={data.profiles} refresh={refresh} />
      ) : tab === "components" ? (
        <ComponentsPanel projectId={projectId} catalog={data.catalog} refresh={refresh} />
      ) : (
        <ScreenComposer projectId={projectId} catalog={data.catalog} refresh={refresh} />
      )}
    </>
  );
}
