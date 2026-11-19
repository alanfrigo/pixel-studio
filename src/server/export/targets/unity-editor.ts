// Shipped as plain C# in the archive. Keeping it in the module makes the exporter
// self-contained in both the Next server bundle and the standalone worker.
export const unityEditorSource = String.raw`using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEditor.U2D.Sprites;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;
using UnityEngine.Tilemaps;
using Object = UnityEngine.Object;

namespace PixelStudio.ExportV1
{
    public static class PixelStudioImporter
    {
        private const string Menu = "Assets/Pixel Studio/Import Bundle";
        private static readonly Regex JobPath = new Regex(@"\AAssets/PixelStudio/Bundles/job-[0-9a-f]{24}/PixelStudio\.job\.json\z");
        private static readonly Regex TexturePath = new Regex(@"\ATextures/source-[0-9a-f]{24}\.png\z");
        private static readonly Regex SafeKey = new Regex(@"\A[a-z0-9][a-z0-9-]{0,79}\z");

        // JsonUtility uses fields and does not support dictionaries or nested arrays.
#pragma warning disable CS0649
        [Serializable] private sealed class Job
        {
            public int version, pixelsPerUnit;
            public Image[] textures;
            public StaticRoot[] sprites;
            public ClipRoot[] clips;
            public TilesetRoot[] tilesets;
            public ObjectRoot[] objects;
            public MapRoot[] maps;
        }
        [Serializable] private sealed class Image { public string path; public int width, height; public Slice[] slices; }
        [Serializable] private sealed class Slice { public string name, guid; public int id, x, y, width, height; public float pivotX, pivotY; }
        [Serializable] private sealed class SpriteRef { public string name, slug; public int sprite; public float x, y; }
        [Serializable] private sealed class StaticRoot { public string key, name; public SpriteRef[] variants; }
        [Serializable] private sealed class ClipRoot { public string key, name, playback; public int durationMs; public Frame[] frames; }
        [Serializable] private sealed class Frame { public int startMs; public float moveX, moveY; public SpriteRef[] layers; }
        [Serializable] private sealed class TilesetRoot { public string key; public TileSpec[] tiles; }
        [Serializable] private sealed class TileSpec { public string name; public int sprite; public TimedFrame[] frames; }
        [Serializable] private sealed class TimedFrame { public int sprite, durationMs; }
        [Serializable] private sealed class ObjectRoot
        {
            public string key, name;
            public bool selected;
            public SpriteRef shadow, bottom, top;
            public Box[] collision;
        }
        [Serializable] private sealed class Box { public float x, y, width, height; }
        [Serializable] private sealed class Point { public float x, y; }
        [Serializable] private sealed class Polygon { public string id; public Point[] points; }
        [Serializable] private sealed class Region { public string id, name, kind; public float x, y, width, height; }
        [Serializable] private sealed class Entrance { public string id, name, side; public float x, y; }
        [Serializable] private sealed class Placement { public string id, name, objectKey; public float x, y; }
        [Serializable] private sealed class MapRoot
        {
            public string key, name, tileset;
            public int width, height;
            public float cellWidth, cellHeight;
            public int[] cells, blocked;
            public Polygon[] polygons;
            public Region[] regions;
            public Entrance[] entrances;
            public Placement[] objects;
        }
#pragma warning restore CS0649

        [MenuItem(Menu, true)]
        private static bool CanImport()
        {
            return Selection.activeObject is TextAsset asset && JobPath.IsMatch(AssetDatabase.GetAssetPath(asset));
        }

        [MenuItem(Menu)]
        private static void ImportSelected()
        {
            if (!CanImport()) throw new InvalidOperationException("Select a PixelStudio.job.json in Assets/PixelStudio/Bundles.");
            var asset = (TextAsset)Selection.activeObject;
            var path = AssetDatabase.GetAssetPath(asset);
            var directory = Path.GetDirectoryName(path).Replace('\\', '/');
            var destination = directory + "/Generated";
            if (AssetDatabase.IsValidFolder(destination) || Directory.Exists(destination) || File.Exists(destination))
                throw new IOException($"{destination} already exists. Move it or remove it before importing again.");

            var job = JsonUtility.FromJson<Job>(asset.text);
            if (job == null || job.version != 1 || job.pixelsPerUnit <= 0)
                throw new InvalidDataException("Unsupported Pixel Studio Unity job descriptor.");

            MakeFolder(directory, "Generated");
            try
            {
                var sprites = ReadSprites(job, directory);
                var scene = EditorSceneManager.NewPreviewScene();
                try { new Writer(destination, scene, job.pixelsPerUnit, sprites).Write(job); }
                finally { EditorSceneManager.ClosePreviewScene(scene); }
                AssetDatabase.SaveAssets();
                Selection.activeObject = AssetDatabase.LoadAssetAtPath<DefaultAsset>(destination);
                EditorGUIUtility.PingObject(Selection.activeObject);
                Debug.Log($"Pixel Studio: imported bundle into {destination}.");
            }
            catch
            {
                AssetDatabase.DeleteAsset(destination);
                throw;
            }
        }

        private static string MakeFolder(string parent, string key)
        {
            if (key != "Generated" && !SafeKey.IsMatch(key)) throw new InvalidDataException($"Unsafe asset key: {key}");
            if (AssetDatabase.CreateFolder(parent, key) == "" || !AssetDatabase.IsValidFolder(parent + "/" + key))
                throw new IOException($"Could not create {parent}/{key}.");
            return parent + "/" + key;
        }

        private static Dictionary<int, Sprite> ReadSprites(Job job, string directory)
        {
            var factory = new SpriteDataProviderFactories();
            factory.Init();
            var sprites = new Dictionary<int, Sprite>();
            foreach (var image in job.textures)
            {
                if (!TexturePath.IsMatch(image.path)) throw new InvalidDataException($"Unsafe source texture path: {image.path}");
                var path = directory + "/" + image.path;
                var importer = AssetImporter.GetAtPath(path) as TextureImporter;
                if (importer == null) throw new IOException($"Missing PNG at {path}.");
                importer.textureType = TextureImporterType.Sprite;
                importer.spriteImportMode = SpriteImportMode.Multiple;
                importer.spritePixelsPerUnit = job.pixelsPerUnit;
                importer.filterMode = FilterMode.Point;
                importer.wrapMode = TextureWrapMode.Clamp;
                importer.mipmapEnabled = false;
                importer.textureCompression = TextureImporterCompression.Uncompressed;
                importer.crunchedCompression = false;
                importer.npotScale = TextureImporterNPOTScale.None;
                importer.alphaSource = TextureImporterAlphaSource.FromInput;
                importer.alphaIsTransparency = false;
                importer.maxTextureSize = Mathf.Max(32, Mathf.NextPowerOfTwo(Mathf.Max(image.width, image.height)));
                var textureSettings = new TextureImporterSettings();
                importer.ReadTextureSettings(textureSettings);
                textureSettings.spriteMeshType = SpriteMeshType.FullRect;
                textureSettings.spriteGenerateFallbackPhysicsShape = false;
                importer.SetTextureSettings(textureSettings);

                var provider = factory.GetSpriteEditorDataProviderFromObject(importer);
                provider.InitSpriteEditorDataProvider();
                var slices = image.slices.Select(s => new SpriteRect {
                    name = s.name,
                    spriteID = new GUID(s.guid),
                    rect = new Rect(s.x, s.y, s.width, s.height),
                    alignment = SpriteAlignment.Custom,
                    pivot = new Vector2(s.pivotX / s.width, s.pivotY / s.height),
                }).ToArray();
                provider.SetSpriteRects(slices);
                provider.GetDataProvider<ISpriteNameFileIdDataProvider>().SetNameFileIdPairs(
                    slices.Select(s => new SpriteNameFileIdPair(s.name, s.spriteID)).ToArray());
                provider.Apply();
                importer.SaveAndReimport();

                var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
                if (texture == null || texture.width != image.width || texture.height != image.height)
                    throw new InvalidDataException($"Unity resized {path}; the original pixel grid is required.");
                var imported = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Sprite>().ToDictionary(s => s.name);
                foreach (var spec in image.slices)
                {
                    var sprite = imported[spec.name];
                    if (sprite.rect != new Rect(spec.x, spec.y, spec.width, spec.height)
                        || (sprite.pivot - new Vector2(spec.pivotX, spec.pivotY)).sqrMagnitude > 0.001f
                        || !Mathf.Approximately(sprite.pixelsPerUnit, job.pixelsPerUnit))
                        throw new InvalidDataException($"Unity changed sprite geometry or pixels per unit for {spec.name} in {path}.");
                    sprites.Add(spec.id, sprite);
                }
            }
            return sprites;
        }

        private sealed class Writer
        {
            private readonly string folder;
            private readonly Scene scene;
            private readonly float ppu;
            private readonly Dictionary<int, Sprite> sprites;
            private readonly Dictionary<string, TileBase[]> tilesets = new Dictionary<string, TileBase[]>();
            private Tile collisionTile;

            public Writer(string folder, Scene scene, float ppu, Dictionary<int, Sprite> sprites)
            {
                this.folder = folder;
                this.scene = scene;
                this.ppu = ppu;
                this.sprites = sprites;
            }

            public void Write(Job job)
            {
                foreach (var asset in job.sprites) WriteSprites(asset);
                foreach (var asset in job.clips) WriteClip(asset);
                foreach (var set in job.tilesets) WriteTileset(set);
                var objects = job.objects.ToDictionary(o => o.key);
                foreach (var asset in job.objects)
                {
                    if (!asset.selected) continue;
                    var dir = MakeFolder(folder, asset.key);
                    var root = Node(asset.name);
                    BuildObject(root.transform, asset, 0);
                    SavePrefab(root, dir + "/object.prefab");
                }
                foreach (var map in job.maps) WriteMap(map, objects);
            }

            private GameObject Node(string name, Transform parent = null)
            {
                var node = new GameObject(name);
                SceneManager.MoveGameObjectToScene(node, scene);
                if (parent != null) node.transform.SetParent(parent, false);
                return node;
            }

            private Vector3 Position(float x, float y) => new Vector3(x / ppu, y / ppu, 0f);

            private void SavePrefab(GameObject root, string path)
            {
                PrefabUtility.SaveAsPrefabAsset(root, path, out var success);
                if (!success) throw new IOException($"Could not save {path}.");
                Object.DestroyImmediate(root);
            }

            private void WriteSprites(StaticRoot asset)
            {
                var dir = MakeFolder(folder, asset.key);
                for (var i = 0; i < asset.variants.Length; i++)
                {
                    var spec = asset.variants[i];
                    var root = Node(asset.name + " - " + spec.name);
                    PutSprite(root.transform, "Sprite", spec, 0);
                    if (!SafeKey.IsMatch(spec.slug)) throw new InvalidDataException("Unsafe sprite variant key.");
                    SavePrefab(root, $"{dir}/variant-{i:D2}-{spec.slug}.prefab");
                }
            }

            private void PutSprite(Transform parent, string name, SpriteRef spec, int order)
            {
                if (spec == null || spec.sprite == 0) return;
                var node = Node(name, parent);
                node.transform.localPosition = Position(spec.x, spec.y);
                var renderer = node.AddComponent<SpriteRenderer>();
                renderer.sprite = sprites[spec.sprite];
                renderer.sortingOrder = order;
            }

            private void WriteClip(ClipRoot asset)
            {
                var dir = MakeFolder(folder, asset.key);
                var root = Node(asset.name);
                root.AddComponent<SortingGroup>();
                var motion = Node("Motion", root.transform);
                var clip = new AnimationClip { name = asset.name, frameRate = 1000f };
                var frames = asset.frames;
                var loop = asset.playback != "once";
                // A terminal key keeps the final frame's whole duration, even for a one-frame clip.
                var last = loop ? frames[0] : frames[frames.Length - 1];
                var count = frames.Length + 1;
                var times = new float[count];
                for (var i = 0; i < frames.Length; i++) times[i] = frames[i].startMs / 1000f;
                times[frames.Length] = asset.durationMs / 1000f;
                motion.transform.localPosition = Position(frames[0].moveX, frames[0].moveY);

                // The portable layer array is back-to-front in every frame; do not sort by part ID.
                var layerCount = frames.Max(f => f.layers.Length);
                var bindings = new EditorCurveBinding[layerCount];
                var curves = new ObjectReferenceKeyframe[layerCount][];
                var positions = new EditorCurveBinding[2 * (layerCount + 1)];
                var positionCurves = new AnimationCurve[positions.Length];
                var xs = new Keyframe[count];
                var ys = new Keyframe[count];
                for (var i = 0; i < count; i++)
                {
                    var frame = i < frames.Length ? frames[i] : last;
                    PositionKeys(i, frame.moveX, frame.moveY);
                }
                BindPosition("Motion", 0);
                for (var layer = 0; layer < layerCount; layer++)
                {
                    var name = $"Layer-{layer:D2}";
                    var node = Node(name, motion.transform);
                    var renderer = node.AddComponent<SpriteRenderer>();
                    renderer.sortingOrder = layer;
                    var keys = new ObjectReferenceKeyframe[count];
                    for (var i = 0; i < count; i++)
                    {
                        var frame = i < frames.Length ? frames[i] : last;
                        var spec = layer < frame.layers.Length ? frame.layers[layer] : null;
                        keys[i] = new ObjectReferenceKeyframe { time = times[i], value = spec == null ? null : sprites[spec.sprite] };
                        PositionKeys(i, spec?.x ?? 0, spec?.y ?? 0);
                    }
                    renderer.sprite = keys[0].value as Sprite;
                    node.transform.localPosition = new Vector3(xs[0].value, ys[0].value, 0f);
                    var bindingPath = "Motion/" + name;
                    bindings[layer] = EditorCurveBinding.PPtrCurve(bindingPath, typeof(SpriteRenderer), "m_Sprite");
                    curves[layer] = keys;
                    BindPosition(bindingPath, 2 * (layer + 1));
                }
                AnimationUtility.SetEditorCurves(clip, positions, positionCurves);
                AnimationUtility.SetObjectReferenceCurves(clip, bindings, curves);
                var settings = AnimationUtility.GetAnimationClipSettings(clip);
                settings.loopTime = loop;
                AnimationUtility.SetAnimationClipSettings(clip, settings);
                AssetDatabase.CreateAsset(clip, dir + "/animation.anim");
                var controller = AnimatorController.CreateAnimatorControllerAtPathWithClip(dir + "/animation.controller", clip);
                if (controller == null) throw new IOException($"Could not save Animator Controller at {dir}.");
                root.AddComponent<Animator>().runtimeAnimatorController = controller;
                SavePrefab(root, dir + "/animation.prefab");

                void PositionKeys(int index, float x, float y)
                {
                    xs[index] = new Keyframe(times[index], x / ppu);
                    ys[index] = new Keyframe(times[index], y / ppu);
                }

                void BindPosition(string path, int index)
                {
                    positions[index] = EditorCurveBinding.FloatCurve(path, typeof(Transform), "m_LocalPosition.x");
                    positions[index + 1] = EditorCurveBinding.FloatCurve(path, typeof(Transform), "m_LocalPosition.y");
                    positionCurves[index] = SteppedCurve(xs);
                    positionCurves[index + 1] = SteppedCurve(ys);
                }
            }

            private static AnimationCurve SteppedCurve(Keyframe[] keys)
            {
                var curve = new AnimationCurve(keys);
                for (var i = 0; i < keys.Length; i++)
                {
                    AnimationUtility.SetKeyLeftTangentMode(curve, i, AnimationUtility.TangentMode.Constant);
                    AnimationUtility.SetKeyRightTangentMode(curve, i, AnimationUtility.TangentMode.Constant);
                }
                return curve;
            }

            private void WriteTileset(TilesetRoot set)
            {
                var dir = MakeFolder(folder, set.key);
                var tiles = new TileBase[set.tiles.Length + 1]; // 0 is an intentionally empty cell.
                for (var i = 0; i < set.tiles.Length; i++)
                {
                    var spec = set.tiles[i];
                    if (!SafeKey.IsMatch(spec.name)) throw new InvalidDataException($"Unsafe tile name: {spec.name}");
                    Tile tile;
                    if (spec.frames.Length == 0) tile = ScriptableObject.CreateInstance<Tile>();
                    else
                    {
                        var animated = ScriptableObject.CreateInstance<PixelStudioTimedTile>();
                        animated.frames = spec.frames.Select(f => new PixelStudioTimedTile.Frame { sprite = sprites[f.sprite], durationMs = f.durationMs }).ToArray();
                        tile = animated;
                    }
                    tile.sprite = sprites[spec.sprite];
                    tile.colliderType = Tile.ColliderType.None;
                    AssetDatabase.CreateAsset(tile, $"{dir}/{spec.name}.asset");
                    tiles[i + 1] = tile;
                }
                tilesets.Add(set.key, tiles);
            }

            private void BuildObject(Transform node, ObjectRoot asset, int index)
            {
                PutSprite(node, "Shadow", asset.shadow, -2048 + index);
                PutSprite(node, "Base", asset.bottom, -1024 + index);
                PutSprite(node, "Occlusion", asset.top, 1 + index);
                foreach (var box in asset.collision)
                {
                    var collider = node.gameObject.AddComponent<BoxCollider2D>();
                    collider.offset = Position(box.x, box.y);
                    collider.size = Position(box.width, box.height);
                }
            }

            private void WriteMap(MapRoot map, Dictionary<string, ObjectRoot> objects)
            {
                var dir = MakeFolder(folder, map.key);
                var root = Node(map.name);
                root.AddComponent<Grid>().cellSize = new Vector3(map.cellWidth / ppu, map.cellHeight / ppu, 1f);
                var terrain = Node("Terrain", root.transform);
                var tilemap = terrain.AddComponent<Tilemap>();
                tilemap.animationFrameRate = 1f;
                terrain.AddComponent<TilemapRenderer>().sortingOrder = -3000;
                var tiles = tilesets[map.tileset];
                var written = new TileBase[map.cells.Length];
                for (var i = 0; i < written.Length; i++)
                    written[(map.height - 1 - i / map.width) * map.width + i % map.width] = tiles[map.cells[i]];
                tilemap.SetTilesBlock(new BoundsInt(0, -map.height, 0, map.width, map.height, 1), written);

                if (map.blocked.Length != 0)
                {
                    if (collisionTile == null)
                    {
                        collisionTile = ScriptableObject.CreateInstance<Tile>();
                        collisionTile.colliderType = Tile.ColliderType.Grid;
                        AssetDatabase.CreateAsset(collisionTile, folder + "/collision-cell.asset");
                    }
                    var node = Node("Blocking cells", root.transform);
                    var collision = node.AddComponent<Tilemap>();
                    var cells = new Vector3Int[map.blocked.Length];
                    var blocking = new TileBase[map.blocked.Length];
                    for (var i = 0; i < cells.Length; i++)
                    {
                        var cell = map.blocked[i];
                        cells[i] = new Vector3Int(cell % map.width, -1 - cell / map.width, 0);
                        blocking[i] = collisionTile;
                    }
                    collision.SetTiles(cells, blocking);
                    node.AddComponent<TilemapCollider2D>();
                }
                if (map.polygons.Length != 0)
                {
                    var group = Node("Collision polygons", root.transform);
                    foreach (var polygon in map.polygons)
                    {
                        var collider = Node(polygon.id, group.transform).AddComponent<PolygonCollider2D>();
                        collider.pathCount = 1;
                        collider.SetPath(0, polygon.points.Select(p => (Vector2)Position(p.x, p.y)).ToArray());
                        if (collider.errorState != ColliderErrorState2D.None)
                            throw new InvalidDataException($"Unity cannot create the collider for polygon {polygon.id}.");
                    }
                }
                if (map.objects.Length != 0)
                {
                    var group = Node("Objects", root.transform);
                    for (var i = 0; i < map.objects.Length; i++)
                    {
                        var placement = map.objects[i];
                        var node = Node($"{placement.name} [{placement.id}]", group.transform).transform;
                        node.localPosition = Position(placement.x, placement.y);
                        BuildObject(node, objects[placement.objectKey], i);
                    }
                }
                if (map.regions.Length != 0)
                {
                    var group = Node("Regions", root.transform);
                    foreach (var region in map.regions)
                    {
                        var node = Node($"{region.kind}: {region.name} [{region.id}]", group.transform);
                        node.transform.localPosition = Position(region.x, region.y);
                        if (region.kind == "trigger")
                        {
                            var trigger = node.AddComponent<BoxCollider2D>();
                            trigger.isTrigger = true;
                            trigger.size = Position(region.width, region.height);
                        }
                    }
                }
                if (map.entrances.Length != 0)
                {
                    var group = Node("Entrances", root.transform);
                    foreach (var entrance in map.entrances)
                    {
                        var node = Node($"{entrance.name} [{entrance.id}]", group.transform);
                        node.transform.localPosition = Position(entrance.x, entrance.y);
                        var angle = entrance.side == "E" ? -90f : entrance.side == "S" ? 180f : entrance.side == "W" ? 90f : 0f;
                        node.transform.localRotation = Quaternion.Euler(0f, 0f, angle);
                    }
                }
                SavePrefab(root, dir + "/map.prefab");
            }
        }
    }
}
`;

export const unityTimedTileSource = String.raw`using System;
using UnityEngine;
using UnityEngine.Tilemaps;

namespace PixelStudio.ExportV1
{
    // Unity's native tile player uses equal time steps. Repeating a sprite at
    // the greatest common divisor of the authored durations retains timing.
    public sealed class PixelStudioTimedTile : Tile
    {
        [Serializable] public struct Frame { public Sprite sprite; [Min(1)] public int durationMs; }
        public Frame[] frames;
        [NonSerialized] private Sprite[] steps;
        [NonSerialized] private int quantumMs;

        private void OnValidate() { steps = null; }

        public override bool GetTileAnimationData(Vector3Int position, ITilemap map, ref TileAnimationData data)
        {
            if (frames == null || frames.Length == 0) return false;
            if (steps == null)
            {
                quantumMs = 0;
                foreach (var frame in frames)
                {
                    if (frame.durationMs <= 0 || frame.sprite == null) return false;
                    var duration = frame.durationMs;
                    while (duration != 0)
                    {
                        var remainder = quantumMs % duration;
                        quantumMs = duration;
                        duration = remainder;
                    }
                }
                long count = 0;
                foreach (var frame in frames) count += frame.durationMs / quantumMs;
                if (count > 8192)
                {
                    Debug.LogError($"Pixel Studio tile {name} exceeds 8192 animation steps.", this);
                    return false;
                }
                steps = new Sprite[(int)count];
                var i = 0;
                foreach (var frame in frames)
                    for (var n = frame.durationMs / quantumMs; n > 0; n--) steps[i++] = frame.sprite;
            }
            data.animatedSprites = steps;
            data.animationSpeed = 1000f / quantumMs;
            data.animationStartTime = 0f;
            return true;
        }
    }
}
`;

export function unityInstructions(bundle: string) {
  return `Pixel Studio — Unity 6 / Unity 6000.0 2D

1. Extract the ZIP. In a Unity 6 2D project, make sure Package Manager has
   2D Sprite (com.unity.2d.sprite) and 2D Tilemap Editor (com.unity.2d.tilemap).
2. Merge the extracted unity/Assets directory into the project's Assets
   directory (not Assets/Assets). Wait for Unity to finish compiling.
3. Select Assets/PixelStudio/Bundles/${bundle}/PixelStudio.job.json in
   the Project window. Choose Assets > Pixel Studio > Import Bundle from the
   main menu or the selected asset's context menu.
4. Open the Generated folder next to the job descriptor. Drag prefabs into a
   scene or inspect/edit their native Unity assets. Slices live in the bundle's
   Textures folder; no manual slicing is needed. Import leaves an existing
   Generated folder alone; move or delete it first if you want to run it again.

All sprites use 32 pixels per world unit with Point filtering and no texture
compression. A pivot outside trimmed art is carried by the prefab's local
sprite offset. Static character views and item forms each have their own
prefab. Animation prefabs start their Animator's clip automatically: sprite
references and positions use stepped keys at the authored millisecond times;
loop and ping-pong repeat, and once holds its last frame. Layers remain
separate (including source alpha). The job and portable manifest retain socket
and event data; audio/VFX events are not connected to gameplay automatically.

Tile assets are reusable in the Tile Palette. Resolved maps use rectangular
Grid/Tilemap prefabs, including intentionally empty or unresolved cells.
Animated tiles need Tilemap Animation Frame Rate = 1 (set on imported maps).
The exporter rejects timings that would exceed 8192 equal steps per tile.
Maps include authored polygon and object colliders, blocking cells (including
solid side-scroller terrain), trigger colliders, spawn/region markers, and
entrance transforms with +Y pointing out. Passage links, region bounds and
side-scroller walking-line metadata are data for the game to interpret;
side-scroller terrain uses full-cell collision. Use the same sorting layer and
order 0 for characters between map object bases and occlusion sprites. This is
static occlusion ordering, not a dynamic depth-sort or autotile system.
In a URP 2D scene using lit sprite materials, add a Global Light 2D if the
scene does not already have one.

Unity docs:
https://docs.unity3d.com/Packages/com.unity.2d.sprite@1.0/manual/DataProvider.html
https://docs.unity3d.com/Packages/com.unity.2d.tilemap@1.0/manual/index.html
https://docs.unity3d.com/6000.0/Documentation/ScriptReference/AnimationUtility.SetObjectReferenceCurve.html

---

1. Extraia o ZIP. Em um projeto Unity 6 2D, instale 2D Sprite e 2D Tilemap Editor
   pelo Package Manager se ainda não estiverem instalados.
2. Mescle unity/Assets com a pasta Assets do projeto. Aguarde a compilação.
3. Selecione Assets/PixelStudio/Bundles/${bundle}/PixelStudio.job.json
   na janela Project e escolha Assets > Pixel Studio > Import Bundle.
4. Abra a pasta Generated ao lado do descritor. Use os prefabs e assets
   editáveis; as texturas já vêm recortadas pelo importador. Para importar de
   novo, primeiro mova ou exclua Generated. Não é necessário recorte manual.
`;
}
