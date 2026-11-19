import { describe, expect, it } from "vitest";
import { type ClipPayload, MotionPayload } from "@/contracts";
import { readPngInfo } from "@/lib/media/png";
import { closestView, orientationFor, resolveView, viewForWorld, viewSet } from "./directions";
import { renderPoseGuide } from "./pose-guide";
import { BUILTIN_PRESETS, findPreset, fitsTextV3, parsePresetRevisionId, presetRevisionId } from "./presets";
import {
  addCustomJoint,
  buildMotion,
  defaultHumanoidPose,
  duplicatePose,
  fillBetween,
  humanoidSkeleton,
  moveJoint,
  presetPoses,
  removeCustomJoint,
  removePose,
  reparent,
} from "./skeleton";
import { averageFps, frameAt, retimeClip, sheetLayout, uniformDurations } from "./timeline";

describe("presets de ação versionados", () => {
  it("cobrem a tabela do plano com IDs de quadro e durações inteiras", () => {
    const byKey = Object.fromEntries(BUILTIN_PRESETS.map((p) => [p.key, p]));
    expect(byKey.idle).toMatchObject({ durationsMs: [180, 180, 180, 180], playback: "loop", strategy: "text" });
    expect(byKey.walk!.durationsMs).toEqual(Array(6).fill(120));
    expect(byKey.run!.durationsMs).toEqual(Array(6).fill(85));
    expect(byKey["attack-shield"]).toMatchObject({ durationsMs: [140, 80, 60, 160], stance: "one_hand_shield", playback: "once" });
    expect(byKey["attack-two-handed"]!.durationsMs).toEqual([120, 100, 90, 60, 110, 180]);
    // hurt de 3 quadros não cabe no texto v3: é preset de esqueleto, não "gera 4 e descarta 1".
    expect(byKey.hurt).toMatchObject({ durationsMs: [100, 70, 140], strategy: "skeleton" });
    expect(fitsTextV3(3)).toBe(false);
    expect(BUILTIN_PRESETS.filter((p) => p.strategy === "text").every((p) => fitsTextV3(p.frameIds.length))).toBe(true);
    for (const p of BUILTIN_PRESETS) expect(`${p.motion["pt-BR"]} ${p.motion.en}`).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("ID de revisão carrega projeto, chave e versão; versão inexistente não resolve", () => {
    const id = presetRevisionId("prj_1", findPreset("walk")!);
    expect(id).toBe("prj_1:preset:walk:v1");
    expect(parsePresetRevisionId(id)).toMatchObject({ projectId: "prj_1", preset: { key: "walk", version: 1 } });
    expect(parsePresetRevisionId("prj_1:preset:walk:v9")).toBeNull();
    expect(parsePresetRevisionId("rev_qualquer")).toBeNull();
  });
});

describe("direção → vista", () => {
  it("isométrico de referência: cardinais do mundo usam diagonais da tela (tabela do plano 04)", () => {
    const iso = orientationFor("isometric");
    expect(iso.worldToView).toEqual({ N: "NE", NE: "E", E: "SE", SE: "S", S: "SW", SW: "W", W: "NW", NW: "N" });
    expect(viewForWorld("E", iso)).toBe("SE");
    expect(viewForWorld("N", iso)).toBe("NE");
    expect(viewSet(4, "isometric")).toEqual(["NE", "SE", "SW", "NW"]);
    expect(viewSet(4, "top_down")).toEqual(["N", "E", "S", "W"]);
    expect(viewSet(8, "top_down")).toHaveLength(8);
    expect(viewForWorld("E", orientationFor("top_down"))).toBe("E");
  });

  it("vista ausente é lacuna; espelho só com par explícito", () => {
    const views = [{ direction: "E" as const }];
    expect(resolveView("W", views)).toMatchObject({ kind: "missing" });
    expect(resolveView("W", views, { policy: "explicit", pairs: [{ source: "E", target: "W" }] })).toEqual({ kind: "mirror", direction: "W", from: "E" });
    expect(resolveView("E", views)).toEqual({ kind: "view", direction: "E" });
    expect(closestView("SE", ["S", "N"])).toBe("S");
    expect(closestView("W", ["N", "S"])).toBe("S");
    expect(closestView("NE", [])).toBeNull();
  });
});

describe("tempo do clipe", () => {
  const d = [100, 50, 200];
  it("quadro no instante para ciclo, execução única e vai-e-volta", () => {
    expect([0, 99, 100, 149, 150, 349, 350].map((t) => frameAt(d, t, "loop"))).toEqual([0, 0, 1, 1, 2, 2, 0]);
    expect(frameAt(d, 10_000, "once")).toBe(2);
    // vai-e-volta sem repetir as pontas: 0,1,2,1 | 0…
    expect([0, 100, 150, 350, 400].map((t) => frameAt(d, t, "ping_pong"))).toEqual([0, 1, 2, 1, 0]);
  });

  it("retime troca só durações; FPS só preenche tempos uniformes", () => {
    const clip = {
      frames: [
        { frameId: "a", durationMs: 100, layers: [], sockets: [], rootOffset: [0, 0] },
        { frameId: "b", durationMs: 100, layers: [], sockets: [], rootOffset: [0, 0] },
      ],
    } as unknown as ClipPayload;
    expect(retimeClip(clip, [60, 140]).frames.map((f) => [f.frameId, f.durationMs])).toEqual([
      ["a", 60],
      ["b", 140],
    ]);
    expect(() => retimeClip(clip, [60])).toThrow(/Esperadas 2/);
    expect(() => retimeClip(clip, [60, 0])).toThrow(/inteira/);
    expect(uniformDurations(12, 3)).toEqual([83, 83, 83]);
    expect(averageFps([100, 100])).toBe(10);
  });

  it("grade da folha usa proporções aceitas pelos modelos", () => {
    expect([1, 2, 3, 4, 5, 6, 8, 12, 16].map((n) => sheetLayout(n))).toEqual([
      { columns: 1, rows: 1 },
      { columns: 2, rows: 1 },
      { columns: 2, rows: 2 },
      { columns: 2, rows: 2 },
      { columns: 3, rows: 2 },
      { columns: 3, rows: 2 },
      { columns: 3, rows: 3 },
      { columns: 4, rows: 3 },
      { columns: 4, rows: 4 },
    ]);
  });
});

describe("esqueleto e timeline de keypoints", () => {
  const cell: [number, number] = [64, 64];
  const ref = defaultHumanoidPose("S", cell, [16, 8, 32, 52]);

  it("pose padrão: 18 joints humanoides, lado anatômico correto por direção, dentro da célula", () => {
    expect(Object.keys(ref)).toHaveLength(18);
    // De frente (S), a mão direita do personagem fica à esquerda da tela; de costas (N), à direita.
    expect(ref.wrist_r!.x).toBeLessThan(ref.wrist_l!.x);
    const back = defaultHumanoidPose("N", cell);
    expect(back.wrist_r!.x).toBeGreaterThan(back.wrist_l!.x);
    expect(back.nose!.visible).toBe(false); // oculto, mas presente e revisável
    const east = defaultHumanoidPose("E", cell);
    expect(east.wrist_r!.zIndex).toBeGreaterThan(east.wrist_l!.zIndex); // lado perto da câmera à frente
    for (const p of Object.values(ref)) expect(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1).toBe(true);
  });

  it("presets viram poses-guia completas; a fase aérea da corrida sobe a figura (root motion)", () => {
    const run = presetPoses("run_cycle", ref, "S", 6);
    expect(run).toHaveLength(6);
    expect(run[2]!.ankle_l!.y).toBeLessThan(run[0]!.ankle_l!.y);
    const motion = buildMotion({
      skeleton: humanoidSkeleton(),
      cell,
      direction: "S",
      projection: "top_down",
      action: "run",
      referencePose: ref,
      poses: run.map((joints, i) => ({ poseId: `p${i + 1}`, durationMs: 85, joints })),
      loop: true,
    });
    expect(MotionPayload.safeParse(motion).success).toBe(true);
  });

  it("editar keyframes: mover, interpolar intermediários, duplicar e remover mantêm IDs", () => {
    const poses = [0, 1, 2, 3].map((i) => ({ poseId: `k${i}`, durationMs: 100, joints: ref }));
    poses[3] = { ...poses[3]!, joints: moveJoint(ref, "wrist_r", 0.9, 0.2) };
    const filled = fillBetween(poses, 0, 3);
    expect(filled[1]!.joints.wrist_r!.x).toBeCloseTo(ref.wrist_r!.x + (0.9 - ref.wrist_r!.x) / 3, 4);
    expect(filled.map((p) => p.poseId)).toEqual(["k0", "k1", "k2", "k3"]);
    const dup = duplicatePose(filled, 1);
    expect(dup).toHaveLength(5);
    expect(new Set(dup.map((p) => p.poseId)).size).toBe(5);
    expect(removePose(dup, 0)).toHaveLength(4);
    expect(removePose([poses[0]!], 0)).toHaveLength(1);
    expect(moveJoint(ref, "wrist_r", 1.4, -2).wrist_r).toMatchObject({ x: 1, y: 0 });
  });

  it("hierarquia custom: parent editável sem ciclo, joint novo herda posição, remover religa filhos", () => {
    const skeleton = { kind: "custom" as const, joints: [
      { jointId: "root", name: "raiz", parent: null, anatomicalSide: "center" as const },
      { jointId: "lid", name: "tampa", parent: "root", anatomicalSide: "center" as const },
    ] };
    expect(reparent(skeleton, "root", "lid").problems.length).toBeGreaterThan(0);
    const base = { skeleton, referencePose: { root: { x: 0.5, y: 0.8, visible: true, zIndex: 0 }, lid: { x: 0.5, y: 0.4, visible: true, zIndex: 1 } }, poses: [{ poseId: "a", durationMs: 100, joints: { root: { x: 0.5, y: 0.8, visible: true, zIndex: 0 }, lid: { x: 0.5, y: 0.3, visible: true, zIndex: 1 } } }] };
    const added = addCustomJoint(base, { jointId: "hinge", name: "dobradiça", parent: "lid", anatomicalSide: "center" });
    expect(added.poses[0]!.joints.hinge).toMatchObject({ x: 0.5, y: 0.3 });
    const removed = removeCustomJoint(added, "lid")!;
    expect(removed.skeleton.joints.find((j) => j.jointId === "hinge")!.parent).toBe("root");
    expect(removeCustomJoint(added, "root")).toBeNull();
  });

  it("guia de poses em imagem: grade da folha, e mudar um joint muda os bytes", () => {
    const poses = presetPoses("idle_breath", ref, "S", 4);
    const guide = (p: typeof poses) => renderPoseGuide({ skeleton: humanoidSkeleton(), poses: p, columns: 2, rows: 2, cell, scale: 4, background: [255, 255, 255, 255] });
    const a = guide(poses);
    expect(readPngInfo(a)).toMatchObject({ width: 512, height: 512 });
    const b = guide(poses.map((p, i) => (i === 1 ? moveJoint(p, "elbow_r", 0.1, 0.5) : p)));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
