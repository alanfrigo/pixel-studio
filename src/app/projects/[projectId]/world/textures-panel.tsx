"use client";

import Link from "next/link";
import { useState } from "react";
import type { TexturePayload } from "@/contracts";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { useLocale, useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { worldMessages } from "@/i18n/messages/world";
import { JobStatus } from "./job-status";
import { errorText, estimateLabel, fileOf, mediaUrl, PIXEL, type PlanPreview, type Profile, review, runPlan, uploadImage, type WorldCatalog } from "./world-client";

/**
 * Textura repetível própria (06 §repetição verificável): gerar material,
 * importar, abrir a bancada (mosaico 3×3 em 1× e ampliado, linhas de emenda,
 * deslocamento cíclico) e corrigir emendas por inpainting.
 */

interface SeamAxis {
  seamDelta: number;
  interiorDelta: number;
  ratio: number;
  passed: boolean;
  flagged: { start: number; end: number; maxDelta: number }[];
}
interface SeamReport {
  threshold: number;
  x: SeamAxis | null;
  y: SeamAxis | null;
}

function axisBadge(payload: TexturePayload, axis: "x" | "y", m: (typeof worldMessages)["en"]["textures"]) {
  const requested = payload.requestedAxes?.[axis] ?? payload.repeatAxes[axis];
  if (!requested) return <span className="badge">{m.axisNotRequested(axis.toUpperCase())}</span>;
  return payload.repeatAxes[axis] ? (
    <span className="badge state-approved">{m.axisSeamless(axis.toUpperCase())}</span>
  ) : (
    <span className="badge state-rejected">{m.axisSeamFailed(axis.toUpperCase())}</span>
  );
}

export function TexturesPanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: WorldCatalog; profiles: Profile[]; refresh: () => void }) {
  const m = useMessages(worldMessages).textures;
  const w = useMessages(worldMessages).shared;
  const c = useMessages(commonMessages);
  const text = useText();
  const [bench, setBench] = useState<{ asset: AssetView; revision: RevisionView } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const textures = catalog.textures;

  async function decide(asset: AssetView, revision: RevisionView, decision: "approve" | "reject") {
    try {
      const reason = decision === "reject" ? (window.prompt(c.rejectReasonPrompt) ?? "").trim() || null : null;
      if (decision === "reject" && !reason) return;
      await review(projectId, asset, revision.id, decision, reason);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <>
      {message && <p className="error">{message}</p>}
      <div className="grid2">
        <GenerateTexture projectId={projectId} profiles={profiles} textures={textures} refresh={refresh} />
        <ImportTexture projectId={projectId} refresh={refresh} />
      </div>
      <section>
        <h2>{m.projectTextures}</h2>
        {textures.length === 0 && <p className="muted small">{m.empty}</p>}
        {textures.map(({ asset, revisions }) => (
          <div key={asset.id} style={{ marginBottom: 12 }}>
            <strong>{asset.name}</strong>{" "}
            <span className="muted small">
              {asset.approvedRevisionId ? w.activeRevision(revisions.find((r) => r.id === asset.approvedRevisionId)?.number) : m.noApproved}
            </span>
            <div className="row" style={{ alignItems: "flex-start", marginTop: 6 }}>
              {revisions.slice(0, 6).map((rev) => {
                const payload = rev.payload as TexturePayload;
                const tex = fileOf(rev, "texture");
                const report = rev.technicalReport as { verdict?: TextValue; routeLabel?: TextValue; label?: TextValue } | null;
                return (
                  <div key={rev.id} className="small" style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8, width: 230 }}>
                    <div className="row">
                      {tex && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={mediaUrl(projectId, tex.id)} alt={`${asset.name} r${rev.number}`} width={payload.logicalSize[0] * 2} height={payload.logicalSize[1] * 2} className="pixel bg-checker" style={PIXEL} />
                      )}
                      <div>
                        r{rev.number} <span className={`badge state-${rev.status}`}>{labelOf(c.revisionStatus, rev.status)}</span>
                        <br />
                        {payload.logicalSize.join("×")} · {rev.origin}
                      </div>
                    </div>
                    <div className="row" style={{ marginTop: 4 }}>
                      {axisBadge(payload, "x", m)}
                      {axisBadge(payload, "y", m)}
                    </div>
                    {report?.verdict && <p className="muted">{text(report.verdict)}</p>}
                    <div className="row">
                      <button type="button" className="secondary" onClick={() => setBench({ asset, revision: rev })}>
                        {m.bench}
                      </button>
                      {rev.status === "candidate" && (
                        <>
                          <button type="button" onClick={() => decide(asset, rev, "approve")}>
                            {c.approve}
                          </button>
                          <button type="button" className="secondary" onClick={() => decide(asset, rev, "reject")}>
                            {c.reject}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>
      {bench && <TextureBench projectId={projectId} asset={bench.asset} revision={bench.revision} refresh={refresh} onClose={() => setBench(null)} />}
    </>
  );
}

function TextureBench({ projectId, asset, revision, refresh, onClose }: { projectId: string; asset: AssetView; revision: RevisionView; refresh: () => void; onClose: () => void }) {
  const m = useMessages(worldMessages).textures;
  const c = useMessages(commonMessages);
  const text = useText();
  const [lines, setLines] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const payload = revision.payload as TexturePayload;
  const report = (revision.technicalReport as { seams?: SeamReport } | null)?.seams ?? null;
  const axes = payload.requestedAxes ?? payload.repeatAxes;
  const url = (key: string) => {
    const f = fileOf(revision, key);
    return f ? mediaUrl(projectId, f.id) : null;
  };
  const [w, h] = payload.logicalSize;
  const cols = axes.x ? 3 : 1;
  const rows = axes.y ? 3 : 1;
  const zoom = Math.max(1, Math.floor(384 / Math.max(w * cols, h * rows)));

  async function publish(image: { from: "revision"; revisionId: string; fileKey: string }, unshift: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch<{ revision: RevisionView; verdict: TextValue }>(`/projects/${projectId}/world/textures`, {
        method: "POST",
        json: { target: { assetId: asset.id }, texture: { image, material: payload.material, axes, threshold: payload.seamReport.threshold, sourceRevisionId: revision.id, unshift } },
      });
      setMessage(m.publishedCandidate(res.revision.number, text(res.verdict)));
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>
          {m.benchTitle} · {asset.name} r{revision.number}
        </h2>
        <button type="button" className="secondary" onClick={onClose}>
          {c.close}
        </button>
      </div>
      <p className="small">{m.materialLine(payload.material, payload.seamReport.threshold, payload.seamReport.method)}</p>
      {report && (
        <table className="small" style={{ marginBottom: 8 }}>
          <thead>
            <tr>
              <th>{m.axis}</th>
              <th>{m.seam}</th>
              <th>{m.interior}</th>
              <th>{m.ratio}</th>
              <th>{m.result}</th>
              <th>{m.flaggedSeams}</th>
            </tr>
          </thead>
          <tbody>
            {(["x", "y"] as const).map((a) =>
              report[a] ? (
                <tr key={a}>
                  <td>{a.toUpperCase()}</td>
                  <td>{report[a]!.seamDelta}</td>
                  <td>{report[a]!.interiorDelta}</td>
                  <td>{report[a]!.ratio}</td>
                  <td className={report[a]!.passed ? "" : "error"}>{report[a]!.passed ? m.passed : m.failed}</td>
                  <td>{report[a]!.flagged.map((f) => m.flaggedRange(a, f.start, f.end, f.maxDelta)).join("; ") || "—"}</td>
                </tr>
              ) : (
                <tr key={a}>
                  <td>{a.toUpperCase()}</td>
                  <td colSpan={5} className="muted">
                    {m.axisNotRequestedRow}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      <div className="row" style={{ alignItems: "flex-start" }}>
        <figure style={{ margin: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {url("mosaic") && <img src={url("mosaic")!} alt={m.mosaicAlt} className="pixel bg-checker" style={PIXEL} />}
          <figcaption className="small">{m.mosaicCaption(cols, rows)}</figcaption>
        </figure>
        <figure style={{ margin: 0 }}>
          {lines && url("mosaic-lines") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url("mosaic-lines")!} alt={m.mosaicLinesAlt} style={{ ...PIXEL, width: w * cols * zoom }} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            url("mosaic") && <img src={url("mosaic")!} alt={m.mosaicZoomAlt} className="pixel" style={{ ...PIXEL, width: w * cols * zoom }} />
          )}
          <figcaption className="small">
            <label style={{ flexDirection: "row", gap: 4, color: "inherit" }}>
              <input type="checkbox" checked={lines} onChange={(e) => setLines(e.target.checked)} /> {m.seamLines}
            </label>
          </figcaption>
        </figure>
        <figure style={{ margin: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {url("shifted") && <img src={url("shifted")!} alt={m.shiftedAlt} className="pixel" style={{ ...PIXEL, width: w * 4 }} />}
          <figcaption className="small">{m.shiftedCaption}</figcaption>
        </figure>
      </div>
      <ScrollPreview src={url("texture")} size={[w, h]} axes={axes} />
      <h3 className="small">{m.fixSeams}</h3>
      <ol className="small">
        <li>
          <button type="button" className="secondary" disabled={busy || !url("shifted")} onClick={() => publish({ from: "revision", revisionId: revision.id, fileKey: "shifted" }, false)}>
            {m.publishShifted}
          </button>{" "}
          {m.publishShiftedNote}
        </li>
        <li>
          {m.paintSeams}{" "}
          {revision.status === "approved" ? (
            <Link href={`/projects/${projectId}/inpaint?asset=${asset.id}&revision=${revision.id}&file=texture`}>{m.inpaintThis}</Link>
          ) : (
            m.inpaintOpenShifted
          )}
          .
        </li>
        <li>
          <button type="button" className="secondary" disabled={busy} onClick={() => publish({ from: "revision", revisionId: revision.id, fileKey: "texture" }, true)}>
            {m.unshift}
          </button>
        </li>
      </ol>
      {message && <p className="small">{message}</p>}
    </section>
  );
}

/** Rolagem nos eixos declarados: a mesma textura repetida num fundo que se desloca. */
function ScrollPreview({ src, size, axes }: { src: string | null; size: [number, number]; axes: { x: boolean; y: boolean } }) {
  const m = useMessages(worldMessages).textures;
  const [offset, setOffset] = useState(0);
  if (!src) return null;
  const scale = 3;
  return (
    <div className="small" style={{ marginTop: 8 }}>
      <div
        className="pixel"
        style={{
          ...PIXEL,
          width: 360,
          height: axes.y ? 180 : size[1] * scale,
          backgroundImage: `url(${src})`,
          backgroundSize: `${size[0] * scale}px ${size[1] * scale}px`,
          backgroundRepeat: axes.x && axes.y ? "repeat" : axes.x ? "repeat-x" : "repeat-y",
          backgroundPosition: `${axes.x ? -offset : 0}px ${axes.y ? -offset : 0}px`,
          border: "1px solid var(--border)",
        }}
      />
      <label style={{ flexDirection: "row", gap: 6, color: "inherit" }}>
        {m.scroll}
        <input type="range" min={0} max={size[0] * scale * 4} value={offset} onChange={(e) => setOffset(Number(e.target.value))} />
      </label>
    </div>
  );
}

function GenerateTexture({ projectId, profiles, textures, refresh }: { projectId: string; profiles: Profile[]; textures: WorldCatalog["textures"]; refresh: () => void }) {
  const m = useMessages(worldMessages).textures;
  const w = useMessages(worldMessages).shared;
  const c = useMessages(commonMessages);
  const locale = useLocale();
  const text = useText();
  const usable = profiles.filter((p) => (p.capabilities.generate_texture?.length ?? 0) > 0);
  const [name, setName] = useState(m.defaultName);
  const [brief, setBrief] = useState(m.defaultBrief);
  const [size, setSize] = useState(32);
  const [axes, setAxes] = useState({ x: true, y: true });
  const [threshold, setThreshold] = useState(1.5);
  const [refs, setRefs] = useState<string[]>([]);
  const [profileId, setProfileId] = useState("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const profile = usable.find((p) => p.id === profileId) ?? usable[0];
  const approved = textures.flatMap(({ asset, revisions }) => revisions.filter((r) => r.status === "approved").map((r) => ({ asset, r })));

  async function plan() {
    setMessage(null);
    try {
      if (!profile) throw new Error(m.noProfile);
      const p = await apiFetch<PlanPreview>(`/projects/${projectId}/generation-plans`, {
        method: "POST",
        json: { operation: "generate_texture", providerProfileId: profile.id, materialBrief: brief, logicalSize: [size, size], repeatAxes: axes, seamThreshold: threshold, referenceRevisionIds: refs },
      });
      setPreview(p);
      return p;
    } catch (err) {
      setMessage(errorText(err));
      return null;
    }
  }

  async function run() {
    const p = preview ?? (await plan());
    if (!p) return;
    try {
      const { asset } = await apiFetch<{ asset: AssetView }>(`/projects/${projectId}/assets`, { method: "POST", json: { family: "texture", kind: "material", name } });
      const res = await runPlan(projectId, p, asset.id);
      setJobId(res.job.id);
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <section>
      <h2>{m.generateTitle}</h2>
      <div className="row">
        <label>
          {w.name}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {w.size}
          <select value={size} onChange={(e) => (setSize(Number(e.target.value)), setPreview(null))}>
            {[16, 32, 48, 64].map((s) => (
              <option key={s} value={s}>
                {s}×{s}
              </option>
            ))}
          </select>
        </label>
        <label>
          {w.threshold}
          <input type="number" step={0.1} min={1} max={5} value={threshold} onChange={(e) => (setThreshold(Number(e.target.value)), setPreview(null))} style={{ width: 70 }} />
        </label>
        {(["x", "y"] as const).map((a) => (
          <label key={a} style={{ flexDirection: "row", gap: 4, color: "inherit" }}>
            <input type="checkbox" checked={axes[a]} onChange={(e) => (setAxes({ ...axes, [a]: e.target.checked }), setPreview(null))} /> {m.repeatsOn(a.toUpperCase())}
          </label>
        ))}
      </div>
      <label>
        {m.material}
        <textarea value={brief} maxLength={500} onChange={(e) => (setBrief(e.target.value), setPreview(null))} />
      </label>
      {approved.length > 0 && (
        <label>
          {m.materialRefs}
          <select multiple value={refs} onChange={(e) => (setRefs([...e.target.selectedOptions].map((o) => o.value)), setPreview(null))}>
            {approved.map(({ asset, r }) => (
              <option key={r.id} value={r.id}>
                {asset.name} r{r.number}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <label>
          {w.profile}
          <select value={profile?.id ?? ""} onChange={(e) => (setProfileId(e.target.value), setPreview(null))}>
            {usable.length === 0 && <option value="">{m.noProfile}</option>}
            {usable.map((p) => (
              <option key={p.id} value={p.id} disabled={Boolean(p.unavailable)}>
                {p.name}
                {p.unavailable ? ` (${c.unavailable})` : ""}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary" disabled={!axes.x && !axes.y} onClick={plan}>
          {w.planPreview}
        </button>
        <button type="button" disabled={!axes.x && !axes.y} onClick={run}>
          {w.generate}
        </button>
      </div>
      {preview && (
        <div className="small">
          <p>
            {text(preview.routeLabel)} · {w.destination(preview.destination.name)}
            {preview.destination.simulated ? w.simulated : ""} · {w.estimate(estimateLabel(preview.plan, locale))}
          </p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{preview.plan.prompt.compiled}</pre>
        </div>
      )}
      {message && <p className="error small">{message}</p>}
      {jobId && <JobStatus projectId={projectId} jobId={jobId} onDone={refresh} />}
    </section>
  );
}

function ImportTexture({ projectId, refresh }: { projectId: string; refresh: () => void }) {
  const m = useMessages(worldMessages).textures;
  const w = useMessages(worldMessages).shared;
  const locale = useLocale();
  const text = useText();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [axes, setAxes] = useState({ x: true, y: true });
  const [threshold, setThreshold] = useState(1.5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const uploadId = await uploadImage(projectId, file, file.name, locale);
      const material = name.trim() || file.name.replace(/\.[^.]+$/, "");
      const res = await apiFetch<{ revision: RevisionView; verdict: TextValue }>(`/projects/${projectId}/world/textures`, {
        method: "POST",
        json: { target: { name: material }, texture: { image: { from: "upload", uploadId }, material, axes, threshold } },
      });
      setMessage(`r${res.revision.number}: ${text(res.verdict)}`);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>{m.importTitle}</h2>
      <p className="small muted">{m.importNote}</p>
      <div className="row">
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <label>
          {m.material}
          <input value={name} placeholder={m.fileNamePlaceholder} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {w.threshold}
          <input type="number" step={0.1} min={1} max={5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        {(["x", "y"] as const).map((a) => (
          <label key={a} style={{ flexDirection: "row", gap: 4, color: "inherit" }}>
            <input type="checkbox" checked={axes[a]} onChange={(e) => setAxes({ ...axes, [a]: e.target.checked })} /> {a.toUpperCase()}
          </label>
        ))}
        <button type="button" disabled={busy || !file || (!axes.x && !axes.y)} onClick={submit}>
          {m.importAndValidate}
        </button>
      </div>
      {message && <p className="small">{message}</p>}
    </section>
  );
}
