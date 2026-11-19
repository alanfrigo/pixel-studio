import type { ClareiraFixture, FixtureFile } from "./clareira";

/** Arquivos JSON de projeto da fixture, com caminhos relativos a `fixtures/clareira/`. */
export function fixtureJsonFiles(fixture: ClareiraFixture): FixtureFile[] {
  const json = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  return [
    { path: "project/style-a.json", bytes: json(fixture.style) },
    { path: "project/catalog.json", bytes: json(fixture.catalog) },
    ...Object.entries(fixture.plans).map(([name, plan]) => ({ path: `project/plans/${name}.json`, bytes: json(plan) })),
  ];
}

/** Todos os arquivos que o gerador grava, relativos a `fixtures/clareira/`. */
export function allFixtureFiles(fixture: ClareiraFixture): FixtureFile[] {
  return [
    ...fixture.packageFiles.map((f) => ({ path: `package/${f.path}`, bytes: f.bytes })),
    ...fixture.projectFiles.map((f) => ({ path: `project/${f.path}`, bytes: f.bytes })),
    ...fixtureJsonFiles(fixture),
  ];
}
