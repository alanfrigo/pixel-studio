import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getProject } from "@/server/catalog/catalog";
import { DomainFailure } from "@/server/errors";
import { webStudio } from "@/server/studio";
import { ProjectSidebar } from "./project-sidebar";
import styles from "./project-layout.module.css";

export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  let project;
  try {
    project = getProject(webStudio().db, projectId);
  } catch (error) {
    if (error instanceof DomainFailure && error.code === "not_found") notFound();
    throw error;
  }
  return (
    <div className={styles.layout}>
      <ProjectSidebar projectId={project.id} name={project.name} />
      <main id="studio-content" tabIndex={-1} className={styles.content}>
        {children}
      </main>
    </div>
  );
}
