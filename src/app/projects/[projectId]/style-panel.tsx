"use client";

import { useState } from "react";
import type { StylePayload } from "@/contracts";
import { ApiError, apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";

const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** Guia de estilo (U1): paleta, contorno, luz, densidade e idioma; salvar cria revisão nova. */
export function StylePanel({ projectId, onChange }: { projectId: string; onChange: () => void }) {
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
      setMessage(`Guia salvo como revisão ${saved.number}.`);
      refresh();
      onChange();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <section>
      <h2>
        Guia de estilo <span className="muted small">revisão {data.style.number}</span>
      </h2>
      <div className="row">
        {hexes.map((hex, i) => (
          <span key={i} className="row" style={{ gap: 2 }}>
            <input type="color" value={hex} aria-label={`Cor ${i + 1}`} onChange={(e) => setColors(hexes.map((h, j) => (j === i ? e.target.value : h)))} />
            <button type="button" className="secondary" aria-label={`Remover cor ${i + 1}`} disabled={hexes.length <= 1} onClick={() => setColors(hexes.filter((_, j) => j !== i))}>
              ×
            </button>
          </span>
        ))}
        <button type="button" className="secondary" onClick={() => setColors([...hexes, "#808080"])}>
          + cor
        </button>
      </div>
      <div className="row">
        <label>
          Paleta
          <select value={style.palette.policy} onChange={(e) => edit({ palette: { ...style.palette, policy: e.target.value as "strict" | "guided" } })}>
            <option value="strict">estrita</option>
            <option value="guided">guia</option>
          </select>
        </label>
        <label>
          Contorno (px)
          <input type="number" min={0} max={4} value={style.outline.widthPx} onChange={(e) => edit({ outline: { ...style.outline, widthPx: Number(e.target.value) } })} />
        </label>
        <label>
          Luz vinda de
          <select value={style.lighting.lightFrom} onChange={(e) => edit({ lighting: { ...style.lighting, lightFrom: e.target.value as StylePayload["lighting"]["lightFrom"] } })}>
            {DIRECTIONS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          Detalhe
          <select value={style.detailDensity} onChange={(e) => edit({ detailDensity: e.target.value as StylePayload["detailDensity"] })}>
            <option value="low">baixo</option>
            <option value="medium">médio</option>
            <option value="high">alto</option>
          </select>
        </label>
        <label>
          Idioma do pedido
          <select value={style.briefLanguage} onChange={(e) => edit({ briefLanguage: e.target.value })}>
            <option value="pt-BR">pt-BR</option>
            <option value="en">en</option>
          </select>
        </label>
        <button type="button" disabled={!draft} onClick={save}>
          Salvar guia
        </button>
        {draft && (
          <button type="button" className="secondary" onClick={() => setDraft(null)}>
            Descartar
          </button>
        )}
      </div>
      {message && <p className="small">{message}</p>}
    </section>
  );
}
