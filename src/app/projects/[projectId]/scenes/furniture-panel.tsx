"use client";

import { useState } from "react";
import type { MapObjectPayload, RoomPayload } from "@/contracts";
import type { RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { useLocale, useMessages } from "@/i18n/client";
import { scenesMessages } from "@/i18n/messages/scenes";
import { errorText, fileOf, flatRevisions, mediaUrl, PIXEL, type Profile, type ScenesCatalog, scenesApi, uploadImage } from "./scenes-client";
import { MaskPainter, Message, PlanRunner, PointPicker, RevisionCard } from "./shared";

/**
 * Móveis e áreas antes ocultas (06 §móveis e kit; demonstração da mesa):
 * recorte local revisado com máscara explícita; a área de onde a peça saiu é
 * medida e, se havia piso atrás, reconstruída por inpainting (E1) — apagar o
 * alfa não basta. Depois: mover a mesa, reutilizá-la em outra sala, com
 * sombra e apoio.
 */

interface CutoutResult {
  object: RevisionView;
  areaMaskUploadId: string;
  needsReconstruction: boolean;
  report: { contextOpaque: number; areaPixels: number; pieceRect: number[] };
  inpaint: { sourceRevisionId: string; sourceFileKey: string; maskUploadId: string };
}

export function FurniturePanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: ScenesCatalog; profiles: Profile[]; refresh: () => void }) {
  const m = useMessages(scenesMessages).furniture;
  const rooms = flatRevisions(catalog.rooms, (r) => r.status === "approved");
  const [roomId, setRoomId] = useState("");
  const entry = rooms.find((r) => r.revision.id === roomId);
  const room = entry?.revision.payload as RoomPayload | undefined;
  const furnishedRooms = flatRevisions(catalog.rooms, (r) => (r.payload as RoomPayload).exposedAreas.length > 0);
  return (
    <>
      <section>
        <h2>{m.chooseRoom}</h2>
        <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          <option value="">—</option>
          {rooms.map(({ asset, revision }) => (
            <option key={revision.id} value={revision.id}>
              {asset.name} r{revision.number} ({(revision.payload as RoomPayload).projection}, {(revision.payload as RoomPayload).route})
            </option>
          ))}
        </select>
        {room?.projection === "oblique" && <p className="small">{m.obliqueRoom}</p>}
      </section>
      {entry && room && room.projection !== "oblique" && (
        <LocalCutout key={`l-${roomId}`} projectId={projectId} revision={entry.revision} room={room} assetId={entry.asset.id} catalog={catalog} profiles={profiles} refresh={refresh} />
      )}
      <section>
        <h2>{m.hiddenTitle}</h2>
        <div className="row" style={{ alignItems: "flex-start" }}>
          {furnishedRooms.length === 0 && <p className="muted small">{m.emptyHidden}</p>}
          {furnishedRooms.map(({ asset, revision }) => {
            const p = revision.payload as RoomPayload;
            const bg = fileOf(revision, p.background!.fileId);
            return (
              <RevisionCard key={revision.id} projectId={projectId} asset={asset} revision={revision} src={bg ? mediaUrl(projectId, bg.id) : null} refresh={refresh}>
                {p.exposedAreas.map((a) => {
                  const maskFile = fileOf(revision, a.mask.fileId);
                  return (
                    <div key={a.areaId} className="row">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {maskFile && <img src={mediaUrl(projectId, maskFile.id)} alt={a.areaId} className="pixel" style={{ ...PIXEL, width: 64 }} />}
                      <span>
                        {a.pieceName}: {a.status === "reconstructed_inpaint" ? m.areaReconstructed : m.areaTransparent} · {m.outlinePainted(Math.round(a.measured.contextOpaque * 100))}
                      </span>
                    </div>
                  );
                })}
              </RevisionCard>
            );
          })}
        </div>
      </section>
      <MoveReuse projectId={projectId} catalog={catalog} refresh={refresh} />
    </>
  );
}

function LocalCutout({ projectId, revision, room, assetId, catalog, profiles, refresh }: { projectId: string; revision: RevisionView; room: RoomPayload; assetId: string; catalog: ScenesCatalog; profiles: Profile[]; refresh: () => void }) {
  const { furniture: m, shared: sm } = useMessages(scenesMessages);
  const locale = useLocale();
  const base = room.background ?? room.picture;
  const file = fileOf(revision, base.fileId);
  const size: [number, number] = [room.picture.rect[2], room.picture.rect[3]];
  const [mask, setMask] = useState<Blob | null>(null);
  const [shadow, setShadow] = useState<Blob | null>(null);
  const [uploads, setUploads] = useState<{ mask: string; shadow: string | null } | null>(null);
  const [preview, setPreview] = useState<{ report: { pieceRect: number[]; suggestedSupport: [number, number]; needsReconstruction: boolean; contextOpaque: number }; previews: { piece: string; shadow: string | null; area: string } } | null>(null);
  const [name, setName] = useState(m.defaultName);
  const [collision, setCollision] = useState("");
  const [result, setResult] = useState<CutoutResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inpaintProfiles = profiles.filter((p) => (p.capabilities.inpaint?.length ?? 0) > 0 && !p.unavailable);
  const inpaints = (catalog.rooms.find((r) => r.asset.id === assetId)?.revisions ?? []).filter((r) => r.predecessorId === revision.id && (r.technicalReport as { operation?: string } | null)?.operation === "inpaint");
  async function doPreview() {
    if (!mask) return;
    try {
      const up = { mask: await uploadImage(projectId, mask, "mascara-movel.png", locale), shadow: shadow ? await uploadImage(projectId, shadow, "mascara-sombra.png", locale) : null };
      setUploads(up);
      setPreview(await apiFetch(scenesApi(projectId, "/rooms/cutout/preview"), { method: "POST", json: { roomRevisionId: revision.id, maskUploadId: up.mask, shadowMaskUploadId: up.shadow } }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function publish() {
    if (!uploads || !preview) return;
    try {
      const rect = collision.split(/[ ,]+/).map(Number).filter((n) => Number.isFinite(n));
      const r = await apiFetch<CutoutResult>(scenesApi(projectId, "/rooms/cutout"), {
        method: "POST",
        json: { roomRevisionId: revision.id, maskUploadId: uploads.mask, shadowMaskUploadId: uploads.shadow, name, collision: rect.length === 4 ? [rect] : [] },
      });
      setResult(r);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function compose(reconstruction: { kind: "inpaint"; inpaintRevisionId: string } | { kind: "transparent" }) {
    if (!result) return;
    try {
      await apiFetch(scenesApi(projectId, "/rooms/compose"), { method: "POST", json: { roomRevisionId: revision.id, areaMaskUploadId: result.areaMaskUploadId, reconstruction } });
      setMessage(m.composed);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  if (!file) return null;
  return (
    <section>
      <h2>{m.cutoutTitle}</h2>
      <p className="small muted">{m.cutoutHint}</p>
      <div className="grid2">
        <div>
          <strong className="small">{m.piece}</strong>
          <MaskPainter src={mediaUrl(projectId, file.id)} size={size} onChange={(b) => setMask(b)} />
        </div>
        <div>
          <strong className="small">{m.shadowOptional}</strong>
          <MaskPainter src={mediaUrl(projectId, file.id)} size={size} color={[0, 120, 255, 120]} onChange={(b) => setShadow(b)} />
        </div>
      </div>
      <button type="button" onClick={doPreview} disabled={!mask}>
        {m.measure}
      </button>
      {preview && (
        <div className="small">
          <div className="row">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview.previews.piece} alt={m.piece} className="pixel bg-checker" style={{ ...PIXEL, height: 64 }} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {preview.previews.shadow && <img src={preview.previews.shadow} alt={m.shadow} className="pixel bg-checker" style={{ ...PIXEL, height: 32 }} />}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview.previews.area} alt={sm.previouslyHidden} className="pixel" style={{ ...PIXEL, height: 128 }} />
          </div>
          <div>
            {m.cutoutInfo(preview.report.pieceRect.join(", "), preview.report.suggestedSupport.join(", "), Math.round(preview.report.contextOpaque * 100))}{" "}
            <strong>{preview.report.needsReconstruction ? m.needsInpaint : m.overRock}</strong>
          </div>
          <div className="row">
            <label>
              {sm.name}
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              {m.collision}
              <input value={collision} onChange={(e) => setCollision(e.target.value)} placeholder="0,12,26,6" />
            </label>
            <button type="button" onClick={publish}>
              {m.publishPiece}
            </button>
          </div>
        </div>
      )}
      {result && (
        <div className="small">
          <p>
            {m.propPublished(result.report.areaPixels, result.needsReconstruction)}
          </p>
          {result.needsReconstruction ? (
            <>
              <PlanRunner
                projectId={projectId}
                label={m.rebuildArea}
                disabled={!inpaintProfiles.length}
                body={() => ({ operation: "inpaint", providerProfileId: inpaintProfiles[0]?.id, sourceRevisionId: result.inpaint.sourceRevisionId, sourceFileKey: result.inpaint.sourceFileKey, maskUploadId: result.inpaint.maskUploadId, instruction: `piso e parede contínuos onde estava ${name}, sem o móvel`, mode: inpaintProfiles[0]?.capabilities.inpaint?.includes("native_mask") ? "native-mask" : "candidate-composite" })}
                target={async () => assetId}
                onDone={refresh}
              />
              <a href={`/projects/${projectId}/inpaint?asset=${assetId}&revision=${revision.id}&file=${base.fileId}`}>{m.openInpaint}</a>
            </>
          ) : (
            <button type="button" onClick={() => compose({ kind: "transparent" })}>
              {m.composeOverRock}
            </button>
          )}
        </div>
      )}
      {inpaints.length > 0 && (
        <div className="row" style={{ alignItems: "flex-start" }}>
          {inpaints.map((r) => {
            const f = fileOf(r, base.fileId);
            return (
              <RevisionCard key={r.id} projectId={projectId} asset={catalog.rooms.find((x) => x.asset.id === assetId)!.asset} revision={r} src={f ? mediaUrl(projectId, f.id) : null} refresh={refresh}>
                {result && r.status === "approved" && (
                  <button type="button" onClick={() => compose({ kind: "inpaint", inpaintRevisionId: r.id })}>
                    {m.composeWithRebuild}
                  </button>
                )}
              </RevisionCard>
            );
          })}
        </div>
      )}
      <Message text={message} />
    </section>
  );
}

function MoveReuse({ projectId, catalog, refresh }: { projectId: string; catalog: ScenesCatalog; refresh: () => void }) {
  const { furniture: m, shared: sm } = useMessages(scenesMessages);
  const rooms = flatRevisions(catalog.rooms, (r) => r.status === "approved" && (r.payload as RoomPayload).projection !== "oblique");
  const props = flatRevisions(catalog.objects, (r) => r.status === "approved");
  const [roomId, setRoomId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [furniture, setFurniture] = useState<RoomPayload["furniture"] | null>(null);
  const [composite, setComposite] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const entry = rooms.find((r) => r.revision.id === roomId);
  const room = entry?.revision.payload as RoomPayload | undefined;
  const list = furniture ?? room?.furniture ?? [];
  const pic = entry && room ? fileOf(entry.revision, (room.background ?? room.picture).fileId) : null;
  function pick(at: [number, number]) {
    if (adding) {
      const obj = props.find((p) => p.revision.id === adding);
      setFurniture([...list, { placementId: `movel-${list.length + 1}`, objectRevisionId: adding, supportAtPx: at, label: obj?.asset.name.split("·").pop()?.trim().slice(0, 64) || m.placementFallback }]);
      setAdding("");
    } else if (selected) {
      setFurniture(list.map((f) => (f.placementId === selected ? { ...f, supportAtPx: at } : f)));
    }
  }
  async function save() {
    try {
      const r = await apiFetch<{ revision: RevisionView }>(scenesApi(projectId, "/rooms/edit"), { method: "POST", json: { baseRevisionId: roomId, furniture: list, note: m.moveNote } });
      const pv = await apiFetch<{ previews: { zoom: string } }>(scenesApi(projectId, `/rooms/${r.revision.id}/preview`));
      setComposite(pv.previews.zoom);
      setFurniture(null);
      setMessage(m.moved);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <section>
      <h2>{m.moveTitle}</h2>
      <div className="row">
        <select value={roomId} onChange={(e) => (setRoomId(e.target.value), setFurniture(null), setComposite(null))}>
          <option value="">{sm.approvedRoomOption}</option>
          {rooms.map(({ asset, revision }) => (
            <option key={revision.id} value={revision.id}>
              {asset.name} r{revision.number}
            </option>
          ))}
        </select>
        <select value={adding} onChange={(e) => (setAdding(e.target.value), setSelected(null))}>
          <option value="">{m.reuseProp}</option>
          {props.map(({ asset, revision }) => (
            <option key={revision.id} value={revision.id}>
              {asset.name} r{revision.number} {(revision.payload as MapObjectPayload).shadow ? m.withShadow : ""}
            </option>
          ))}
        </select>
      </div>
      {room && pic && (
        <>
          <p className="small muted">{m.moveHint}</p>
          <div className="row small">
            {list.map((f) => (
              <button key={f.placementId} type="button" className={selected === f.placementId ? "" : "secondary"} onClick={() => (setSelected(f.placementId), setAdding(""))}>
                {f.label ?? f.placementId} @ {f.supportAtPx.join(",")}
              </button>
            ))}
            {list.length > 0 && selected && (
              <button type="button" className="secondary" onClick={() => setFurniture(list.filter((f) => f.placementId !== selected))}>
                {m.takeOut}
              </button>
            )}
          </div>
          <PointPicker src={mediaUrl(projectId, pic.id)} size={[room.picture.rect[2], room.picture.rect[3]]} points={list.map((f) => ({ at: f.supportAtPx, label: f.label }))} onPick={pick} />
          <button type="button" onClick={save} disabled={!furniture}>
            {m.publishRoom}
          </button>
        </>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {composite && <img src={composite} alt={m.assembledAlt} className="pixel bg-checker" style={{ ...PIXEL, maxWidth: "100%", display: "block" }} />}
      <Message text={message} />
    </section>
  );
}
