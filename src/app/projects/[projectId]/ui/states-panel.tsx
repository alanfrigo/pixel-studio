"use client";

import { useState } from "react";
import { ButtonPayload, SlotPayload, type StateOrigin, type UiState, type UiTransform } from "@/contracts";
import type { RevisionView } from "@/server/catalog/catalog";
import { useMessages } from "@/i18n/client";
import { uiKitMessages } from "@/i18n/messages/ui-kit";
import { apiFetch } from "@/app/client/api";
import { Card, defaultProfile, ProfileSelect, ReviewBar } from "./kit-shared";
import { PlanRunner } from "./plan-runner";
import { approvedRevisions, errorText, fileUrl, PIXEL, type Profile, type UiCatalog, uiApi } from "./ui-client";

const STATES: UiState[] = ["normal", "hover", "pressed", "disabled", "selected", "empty", "occupied"];

function parse(kind: string, payload: unknown) {
  const r = kind === "button" ? ButtonPayload.safeParse(payload) : SlotPayload.safeParse(payload);
  return r.success ? r.data : null;
}

/** Origem de cada aparência, como texto curto (template, referência, transformação local, importada). */
function useOriginLabel() {
  const m = useMessages(uiKitMessages).states;
  return (origin: StateOrigin | undefined, revNumber: (id: string) => string) => {
    if (!origin) return m.origin.unknown;
    switch (origin.kind) {
      case "imported":
        return m.origin.imported;
      case "template_split":
        return m.origin.template(revNumber(origin.templateRevisionId));
      case "generated_reference":
        return m.origin.reference(revNumber(origin.referenceRevisionId), origin.referenceState);
      case "local_transform":
        return m.origin.local(m.transforms[origin.transform.kind], revNumber(origin.sourceRevisionId), origin.sourceState);
    }
  };
}

export function StatesPanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: UiCatalog; profiles: Profile[]; refresh: () => void }) {
  const m = useMessages(uiKitMessages).states;
  const [profile, setProfile] = useState(defaultProfile(profiles));
  const [selected, setSelected] = useState<string[]>([]);
  const stateful = catalog.components.filter((e) => e.asset.kind === "button" || e.asset.kind === "slot");
  const approved = approvedRevisions(catalog.components, ["button", "slot"]);
  const numbers = new Map(catalog.components.concat(catalog.templates).flatMap((e) => e.revisions.map((r) => [r.id, `${e.asset.name} r${r.number}`] as const)));
  const revNumber = (id: string) => numbers.get(id) ?? id;
  return (
    <>
      <section>
        <h2>{m.generateTitle}</h2>
        <p className="muted small">{m.generateHelp}</p>
        <ProfileSelect profiles={profiles} value={profile} onChange={setProfile} />
        <div className="row small" style={{ margin: "8px 0" }}>
          {approved.map(({ asset, revision }) => (
            <label key={revision.id} style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
              <input type="checkbox" checked={selected.includes(revision.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, revision.id] : selected.filter((x) => x !== revision.id))} />
              {asset.name} r{revision.number}
            </label>
          ))}
          {approved.length === 0 && <span className="muted">{m.noApproved}</span>}
        </div>
        <PlanRunner
          projectId={projectId}
          label={m.generate}
          body={() => (selected.length ? { operation: "generate_ui_states", providerProfileId: profile, componentRevisionIds: selected } : null)}
          target={async () => ""}
          onDone={refresh}
          disabled={selected.length === 0 || !profile}
        />
      </section>
      <LocalForm projectId={projectId} catalog={catalog} refresh={refresh} />
      <section>
        <h2>{m.sideBySide}</h2>
        {stateful.length === 0 && <p className="muted">{m.none}</p>}
        {stateful.map((entry) => (
          <div key={entry.asset.id} style={{ marginBottom: 12 }}>
            <h3 className="small">
              {entry.asset.name} <span className="muted">ui/{entry.asset.kind}</span>
            </h3>
            <div className="row" style={{ alignItems: "flex-start" }}>
              {entry.revisions.slice(0, 4).map((revision) => (
                <StateStrip key={revision.id} projectId={projectId} kind={entry.asset.kind} revision={revision} revNumber={revNumber}>
                  <ReviewBar projectId={projectId} asset={entry.asset} revision={revision} refresh={refresh} />
                </StateStrip>
              ))}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

/** Todos os estados na mesma célula, lado a lado, com origem; estados obrigatórios pendentes ficam marcados. */
function StateStrip({ projectId, kind, revision, revNumber, children }: { projectId: string; kind: string; revision: RevisionView; revNumber: (id: string) => string; children: React.ReactNode }) {
  const m = useMessages(uiKitMessages).states;
  const originLabel = useOriginLabel();
  const p = parse(kind, revision.payload);
  if (!p) return null;
  const [w, h] = p.logicalSize;
  const zoom = Math.max(1, Math.min(4, Math.floor(96 / w)));
  const present = new Set(p.states.map((s) => s.state));
  const missing = p.requiredStates.filter((s) => !present.has(s));
  const focus = "focus" in p ? p.focus : null;
  return (
    <Card width={Math.max(260, (w * zoom + 12) * (p.states.length + 1))}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        {p.states.map((s) => (
          <figure key={s.state} style={{ margin: 0 }} title={originLabel(s.origin, revNumber)}>
            <Crop src={fileUrl(projectId, revision, s.fileId)} rect={s.rect} zoom={zoom} />
            <figcaption className="small">
              {s.state}
              <div className="muted" style={{ maxWidth: w * zoom + 40 }}>
                {originLabel(s.origin, revNumber)}
              </div>
            </figcaption>
          </figure>
        ))}
        {focus && (
          <figure style={{ margin: 0 }}>
            <div style={{ position: "relative", width: w * zoom, height: h * zoom }}>
              <Crop src={fileUrl(projectId, revision, p.states[0]!.fileId)} rect={p.states[0]!.rect} zoom={zoom} abs />
              <Crop src={fileUrl(projectId, revision, focus.fileId)} rect={focus.rect} zoom={zoom} abs />
            </div>
            <figcaption className="small">
              {m.focusOverlay}
              <div className="muted">{focus.origin?.kind === "local_overlay" ? m.origin.overlay(focus.origin.color) : m.origin.imported}</div>
            </figcaption>
          </figure>
        )}
      </div>
      <div className="small">
        {p.complete ? <span className="badge state-approved">{m.complete}</span> : <span className="badge state-candidate">{m.incomplete(missing.join(", "))}</span>}
      </div>
      {children}
    </Card>
  );
}

/** Região de um arquivo ampliada (estado dentro de um atlas ou arquivo próprio). */
function Crop({ src, rect, zoom, abs }: { src: string | null; rect: [number, number, number, number]; zoom: number; abs?: boolean }) {
  if (!src) return null;
  const [x, y, w, h] = rect;
  return (
    <div className="bg-checker" style={{ width: w * zoom, height: h * zoom, overflow: "hidden", position: abs ? "absolute" : "relative", inset: abs ? 0 : undefined }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" style={{ ...PIXEL, position: "absolute", left: -x * zoom, top: -y * zoom, transformOrigin: "0 0", transform: `scale(${zoom})` }} />
    </div>
  );
}

function LocalForm({ projectId, catalog, refresh }: { projectId: string; catalog: UiCatalog; refresh: () => void }) {
  const m = useMessages(uiKitMessages).states;
  const all = catalog.components.filter((e) => e.asset.kind === "button" || e.asset.kind === "slot").flatMap((e) => e.revisions.filter((r) => r.status !== "rejected").map((revision) => ({ asset: e.asset, revision })));
  const [rev, setRev] = useState("");
  const [state, setState] = useState<UiState>("hover");
  const [kind, setKind] = useState<UiTransform["kind"]>("highlight");
  const [steps, setSteps] = useState(-1);
  const [amount, setAmount] = useState(0.25);
  const [dy, setDy] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  const picked = all.find((x) => x.revision.id === rev);
  async function apply() {
    setMessage(null);
    const transform: UiTransform = kind === "ramp" ? { kind, steps } : kind === "highlight" ? { kind, amount } : { kind, dx: 0, dy };
    try {
      const res = await apiFetch<{ revision: { number: number }; missing: string[] }>(uiApi(projectId, "/states/local"), { method: "POST", json: { componentRevisionId: rev, state, transform } });
      setMessage(m.localDone(res.revision.number, res.missing.join(", ")));
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function focus() {
    setMessage(null);
    try {
      const res = await apiFetch<{ revision: { number: number } }>(uiApi(projectId, "/states/focus"), { method: "POST", json: { componentRevisionId: rev } });
      setMessage(m.focusDone(res.revision.number));
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <section>
      <h2>{m.localTitle}</h2>
      <p className="muted small">{m.localHelp}</p>
      <div className="row">
        <label>
          {m.component}
          <select value={rev} onChange={(e) => setRev(e.target.value)}>
            <option value="">—</option>
            {all.map(({ asset, revision }) => (
              <option key={revision.id} value={revision.id}>
                {asset.name} r{revision.number} ({revision.status})
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.state}
          <select value={state} onChange={(e) => setState(e.target.value as UiState)}>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.transform}
          <select value={kind} onChange={(e) => setKind(e.target.value as UiTransform["kind"])}>
            {(["ramp", "highlight", "offset"] as const).map((k) => (
              <option key={k} value={k}>
                {m.transforms[k]}
              </option>
            ))}
          </select>
        </label>
        {kind === "ramp" && (
          <label>
            {m.steps}
            <input type="number" min={-3} max={3} value={steps} style={{ width: 60 }} onChange={(e) => setSteps(Number(e.target.value))} />
          </label>
        )}
        {kind === "highlight" && (
          <label>
            {m.amount(Math.round(amount * 100))}
            <input type="range" min={0.05} max={0.6} step={0.05} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          </label>
        )}
        {kind === "offset" && (
          <label>
            {m.offsetY}
            <input type="number" min={-2} max={2} value={dy} style={{ width: 60 }} onChange={(e) => setDy(Number(e.target.value))} />
          </label>
        )}
        <button type="button" onClick={apply} disabled={!rev}>
          {m.applyLocal}
        </button>
        <button type="button" className="secondary" onClick={focus} disabled={!rev || picked?.asset.kind !== "button"}>
          {m.drawFocus}
        </button>
      </div>
      {message && <p className="small">{message}</p>}
    </section>
  );
}
