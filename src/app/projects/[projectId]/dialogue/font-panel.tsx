"use client";

import { useState } from "react";
import type { FontPayload } from "@/contracts";
import { apiFetch } from "@/app/client/api";
import { useLocale, useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { dialogueMessages } from "@/i18n/messages/dialogue";
import type { RevisionView } from "@/server/catalog/catalog";
import { allRevisions, type DialogueCatalog, dialogueApi, errorText, fileOf, mediaUrl, PIXEL, type Profile, uploadImage } from "./dialogue-client";
import { createAsset } from "./portrait-panel";
import { PlanRunner, ProfileSelect, RevisionCard, usableProfile, ZoomSelect } from "./shared";

type Kit = "basic" | "basic_pt";

interface Coverage {
  required: number;
  present: number;
  missing: number[];
  complete: boolean;
  origins: Record<string, number> | null;
}

interface Rendered {
  texts: { text: string; one: string; zoomed: string; width: number; height: number; lines: number; missing: { char: string }[]; overflow: boolean; wrapped: boolean }[];
  warnings: TextValue[];
}

const chars = (cps: number[]) => cps.map((c) => String.fromCodePoint(c)).join(" ");
const DARK = "#1e1e26";

/** Fonte bitmap: gerar pelo gabarito, cobertura do projeto, extensão dos ausentes, bancada de texto e importação. */
export function FontPanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: DialogueCatalog; profiles: Profile[]; refresh: () => void }) {
  const m = useMessages(dialogueMessages);
  const f = m.font;
  const [profileId, setProfileId] = useState("");
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [weight, setWeight] = useState<"light" | "regular" | "bold">("regular");
  const [glyphSize, setGlyphSize] = useState(8);
  const [kit, setKit] = useState<Kit>("basic_pt");
  const [extraText, setExtraText] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const profile = usableProfile(profiles, "generate_pixel_font", profileId);
  const fonts = allRevisions(catalog.fonts);
  const bench = fonts.find((x) => x.revision.id === selected) ?? null;
  return (
    <>
      <section>
        <h2>{f.heading}</h2>
        <div className="row">
          <ProfileSelect profiles={profiles} operation="generate_pixel_font" value={profileId} onChange={setProfileId} />
          <label>
            {m.shared.name}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={f.generate} />
          </label>
          <label>
            {f.weight}
            <select value={weight} onChange={(e) => setWeight(e.target.value as typeof weight)}>
              {(["light", "regular", "bold"] as const).map((w) => (
                <option key={w} value={w}>
                  {f.weights[w]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {f.glyphSize}
            <select value={glyphSize} onChange={(e) => setGlyphSize(Number(e.target.value))}>
              {[6, 7, 8, 10, 12].map((s) => (
                <option key={s} value={s}>
                  {s} px
                </option>
              ))}
            </select>
          </label>
          <label>
            {f.kit}
            <select value={kit} onChange={(e) => setKit(e.target.value as Kit)}>
              <option value="basic">{f.kits.basic}</option>
              <option value="basic_pt">{f.kits.basic_pt}</option>
            </select>
          </label>
        </div>
        <label>
          {f.brief}
          <input value={brief} placeholder={f.briefPlaceholder} onChange={(e) => setBrief(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label>
          {f.extraText}
          <input value={extraText} onChange={(e) => setExtraText(e.target.value)} style={{ width: "100%" }} />
        </label>
        <PlanRunner
          projectId={projectId}
          label={f.generate}
          disabled={!profile}
          body={() => (profile ? { operation: "generate_pixel_font", providerProfileId: profile, brief, weight, glyphSize, kit, extraText } : null)}
          target={() => createAsset(projectId, "font", "bitmap", name.trim() || f.generate)}
          onDone={refresh}
        />
      </section>
      <section>
        <h2>{f.fonts}</h2>
        {!fonts.length && <p className="muted">{m.shared.noRevisions}</p>}
        <div className="row" style={{ alignItems: "flex-start" }}>
          {fonts.map(({ asset, revision }) => {
            const payload = revision.payload as FontPayload;
            const page = fileOf(revision, payload.glyphs[0]?.fileId ?? "");
            const origins = { generated: 0, extended: 0, imported: 0 };
            payload.glyphs.forEach((g) => (origins[g.origin] += 1));
            const missing = (revision.technicalReport as { missing?: number[] } | null)?.missing ?? [];
            return (
              <RevisionCard key={revision.id} projectId={projectId} asset={asset} revision={revision} src={null} width={240} refresh={refresh}>
                {/* Tinta clara (tingível na engine): página sobre fundo escuro. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {page && <img src={mediaUrl(projectId, page.id)} alt={asset.name} style={{ ...PIXEL, width: 240, background: DARK, display: "block" }} />}
                <div>{f.origins(origins.generated, origins.extended, origins.imported)}</div>
                <div className="muted">{f.metrics(payload.metrics.ascent, payload.metrics.descent, payload.metrics.lineHeight, payload.metrics.spaceAdvance, payload.nativeGlyphPx)}</div>
                {!payload.ttf && <div className="muted">{f.noTtf}</div>}
                {missing.length > 0 && <div className="error">{f.missing(chars(missing))}</div>}
                <button type="button" className="secondary" onClick={() => setSelected(revision.id)}>
                  {f.bench}
                </button>
              </RevisionCard>
            );
          })}
        </div>
      </section>
      {bench && <FontBench key={bench.revision.id} projectId={projectId} revision={bench.revision} profileId={profile} catalog={catalog} kit={kit} extraText={extraText} refresh={refresh} />}
      <ImportAtlas projectId={projectId} refresh={refresh} />
    </>
  );
}

function FontBench({ projectId, revision, profileId, catalog, kit, extraText, refresh }: { projectId: string; revision: RevisionView; profileId: string | undefined; catalog: DialogueCatalog; kit: Kit; extraText: string; refresh: () => void }) {
  const m = useMessages(dialogueMessages);
  const f = m.font;
  const text = useText();
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [strings, setStrings] = useState(catalog.fontTestStrings.join("\n"));
  const [zoom, setZoom] = useState(3);
  const [maxWidth, setMaxWidth] = useState("");
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function check() {
    setMessage(null);
    try {
      setCoverage(await apiFetch<Coverage>(dialogueApi(projectId, "/fonts/coverage"), { method: "POST", json: { fontRevisionId: revision.id, kit, extraText } }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function render() {
    setMessage(null);
    try {
      const texts = strings.split("\n").map((s) => s.trimEnd()).filter(Boolean).slice(0, 8);
      setRendered(await apiFetch<Rendered>(dialogueApi(projectId, "/fonts/render"), { method: "POST", json: { fontRevisionId: revision.id, texts, zoom, maxWidth: maxWidth ? Number(maxWidth) : null, background: DARK } }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <section>
      <h2>
        {f.bench} · r{revision.number}
      </h2>
      <div className="row">
        <button type="button" onClick={check}>
          {f.kit}: {f.kits[kit]}
        </button>
      </div>
      {coverage && (
        <div className="small">
          <div>{f.coverage(coverage.present, coverage.required)}</div>
          {coverage.complete ? <div className="muted">✓ {f.complete}</div> : <div className="error">{f.missing(chars(coverage.missing))}</div>}
          {!coverage.complete && revision.status === "approved" && (
            <PlanRunner
              projectId={projectId}
              label={f.extend}
              disabled={!profileId}
              body={() => (profileId ? { operation: "generate_pixel_font", providerProfileId: profileId, mode: "extend", baseRevisionId: revision.id, kit, extraText } : null)}
              target={async () => revision.assetId}
              onDone={refresh}
            />
          )}
        </div>
      )}
      <label>
        {f.testStrings}
        <textarea rows={4} value={strings} onChange={(e) => setStrings(e.target.value)} style={{ width: "100%" }} />
      </label>
      <div className="row">
        <ZoomSelect value={zoom} onChange={setZoom} />
        <label>
          {f.maxWidth}
          <input value={maxWidth} onChange={(e) => setMaxWidth(e.target.value.replace(/\D/g, ""))} style={{ width: 70 }} />
        </label>
        <button type="button" onClick={render}>
          {f.render}
        </button>
      </div>
      {message && <p className="error">{message}</p>}
      {rendered?.texts.map((t, i) => (
        <div key={i} className="small" style={{ margin: "8px 0", borderTop: "1px solid var(--border, #444)", paddingTop: 6 }}>
          <div>
            “{t.text}” · {f.size(t.width, t.height)}
            {t.wrapped ? ` · ${f.wrapped(t.lines)}` : ""}
          </div>
          {t.missing.length > 0 && <div className="error">{f.textMissing([...new Set(t.missing.map((x) => x.char))].join(" "))}</div>}
          {t.overflow && <div className="error">{f.overflow}</div>}
          <div className="row" style={{ alignItems: "flex-start" }}>
            <figure style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={t.one} alt={t.text} style={PIXEL} />
              <figcaption className="muted">{f.oneX}</figcaption>
            </figure>
            <figure style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={t.zoomed} alt={t.text} style={PIXEL} />
              <figcaption className="muted">{zoom}×</figcaption>
            </figure>
          </div>
        </div>
      ))}
      {rendered?.warnings.map((w, i) => (
        <div key={i} className="small muted">
          ⚠ {text(w)}
        </div>
      ))}
    </section>
  );
}

function ImportAtlas({ projectId, refresh }: { projectId: string; refresh: () => void }) {
  const f = useMessages(dialogueMessages).font;
  const locale = useLocale();
  const [file, setFile] = useState<File | null>(null);
  const [grid, setGrid] = useState({ columns: 16, rows: 6, cellW: 8, cellH: 12, baselineY: 9, capHeight: 7 });
  const [charsText, setChars] = useState("");
  const [license, setLicense] = useState("");
  const [provenance, setProvenance] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labels: Record<keyof typeof grid, string> = { columns: f.columns, rows: f.rows, cellW: f.cellW, cellH: f.cellH, baselineY: f.baseline, capHeight: f.capHeight };
  const num = (k: keyof typeof grid) => (
    <label>
      {labels[k]}
      <input type="number" min={1} value={grid[k]} onChange={(e) => setGrid({ ...grid, [k]: Math.max(1, Number(e.target.value)) })} style={{ width: 56 }} />
    </label>
  );
  async function submit() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const uploadId = await uploadImage(projectId, file, file.name, locale);
      await apiFetch(dialogueApi(projectId, "/fonts/import"), {
        method: "POST",
        json: { name: file.name.replace(/\.[a-z]+$/i, ""), uploadId, columns: grid.columns, rows: grid.rows, cell: [grid.cellW, grid.cellH], baselineY: grid.baselineY, capHeight: grid.capHeight, chars: charsText, license: { name: license, provenance } },
      });
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>{f.importHeading}</h2>
      <div className="row">
        <label>
          {f.importFile}
          <input type="file" accept="image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {num("columns")}
        {num("rows")}
        {num("cellW")}
        {num("cellH")}
        {num("baselineY")}
        {num("capHeight")}
      </div>
      <label>
        {f.chars}
        <input value={charsText} onChange={(e) => setChars(e.target.value)} style={{ width: "100%" }} />
      </label>
      <div className="row">
        <label>
          {f.licenseName}
          <input value={license} onChange={(e) => setLicense(e.target.value)} />
        </label>
        <label>
          {f.provenance}
          <input value={provenance} onChange={(e) => setProvenance(e.target.value)} style={{ width: 280 }} />
        </label>
        <button type="button" onClick={submit} disabled={busy || !file || !charsText || !license.trim() || !provenance.trim()}>
          {f.importRun}
        </button>
      </div>
      {message && <p className="error">{message}</p>}
    </section>
  );
}
