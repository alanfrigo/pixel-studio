import Image from "next/image";
import Link from "next/link";
import { defineMessages, pick } from "@/i18n/locales";
import { requestLocale } from "@/i18n/server";
import { listProjects } from "@/server/catalog/catalog";
import { webStudio } from "@/server/studio";
import { comparisons } from "./samples";
import { studioTemplates } from "./templates";
import "./examples.css";

const messages = defineMessages({
  "pt-BR": {
    title: "Exemplos",
    intro: "Use um prompt no seu projeto ou compare os sprites gerados para o mesmo pedido.",
    templates: "Templates de prompt",
    templateHelp: "O template preenche o editor. Você pode editar o prompt antes de gerar.",
    project: "Projeto de destino",
    projectMissing: "Projeto não encontrado. Escolha outro projeto ao usar um template.",
    projectPicker: "Escolha ou crie um projeto ao usar um template.",
    use: "Usar template",
    character: "Personagem",
    item: "Item",
    results: "Comparação de resultados",
    method: "Cada comparação usa o mesmo pedido em inglês, as mesmas referências e o mesmo tamanho final. O Studio normalizou os PNGs. Uma amostra por modelo e pedido.",
    provenance: "Origem dos modelos de prompt: vitrine de 19 nov 2026, OpenRouter · openai/gpt-image-2.6-flare.",
    scripts: "Relatórios locais produzidos por",
  },
  en: {
    title: "Examples",
    intro: "Start with an editable prompt or compare the sprites generated from the same brief.",
    templates: "Prompt templates",
    templateHelp: "A template fills in the editor. You can change the prompt before generating.",
    projectPicker: "Choose or create a project when you use a template.",
    project: "Destination project",
    projectMissing: "Project not found. Choose another project when you use a template.",
    use: "Use template",
    character: "Character",
    item: "Item",
    results: "Output comparisons",
    method: "Each comparison uses the same English brief, references, and final size. Studio normalized the PNGs. One sample per model and brief.",
    provenance: "Template previews: 19 Nov 2026 showcase, OpenRouter · openai/gpt-image-2.6-flare.",
    scripts: "Local reports produced by",
  },
});

function Sprite({ image, size, alt }: { image: string; size: number; alt: string }) {
  const displaySize = size === 32 ? 96 : 128;
  return (
    <div className="examples-sprite">
      <Image src={image} alt={alt} width={displaySize} height={displaySize} unoptimized />
    </div>
  );
}

export default async function ExamplesPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>;
}) {
  const [locale, params] = await Promise.all([requestLocale(), searchParams]);
  const t = messages[locale];
  const projectId = typeof params.project === "string" ? params.project : undefined;
  const project = projectId ? listProjects(webStudio().db).find(({ id }) => id === projectId) : undefined;

  return (
    <main id="studio-content" tabIndex={-1} className="studio-main examples-page">
      <header className="studio-page-head">
        <h1>{t.title}</h1>
        <p>{t.intro}</p>
      </header>

      <section className="examples-section" aria-labelledby="examples-templates">
        <div className="examples-section-head">
          <h2 id="examples-templates">{t.templates}</h2>
          <p>{t.templateHelp}</p>
          {project ? (
            <p>{t.project}: <Link href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</Link></p>
          ) : <p>{params.project !== undefined ? t.projectMissing : t.projectPicker}</p>}
        </div>
        <ul className="examples-templates">
          {studioTemplates.map((template) => {
            const name = pick(template.name, locale);
            const query = `?template=${encodeURIComponent(template.id)}`;
            const href = project ? `/projects/${encodeURIComponent(project.id)}${query}#create` : `/${query}`;
            return (
              <li className="examples-template" key={template.id}>
                <Sprite image={template.image} size={template.size} alt="" />
                <div className="examples-template-content">
                  <span className="examples-meta">{t[template.family]} · {template.size}×{template.size}</span>
                  <h3>{name}</h3>
                  <Link className="button secondary" href={href} aria-label={`${t.use}: ${name}`}>
                    {t.use}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="examples-meta">{t.provenance}</p>
      </section>

      <section className="examples-section examples-results" aria-labelledby="examples-results">
        <div className="examples-section-head">
          <h2 id="examples-results">{t.results}</h2>
          <p>{t.method}</p>
        </div>
        {comparisons.map((comparison) => {
          const title = pick(comparison.title, locale);
          return (
            <article className="examples-comparison" key={comparison.id} aria-labelledby={`sample-${comparison.id}`}>
              <div className="examples-comparison-brief">
                <span className="examples-meta">{pick(comparison.source, locale)} · {comparison.size}×{comparison.size}</span>
                <h3 id={`sample-${comparison.id}`}>{title}</h3>
                <p>{pick(comparison.brief, locale)}</p>
              </div>
              <ul className="examples-samples">
                {comparison.samples.map((sample) => (
                  <li className="examples-sample" key={sample.image}>
                    <div className="examples-sample-label">
                      <span className="examples-meta">{sample.route}</span>
                      <strong>{pick(sample.model, locale)}</strong>
                    </div>
                    <Sprite image={sample.image} size={comparison.size} alt={title} />
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
        <p className="examples-meta">
          {t.scripts} <code>showcase-real.ts</code>, <code>codex-real.ts</code>, <code>evaluate-models.ts</code>.
        </p>
      </section>
    </main>
  );
}
