import {
  Color,
  DoubleSide,
  LessEqualDepth,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type Material,
  type Side,
  type Texture,
} from 'three';
import type { GraphicsFeature, RenderContext } from '../../core/types';
import type { SceneManager } from '../../core/SceneManager';
import { DepthBoundsPass } from './DepthBoundsPass';
import { LightCulling, type GpuLight } from './LightCulling';
import { forwardPlusFragmentShader, forwardPlusVertexShader } from './shaders';

interface MaterialBackup {
  mesh: Mesh;
  original: Material | Material[];
}

/**
 * Forward+ Feature
 * 管线：Depth Prepass → Tile min/max → Depth-bounded Culling → Final Shading
 * 对应论文 Harada et al. 2012
 */
export class ForwardPlusFeature implements GraphicsFeature {
  readonly id = 'forward-plus';
  readonly name = 'Forward+';
  readonly description =
    'Depth-bounded Tiled Light Culling + Final Shading。关闭后恢复默认 Three.js 管线。';

  enabled = false;

  dbg_lightCount = 256;
  dbg_tileSize = 16;
  dbg_showHeatmap = false;
  dbg_showLightMarkers = false;
  dbg_animateLights = true;

  private sceneManager: SceneManager;
  private lights: GpuLight[] = [];
  private lightBases: Vector3[] = [];
  private lightMarkers: Object3D | null = null;
  private markerMeshes: Mesh[] = [];
  private culling: LightCulling;
  private depthBounds: DepthBoundsPass;
  private backups: MaterialBackup[] = [];
  private fpMaterials = new Map<Mesh, ShaderMaterial>();
  private resolution = new Vector2();
  private markerGeo = new SphereGeometry(0.08, 6, 6);
  private readonly heatmapScale = 32;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.culling = new LightCulling(this.dbg_tileSize, 128);
    this.depthBounds = new DepthBoundsPass(this.dbg_tileSize);
  }

  onEnable(ctx: RenderContext): void {
    this.ensureLights();
    this.sceneManager.setBasicLightsEnabled(false);
    this.patchMaterials();
    this.rebuildLightMarkers();
    this.culling.tileSize = this.dbg_tileSize;
    this.culling.maxTextureSize = ctx.renderer.capabilities.maxTextureSize;
    ctx.renderer.getDrawingBufferSize(this.resolution);
    this.culling.resize(this.resolution.x, this.resolution.y);
  }

  onDisable(_ctx: RenderContext): void {
    this.restoreMaterials();
    this.sceneManager.setBasicLightsEnabled(true);
    if (this.lightMarkers) this.lightMarkers.visible = false;
  }

  update(ctx: RenderContext): void {
    if (!this.enabled) return;

    if (this.lights.length !== this.dbg_lightCount) {
      this.rebuildLights();
      this.rebuildLightMarkers();
    }

    if (this.culling.tileSize !== this.dbg_tileSize) {
      this.culling.tileSize = this.dbg_tileSize;
      ctx.renderer.getDrawingBufferSize(this.resolution);
      this.culling.resize(this.resolution.x, this.resolution.y);
    }

    if (this.dbg_animateLights) this.animateLights(ctx.time);

    if (this.lightMarkers) {
      this.lightMarkers.visible = this.dbg_showLightMarkers;
      if (this.dbg_showLightMarkers) this.syncMarkerPositions();
    } else if (this.dbg_showLightMarkers) {
      this.rebuildLightMarkers();
    }
  }

  render(ctx: RenderContext): boolean {
    const { renderer, scene, camera } = ctx;
    const persp = camera as PerspectiveCamera;
    renderer.getDrawingBufferSize(this.resolution);
    const width = this.resolution.x;
    const height = this.resolution.y;

    const prevAutoClear = renderer.autoClear;
    const prevMarkerVisible = this.lightMarkers?.visible ?? false;
    if (this.lightMarkers) this.lightMarkers.visible = false;

    renderer.autoClear = false;

    const bg = scene.background;
    if (bg && (bg as Color).isColor) {
      renderer.setClearColor(bg as Color, 1);
    }

    // 确保 tile 网格已知（DepthBounds 归约需要）
    this.culling.maxTextureSize = renderer.capabilities.maxTextureSize;
    const wantX = Math.max(1, Math.ceil(width / this.culling.tileSize));
    const wantY = Math.max(1, Math.ceil(height / this.culling.tileSize));
    if (wantX !== this.culling.tileCountX || wantY !== this.culling.tileCountY) {
      this.culling.resize(width, height);
    }
    this.dbg_tileSize = this.culling.tileSize;

    let tileMinMax: Float32Array | null = null;
    // Depth Prepass + tile min/max（始终开启，depth-bounded frustum）
    tileMinMax = this.depthBounds.render(
      renderer,
      scene,
      persp,
      this.culling.tileSize,
      this.culling.tileCountX,
      this.culling.tileCountY,
    );

    // Light Culling：depth-bounded 球-深度粗剔 + 屏幕圆×AABB
    this.culling.cull(this.lights, persp, width, height, tileMinMax);
    this.updateMaterialUniforms(ctx);

    // Final Shading（屏幕；深度重新写入，不依赖 prepass 的 color RT）
    renderer.setRenderTarget(null);
    renderer.clear(true, true, true);
    renderer.state.buffers.depth.setFunc(LessEqualDepth);
    renderer.state.buffers.depth.setMask(true);
    if (this.lightMarkers) this.lightMarkers.visible = prevMarkerVisible;
    renderer.render(scene, camera);

    renderer.autoClear = prevAutoClear;
    return true;
  }

  dispose(): void {
    this.restoreMaterials();
    this.culling.dispose();
    this.depthBounds.dispose();
    this.markerGeo.dispose();
    this.clearMarkers();
  }

  private ensureLights(): void {
    if (this.lights.length !== this.dbg_lightCount) this.rebuildLights();
  }

  private rebuildLights(): void {
    const count = Math.max(1, Math.min(1024, this.dbg_lightCount | 0));
    this.dbg_lightCount = count;
    this.lights = [];
    this.lightBases = [];

    for (let i = 0; i < count; i++) {
      const t = i / count;
      const color = new Color().setHSL((t * 3.7) % 1, 0.75, 0.55);
      const base = new Vector3(
        (Math.random() - 0.5) * 20,
        1.2 + Math.random() * 6,
        (Math.random() - 0.5) * 10,
      );
      this.lightBases.push(base);
      this.lights.push({
        position: base.clone(),
        color: { r: color.r, g: color.g, b: color.b },
        intensity: 2.5 + Math.random() * 3.5,
        radius: 1.6 + Math.random() * 1.8,
      });
    }
  }

  private animateLights(time: number): void {
    for (let i = 0; i < this.lights.length; i++) {
      const L = this.lights[i];
      const base = this.lightBases[i];
      const phase = i * 0.37;
      L.position.set(
        base.x + Math.sin(time * 0.7 + phase) * 0.35,
        base.y + Math.cos(time * 0.55 + phase) * 0.25,
        base.z + Math.sin(time * 0.4 + phase * 1.3) * 0.35,
      );
    }
  }

  private clearMarkers(): void {
    if (!this.lightMarkers) return;
    this.sceneManager.scene.remove(this.lightMarkers);
    for (const m of this.markerMeshes) {
      (m.material as MeshBasicMaterial).dispose();
    }
    this.markerMeshes = [];
    this.lightMarkers = null;
  }

  private rebuildLightMarkers(): void {
    this.clearMarkers();
    const group = new Object3D();
    group.name = 'ForwardPlusLightMarkers';
    group.visible = this.dbg_showLightMarkers;

    const step = Math.max(1, Math.ceil(this.lights.length / 128));
    for (let i = 0; i < this.lights.length; i += step) {
      const L = this.lights[i];
      const mat = new MeshBasicMaterial({
        color: new Color(L.color.r, L.color.g, L.color.b),
      });
      const mesh = new Mesh(this.markerGeo, mat);
      mesh.position.copy(L.position);
      mesh.userData.lightIndex = i;
      group.add(mesh);
      this.markerMeshes.push(mesh);
    }

    this.lightMarkers = group;
    this.sceneManager.scene.add(group);
  }

  private syncMarkerPositions(): void {
    for (const mesh of this.markerMeshes) {
      const idx = mesh.userData.lightIndex as number;
      mesh.position.copy(this.lights[idx].position);
    }
  }

  private patchMaterials(): void {
    this.restoreMaterials();

    this.sceneManager.scene.traverse((obj) => {
      if (!(obj as Mesh).isMesh) return;
      const mesh = obj as Mesh;
      if (mesh.parent?.name === 'ForwardPlusLightMarkers') return;

      this.backups.push({ mesh, original: mesh.material });
      const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const fp = this.createFpMaterial(src);
      this.fpMaterials.set(mesh, fp);
      mesh.material = fp;
    });
  }

  private createFpMaterial(src: Material): ShaderMaterial {
    let map: Texture | null = null;
    let color = new Color(0xffffff);
    let metalness = 0.0;
    let roughness = 0.7;
    let side: Side = DoubleSide;

    if ((src as MeshStandardMaterial).isMeshStandardMaterial) {
      const std = src as MeshStandardMaterial;
      map = std.map;
      color = std.color.clone();
      metalness = std.metalness;
      roughness = std.roughness;
      side = std.side;
    } else if ('color' in src && (src as { color?: Color }).color) {
      color = (src as { color: Color }).color.clone();
      if ('side' in src) side = (src as { side: Side }).side;
    }

    return new ShaderMaterial({
      vertexShader: forwardPlusVertexShader,
      fragmentShader: forwardPlusFragmentShader,
      side,
      uniforms: {
        uColor: { value: color },
        uMap: { value: map },
        uHasMap: { value: map ? 1 : 0 },
        uMetalness: { value: metalness },
        uRoughness: { value: roughness },
        uLights: { value: null },
        uTileCounts: { value: null },
        uTileIndices: { value: null },
        uTileCount: { value: new Vector2(1, 1) },
        uTileSize: { value: this.dbg_tileSize },
        uMaxLightsPerTile: { value: this.culling.maxLightsPerTile },
        uLightCount: { value: 1 },
        uCameraPos: { value: new Vector3() },
        uShowHeatmap: { value: 0 },
        uHeatmapScale: { value: this.heatmapScale },
      },
    });
  }

  private updateMaterialUniforms(ctx: RenderContext): void {
    const camPos = ctx.camera.position;
    for (const mat of this.fpMaterials.values()) {
      mat.uniforms.uLights.value = this.culling.lightsTexture;
      mat.uniforms.uTileCounts.value = this.culling.countsTexture;
      mat.uniforms.uTileIndices.value = this.culling.indicesTexture;
      mat.uniforms.uTileCount.value.set(this.culling.tileCountX, this.culling.tileCountY);
      mat.uniforms.uTileSize.value = this.culling.tileSize;
      mat.uniforms.uMaxLightsPerTile.value = this.culling.maxLightsPerTile;
      mat.uniforms.uLightCount.value = Math.max(1, this.lights.length);
      mat.uniforms.uCameraPos.value.copy(camPos);
      mat.uniforms.uShowHeatmap.value = this.dbg_showHeatmap ? 1 : 0;
      mat.uniforms.uHeatmapScale.value = this.heatmapScale;
    }
  }

  private restoreMaterials(): void {
    for (const { mesh, original } of this.backups) {
      mesh.material = original;
    }
    for (const mat of this.fpMaterials.values()) mat.dispose();
    this.fpMaterials.clear();
    this.backups = [];
  }
}
