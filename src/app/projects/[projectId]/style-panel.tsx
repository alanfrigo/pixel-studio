"use client";

import { useState } from "react";
import type { StylePayload } from "@/contracts";
import { ApiError, apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
import { useMessages } from "@/i18n/client";
import { workspaceMessages } from "@/i18n/messages/workspace";

const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** Guia de estilo (U1): paleta, contorno, luz, densidade e idioma; salvar cria revisão nova. */
export function StylePanel({ projectId, onChange }: { projectId: string; onChange: () => void }) {
  const m = useMessages(workspaceMessages).style;
  const { data, refresh } = usePoll(
    () => apiFetch<{ style: { id: string; number: number; payload: StylePayload } | null }>(`/projects/${projectId}`),
    { active: () => false, slowMs: 60_000 },
  );
  const [draft, setDraft] = useState<StylePayload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const style = draft ?? data?.style?.payload ?? null;
  if (!style || !data?.style) return null;
  const edit = (patch: Partial<StylePayload>) => setDraft({ ...style, ...patch });
  const setColors = (hexes: string[]) => edit({ palette: { ...style.palette, colors: hexes.map((hex, index) => ({ index, hex })) } });
  const hexes = style.palette.colors.map((c) => c.hex);

  async function save() {
    setMessage(null);
    try {
      const { style: saved } = await apiFetch<{ style: { number: number } }>(`/projects/${projectId}/style`, {
        method: "PUT",
        json: { payload: style, expectedActiveStyleRevisionId: data!.style!.id },
      });
      setDraft(null);
      setMessage(m.saved(saved.number));
      refresh();
      onChange();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <section>
      <h2>
        {m.title} <span className="muted small">{m.revision(data.style.number)}</span>
      </h2>
      <div className="row">
        {hexes.map((hex, i) => (
          <span key={i} className="row" style={{ gap: 2 }}>
            <input type="color" value={hex} aria-label={m.color(i + 1)} onChange={(e) => setColors(hexes.map((h, j) => (j === i ? e.target.value : h)))} />
            <button type="button" className="secondary" aria-label={m.removeColor(i + 1)} disabled={hexes.length <= 1} onClick={() => setColors(hexes.filter((_, j) => j !== i))}>
              ×
            </button>
          </span>
        ))}
        <button type="button" className="secondary" onClick={() => setColors([...hexes, "#808080"])}>
          {m.addColor}
        </button>
      </div>
      <div className="row">
        <label>
          {m.palette}
          <select value={style.palette.policy} onChange={(e) => edit({ palette: { ...style.palette, policy: e.target.value as "strict" | "guided" } })}>
            <option value="strict">{m.policy.strict}</option>
            <option value="guided">{m.policy.guided}</option>
          </select>
        </label>
        <label>
          {m.outline}
          <input type="number" min={0} max={4} value={style.outline.widthPx} onChange={(e) => edit({ outline: { ...style.outline, widthPx: Number(e.target.value) } })} />
        </label>
        <label>
          {m.lightFrom}
          <select value={style.lighting.lightFrom} onChange={(e) => edit({ lighting: { ...style.lighting, lightFrom: e.target.value as StylePayload["lighting"]["lightFrom"] } })}>
            {DIRECTIONS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          {m.detail}
          <select value={style.detailDensity} onChange={(e) => edit({ detailDensity: e.target.value as StylePayload["detailDensity"] })}>
            <option value="low">{m.density.low}</option>
            <option value="medium">{m.density.medium}</option>
            <option value="high">{m.density.high}</option>
          </select>
        </label>
        <label>
          {m.briefLanguage}
          <select value={style.briefLanguage} onChange={(e) => edit({ briefLanguage: e.target.value })}>
            <option value="pt-BR">pt-BR</option>
            <option value="en">en</option>
          </select>
        </label>
        <button type="button" disabled={!draft} onClick={save}>
          {m.save}
        </button>
        {draft && (
          <button type="button" className="secondary" onClick={() => setDraft(null)}>
            {m.discard}
          </button>
        )}
      </div>
      {message && <p className="small">{message}</p>}
    </section>
  );
}
