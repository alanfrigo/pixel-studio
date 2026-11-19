/**
 * Semeia a demonstração do caso do guerreiro (cartão S2) num projeto do
 * diretório de dados padrão — sem nenhuma chamada a provedor.
 *
 *   npx tsx scripts/equipment-demo.ts [--project=<id>]
 *
 * Sem --project, cria o projeto "Guerreiro · equipamentos (demo)". Depois abra
 * /projects/<id>/equipment. O mesmo resultado sai do botão "Semear
 * demonstração do guerreiro" na página ou de POST /api/v1/projects/<id>/equipment/demo.
 */
import { createProject, getProject } from "@/server/catalog/catalog";
import { loadConfig } from "@/server/config";
import { seedEquipmentDemo } from "@/server/equipment/demo";
import { openStudio } from "@/server/studio";
import { runMigrations } from "./migrate";

const projectArg = process.argv.find((a) => a.startsWith("--project="))?.split("=")[1];
runMigrations();
const studio = openStudio({ config: loadConfig() });
const project = projectArg ? getProject(studio.db, projectArg) : createProject(studio.db, studio.clock, { name: "Guerreiro · equipamentos (demo)" });
const demo = await seedEquipmentDemo(studio, project.id);
console.log(
  `[equipamentos] ${demo.created ? "demonstração semeada" : "demonstração já existia"} em ${project.name} (${project.id}) · conjuntos A ${demo.loadouts.a} e B ${demo.loadouts.b} · abra /projects/${project.id}/equipment`,
);
studio.db.close();
