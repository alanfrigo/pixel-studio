import {
  AudioFile,
  fileModality,
  Manifest,
  MANIFEST_FILE_NAME,
  type ManifestEntry,
  type ManifestFile,
  type Rect,
} from "@/contracts";
import { entryRefs, type Path } from "./refs";

/**
 * Validação semântica do manifesto portátil (02a §ao ler o ZIP): versão,
 * unicidade, caminhos, resolução de dependências, limites de retângulos,
 * coerência entre entradas e ausência de ciclos de composição.
 *
 * Não lê bytes: integridade de hashes/tamanhos fica em `verify-files.ts`.
 */

export type ManifestIssueCode =
  | "schema_invalid"
  | "unsupported_version"
  | "duplicate_file_id"
  | "duplicate_path"
  | "reserved_path"
  | "duplicate_revision_id"
  | "duplicate_dependency"
  | "dependency_missing"
  | "undeclared_dependency"
  | "dependency_kind_mismatch"
  | "dependency_cycle"
  | "missing_file"
  | "file_modality_mismatch"
  | "rect_out_of_bounds"
  | "cell_mismatch"
  | "unknown_socket"
  | "unknown_part"
  | "unknown_frame"
  | "rig_mismatch"
  | "slot_conflict"
  | "stance_incompatible"
  | "unknown_viseme"
  | "audio_loop_out_of_range"
  | "attribution_subject_unknown";

export interface ManifestIssue {
  code: ManifestIssueCode;
  message: string;
  path: Path;
  revisionId?: string;
  fileId?: string;
}

export interface ManifestValidation {
  ok: boolean;
  manifest: Manifest | null;
  issues: ManifestIssue[];
}

export function validateManifest(input: unknown): ManifestValidation {
  if (typeof input === "object" && input !== null && "schemaVersion" in input && input.schemaVersion !== 1) {
    return {
      ok: false,
      manifest: null,
      issues: [
        {
          code: "unsupported_version",
          message: `Versão de manifesto não suportada: ${String(input.schemaVersion)} (este leitor entende a versão 1)`,
          path: ["schemaVersion"],
        },
      ],
    };
  }

  const parsed = Manifest.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      manifest: null,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema_invalid",
        message: issue.message,
        path: issue.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
      })),
    };
  }

  const manifest = parsed.data;
  const issues: ManifestIssue[] = [];
  const files = indexFiles(manifest, issues);
  const entries = indexEntries(manifest, issues);

  manifest.entries.forEach((entry, ei) => {
    checkEntryReferences(entry, ei, entries, files, issues);
  });
  manifest.entries.forEach((entry, ei) => {
    checkCrossEntry(entry, ei, entries, files, issues);
  });
  checkCycles(manifest, entries, issues);

  manifest.attributions?.forEach((a, i) => {
    if (!files.has(a.subject) && !entries.has(a.subject)) {
      issues.push({
        code: "attribution_subject_unknown",
        message: `Atribuição cita item inexistente: ${a.subject}`,
        path: ["attributions", i, "subject"],
      });
    }
  });

  return { ok: issues.length === 0, manifest, issues };
}

function indexFiles(manifest: Manifest, issues: ManifestIssue[]): Map<string, ManifestFile> {
  const byId = new Map<string, ManifestFile>();
  const paths = new Map<string, number>();
  manifest.files.forEach((file, i) => {
    if (byId.has(file.fileId)) {
      issues.push({ code: "duplicate_file_id", message: `fileId duplicado: ${file.fileId}`, path: ["files", i, "fileId"], fileId: file.fileId });
    } else {
      byId.set(file.fileId, file);
    }
    // Comparação sem diferenciar maiúsculas: o pacote precisa abrir em qualquer sistema de arquivos.
    const key = file.path.toLowerCase();
    if (paths.has(key)) {
      issues.push({ code: "duplicate_path", message: `Caminho duplicado: ${file.path}`, path: ["files", i, "path"], fileId: file.fileId });
    } else {
      paths.set(key, i);
    }
    if (key === MANIFEST_FILE_NAME) {
      issues.push({ code: "reserved_path", message: `${MANIFEST_FILE_NAME} é reservado`, path: ["files", i, "path"], fileId: file.fileId });
    }
  });
  return byId;
}

function indexEntries(manifest: Manifest, issues: ManifestIssue[]): Map<string, ManifestEntry> {
  const byId = new Map<string, ManifestEntry>();
  manifest.entries.forEach((entry, i) => {
    if (byId.has(entry.revisionId)) {
      issues.push({
        code: "duplicate_revision_id",
        message: `revisionId duplicado: ${entry.revisionId}`,
        path: ["entries", i, "revisionId"],
        revisionId: entry.revisionId,
      });
    } else {
      byId.set(entry.revisionId, entry);
    }
  });
  return byId;
}

function rectInside(rect: Rect, width: number, height: number): boolean {
  const [x, y, w, h] = rect;
  return x + w <= width && y + h <= height;
}

function checkEntryReferences(
  entry: ManifestEntry,
  ei: number,
  entries: Map<string, ManifestEntry>,
  files: Map<string, ManifestFile>,
  issues: ManifestIssue[],
) {
  const base: Path = ["entries", ei];
  const declared = new Set<string>();
  entry.dependencies.forEach((dep, di) => {
    const path: Path = [...base, "dependencies", di];
    if (declared.has(dep.revisionId)) {
      issues.push({ code: "duplicate_dependency", message: `Dependência repetida: ${dep.revisionId}`, path, revisionId: entry.revisionId });
    }
    declared.add(dep.revisionId);
    if (!entries.has(dep.revisionId)) {
      issues.push({
        code: "dependency_missing",
        message: `${entry.revisionId} depende de ${dep.revisionId} (${dep.role}), ausente do pacote`,
        path,
        revisionId: entry.revisionId,
      });
    }
  });

  const refs = entryRefs(entry);
  for (const ref of refs.revisions) {
    const path = [...base, ...ref.path];
    const target = entries.get(ref.revisionId);
    if (ref.runtime && !declared.has(ref.revisionId)) {
      issues.push({
        code: "undeclared_dependency",
        message: `${entry.revisionId} usa ${ref.revisionId} sem declará-lo em dependencies`,
        path,
        revisionId: entry.revisionId,
      });
    }
    if (target && !ref.expect.some((e) => e.family === target.family && (!e.kinds || e.kinds.includes(target.kind)))) {
      const expected = ref.expect.map((e) => (e.kinds ? `${e.family}/${e.kinds.join("|")}` : e.family)).join(" ou ");
      issues.push({
        code: "dependency_kind_mismatch",
        message: `${ref.revisionId} é ${target.family}/${target.kind}; esperado ${expected}`,
        path,
        revisionId: entry.revisionId,
      });
    }
  }

  for (const ref of refs.files) {
    const path = [...base, ...ref.path];
    const file = files.get(ref.fileId);
    if (!file) {
      issues.push({ code: "missing_file", message: `Arquivo inexistente: ${ref.fileId}`, path, revisionId: entry.revisionId, fileId: ref.fileId });
      continue;
    }
    const modality = fileModality(file);
    if (modality !== ref.modality) {
      issues.push({
        code: "file_modality_mismatch",
        message: `${ref.fileId} é ${modality}; esperado ${ref.modality}`,
        path,
        revisionId: entry.revisionId,
        fileId: ref.fileId,
      });
      continue;
    }
    if (ref.rect && "width" in file && !rectInside(ref.rect, file.width, file.height)) {
      issues.push({
        code: "rect_out_of_bounds",
        message: `Retângulo [${ref.rect.join(", ")}] excede ${file.width}×${file.height} de ${ref.fileId}`,
        path,
        revisionId: entry.revisionId,
        fileId: ref.fileId,
      });
    }
  }
}

/** Regras que dependem de outra entrada (rig ↔ clipe ↔ peça ↔ conjunto, fala ↔ expressão, áudio ↔ arquivo). */
function checkCrossEntry(
  entry: ManifestEntry,
  ei: number,
  entries: Map<string, ManifestEntry>,
  files: Map<string, ManifestFile>,
  issues: ManifestIssue[],
) {
  const base: Path = ["entries", ei, "payload"];
  const push = (code: ManifestIssueCode, message: string, path: Path) =>
    issues.push({ code, message, path: [...base, ...path], revisionId: entry.revisionId });

  const getRig = (id: string | null) => {
    const e = id ? entries.get(id) : undefined;
    return e?.family === "character" && e.kind === "rig" ? e.payload : undefined;
  };
  const getClip = (id: string) => {
    const e = entries.get(id);
    return e?.family === "character" && e.kind === "clip" ? e.payload : undefined;
  };

  if (entry.family === "character" && entry.kind === "clip") {
    const clip = entry.payload;
    const rig = getRig(clip.rigRevisionId);
    if (rig) {
      const expected = [rig.logicalCell[0] + clip.margins.left + clip.margins.right, rig.logicalCell[1] + clip.margins.top + clip.margins.bottom];
      if (clip.logicalSize[0] !== expected[0] || clip.logicalSize[1] !== expected[1]) {
        push("cell_mismatch", `Célula do clipe deve ser ${expected.join("×")} (célula do rig + margens)`, ["logicalSize"]);
      }
      const sockets = new Set(rig.sockets.map((s) => s.socketId));
      const parts = new Set(rig.parts.map((p) => p.partId));
      clip.frames.forEach((frame, fi) => {
        frame.sockets.forEach((s, si) => {
          if (!sockets.has(s.socketId)) push("unknown_socket", `Socket ${s.socketId} não existe no rig`, ["frames", fi, "sockets", si]);
        });
        frame.layers.forEach((l, li) => {
          if (!parts.has(l.partId)) push("unknown_part", `Parte ${l.partId} não existe no rig`, ["frames", fi, "layers", li]);
        });
      });
      if (clip.stance && !rig.stances.includes(clip.stance)) {
        push("stance_incompatible", `Postura ${clip.stance} não existe no rig`, ["stance"]);
      }
      clip.events.forEach((ev, i) => {
        if (ev.vfx?.socketId && !sockets.has(ev.vfx.socketId)) {
          push("unknown_socket", `Evento usa socket inexistente: ${ev.vfx.socketId}`, ["events", i, "vfx", "socketId"]);
        }
      });
    }
  }

  if (entry.family === "equipment" && entry.kind === "overlay") {
    const overlay = entry.payload;
    const rig = getRig(overlay.rigRevisionId);
    if (rig) {
      const slots = new Set(rig.slots.map((s) => s.slotId));
      overlay.slots.forEach((slot, i) => {
        if (!slots.has(slot)) push("slot_conflict", `Slot ${slot} não existe no rig`, ["slots", i]);
      });
      overlay.stances.forEach((stance, i) => {
        if (!rig.stances.includes(stance)) push("stance_incompatible", `Postura ${stance} não existe no rig`, ["stances", i]);
      });
      const parts = new Set(rig.parts.map((p) => p.partId));
      overlay.parts.forEach((part, pi) => {
        if (!parts.has(part.partId)) push("unknown_part", `Parte ${part.partId} não existe no rig`, ["parts", pi, "partId"]);
      });
    }
    overlay.parts.forEach((part, pi) =>
      part.coverage.forEach((c, ci) => {
        const clip = getClip(c.clipRevisionId);
        if (!clip) return;
        if (clip.rigRevisionId !== overlay.rigRevisionId) {
          push("rig_mismatch", `Clipe ${c.clipRevisionId} usa outro rig`, ["parts", pi, "coverage", ci, "clipRevisionId"]);
        }
        if (!clip.frames.some((f) => f.frameId === c.frameId)) {
          push("unknown_frame", `Frame ${c.frameId} não existe em ${c.clipRevisionId}`, ["parts", pi, "coverage", ci, "frameId"]);
        }
      }),
    );
  }

  if (entry.family === "equipment" && entry.kind === "loadout") {
    const loadout = entry.payload;
    const occupied = new Map<string, string>();
    loadout.overlayRevisionIds.forEach((id, i) => {
      const e = entries.get(id);
      if (e?.family !== "equipment" || e.kind !== "overlay") return;
      if (e.payload.rigRevisionId !== loadout.rigRevisionId) {
        push("rig_mismatch", `Peça ${id} foi feita para outro rig`, ["overlayRevisionIds", i]);
      }
      if (!e.payload.stances.includes(loadout.stance)) {
        push("stance_incompatible", `Peça ${id} não cobre a postura ${loadout.stance}`, ["overlayRevisionIds", i]);
      }
      for (const slot of e.payload.slots) {
        const other = occupied.get(slot);
        if (other) push("slot_conflict", `Slot ${slot} ocupado por ${other} e ${id}`, ["overlayRevisionIds", i]);
        else occupied.set(slot, id);
      }
    });
    loadout.clips.forEach((c, i) => {
      const clip = getClip(c.clipRevisionId);
      if (!clip) return;
      if (clip.rigRevisionId !== loadout.rigRevisionId) push("rig_mismatch", `Clipe ${c.clipRevisionId} usa outro rig`, ["clips", i]);
      if (clip.stance && clip.stance !== loadout.stance) {
        push("stance_incompatible", `Clipe ${c.clipRevisionId} é da postura ${clip.stance}`, ["clips", i]);
      }
      if (clip.action !== c.action || clip.direction !== c.direction) {
        push("cell_mismatch", `Clipe ${c.clipRevisionId} é ${clip.action}/${clip.direction}, não ${c.action}/${c.direction}`, ["clips", i]);
      }
    });
  }

  if (entry.family === "portrait" && entry.kind === "speech") {
    const expr = entries.get(entry.payload.expressionRevisionId);
    if (expr?.family === "portrait" && expr.kind === "expression") {
      const visemes = new Set(expr.payload.visemes.map((v) => v.visemeId));
      entry.payload.timeline.forEach((step, i) => {
        if (!visemes.has(step.visemeId)) push("unknown_viseme", `Viseme ${step.visemeId} não existe na expressão`, ["timeline", i, "visemeId"]);
      });
    }
  }

  if (entry.family === "audio" && entry.payload.loop) {
    const file = files.get(entry.payload.fileId);
    const audio = file ? AudioFile.safeParse(file) : undefined;
    if (audio?.success && entry.payload.loop.endFrame > audio.data.frameCount) {
      push("audio_loop_out_of_range", `Fim do loop (${entry.payload.loop.endFrame}) além do arquivo (${audio.data.frameCount} frames)`, ["loop"]);
    }
  }
}

/** Composição não pode ter ciclos (conexões de mundo ficam dentro do payload, não em dependências). */
function checkCycles(manifest: Manifest, entries: Map<string, ManifestEntry>, issues: ManifestIssue[]) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (id: string) => {
    color.set(id, GRAY);
    stack.push(id);
    const entry = entries.get(id);
    for (const dep of entry?.dependencies ?? []) {
      if (!entries.has(dep.revisionId)) continue;
      const c = color.get(dep.revisionId) ?? WHITE;
      if (c === GRAY) {
        const cycle = [...stack.slice(stack.indexOf(dep.revisionId)), dep.revisionId];
        const key = [...cycle].sort().join(">");
        if (!reported.has(key)) {
          reported.add(key);
          const index = manifest.entries.findIndex((e) => e.revisionId === id);
          issues.push({
            code: "dependency_cycle",
            message: `Ciclo de dependências: ${cycle.join(" → ")}`,
            path: ["entries", index, "dependencies"],
            revisionId: id,
          });
        }
      } else if (c === WHITE) {
        visit(dep.revisionId);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const id of entries.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id);
  }
}
