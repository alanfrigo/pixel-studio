"use client";

import { useMemo, useState } from "react";
import { type Rect, TemplatePayload, type UiComponentType } from "@/contracts";
import { groupCells } from "@/domain/ui-template";
import type { RevisionView } from "@/server/catalog/catalog";
import { useMessages } from "@/i18n/client";
import { uiKitMessages } from "@/i18n/messages/ui-kit";
import { apiFetch } from "@/app/client/api";
import { Card, defaultProfile, ProfileSelect, ReviewBar, Zoomed } from "./kit-shared";
import { PlanRunner } from "./plan-runner";
import { errorText, fileUrl, type Profile, type UiCatalog, type UiEntry, uiApi } from "./ui-client";

interface Row {
  localId: string;
  componentType: UiComponentType;
  w: number;
  h: number;
}

/** Kit da demonstração (07): dois itens de menu, um botão de ícone, barra de vida, painel de diálogo e slot. */
const DEMO: Row[] = [
  { localId: "continue", componentType: "menu_item", w: 64, h: 14 },
  { localId: "inventory", componentType: "menu_item", w: 64, h: 14 },
  { localId: "use", componentType: "button", w: 32, h: 16 },
  { localId: "health", componentType: "meter", w: 68, h: 10 },
  { localId: "dialogue", componentType: "panel", w: 24, h: 24 },
  { localId: "slot", componentType: "slot", w: 20, h: 20 },
];

const TYPES: UiComponentType[] = ["button", "menu_item", "panel", "slot", "meter"];

export function TemplatePanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: UiCatalog; profiles: Profile[]; refresh: () => void }) {
  const m = useMessages(uiKitMessages).template;
  const [profile, setProfile] = useState(defaultProfile(profiles));
  const [brief, setBrief] = useState(m.defaultBrief);
  const [rows, setRows] = useState<Row[]>(DEMO);
  const [refs, setRefs] = useState<string[]>([]);
  const [name, setName] = useState(m.defaultName);
  const choices = [...catalog.backgrounds, ...catalog.images];
  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const body = () => ({
    operation: "generate_ui_template",
    providerProfileId: profile,
    brief,
    components: rows.map((r) => ({ localId: r.localId, componentType: r.componentType, logicalSize: [r.w, r.h] })),
    referenceRevisionIds: refs,
  });
  async function target() {
    const { asset } = await apiFetch<{ asset: { id: string } }>(`/projects/${projectId}/assets`, { method: "POST", json: { family: "ui", kind: "template", name } });
    return asset.id;
  }
  const templates = catalog.templates.flatMap((e) => e.revisions.map((revision) => ({ entry: e, revision }))).sort((a, b) => b.revision.createdAt.localeCompare(a.revision.createdAt));
  return (
    <>
      <section>
        <h2>{m.title}</h2>
        <p className="muted small">{m.help}</p>
        <div className="row">
          <ProfileSelect profiles={profiles} value={profile} onChange={setProfile} />
          <label>
            {m.name}
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <label>
          {m.brief}
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} />
        </label>
        <h3 className="small">{m.pieces}</h3>
        {rows.map((r, i) => (
          <div key={i} className="row small">
            <input aria-label={m.localId} value={r.localId} style={{ width: 110 }} onChange={(e) => update(i, { localId: e.target.value })} />
            <select aria-label={m.type} value={r.componentType} onChange={(e) => update(i, { componentType: e.target.value as UiComponentType })}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {m.types[t]}
                </option>
              ))}
            </select>
            <input aria-label={m.width} type="number" min={4} max={256} value={r.w} style={{ width: 64 }} onChange={(e) => update(i, { w: Number(e.target.value) })} />×
            <input aria-label={m.height} type="number" min={4} max={256} value={r.h} style={{ width: 64 }} onChange={(e) => update(i, { h: Number(e.target.value) })} />
            {r.componentType === "meter" && <span className="muted">{m.meterParts}</span>}
            <button type="button" className="secondary" onClick={() => setRows(rows.filter((_, k) => k !== i))}>
              {m.remove}
            </button>
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => setRows([...rows, { localId: `piece${rows.length + 1}`, componentType: "button", w: 32, h: 16 }])}>
          {m.add}
        </button>
        <h3 className="small">{m.references}</h3>
        <p className="muted small">{m.referencesHelp}</p>
        <div className="row small">
          {choices.map((c) => (
            <label key={c.revisionId} style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
              <input type="checkbox" checked={refs.includes(c.revisionId)} onChange={(e) => setRefs(e.target.checked ? [...refs, c.revisionId] : refs.filter((x) => x !== c.revisionId))} />
              {c.assetName} r{c.number}
            </label>
          ))}
          {choices.length === 0 && <span className="muted">{m.noReferences}</span>}
        </div>
        <div style={{ marginTop: 8 }}>
          <PlanRunner projectId={projectId} label={m.generate} body={body} target={target} onDone={refresh} disabled={!profile || rows.length === 0} />
        </div>
      </section>
      <section>
        <h2>{m.candidates}</h2>
        {templates.length === 0 && <p className="muted">{m.none}</p>}
        <div className="row" style={{ alignItems: "flex-start" }}>
          {templates.map(({ entry, revision }) => (
            <TemplateCard key={revision.id} projectId={projectId} entry={entry} revision={revision} catalog={catalog} refresh={refresh} />
          ))}
        </div>
      </section>
    </>
  );
}

function TemplateCard({ projectId, entry, revision, catalog, refresh }: { projectId: string; entry: UiEntry; revision: RevisionView; catalog: UiCatalog; refresh: () => void }) {
  const m = useMessages(uiKitMessages).template;
  const payload = useMemo(() => TemplatePayload.safeParse(revision.payload), [revision.payload]);
  const [split, setSplit] = useState(false);
  if (!payload.success) return null;
  const p = payload.data;
  const zoom = Math.max(1, Math.min(4, Math.floor(480 / p.logicalSize[0])));
  return (
    <Card width={p.logicalSize[0] * zoom + 24}>
      <Zoomed src={fileUrl(projectId, revision, "split-preview")} size={p.logicalSize} zoom={zoom} alt={entry.asset.name} />
      <p className="muted small">{m.legend}</p>
      <ReviewBar projectId={projectId} asset={entry.asset} revision={revision} refresh={refresh} />
      {revision.status === "approved" && (
        <button type="button" className="secondary" onClick={() => setSplit(!split)}>
          {split ? m.hideSplit : m.reviewSplit}
        </button>
      )}
      {split && <SplitForm projectId={projectId} revision={revision} payload={p} catalog={catalog} refresh={refresh} />}
    </Card>
  );
}

function SplitForm({ projectId, revision, payload, catalog, refresh }: { projectId: string; revision: RevisionView; payload: TemplatePayload; catalog: UiCatalog; refresh: () => void }) {
  const m = useMessages(uiKitMessages).template;
  const groups = [...groupCells(payload.cells)];
  const proposals = new Map(payload.proposals.map((pr) => [pr.localId, pr.rect]));
  const [rects, setRects] = useState<Record<string, Rect>>(() => Object.fromEntries(payload.cells.map((c) => [c.localId, proposals.get(c.localId) ?? c.cell])));
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<string[]>(groups.map(([id]) => id));
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setRect = (id: string, k: number, v: number) => setRects({ ...rects, [id]: rects[id]!.map((x, i) => (i === k ? Math.max(i < 2 ? 0 : 1, v) : x)) as Rect });
  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const pieces = groups
        .filter(([id]) => chosen.includes(id))
        .map(([componentId, cells]) => ({ componentId, rects: cells.map((c) => ({ localId: c.localId, rect: rects[c.localId]! })), ...(targets[componentId] ? { assetId: targets[componentId] } : { name: componentId }) }));
      const res = await apiFetch<{ pieces: { componentId: string; revision: { number: number } }[] }>(uiApi(projectId, "/split"), { method: "POST", json: { templateRevisionId: revision.id, pieces } });
      setMessage(m.splitDone(res.pieces.length));
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="small" style={{ marginTop: 8 }}>
      <p className="muted">{m.splitHelp}</p>
      {groups.map(([componentId, cells]) => {
        const kind = cells[0]!.componentType === "menu_item" ? "button" : cells[0]!.componentType;
        const existing = catalog.components.filter((e) => e.asset.kind === kind);
        return (
          <div key={componentId} style={{ borderTop: "1px solid var(--border)", paddingTop: 4, marginTop: 4 }}>
            <label style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
              <input type="checkbox" checked={chosen.includes(componentId)} onChange={(e) => setChosen(e.target.checked ? [...chosen, componentId] : chosen.filter((x) => x !== componentId))} />
              <strong>{componentId}</strong> <span className="muted">{m.types[cells[0]!.componentType]}</span>
            </label>
            {cells.map((c) => (
              <div key={c.localId} className="row">
                <span style={{ minWidth: 90 }}>{c.meterPart ? m.parts[c.meterPart] : m.piece}</span>
                {(["x", "y", "w", "h"] as const).map((axis, k) => (
                  <input key={axis} aria-label={`${c.localId} ${axis}`} type="number" value={rects[c.localId]![k]} style={{ width: 52 }} onChange={(e) => setRect(c.localId, k, Number(e.target.value))} />
                ))}
                {proposals.get(c.localId) === null && <span className="error">{m.emptyCell}</span>}
              </div>
            ))}
            <label>
              {m.target}
              <select value={targets[componentId] ?? ""} onChange={(e) => setTargets({ ...targets, [componentId]: e.target.value })}>
                <option value="">{m.newAsset}</option>
                {existing.map((e) => (
                  <option key={e.asset.id} value={e.asset.id}>
                    {e.asset.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        );
      })}
      <button type="button" onClick={submit} disabled={busy || chosen.length === 0}>
        {m.split}
      </button>
      {message && <p>{message}</p>}
    </div>
  );
}
