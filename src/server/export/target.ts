import type { Manifest, ManifestEntry } from "@/contracts";
import type { LocalizedText } from "@/i18n/locales";
import type { PackageFile } from "./package";

export interface TargetInput {
  manifest: Manifest;
  sourceFiles: readonly PackageFile[];
  selected: ReadonlySet<string>;
  projectName: string;
  workDir: string;
  python: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ExportTarget {
  problem(entry: ManifestEntry): LocalizedText | null;
  build(input: TargetInput): PackageFile[] | Promise<PackageFile[]>;
}
