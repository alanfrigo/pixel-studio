import Link from "next/link";
import { UiEditor } from "./ui-editor";

export default async function UiEditorPage({ params }: { params: Promise<{ projectId: string; assetId: string }> }) {
  const { projectId, assetId } = await params;
  return (
    <main>
      <p className="small">
        <Link href={`/projects/${projectId}`}>← Projeto</Link>
      </p>
      <UiEditor projectId={projectId} assetId={assetId} />
    </main>
  );
}
