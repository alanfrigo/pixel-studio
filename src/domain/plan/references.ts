import { type LocalizedText, tx } from "@/i18n/locales";
import type { AssetFamily, GenerationPlan } from "@/contracts";

/**
 * Validação de referências de um plano contra o catálogo (02a): toda revisão
 * citada existe, pertence ao mesmo projeto, fontes estão aprovadas ou são
 * uploads raster normalizados e os hashes congelados conferem. A máscara é um
 * upload do projeto com a mesma grade da fonte.
 */

export interface CatalogFile {
  sha256: string;
  mime: string;
  width?: number;
  height?: number;
}

export interface CatalogRevision {
  revisionId: string;
  projectId: string;
  family: AssetFamily | "style" | "preset";
  kind: string;
  status: "candidate" | "approved" | "rejected" | "archived";
  files: Record<string, CatalogFile>;
  /** Digest canônico do payload tipado (revisões sem arquivo). */
  payloadDigest?: string;
}

export interface CatalogUpload extends Omit<CatalogFile, "mime"> {
  fileId: string;
  projectId: string;
  status: "pending" | "ready" | "rejected";
  normalizedRasterSha256: string | null;
}

export interface PlanLookup {
  revision(revisionId: string): CatalogRevision | undefined;
  upload(fileId: string): CatalogUpload | undefined;
}

export type PlanIssueCode =
  | "not_found"
  | "cross_project_reference"
  | "source_not_approved"
  | "source_file_mismatch"
  | "wrong_reference_kind"
  | "upload_not_ready"
  | "mask_size_mismatch";

export interface PlanIssue {
  code: PlanIssueCode;
  message: LocalizedText;
  path: (string | number)[];
  revisionId?: string;
  uploadId?: string;
}

interface ParamRef {
  revisionId: string;
  path: (string | number)[];
  family?: CatalogRevision["family"];
}

/** Revisões citadas nos parâmetros (além de estilo e fontes). */
export function planParamRefs(plan: GenerationPlan): ParamRef[] {
  const refs: ParamRef[] = [];
  const add = (revisionId: string | null | undefined, path: (string | number)[], family?: ParamRef["family"]) => {
    if (revisionId) refs.push({ revisionId, path: ["params", ...path], ...(family ? { family } : {}) });
  };
  switch (plan.operation) {
    case "animate_preset":
      add(plan.params.presetRevisionId, ["presetRevisionId"], "preset");
      add(plan.params.baseRevisionId, ["baseRevisionId"], "character");
      break;
    case "animate_text":
      add(plan.params.baseRevisionId, ["baseRevisionId"], "character");
      add(plan.params.startFrame?.clipRevisionId, ["startFrame", "clipRevisionId"], "character");
      add(plan.params.endFrame?.clipRevisionId, ["endFrame", "clipRevisionId"], "character");
      break;
    case "animate_skeleton":
      add(plan.params.baseRevisionId, ["baseRevisionId"], "character");
      add(plan.params.motionRevisionId, ["motionRevisionId"], "character");
      break;
    case "rotate_views":
      add(plan.params.identityRevisionId, ["identityRevisionId"]);
      break;
    case "inpaint":
      add(plan.params.sourceRevisionId, ["sourceRevisionId"]);
      break;
    case "create_state":
      add(plan.params.baseRevisionId, ["baseRevisionId"]);
      add(plan.params.predecessorStateRevisionId, ["predecessorStateRevisionId"]);
      break;
    case "generate_room":
      add(plan.params.styleRoomRevisionId, ["styleRoomRevisionId"]);
      break;
    case "generate_ui_states":
      plan.params.componentRevisionIds.forEach((id, i) => add(id, ["componentRevisionIds", i], "ui"));
      break;
    case "generate_portrait":
      add(plan.params.characterRevisionId, ["characterRevisionId"], "character");
      break;
    case "generate_visemes":
      add(plan.params.portraitRevisionId, ["portraitRevisionId"], "portrait");
      break;
    default:
      break;
  }
  return refs;
}

export function resolveGenerationUpload(lookup: PlanLookup, projectId: string, uploadId: string, path: (string | number)[]): { sha256: string } | { issue: PlanIssue } {
  const upload = lookup.upload(uploadId);
  if (!upload || upload.projectId !== projectId) {
    return { issue: { code: upload ? "cross_project_reference" : "not_found", message: tx("Upload não encontrado neste projeto", "Upload not found in this project"), path, uploadId } };
  }
  if (upload.status !== "ready" || upload.normalizedRasterSha256 === null) {
    return { issue: { code: "upload_not_ready", message: tx(`Upload ${uploadId} não é uma imagem normalizada pronta para usar como referência`, `Upload ${uploadId} is not a normalized image ready for use as a reference`), path, uploadId } };
  }
  return { sha256: upload.normalizedRasterSha256 };
}

export function validatePlanReferences(plan: GenerationPlan, lookup: PlanLookup): PlanIssue[] {
  const issues: PlanIssue[] = [];

  const resolve = (revisionId: string, path: (string | number)[], opts: { approved: boolean; family?: ParamRef["family"] }) => {
    const rev = lookup.revision(revisionId);
    if (!rev) {
      issues.push({ code: "not_found", message: tx(`Revisão inexistente: ${revisionId}`, `Revision does not exist: ${revisionId}`), path, revisionId });
      return undefined;
    }
    if (rev.projectId !== plan.projectId) {
      // Mesma resposta de "não encontrado" para o cliente (404), código distinto para diagnóstico.
      issues.push({ code: "cross_project_reference", message: tx(`Revisão ${revisionId} pertence a outro projeto`, `Revision ${revisionId} belongs to another project`), path, revisionId });
      return undefined;
    }
    if (opts.family && rev.family !== opts.family) {
      issues.push({ code: "wrong_reference_kind", message: tx(`${revisionId} é ${rev.family}; esperado ${opts.family}`, `${revisionId} is ${rev.family}; expected ${opts.family}`), path, revisionId });
    }
    if (opts.approved && rev.status !== "approved") {
      issues.push({ code: "source_not_approved", message: tx(`Revisão ${revisionId} não está aprovada (${rev.status})`, `Revision ${revisionId} is not approved (${rev.status})`), path, revisionId });
    }
    return rev;
  };

  const readyMask = (fileId: string) => {
    const upload = lookup.upload(fileId);
    return upload?.status === "ready" ? upload : undefined;
  };

  resolve(plan.styleRevisionId, ["styleRevisionId"], { approved: true, family: "style" });

  plan.sources.forEach((source, i) => {
    const path = ["sources", i];
    if ("uploadId" in source) {
      const resolved = resolveGenerationUpload(lookup, plan.projectId, source.uploadId, [...path, "uploadId"]);
      if ("issue" in resolved) {
        issues.push(resolved.issue);
      } else if (resolved.sha256 !== source.sha256) {
        issues.push({ code: "source_file_mismatch", message: tx("Hash congelado da referência diverge do upload normalizado", "Frozen reference hash does not match the normalized upload"), path, uploadId: source.uploadId });
      }
      return;
    }
    if (source.role === "edit_mask") {
      const upload = source.fileId === null ? undefined : readyMask(source.fileId);
      if (!upload) {
        issues.push({ code: "not_found", message: tx(`Máscara inexistente: ${source.fileId}`, `Mask does not exist: ${source.fileId}`), path });
      } else if (upload.projectId !== plan.projectId) {
        issues.push({ code: "cross_project_reference", message: tx(`Máscara ${source.fileId} pertence a outro projeto`, `Mask ${source.fileId} belongs to another project`), path });
      } else if (upload.sha256 !== source.sha256) {
        issues.push({ code: "source_file_mismatch", message: tx(`Hash congelado da máscara diverge do upload`, `Frozen mask hash does not match the upload`), path });
      }
      return;
    }
    const rev = resolve(source.revisionId, [...path, "revisionId"], { approved: true });
    if (!rev) return;
    if (source.fileId === null) {
      if (rev.payloadDigest !== source.sha256) {
        issues.push({ code: "source_file_mismatch", message: tx(`Digest congelado de ${source.revisionId} diverge do payload`, `Frozen digest of ${source.revisionId} does not match the payload`), path, revisionId: source.revisionId });
      }
      return;
    }
    const file = Object.hasOwn(rev.files, source.fileId) ? rev.files[source.fileId] : undefined;
    if (!file) {
      issues.push({ code: "source_file_mismatch", message: tx(`${source.fileId} não pertence a ${source.revisionId}`, `${source.fileId} does not belong to ${source.revisionId}`), path, revisionId: source.revisionId });
    } else if (plan.operation === "generate_asset" && !file.mime.startsWith("image/")) {
      issues.push({ code: "wrong_reference_kind", message: tx(`${source.fileId} não é uma imagem`, `${source.fileId} is not an image`), path, revisionId: source.revisionId });
    } else if (file.sha256 !== source.sha256) {
      issues.push({ code: "source_file_mismatch", message: tx(`Hash congelado de ${source.fileId} diverge da revisão`, `Frozen hash of ${source.fileId} does not match the revision`), path, revisionId: source.revisionId });
    }
  });

  for (const ref of planParamRefs(plan)) {
    resolve(ref.revisionId, ref.path, { approved: true, ...(ref.family ? { family: ref.family } : {}) });
  }

  if (plan.operation === "inpaint") {
    const source = lookup.revision(plan.params.sourceRevisionId)?.files[plan.params.sourceFileId];
    const mask = readyMask(plan.params.editMaskFileId);
    if (source && mask && (source.width !== mask.width || source.height !== mask.height)) {
      issues.push({
        code: "mask_size_mismatch",
        message: tx(`Máscara ${mask.width}×${mask.height} difere da fonte ${source.width}×${source.height}`, `Mask ${mask.width}×${mask.height} differs from the source ${source.width}×${source.height}`),
        path: ["params", "editMaskFileId"],
      });
    }
    const [w, h] = plan.params.logicalSize;
    if (source && (source.width !== w || source.height !== h)) {
      issues.push({ code: "mask_size_mismatch", message: tx(`Tamanho lógico ${w}×${h} difere da fonte`, `Logical size ${w}×${h} differs from the source`), path: ["params", "logicalSize"] });
    }
  }

  return issues;
}
