import Link from "next/link";
import { studioMessages } from "@/i18n/messages/studio";
import { serverMessages } from "@/i18n/server";
import { ProjectList } from "./project-list";
import { HealthBanner } from "./client/health-banner";
import { HomeMotion } from "./home-motion";

export default async function HomePage({ searchParams }: PageProps<"/">) {
  const [m, query] = await Promise.all([serverMessages(studioMessages), searchParams]);
  const templateId = typeof query.template === "string" ? query.template : undefined;
  return (
    <>
    <main id="studio-content" tabIndex={-1} className="studio-home" key={m.category}>
      {/* Software: white-link-blue / Instrument Sans, centred, nav-centre, tonal, sage, fluted-glass, word-highlight. */}
      <section id="projects" className="hero hero--centred studio-hero" data-enter="" aria-labelledby="hero-title">
        <div className="wrap studio-wrap">
          <div className="hero-text studio-intro">
            <h1 id="hero-title" data-enter-whole="">{m.category}</h1>
            <p className="hero__lead">{m.intro}</p>
            <Link href="#new-project" className="btn btn--primary button studio-cta">{m.create} <span aria-hidden="true">↘</span></Link>
          </div>
          <div className="ui studio-window hero__window" data-enter-media="">
            <div className="studio-window-bar">
              <span className="studio-window-grid" aria-hidden="true" />
              <span>Pixel Studio</span>
              <span className="studio-window-scope">{m.projects}</span>
            </div>
            <div className="studio-window-body">
              <div className="studio-project-pane">
                <ProjectList templateId={templateId} />
                <HealthBanner warningsOnly />
              </div>
              <Link href="/examples" className="studio-preview m-zoom">
                <div className="studio-preview-ground" data-fx="fluted-glass" data-fx-params='{"speed":0}' data-fx-seed="32" aria-hidden="true" />
                <span className="studio-preview-label">{m.previewLabel}</span>
                <span className="studio-preview-sprites">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/examples/wizard.png" alt={m.homeArt.wizard} width={64} height={64} data-source="Pixel Studio" data-subject="wizard" />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/examples/ranger.png" alt={m.homeArt.ranger} width={64} height={64} data-source="Pixel Studio" data-subject="ranger" />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/examples/slime.png" alt={m.homeArt.slime} width={64} height={64} data-source="Pixel Studio" data-subject="slime" />
                </span>
                <span className="studio-preview-link">{m.previewAction} <span aria-hidden="true">↗</span></span>
              </Link>
            </div>
          </div>
        </div>
      </section>
      <section id="references" className="studio-references" data-moment="word-highlight" aria-labelledby="reference-title">
        <div className="wrap studio-wrap">
          <div className="studio-references-copy">
            <h2 id="reference-title">{m.libraryTitle}</h2>
            <p className="mo-wh__text">{m.libraryLead}</p>
            <Link className="button secondary" href="/examples">{m.libraryAction} <span aria-hidden="true">↗</span></Link>
          </div>
          <Link href="/examples" className="studio-reference-art m-zoom card" aria-label={m.libraryAction}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/examples/chest.png" alt={m.homeArt.chest} width={32} height={32} loading="lazy" data-source="Pixel Studio" data-subject="chest" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/examples/potion.png" alt={m.homeArt.potion} width={32} height={32} loading="lazy" data-source="Pixel Studio" data-subject="potion" />
          </Link>
        </div>
      </section>
      <HomeMotion />
    </main>
      <footer className="studio-footer footer-columns">
        <div className="wrap studio-wrap">
          <strong>Pixel Studio</strong>
          <Link className="m-link" href="/examples">{m.examples}</Link>
          <Link className="m-link" href="/settings">{m.settings}</Link>
          <small>{m.artCredit}</small>
        </div>
      </footer>
    </>
  );
}
