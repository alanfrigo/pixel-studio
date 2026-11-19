import { createHash } from "node:crypto";
import { fileModality, type Manifest } from "@/contracts";
import { readPngInfo } from "@/lib/media/png";
import { readWavInfo } from "@/lib/media/wav";

/**
 * Confere os bytes de cada arquivo do manifesto: existência, tamanho, SHA-256
 * e metadados medidos por modalidade (dimensões do PNG, frames/taxa do WAV).
 * `readFile` recebe o caminho relativo do pacote; quem chama resolve a raiz.
 */

export type FileIssueCode = "file_unreadable" | "bytes_mismatch" | "hash_mismatch" | "metadata_mismatch" | "undecodable";

export interface FileIssue {
  code: FileIssueCode;
  fileId: string;
  message: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyManifestFiles(
  manifest: Manifest,
  readFile: (relativePath: string) => Promise<Uint8Array>,
): Promise<FileIssue[]> {
  const issues: FileIssue[] = [];
  for (const file of manifest.files) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file.path);
    } catch {
      issues.push({ code: "file_unreadable", fileId: file.fileId, message: `Não foi possível ler ${file.path}` });
      continue;
    }
    if (bytes.length !== file.bytes) {
      issues.push({ code: "bytes_mismatch", fileId: file.fileId, message: `${file.path}: ${bytes.length} bytes, manifesto diz ${file.bytes}` });
    }
    const hash = sha256Hex(bytes);
    if (hash !== file.sha256) {
      issues.push({ code: "hash_mismatch", fileId: file.fileId, message: `${file.path}: SHA-256 diverge do manifesto` });
    }
    const modality = fileModality(file);
    if (modality === "raster" && "width" in file) {
      const info = readPngInfo(bytes);
      if (!info) {
        issues.push({ code: "undecodable", fileId: file.fileId, message: `${file.path} não é PNG válido` });
      } else if (info.width !== file.width || info.height !== file.height) {
        issues.push({
          code: "metadata_mismatch",
          fileId: file.fileId,
          message: `${file.path}: PNG tem ${info.width}×${info.height}, manifesto diz ${file.width}×${file.height}`,
        });
      }
    } else if (modality === "audio" && "frameCount" in file && file.mime === "audio/wav") {
      const info = readWavInfo(bytes);
      if (!info) {
        issues.push({ code: "undecodable", fileId: file.fileId, message: `${file.path} não é WAV válido` });
      } else if (
        info.sampleRate !== file.sampleRate ||
        info.channels !== file.channels ||
        info.frameCount !== file.frameCount ||
        info.durationMs !== file.durationMs
      ) {
        issues.push({ code: "metadata_mismatch", fileId: file.fileId, message: `${file.path}: metadados de áudio divergem do manifesto` });
      }
    }
  }
  return issues;
}
