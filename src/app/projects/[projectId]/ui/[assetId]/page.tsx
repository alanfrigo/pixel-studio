import { UiEditor } from "./ui-editor";

export default async function UiEditorPage({ params }: { params: Promise<{ projectId: string; assetId: string }> }) {
  const { projectId, assetId } = await params;
  return <UiEditor projectId={projectId} assetId={assetId} />;
}
