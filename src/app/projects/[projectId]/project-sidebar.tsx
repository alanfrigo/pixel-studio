"use client";

import Link from "next/link";
import { useSearchParams, useSelectedLayoutSegment } from "next/navigation";
import { useId, useRef, useState } from "react";
import { useMessages } from "@/i18n/client";
import { studioMessages } from "@/i18n/messages/studio";
import styles from "./project-layout.module.css";

export function ProjectSidebar({ projectId, name }: { projectId: string; name: string }) {
  const m = useMessages(studioMessages);
  const segment = useSelectedLayoutSegment();
  const search = useSearchParams();
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const [view, repeatedView] = search.getAll("view");
  const [template, repeatedTemplate] = search.getAll("template");
  const current = segment ?? (repeatedView === undefined && (view === "library" || view === "activity" || view === "export" || view === "style") ? view : "create");

  function hrefForView(view?: "library" | "activity" | "export" | "style") {
    const query = new URLSearchParams();
    if (view) query.set("view", view);
    if (template && repeatedTemplate === undefined) query.set("template", template);
    return query.size ? `${base}?${query}` : base;
  }

  const groups = [
    {
      id: "workflow",
      label: m.workflow,
      items: [
        { id: "create", label: m.createStep, href: hrefForView() },
        { id: "library", label: m.assets, href: hrefForView("library") },
        { id: "animation", label: m.animateStep, href: `${base}/animation` },
        { id: "export", label: m.exportStep, href: hrefForView("export") },
      ],
    },
    {
      id: "production",
      label: m.production,
      items: [
        { id: "equipment", label: m.equipmentStep, href: `${base}/equipment` },
        { id: "world", label: m.world, href: `${base}/world` },
        { id: "scenes", label: m.scenes, href: `${base}/scenes` },
        { id: "dialogue", label: m.dialogue, href: `${base}/dialogue` },
        { id: "ui", label: m.ui, href: `${base}/ui` },
      ],
    },
    {
      id: "tools",
      label: m.tools,
      items: [
        { id: "activity", label: m.activity, href: hrefForView("activity") },
        { id: "style", label: m.style, href: hrefForView("style") },
        { id: "examples", label: m.examples, href: `/examples?project=${encodeURIComponent(projectId)}` },
      ],
    },
  ] as const;
  const currentLabel = current === "inpaint"
    ? m.inpaint
    : groups.flatMap(({ items }) => [...items]).find(({ id }) => id === current)?.label;

  function closeMenu() {
    if (!open || !toggleRef.current?.getClientRects().length) return;
    setOpen(false);
    toggleRef.current.focus();
  }

  return (
    <aside className={styles.sidebar} onKeyDown={(event) => {
      if (event.key === "Escape") closeMenu();
    }}>
      <div>
        <Link className={styles.projects} href="/"><span aria-hidden="true">←</span> {m.projects}</Link>
        <p className={styles.name}>{name}</p>
      </div>
      <button ref={toggleRef} type="button" className={`secondary ${styles.toggle}`} aria-controls={menuId} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={styles.toggleLabel}>
          <strong>{m.projectMenu}</strong>
          {currentLabel && <span>{currentLabel}</span>}
        </span>
        <svg className={styles.chevron} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m2 4 4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.5" />
        </svg>
      </button>
      <nav id={menuId} aria-label={m.workspace} className={styles.navigation} data-open={open}>
        {groups.map(({ id: groupId, label, items }) => (
          <div className={styles.group} key={groupId}>
            <p className={styles.groupLabel}>{label}</p>
            <ul>
              {items.map(({ id, label, href }) => (
                <li key={id}><Link href={href} aria-current={id === current ? "page" : undefined} onNavigate={closeMenu}>{label}</Link></li>
              ))}
              {groupId === "tools" && current === "inpaint" && (
                <li><span aria-current="page">{m.inpaint}</span></li>
              )}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
