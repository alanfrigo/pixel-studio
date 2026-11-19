"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LocaleSwitch, useMessages } from "@/i18n/client";
import { studioMessages } from "@/i18n/messages/studio";

export function StudioNavigation() {
  const path = usePathname();
  const inProject = path.startsWith("/projects/");
  const m = useMessages(studioMessages);
  const links = [
    ...(!inProject ? [
      { href: "/", label: m.projects, active: path === "/" },
      { href: "/examples", label: m.examples, active: path === "/examples" },
    ] : []),
    { href: "/settings", label: m.settings, active: path === "/settings" },
  ];
  return (
    <header className={`studio-header nav nav--centre${inProject ? " studio-header--project" : ""}`}>
      <a className="studio-skip skip-link" href="#studio-content">{m.skip}</a>
      <div className="wrap studio-header-inner">
          <Link href="/" className="studio-brand" aria-label="Pixel Studio">
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M2 2h9v9H2zm11 0h9v9h-9zM2 13h9v9H2zm11 0h5v5h-5z" /></svg>
            Pixel Studio
          </Link>
          <nav className="studio-nav" aria-label={m.navigation}>
            {links.map(({ href, label, active }) => <Link key={href} className="m-link" href={href} aria-current={active ? "page" : undefined}>{label}</Link>)}
          </nav>
          <label className="studio-language-field">
            {m.language}
            <LocaleSwitch className="studio-language" />
          </label>
      </div>
    </header>
  );
}
