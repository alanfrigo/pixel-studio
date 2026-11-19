"use client";

import { useEffect, useState } from "react";
import type { ExpressionPayload, SpeechPayload, VisemeId } from "@/contracts";
import { apiFetch } from "@/app/client/api";
import { useLocale, useMessages, useText } from "@/i18n/client";
import { dialogueMessages } from "@/i18n/messages/dialogue";
import type { RevisionView } from "@/server/catalog/catalog";
import { allRevisions, approvedRevisions, type DialogueCatalog, dialogueApi, errorText, fileOf, mediaUrl, PIXEL } from "./dialogue-client";
import { FrameCrop, sheetOf } from "./expressions-panel";
import { RevisionCard, ZoomSelect } from "./shared";

interface Step {
  visemeId: string;
  durationMs: number;
  textPosition: number;
  startMs?: number;
}

interface Preview {
  text: string;
  timeline: Step[];
  frames: (Step & { startMs: number })[];
  totalMs: number;
  unresolved: { char: string; textPosition: number }[];
  generationJobs: number;
}

/** Toca a sequência com os quadros da expressão (prévia local; a engine usa o mesmo plano). */
function SpeechPlayer({ expression, timeline, text, zoom }: { expression: RevisionView; timeline: Step[]; text: string; zoom: number }) {
  const s = useMessages(dialogueMessages).speech;
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { payload, file, sheet } = sheetOf(expression);
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      if (step + 1 >= timeline.length) {
        setPlaying(false);
        setStep(0);
      } else setStep(step + 1);
    }, timeline[step]?.durationMs ?? 0);
    return () => clearTimeout(timer);
  }, [playing, step, timeline]);
  const current = timeline[Math.min(step, timeline.length - 1)];
  const rect = payload.visemes.find((v) => v.visemeId === current?.visemeId)?.rect;
  const chars = [...text];
  return (
    <div className="row" style={{ alignItems: "center" }}>
      {file && rect && <FrameCrop src={mediaUrl(expression.projectId, file.id)} rect={rect} sheet={sheet} zoom={zoom} title={current?.visemeId} />}
      <div>
        <button type="button" onClick={() => (setStep(0), setPlaying((p) => !p))}>
          {playing ? s.stop : s.play}
        </button>
        <p style={{ fontSize: "1.1em" }}>
          {chars.map((c, i) => (
            <span key={i} style={current && i >= current.textPosition && i < (timeline[step + 1]?.textPosition ?? chars.length) && playing ? { background: "#ffd60066" } : undefined}>
              {c}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

function TimelineTable({ frames, text }: { frames: (Step & { startMs: number })[]; text: string }) {
  const s = useMessages(dialogueMessages).speech;
  const e = useMessages(dialogueMessages).expressions;
  const chars = [...text];
  return (
    <details>
      <summary>{s.timeline}</summary>
      <table className="small">
        <thead>
          <tr>
            <th>{s.columns.step}</th>
            <th>{s.columns.viseme}</th>
            <th>{s.columns.start}</th>
            <th>{s.columns.duration}</th>
            <th>{s.columns.text}</th>
          </tr>
        </thead>
        <tbody>
          {frames.map((f, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{e.visemes[f.visemeId as VisemeId] ?? f.visemeId}</td>
              <td>{f.startMs} ms</td>
              <td>{f.durationMs} ms</td>
              <td>
                {f.textPosition}
                {chars[f.textPosition] ? ` “${chars[f.textPosition]}”` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const withStarts = (timeline: Step[]) => {
  let at = 0;
  return timeline.map((s) => {
    const f = { ...s, startMs: at };
    at += s.durationMs;
    return f;
  });
};

/** Planejador de fala: texto → sequência de visemes (regra letters-v1), prévia animada e publicação sem geração. */
export function SpeechPanel({ projectId, catalog, refresh }: { projectId: string; catalog: DialogueCatalog; refresh: () => void }) {
  const m = useMessages(dialogueMessages);
  const s = m.speech;
  const text = useText();
  const expressions = approvedRevisions(catalog.expressions).filter(({ revision }) => (revision.technicalReport as { complete?: boolean } | null)?.complete !== false);
  const [expressionId, setExpressionId] = useState("");
  const [textKey, setTextKey] = useState("npc.greeting");
  const locale = useLocale();
  const [language, setLanguage] = useState<"pt-BR" | "en">(locale);
  const [line, setLine] = useState(s.defaultLine);
  const [rate, setRate] = useState(1);
  const [name, setName] = useState("");
  const [zoom, setZoom] = useState(3);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const expression = expressions.find((x) => x.revision.id === expressionId) ?? expressions[0];
  const body = () => ({ expressionRevisionId: expression!.revision.id, textKey, language, text: line, rate });
  async function compute() {
    setMessage(null);
    try {
      setPreview(await apiFetch<Preview>(dialogueApi(projectId, "/speech/preview"), { method: "POST", json: body() }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function publish() {
    setMessage(null);
    try {
      await apiFetch(dialogueApi(projectId, "/speech"), { method: "POST", json: { ...body(), ...(name.trim() ? { name: name.trim() } : {}) } });
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <>
      <section>
        <h2>{s.heading}</h2>
        <p className="small muted">{text(catalog.speechRule.label)}</p>
        {!expressions.length && <p className="muted">{s.noExpression}</p>}
        <div className="row">
          <label>
            {s.expression}
            <select value={expression?.revision.id ?? ""} onChange={(ev) => (setExpressionId(ev.target.value), setPreview(null))}>
              {expressions.map(({ asset, revision }) => (
                <option key={revision.id} value={revision.id}>
                  {s.expressionOf(asset.name, revision.number)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {s.textKey}
            <input value={textKey} onChange={(ev) => setTextKey(ev.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, ""))} style={{ width: 140 }} />
          </label>
          <label>
            {s.language}
            <select value={language} onChange={(ev) => setLanguage(ev.target.value as "pt-BR" | "en")}>
              <option value="pt-BR">{s.languages["pt-BR"]}</option>
              <option value="en">{s.languages.en}</option>
            </select>
          </label>
          <label>
            {s.rate} {rate.toFixed(2)}×
            <input type="range" min={0.5} max={2} step={0.25} value={rate} onChange={(ev) => setRate(Number(ev.target.value))} />
          </label>
          <ZoomSelect value={zoom} onChange={setZoom} />
        </div>
        <label>
          {s.text}
          <textarea value={line} onChange={(ev) => setLine(ev.target.value)} rows={2} style={{ width: "100%" }} />
        </label>
        <div className="row">
          <button type="button" onClick={compute} disabled={!expression || !line.trim()}>
            {s.preview}
          </button>
          <label>
            {s.name}
            <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder={textKey} />
          </label>
          <button type="button" onClick={publish} disabled={!expression || !line.trim()}>
            {s.publish}
          </button>
        </div>
        {message && <p className="error">{message}</p>}
        {preview && expression && (
          <div className="small">
            <p>
              {s.total(preview.totalMs, preview.timeline.length)} · <strong>{s.zeroJobs}</strong>
            </p>
            {preview.unresolved.length > 0 && <p className="muted">⚠ {s.unresolved(preview.unresolved.map((u) => u.char).join(" "))}</p>}
            <SpeechPlayer expression={expression.revision} timeline={preview.timeline} text={preview.text} zoom={zoom} />
            <TimelineTable frames={preview.frames} text={preview.text} />
          </div>
        )}
      </section>
      <section>
        <h2>{s.speeches}</h2>
        {!catalog.speeches.length && <p className="muted">{m.shared.noRevisions}</p>}
        <div className="row" style={{ alignItems: "flex-start" }}>
          {allRevisions(catalog.speeches).map(({ asset, revision }) => (
            <SpeechCard key={revision.id} projectId={projectId} catalog={catalog} asset={asset} revision={revision} refresh={refresh} />
          ))}
        </div>
      </section>
    </>
  );
}

function SpeechCard({ projectId, catalog, asset, revision, refresh }: { projectId: string; catalog: DialogueCatalog; asset: DialogueCatalog["speeches"][number]["asset"]; revision: DialogueCatalog["speeches"][number]["revisions"][number]; refresh: () => void }) {
  const s = useMessages(dialogueMessages).speech;
  const payload = revision.payload as SpeechPayload;
  const gif = fileOf(revision, "preview-gif");
  const expressions = approvedRevisions(catalog.expressions);
  const current = expressions.find((x) => x.revision.id === payload.expressionRevisionId);
  const sameSet = (r: RevisionView) => {
    const ids = (r.payload as ExpressionPayload).visemes.map((v) => v.visemeId).join("|");
    const mine = current ? (current.revision.payload as ExpressionPayload).visemes.map((v) => v.visemeId).join("|") : null;
    return r.id !== payload.expressionRevisionId && (mine === null || ids === mine);
  };
  const targets = expressions.filter(({ revision: r }) => sameSet(r));
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  async function retarget() {
    setMessage(null);
    try {
      await apiFetch(dialogueApi(projectId, "/speech/retarget"), { method: "POST", json: { speechRevisionId: revision.id, expressionRevisionId: target || targets[0]!.revision.id } });
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <RevisionCard projectId={projectId} asset={asset} revision={revision} src={null} width={260} refresh={refresh}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {gif && <img src={mediaUrl(projectId, gif.id)} alt="" style={{ ...PIXEL, display: "block" }} title={s.derived} />}
      <div>
        <code>{payload.textKey}</code> · {payload.language}
      </div>
      <div>“{payload.sampleText}”</div>
      <div className="muted">{current ? s.expressionOf(current.asset.name, current.revision.number) : payload.expressionRevisionId}</div>
      <div className={revision.verify?.reproducible ? "muted" : "error"}>{revision.verify?.reproducible ? `✓ ${s.reproducible}` : s.notReproducible}</div>
      <TimelineTable frames={withStarts(payload.timeline)} text={payload.sampleText} />
      {targets.length > 0 && (
        <div className="row">
          <label>
            {s.retargetTo}
            <select value={target || targets[0]!.revision.id} onChange={(ev) => setTarget(ev.target.value)}>
              {targets.map(({ asset: a, revision: r }) => (
                <option key={r.id} value={r.id}>
                  {s.expressionOf(a.name, r.number)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="secondary" onClick={retarget}>
            {s.retargetRun}
          </button>
        </div>
      )}
      {message && <p className="error">{message}</p>}
    </RevisionCard>
  );
}
