import { inpaintMessages } from "@/i18n/messages/inpaint";
import { serverMessages } from "@/i18n/server";
import { InpaintEditor } from "./inpaint-editor";

export default async function InpaintPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ asset?: string; revision?: string; file?: string }>;
}) {
  const { projectId } = await params;
  const { asset, revision, file } = await searchParams;
  if (!asset || !revision || !file) {
    const m = await serverMessages(inpaintMessages);
    return <p className="error">{m.openFromLibrary}</p>;
  }
  return <InpaintEditor projectId={projectId} assetId={asset} revisionId={revision} fileKey={file} />;
}
