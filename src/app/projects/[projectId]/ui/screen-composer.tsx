"use client";

import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { gridCellOffsets, MenuItemPayload, ScreenPayload, type ScreenInstance, type Size, type TextSlot, UiElementRole, type UiState } from "@/contracts";
import { focusStepForKey, layoutScreen, moveFocus, type ResolvedInstance, starterScreen } from "@/domain/ui-screen";
import type { RevisionView } from "@/server/catalog/catalog";
import { useMessages } from "@/i18n/client";
import { uiKitMessages } from "@/i18n/messages/ui-kit";
import { ApiError, apiFetch } from "@/app/client/api";
import { loadImage, naturalSize, type RenderDeps, renderScreen, screenProblems, screenUrls } from "./render";
import { approvedRevisions, errorText, issuesText, type UiCatalog, uiApi } from "./ui-client";

/**
 * Compositor de telas (07 §compor uma tela, cartão U3): âncoras por lado +
 * offsets inteiros, grupos, ordem de desenho, ordem de foco independente,
 * navegação por teclado, valor do medidor, estados, legendas e idioma —
 * tudo sem job de geração. Salvar publica uma revisão candidata da tela.
 */

const RESOLUTIONS: Size[] = [
  [320, 180],
  [400, 300],
];
const SIDES = ["left", "top", "right", "bottom"] as const;
const STATES: UiState[] = ["normal", "hover", "pressed", "disabled", "selected", "empty", "occupied"];
type Backdrop = "scene" | "light" | "dark";

let counter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`;

export function ScreenComposer({ projectId, catalog, refresh }: { projectId: string; catalog: UiCatalog; refresh: () => void }) {
  const m = useMessages(uiKitMessages).composer;
  const deps = useMemo<Omit<RenderDeps, "loaded">>(() => {
    const revisions = new Map<string, { kind: string; revision: RevisionView }>();
    for (const e of catalog.components) for (const r of e.revisions) revisions.set(r.id, { kind: e.asset.kind, revision: r });
    const images = new Map([...catalog.images, ...catalog.backgrounds].map((i) => [i.revisionId, i]));
    return { projectId, revisions, images };
  }, [catalog, projectId]);
  const [screenAssetId, setScreenAssetId] = useState("");
  const [loadedRevisionId, setLoadedRevisionId] = useState<string | null>(null);
  const [payload, setPayload] = useState<ScreenPayload | null>(null);
  const [name, setName] = useState(m.defaultName);
  const [resolution, setResolution] = useState<Size>([320, 180]);
  const [zoom, setZoom] = useState(3);
  const [language, setLanguage] = useState("pt-BR");
  const [backdrop, setBackdrop] = useState<Backdrop>("scene");
  const [guides, setGuides] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Map<string, HTMLImageElement>>(new Map());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resolvedRef = useRef<ResolvedInstance[]>([]);
  const dirty = useRef(false);

  const change = (next: ScreenPayload) => {
    dirty.current = true;
    setPayload(next);
  };
  const languages = payload?.textCatalog?.languages ?? ["pt-BR", "en"];

  // Pré-carrega as imagens da tela antes de desenhar.
  useEffect(() => {
    if (!payload) return;
    let alive = true;
    const urls = screenUrls(payload, deps).filter((u) => !loaded.has(u));
    if (!urls.length) return;
    Promise.all(urls.map((u) => loadImage(u).then((img) => [u, img] as const, () => null))).then((pairs) => {
      if (!alive) return;
      setLoaded((prev) => {
        const next = new Map(prev);
        for (const p of pairs) if (p) next.set(p[0], p[1]);
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [payload, deps, loaded]);

  // Desenha em 1× na resolução lógica e amplia por fator inteiro.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !payload) return;
    const [W, H] = resolution;
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const o = off.getContext("2d")!;
    const shown = backdrop === "scene" ? payload : { ...payload, background: null };
    resolvedRef.current = renderScreen(o, shown, resolution, { ...deps, loaded }, { language, hover, focus, pressed, focusColor: catalog.focusColor, textColor: "#f4f1e8", guides, selected });
    canvas.width = W * zoom;
    canvas.height = H * zoom;
    const c = canvas.getContext("2d")!;
    c.imageSmoothingEnabled = false;
    c.fillStyle = backdrop === "light" ? "#e9e4d4" : backdrop === "dark" ? "#14141a" : "#2a2a31";
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(off, 0, 0, W * zoom, H * zoom);
  }, [payload, resolution, zoom, deps, loaded, language, hover, focus, pressed, catalog.focusColor, guides, selected, backdrop]);

  const checks = useMemo(() => (payload ? (payload.testedResolutions?.length ? payload.testedResolutions : [payload.referenceResolution]).map((r) => screenProblems(payload, r, deps, language)) : []), [payload, deps, language]);

  function startFromKit() {
    const pick = (kind: string) => approvedRevisions(catalog.components, [kind])[0]?.revision;
    const size = (id: string | undefined) => (id ? (naturalSize(id, deps) ?? [16, 16]) : [16, 16]) as [number, number];
    const meter = pick("meter");
    const panel = pick("panel");
    const slot = pick("slot");
    const portrait = catalog.images.find((i) => i.family === "portrait") ?? catalog.images.find((i) => i.family === "character");
    const potion = catalog.images.find((i) => i.family === "item");
    const items = approvedRevisions(catalog.components, ["menu_item"]).slice(0, 3);
    const next = starterScreen({
      meter: meter ? { revisionId: meter.id, size: size(meter.id) } : undefined,
      panel: panel ? { revisionId: panel.id } : undefined,
      portrait: portrait ? { revisionId: portrait.revisionId, size: [portrait.rect[2], portrait.rect[3]] } : undefined,
      menuItems: items.map(({ revision }) => ({ revisionId: revision.id, size: size(revision.id) })),
      slot: slot ? { revisionId: slot.id, size: size(slot.id) } : undefined,
      icon: potion ? { revisionId: potion.revisionId } : undefined,
      background: catalog.backgrounds[0] ? { revisionId: catalog.backgrounds[0].revisionId } : undefined,
    });
    // Legendas dos itens de menu entram no catálogo pela chave de cada item.
    for (const { revision } of items) {
      const text = MenuItemPayload.parse(revision.payload).text;
      if (!next.textCatalog!.entries.some((e) => e.key === text.key)) next.textCatalog!.entries.push({ key: text.key, text: { "pt-BR": text.sample } });
    }
    setScreenAssetId("");
    setLoadedRevisionId(null);
    change(next);
    setSelected(null);
    setFocus(null);
  }

  function startEmpty() {
    setScreenAssetId("");
    setLoadedRevisionId(null);
    change({
      referenceResolution: [320, 180],
      background: null,
      instances: [{ instanceId: "root", parentId: null, componentRevisionId: null, anchors: { left: 0, top: 0, right: 1, bottom: 1 }, offsets: { left: 0, top: 0, right: 0, bottom: 0 }, order: 0, hidden: false, overrides: {} }],
      focusOrder: [],
      textCatalog: { languages: ["pt-BR", "en"], entries: [] },
      testedResolutions: RESOLUTIONS,
    });
  }

  function open(revision: RevisionView, assetId: string) {
    const parsed = ScreenPayload.safeParse(revision.payload);
    if (!parsed.success) return setMessage(m.invalid);
    setScreenAssetId(assetId);
    setLoadedRevisionId(revision.id);
    dirty.current = false;
    setPayload(parsed.data);
    setSelected(null);
    setFocus(null);
    setMessage(m.opened(revision.number));
  }

  async function save() {
    if (!payload) return;
    setMessage(null);
    try {
      const res = await apiFetch<{ asset: { id: string }; revision: RevisionView }>(uiApi(projectId, "/screens"), { method: "POST", json: { ...(screenAssetId ? { assetId: screenAssetId } : { name }), payload, language } });
      setScreenAssetId(res.asset.id);
      setLoadedRevisionId(res.revision.id);
      dirty.current = false;
      setMessage(m.saved(res.revision.number));
      refresh();
    } catch (err) {
      setMessage((err instanceof ApiError && issuesText(err.details)) || errorText(err));
    }
  }

  async function duplicate() {
    if (!loadedRevisionId) return;
    try {
      const res = await apiFetch<{ asset: { id: string; name: string }; revision: RevisionView }>(`/projects/${projectId}/library/duplicate`, { method: "POST", json: { revisionId: loadedRevisionId, name: `${name} · ${m.copySuffix}` } });
      setScreenAssetId(res.asset.id);
      setLoadedRevisionId(res.revision.id);
      setMessage(m.duplicated(res.asset.name));
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  // Componentes com revisão aprovada mais nova que a usada nas instâncias (oferecer religar).
  const updates = useMemo(() => {
    if (!payload) return [];
    const used = new Set(payload.instances.map((i) => i.componentRevisionId).filter((x): x is string => Boolean(x)));
    const out: { from: string; to: string; label: string }[] = [];
    for (const e of catalog.components) {
      const approved = e.asset.approvedRevisionId;
      for (const r of e.revisions) if (used.has(r.id) && approved && approved !== r.id) out.push({ from: r.id, to: approved, label: `${e.asset.name} r${r.number} → r${e.revisions.find((x) => x.id === approved)?.number}` });
    }
    return out;
  }, [payload, catalog.components]);

  async function rebind() {
    if (!payload || !updates.length) return;
    if (loadedRevisionId && !dirty.current) {
      try {
        const res = await apiFetch<{ revision: RevisionView; instances: number }>(uiApi(projectId, "/screens/rebind"), { method: "POST", json: { screenRevisionId: loadedRevisionId, replacements: updates.map(({ from, to }) => ({ from, to })) } });
        open(res.revision, screenAssetId);
        setMessage(m.rebound(res.instances, res.revision.number));
        refresh();
      } catch (err) {
        setMessage(errorText(err));
      }
      return;
    }
    const swap = new Map(updates.map((u) => [u.from, u.to]));
    change({ ...payload, instances: payload.instances.map((i) => (i.componentRevisionId && swap.has(i.componentRevisionId) ? { ...i, componentRevisionId: swap.get(i.componentRevisionId)! } : i)) });
    setMessage(m.reboundLocal);
  }

  // ---- interação na prévia: ponteiro e teclado ----
  const at = (e: MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.floor(((e.clientX - r.left) / r.width) * resolution[0]), Math.floor(((e.clientY - r.top) / r.height) * resolution[1])] as const;
  };
  const hit = (x: number, y: number, interactive: boolean) =>
    [...resolvedRef.current].reverse().find((r) => r.visible && x >= r.rect[0] && y >= r.rect[1] && x < r.rect[0] + r.rect[2] && y < r.rect[1] + r.rect[3] && (!interactive || payload?.focusOrder.includes(r.instance.instanceId)))?.instance.instanceId ?? null;
  function activate(id: string) {
    setPressed(id);
    setTimeout(() => setPressed(null), 180);
    const inst = payload?.instances.find((i) => i.instanceId === id);
    const ref = inst?.componentRevisionId ? deps.revisions.get(inst.componentRevisionId) : undefined;
    setMessage(ref?.kind === "menu_item" ? m.triggered(MenuItemPayload.parse(ref.revision.payload).actionId) : m.activated(id));
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!payload) return;
    const step = focusStepForKey(e.key, e.shiftKey);
    if (step) {
      e.preventDefault();
      setFocus(moveFocus(payload, resolution, focus, step));
    } else if ((e.key === "Enter" || e.key === " ") && focus) {
      e.preventDefault();
      activate(focus);
    }
  }

  const sel = payload?.instances.find((i) => i.instanceId === selected) ?? null;
  const update = (id: string, patch: Partial<ScreenInstance>) => payload && change({ ...payload, instances: payload.instances.map((i) => (i.instanceId === id ? { ...i, ...patch } : i)) });

  return (
    <>
      <section>
        <h2>{m.title}</h2>
        <p className="muted small">{m.help}</p>
        <div className="row">
          <button type="button" onClick={startFromKit}>
            {m.fromKit}
          </button>
          <button type="button" className="secondary" onClick={startEmpty}>
            {m.empty}
          </button>
          {catalog.screens.map((e) => (
            <span key={e.asset.id} className="small">
              {e.asset.name}:{" "}
              {e.revisions.slice(0, 4).map((r) => (
                <button key={r.id} type="button" className="secondary" onClick={() => open(r, e.asset.id)}>
                  r{r.number} {r.status === "approved" ? "✓" : ""}
                </button>
              ))}
            </span>
          ))}
        </div>
      </section>
      {payload && (
        <>
          <section>
            <div className="row small">
              <label>
                {m.name}
                <input value={name} onChange={(e) => setName(e.target.value)} disabled={Boolean(screenAssetId)} />
              </label>
              <label>
                {m.resolution}
                <select value={resolution.join("x")} onChange={(e) => setResolution(e.target.value.split("x").map(Number) as Size)}>
                  {(payload.testedResolutions?.length ? payload.testedResolutions : RESOLUTIONS).map((r) => (
                    <option key={r.join("x")} value={r.join("x")}>
                      {r.join(" × ")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {m.zoom}
                <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
                  {[1, 2, 3, 4].map((z) => (
                    <option key={z} value={z}>
                      {z}×
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {m.language}
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {languages.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {m.backdrop}
                <select value={backdrop} onChange={(e) => setBackdrop(e.target.value as Backdrop)}>
                  {(["scene", "light", "dark"] as const).map((b) => (
                    <option key={b} value={b}>
                      {m.backdrops[b]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {m.background}
                <select value={payload.background?.revisionId ?? ""} onChange={(e) => change({ ...payload, background: e.target.value ? { revisionId: e.target.value, exported: payload.background?.exported ?? false } : null })}>
                  <option value="">—</option>
                  {catalog.backgrounds.map((b) => (
                    <option key={b.revisionId} value={b.revisionId}>
                      {b.assetName} r{b.number}
                    </option>
                  ))}
                </select>
              </label>
              {payload.background && (
                <label style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
                  <input type="checkbox" checked={payload.background.exported} onChange={(e) => change({ ...payload, background: { ...payload.background!, exported: e.target.checked } })} /> {m.backgroundExported}
                </label>
              )}
              <label style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
                <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> {m.guides}
              </label>
            </div>
            <div tabIndex={0} onKeyDown={onKey} aria-label={m.previewLabel} style={{ outline: "none", marginTop: 8, overflow: "auto", maxWidth: "100%" }}>
              <canvas
                ref={canvasRef}
                className="pixel"
                style={{ imageRendering: "pixelated", border: "1px solid var(--border)" }}
                onMouseMove={(e) => setHover(hit(...at(e), true))}
                onMouseLeave={() => setHover(null)}
                onClick={(e) => {
                  const [x, y] = at(e);
                  const target = hit(x, y, false);
                  setSelected(target);
                  const interactive = hit(x, y, true);
                  if (interactive) {
                    setFocus(interactive);
                    activate(interactive);
                  }
                }}
              />
            </div>
            <p className="muted small">{m.keyboardHelp}</p>
            {checks.map((c) => (
              <div key={c.resolution.join("x")} className="small">
                <strong>{c.resolution.join(" × ")}</strong>: {c.offscreen.length || c.text.length || c.small.length ? "" : m.checkOk}
                {c.offscreen.length > 0 && <span className="error"> {m.offscreen(c.offscreen.join(", "))}</span>}
                {c.small.length > 0 && <span className="error"> {m.tooSmall(c.small.join(", "))}</span>}
                {c.text.map((t) => (
                  <span key={t.instanceId} className={t.outcome === "report" ? "error" : "muted"}>
                    {" "}
                    {m.textOutcome(t.instanceId, m.outcomes[t.outcome as keyof typeof m.outcomes] ?? t.outcome)}
                  </span>
                ))}
              </div>
            ))}
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" onClick={save}>
                {m.save}
              </button>
              <button type="button" className="secondary" onClick={duplicate} disabled={!loadedRevisionId}>
                {m.duplicate}
              </button>
              <button type="button" className="secondary" onClick={rebind} disabled={!updates.length}>
                {m.rebind(updates.length)}
              </button>
              {updates.map((u) => (
                <span key={u.from} className="muted small">
                  {u.label}
                </span>
              ))}
            </div>
            {message && <p className="small">{message}</p>}
          </section>
          <div className="grid2">
            <Tree payload={payload} resolution={resolution} selected={selected} onSelect={setSelected} onChange={change} catalog={catalog} deps={deps} />
            {sel ? <Inspector inst={sel} payload={payload} deps={deps} catalog={catalog} update={update} onChange={change} /> : <section className="muted small">{m.selectHint}</section>}
          </div>
          <div className="grid2">
            <FocusOrder payload={payload} selected={selected} onChange={change} />
            <TextCatalogEditor payload={payload} onChange={change} />
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Hierarquia: ordem de desenho, grupos, ocultar/bloquear, inserir e remover
// ---------------------------------------------------------------------------

function Tree({ payload, resolution, selected, onSelect, onChange, catalog, deps }: { payload: ScreenPayload; resolution: Size; selected: string | null; onSelect: (id: string | null) => void; onChange: (p: ScreenPayload) => void; catalog: UiCatalog; deps: Omit<RenderDeps, "loaded"> }) {
  const m = useMessages(uiKitMessages).composer;
  const resolved = layoutScreen(payload, resolution);
  const [kind, setKind] = useState("");
  const components = approvedRevisions(catalog.components, ["button", "panel", "slot", "meter", "menu_item"]);
  const sel = payload.instances.find((i) => i.instanceId === selected);
  const parentFor = sel ? (sel.componentRevisionId === null && !sel.text ? sel : payload.instances.find((i) => i.instanceId === sel.parentId)) : payload.instances.find((i) => i.parentId === null);
  function move(id: string, dir: -1 | 1) {
    const inst = payload.instances.find((i) => i.instanceId === id)!;
    const siblings = payload.instances.filter((i) => i.parentId === inst.parentId).sort((a, b) => a.order - b.order);
    const at = siblings.indexOf(inst);
    const other = siblings[at + dir];
    if (!other) return;
    // Trazer à frente persiste a nova ordem entre os irmãos.
    const reordered = siblings.map((s) => s.instanceId);
    reordered.splice(at, 1);
    reordered.splice(at + dir, 0, id);
    const grid = payload.instances.find((g) => g.instanceId === inst.parentId)?.layout;
    onChange({
      ...payload,
      instances: payload.instances.map((i) => {
        const k = reordered.indexOf(i.instanceId);
        if (k < 0) return i;
        return { ...i, order: k, ...(grid ? { offsets: gridCellOffsets(grid, k) } : {}) };
      }),
    });
  }
  function remove(id: string) {
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const i of payload.instances) {
        if (i.parentId && doomed.has(i.parentId) && !doomed.has(i.instanceId)) {
          doomed.add(i.instanceId);
          grew = true;
        }
      }
    }
    onChange({ ...payload, instances: payload.instances.filter((i) => !doomed.has(i.instanceId)), focusOrder: payload.focusOrder.filter((f) => !doomed.has(f)) });
    onSelect(null);
  }
  function add() {
    if (!kind || !parentFor) return;
    const siblings = payload.instances.filter((i) => i.parentId === parentFor.instanceId);
    const order = siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 0;
    const fixed = (w: number, h: number) => (parentFor.layout ? gridCellOffsets(parentFor.layout, siblings.length) : { left: 8, top: 8, right: 8 + w, bottom: 8 + h });
    const zero = { left: 0, top: 0, right: 0, bottom: 0 };
    let inst: ScreenInstance;
    if (kind === "group") {
      inst = { instanceId: newId("group"), parentId: parentFor.instanceId, componentRevisionId: null, anchors: { left: 0, top: 0, right: 1, bottom: 1 }, offsets: zero, order, hidden: false, overrides: {} };
    } else if (kind === "text") {
      const text: TextSlot = { key: "screen.text", sample: m.textSample, align: "start", verticalAlign: "top", wrap: "word", overflow: "report", fontRevisionId: null };
      inst = { instanceId: newId("text"), parentId: parentFor.instanceId, componentRevisionId: null, anchors: zero, offsets: fixed(80, 10), order, hidden: false, overrides: {}, text };
    } else {
      const [w, h] = naturalSize(kind, deps) ?? [16, 16];
      inst = { instanceId: newId("item"), parentId: parentFor.instanceId, componentRevisionId: kind, anchors: zero, offsets: fixed(w, h), order, hidden: false, overrides: {} };
    }
    onChange({ ...payload, instances: [...payload.instances, inst] });
    onSelect(inst.instanceId);
  }
  return (
    <section>
      <h3 className="small">{m.hierarchy}</h3>
      <div style={{ maxHeight: 360, overflow: "auto" }}>
        {resolved.map((r) => {
          const inst = r.instance;
          const label = inst.componentRevisionId ? (deps.revisions.get(inst.componentRevisionId)?.kind ?? deps.images.get(inst.componentRevisionId)?.assetName ?? "?") : inst.text ? m.textElement : inst.layout ? m.gridGroup : m.group;
          return (
            <div key={inst.instanceId} className="row small" style={{ paddingLeft: r.depth * 14, background: inst.instanceId === selected ? "var(--border)" : undefined, opacity: r.visible ? 1 : 0.5 }}>
              <button type="button" className="secondary" style={{ padding: "0 6px" }} onClick={() => onSelect(inst.instanceId)}>
                {inst.instanceId}
              </button>
              <span className="muted">
                {label}
                {inst.role ? ` · ${inst.role}` : ""} · {r.rect.join(",")}
                {inst.locked ? ` · ${m.locked}` : ""}
              </span>
              {inst.parentId && (
                <>
                  <button type="button" className="secondary" style={{ padding: "0 4px" }} aria-label={m.back} onClick={() => move(inst.instanceId, -1)}>
                    ↑
                  </button>
                  <button type="button" className="secondary" style={{ padding: "0 4px" }} aria-label={m.front} onClick={() => move(inst.instanceId, 1)}>
                    ↓
                  </button>
                  <button type="button" className="secondary" style={{ padding: "0 4px" }} onClick={() => onChange({ ...payload, instances: payload.instances.map((i) => (i.instanceId === inst.instanceId ? { ...i, hidden: !i.hidden } : i)) })}>
                    {inst.hidden ? m.show : m.hide}
                  </button>
                  <button type="button" className="secondary" style={{ padding: "0 4px" }} onClick={() => remove(inst.instanceId)}>
                    ✕
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="row small" style={{ marginTop: 8 }}>
        <label>
          {m.addTo(parentFor?.instanceId ?? "—")}
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">—</option>
            <option value="group">{m.group}</option>
            <option value="text">{m.textElement}</option>
            {components.map(({ asset, revision }) => (
              <option key={revision.id} value={revision.id}>
                {asset.name} r{revision.number} (ui/{asset.kind})
              </option>
            ))}
            {catalog.images.map((i) => (
              <option key={i.revisionId} value={i.revisionId}>
                {i.assetName} r{i.number} ({i.family})
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary" onClick={add} disabled={!kind || Boolean(parentFor?.locked)}>
          {m.add}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Propriedades da instância selecionada
// ---------------------------------------------------------------------------

function Inspector({ inst, payload, deps, catalog, update, onChange }: { inst: ScreenInstance; payload: ScreenPayload; deps: Omit<RenderDeps, "loaded">; catalog: UiCatalog; update: (id: string, patch: Partial<ScreenInstance>) => void; onChange: (p: ScreenPayload) => void }) {
  const m = useMessages(uiKitMessages).composer;
  const ref = inst.componentRevisionId ? deps.revisions.get(inst.componentRevisionId) : undefined;
  const parent = payload.instances.find((i) => i.instanceId === inst.parentId);
  const lockedByParent = Boolean(parent?.locked) || Boolean(parent?.layout);
  const ov = inst.overrides;
  const setOv = (patch: Partial<ScreenInstance["overrides"]>) => {
    const next = { ...ov, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined || next[k] === "") delete next[k];
    update(inst.instanceId, { overrides: next });
  };
  const meter = ref?.kind === "meter" ? (ref.revision.payload as { range: { min: number; max: number } }) : null;
  const states = ref ? ((ref.kind === "menu_item" ? deps.revisions.get(MenuItemPayload.parse(ref.revision.payload).buttonRevisionId)?.revision.payload : ref.revision.payload) as { states?: { state: UiState }[] } | undefined)?.states?.map((s) => s.state) ?? [] : [];
  function arrangeGrid(columns: number, rows: number, gap: number) {
    const cell = inst.layout?.cell ?? (() => {
      const first = payload.instances.find((i) => i.parentId === inst.instanceId && i.componentRevisionId);
      return (first && naturalSize(first.componentRevisionId!, deps)) ?? [16, 16];
    })();
    const layout = { kind: "grid" as const, columns, rows, cell: cell as [number, number], gap: [gap, gap] as [number, number] };
    const children = payload.instances.filter((i) => i.parentId === inst.instanceId).sort((a, b) => a.order - b.order);
    onChange({
      ...payload,
      instances: payload.instances.map((i) => {
        if (i.instanceId === inst.instanceId) return { ...i, layout };
        const k = children.findIndex((c) => c.instanceId === i.instanceId);
        return k < 0 ? i : { ...i, order: k, anchors: { left: 0, top: 0, right: 0, bottom: 0 }, offsets: gridCellOffsets(layout, k) };
      }),
    });
  }
  return (
    <section className="small">
      <h3 className="small">
        {inst.instanceId} <span className="muted">{ref ? `ui/${ref.kind}` : inst.componentRevisionId ? deps.images.get(inst.componentRevisionId)?.assetName : inst.text ? m.textElement : m.group}</span>
      </h3>
      <label>
        {m.role}
        <select value={inst.role ?? ""} onChange={(e) => update(inst.instanceId, { role: (e.target.value || undefined) as ScreenInstance["role"] })}>
          <option value="">—</option>
          {UiElementRole.options.map((r) => (
            <option key={r} value={r}>
              {m.roles[r]}
            </option>
          ))}
        </select>
      </label>
      {lockedByParent ? (
        <p className="muted">{parent?.layout ? m.inGrid : m.lockedHint}</p>
      ) : (
        <>
          <div className="row">
            <strong style={{ minWidth: 70 }}>{m.anchors}</strong>
            {SIDES.map((s) => (
              <label key={s}>
                {m.sides[s]}
                <input type="number" min={0} max={1} step={0.05} value={inst.anchors[s]} style={{ width: 60 }} onChange={(e) => update(inst.instanceId, { anchors: { ...inst.anchors, [s]: Math.min(1, Math.max(0, Number(e.target.value))) } })} />
              </label>
            ))}
          </div>
          <div className="row">
            <strong style={{ minWidth: 70 }}>{m.offsets}</strong>
            {SIDES.map((s) => (
              <label key={s}>
                {m.sides[s]}
                <input type="number" step={1} value={inst.offsets[s]} style={{ width: 60 }} onChange={(e) => update(inst.instanceId, { offsets: { ...inst.offsets, [s]: Math.round(Number(e.target.value)) } })} />
              </label>
            ))}
          </div>
        </>
      )}
      {!inst.componentRevisionId && !inst.text && (
        <div className="row">
          <label style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
            <input type="checkbox" checked={Boolean(inst.locked)} onChange={(e) => update(inst.instanceId, { locked: e.target.checked || undefined })} /> {m.lock}
          </label>
          <GridForm layout={inst.layout} onApply={arrangeGrid} />
        </div>
      )}
      {states.length > 0 && (
        <label>
          {m.state}
          <select value={ov.state ?? ""} onChange={(e) => setOv({ state: (e.target.value || undefined) as UiState | undefined })}>
            <option value="">{m.auto}</option>
            {STATES.filter((s) => states.includes(s)).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}
      {meter && (
        <label>
          {m.value(ov.value ?? meter.range.max)}
          <input type="range" min={meter.range.min} max={meter.range.max} value={ov.value ?? meter.range.max} onChange={(e) => setOv({ value: Number(e.target.value) })} />
        </label>
      )}
      {ref?.kind === "slot" && (
        <div className="row">
          <label>
            {m.icon}
            <select value={ov.iconRevisionId ?? ""} onChange={(e) => setOv({ iconRevisionId: e.target.value || undefined })}>
              <option value="">{m.emptySlot}</option>
              {catalog.images
                .filter((i) => i.family === "item")
                .map((i) => (
                  <option key={i.revisionId} value={i.revisionId}>
                    {i.assetName} r{i.number}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {m.quantity}
            <input type="number" min={0} max={9999} value={ov.quantity ?? ""} style={{ width: 70 }} onChange={(e) => setOv({ quantity: e.target.value === "" ? undefined : Math.max(0, Math.round(Number(e.target.value))) })} />
          </label>
        </div>
      )}
      {(ref?.kind === "button" || ref?.kind === "menu_item") && (
        <div className="row">
          <label>
            {m.captionKey}
            <input value={ov.textKey ?? ""} placeholder={m.fromComponent} onChange={(e) => setOv({ textKey: e.target.value || undefined })} />
          </label>
          <label>
            {m.captionOverride}
            <input value={ov.text ?? ""} placeholder={m.fromCatalog} onChange={(e) => setOv({ text: e.target.value || undefined })} />
          </label>
        </div>
      )}
      {inst.text && (
        <div className="row">
          <label>
            {m.textKey}
            <input value={inst.text.key} onChange={(e) => update(inst.instanceId, { text: { ...inst.text!, key: e.target.value } })} />
          </label>
          <label>
            {m.sample}
            <input value={inst.text.sample} onChange={(e) => update(inst.instanceId, { text: { ...inst.text!, sample: e.target.value || " " } })} />
          </label>
          <label>
            {m.wrap}
            <select value={inst.text.wrap} onChange={(e) => update(inst.instanceId, { text: { ...inst.text!, wrap: e.target.value as TextSlot["wrap"] } })}>
              <option value="none">{m.wraps.none}</option>
              <option value="word">{m.wraps.word}</option>
            </select>
          </label>
          <label>
            {m.overflow}
            <select value={inst.text.overflow} onChange={(e) => update(inst.instanceId, { text: { ...inst.text!, overflow: e.target.value as TextSlot["overflow"] } })}>
              {(["grow", "paginate", "ellipsis", "report"] as const).map((o) => (
                <option key={o} value={o}>
                  {m.outcomes[o]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.align}
            <select value={inst.text.align} onChange={(e) => update(inst.instanceId, { text: { ...inst.text!, align: e.target.value as TextSlot["align"] } })}>
              {(["start", "center", "end"] as const).map((a) => (
                <option key={a} value={a}>
                  {m.aligns[a]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </section>
  );
}

function GridForm({ layout, onApply }: { layout: ScreenInstance["layout"]; onApply: (columns: number, rows: number, gap: number) => void }) {
  const m = useMessages(uiKitMessages).composer;
  const [columns, setColumns] = useState(layout?.columns ?? 4);
  const [rows, setRows] = useState(layout?.rows ?? 1);
  const [gap, setGap] = useState(layout?.gap[0] ?? 2);
  return (
    <div className="row">
      <label>
        {m.columns}
        <input type="number" min={1} max={32} value={columns} style={{ width: 52 }} onChange={(e) => setColumns(Math.max(1, Math.round(Number(e.target.value))))} />
      </label>
      <label>
        {m.rows}
        <input type="number" min={1} max={32} value={rows} style={{ width: 52 }} onChange={(e) => setRows(Math.max(1, Math.round(Number(e.target.value))))} />
      </label>
      <label>
        {m.gap}
        <input type="number" min={0} max={32} value={gap} style={{ width: 52 }} onChange={(e) => setGap(Math.max(0, Math.round(Number(e.target.value))))} />
      </label>
      <button type="button" className="secondary" onClick={() => onApply(columns, rows, gap)}>
        {m.arrangeGrid}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ordem de foco e catálogo de textos
// ---------------------------------------------------------------------------

function FocusOrder({ payload, selected, onChange }: { payload: ScreenPayload; selected: string | null; onChange: (p: ScreenPayload) => void }) {
  const m = useMessages(uiKitMessages).composer;
  const order = payload.focusOrder;
  const swap = (i: number, j: number) => {
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange({ ...payload, focusOrder: next });
  };
  return (
    <section className="small">
      <h3 className="small">{m.focusOrder}</h3>
      <p className="muted">{m.focusHelp}</p>
      <ol>
        {order.map((id, i) => (
          <li key={id}>
            {id}{" "}
            <button type="button" className="secondary" style={{ padding: "0 4px" }} onClick={() => swap(i, i - 1)}>
              ↑
            </button>
            <button type="button" className="secondary" style={{ padding: "0 4px" }} onClick={() => swap(i, i + 1)}>
              ↓
            </button>
            <button type="button" className="secondary" style={{ padding: "0 4px" }} onClick={() => onChange({ ...payload, focusOrder: order.filter((x) => x !== id) })}>
              ✕
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="secondary" disabled={!selected || order.includes(selected)} onClick={() => selected && onChange({ ...payload, focusOrder: [...order, selected] })}>
        {m.addFocus}
      </button>
    </section>
  );
}

function TextCatalogEditor({ payload, onChange }: { payload: ScreenPayload; onChange: (p: ScreenPayload) => void }) {
  const m = useMessages(uiKitMessages).composer;
  const catalog = payload.textCatalog ?? { languages: ["pt-BR", "en"], entries: [] };
  const [lang, setLang] = useState("");
  const [key, setKey] = useState("");
  const set = (next: typeof catalog) => onChange({ ...payload, textCatalog: next });
  return (
    <section className="small">
      <h3 className="small">{m.textCatalog}</h3>
      <p className="muted">{m.textCatalogHelp}</p>
      <table>
        <thead>
          <tr>
            <th>{m.textKey}</th>
            {catalog.languages.map((l) => (
              <th key={l}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {catalog.entries.map((e, i) => (
            <tr key={e.key}>
              <td>{e.key}</td>
              {catalog.languages.map((l) => (
                <td key={l}>
                  <input
                    value={e.text[l] ?? ""}
                    onChange={(ev) => {
                      const text = { ...e.text, [l]: ev.target.value };
                      if (!ev.target.value) delete text[l];
                      set({ ...catalog, entries: catalog.entries.map((x, k) => (k === i ? { ...x, text } : x)) });
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <input value={key} placeholder="menu.continue" onChange={(e) => setKey(e.target.value)} />
        <button type="button" className="secondary" disabled={!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(key) || catalog.entries.some((e) => e.key === key)} onClick={() => {
            set({ ...catalog, entries: [...catalog.entries, { key, text: {} }] });
            setKey("");
          }}>
          {m.addKey}
        </button>
        <input value={lang} placeholder="es" style={{ width: 70 }} onChange={(e) => setLang(e.target.value)} />
        <button type="button" className="secondary" disabled={!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(lang) || catalog.languages.includes(lang)} onClick={() => {
            set({ ...catalog, languages: [...catalog.languages, lang] });
            setLang("");
          }}>
          {m.addLanguage}
        </button>
      </div>
    </section>
  );
}
