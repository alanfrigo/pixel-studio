import { afterEach, describe, expect, it } from "vitest";
import { defaultStyle } from "@/domain/style-presets";
import { DomainFailure } from "../errors";
import { makeTestStudio, type TestStudio } from "../testing";
import { createProject, getProject, getStyleRevision, publishStyleRevision } from "./catalog";

let studio: TestStudio;
afterEach(() => studio?.cleanup());

describe("guia de estilo versionado", () => {
  it("salvar cria revisão nova e ativa; sem mudança não cria; aba desatualizada recebe conflito", () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Estilo" });
    const first = project.activeStyleRevisionId!;
    const style = defaultStyle();
    const edited = { ...style, outline: { widthPx: 2, policy: "selective" as const }, detailDensity: "high" as const };

    const second = publishStyleRevision(studio.db, studio.clock, project.id, { payload: edited, expectedActiveStyleRevisionId: first });
    expect(second.number).toBe(2);
    expect(getProject(studio.db, project.id).activeStyleRevisionId).toBe(second.id);
    expect(getStyleRevision(studio.db, project.id, first).payload.outline.widthPx).toBe(style.outline.widthPx); // a antiga fica intacta

    const same = publishStyleRevision(studio.db, studio.clock, project.id, { payload: edited, expectedActiveStyleRevisionId: second.id });
    expect(same.id).toBe(second.id);

    const stale = (() => {
      try {
        publishStyleRevision(studio.db, studio.clock, project.id, { payload: style, expectedActiveStyleRevisionId: first });
      } catch (e) {
        return e;
      }
    })();
    expect(stale).toBeInstanceOf(DomainFailure);
    expect((stale as DomainFailure).code).toBe("revision_conflict");
    expect(() =>
      publishStyleRevision(studio.db, studio.clock, project.id, { payload: { ...style, palette: { ...style.palette, colors: [] } }, expectedActiveStyleRevisionId: second.id }),
    ).toThrow();
  });
});
