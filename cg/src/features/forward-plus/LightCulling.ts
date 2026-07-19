import {
  DataTexture,
  FloatType,
  Matrix4,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  Vector4,
  type PerspectiveCamera,
  type Vector3,
} from 'three';

export interface GpuLight {
  position: Vector3;
  color: { r: number; g: number; b: number };
  intensity: number;
  radius: number;
}

/**
 * Forward+ Light Culling
 *
 * 对齐 three.js 官方 TiledLightsNode（WebGPU）：
 * https://github.com/mrdoob/three.js/blob/dev/examples/jsm/tsl/lighting/TiledLightsNode.js
 *
 * 核心做法（官方用来避免「方形黑块」）：
 * 1. 灯光投影到屏幕 → 圆 vs tile AABB（circleIntersectsAABB），保守、少误剔
 * 2. 不依赖易出错的 6 平面 frustum（误剔会直接变成 tile 级暗块）
 * 3. 按与相机距离从近到远填列表：tile 溢出时保留更重要的近光
 * 4. depthBounds 仅作可选的深度区间粗剔（球 vs [zMin,zMax]），默认仍保守
 */
export class LightCulling {
  tileSize: number;
  maxLightsPerTile: number;
  maxTextureSize = 8192;

  tileCountX = 0;
  tileCountY = 0;

  counts: Float32Array = new Float32Array(0);
  indices: Float32Array = new Float32Array(0);

  countsTexture: DataTexture | null = null;
  indicesTexture: DataTexture | null = null;
  lightsTexture: DataTexture | null = null;

  private lightData = new Float32Array(0);
  private readonly viewMatrix = new Matrix4();
  private readonly lightView = new Vector4();
  /** 按 view-depth 排序后的灯光下标 */
  private order: number[] = [];
  private viewDepth: Float32Array = new Float32Array(0);

  constructor(tileSize = 16, maxLightsPerTile = 128) {
    this.tileSize = tileSize;
    this.maxLightsPerTile = maxLightsPerTile;
  }

  resize(width: number, height: number): void {
    let size = this.tileSize;
    let tx = Math.max(1, Math.ceil(width / size));
    let ty = Math.max(1, Math.ceil(height / size));
    while (tx * ty > this.maxTextureSize - 4 && size < 256) {
      size *= 2;
      tx = Math.max(1, Math.ceil(width / size));
      ty = Math.max(1, Math.ceil(height / size));
    }
    this.tileSize = size;
    this.tileCountX = tx;
    this.tileCountY = ty;

    const tiles = tx * ty;
    this.counts = new Float32Array(tiles * 4);
    this.indices = new Float32Array(tiles * this.maxLightsPerTile * 4);
    this.rebuildIndexTextures();
  }

  private rebuildIndexTextures(): void {
    this.countsTexture?.dispose();
    this.indicesTexture?.dispose();
    const tiles = this.tileCountX * this.tileCountY;

    this.countsTexture = new DataTexture(
      this.counts,
      this.tileCountX,
      this.tileCountY,
      RGBAFormat,
      FloatType,
    );
    this.countsTexture.magFilter = NearestFilter;
    this.countsTexture.minFilter = NearestFilter;
    this.countsTexture.colorSpace = NoColorSpace;
    this.countsTexture.flipY = false;
    this.countsTexture.needsUpdate = true;

    this.indicesTexture = new DataTexture(
      this.indices,
      this.maxLightsPerTile,
      tiles,
      RGBAFormat,
      FloatType,
    );
    this.indicesTexture.magFilter = NearestFilter;
    this.indicesTexture.minFilter = NearestFilter;
    this.indicesTexture.colorSpace = NoColorSpace;
    this.indicesTexture.flipY = false;
    this.indicesTexture.needsUpdate = true;
  }

  uploadLights(lights: GpuLight[]): void {
    const count = Math.max(1, lights.length);
    const need = count * 2 * 4;
    if (this.lightData.length !== need) {
      this.lightData = new Float32Array(need);
      this.lightsTexture?.dispose();
      this.lightsTexture = new DataTexture(this.lightData, 2, count, RGBAFormat, FloatType);
      this.lightsTexture.magFilter = NearestFilter;
      this.lightsTexture.minFilter = NearestFilter;
      this.lightsTexture.colorSpace = NoColorSpace;
      this.lightsTexture.flipY = false;
    } else if (this.lightsTexture && this.lightsTexture.image.height !== count) {
      this.lightsTexture.image.height = count;
    }

    for (let i = 0; i < lights.length; i++) {
      const L = lights[i];
      const o = i * 8;
      this.lightData[o] = L.position.x;
      this.lightData[o + 1] = L.position.y;
      this.lightData[o + 2] = L.position.z;
      this.lightData[o + 3] = L.radius;
      this.lightData[o + 4] = L.color.r * L.intensity;
      this.lightData[o + 5] = L.color.g * L.intensity;
      this.lightData[o + 6] = L.color.b * L.intensity;
      this.lightData[o + 7] = 1;
    }
    if (this.lightsTexture) this.lightsTexture.needsUpdate = true;
  }

  /**
   * @param tilePosDepthMinMax 可选正线性 [zMin,zMax,...]；仅做球-深度区间粗剔
   */
  cull(
    lights: GpuLight[],
    camera: PerspectiveCamera,
    width: number,
    height: number,
    tilePosDepthMinMax?: Float32Array | null,
  ): void {
    const wantX = Math.max(1, Math.ceil(width / this.tileSize));
    const wantY = Math.max(1, Math.ceil(height / this.tileSize));
    if (wantX !== this.tileCountX || wantY !== this.tileCountY) {
      this.resize(width, height);
    }

    this.counts.fill(0);
    this.viewMatrix.copy(camera.matrixWorldInverse);

    const viewNear = -camera.near;
    const viewFar = -camera.far;
    const useDepthBounds =
      !!tilePosDepthMinMax && tilePosDepthMinMax.length >= this.tileCountX * this.tileCountY * 2;

    const n = lights.length;
    if (this.order.length !== n) {
      this.order = new Array(n);
      this.viewDepth = new Float32Array(n);
    }

    // 预计算 view 位置，并按距相机从近到远排序（溢出时优先近光）
    for (let i = 0; i < n; i++) {
      this.order[i] = i;
      this.lightView
        .set(lights[i].position.x, lights[i].position.y, lights[i].position.z, 1)
        .applyMatrix4(this.viewMatrix);
      this.viewDepth[i] = -this.lightView.z; // 正深度，越小越近
    }
    this.order.sort((a, b) => this.viewDepth[a] - this.viewDepth[b]);

    const fovRad = (camera.fov * Math.PI) / 180;
    const projScaleY = height / (2 * Math.tan(fovRad * 0.5));
    const P = camera.projectionMatrix.elements;

    for (let oi = 0; oi < n; oi++) {
      const li = this.order[oi];
      const light = lights[li];
      this.lightView
        .set(light.position.x, light.position.y, light.position.z, 1)
        .applyMatrix4(this.viewMatrix);

      const lx = this.lightView.x;
      const ly = this.lightView.y;
      const lz = this.lightView.z;
      const radius = light.radius;

      // 在相机 frustum 外
      if (lz > viewNear + radius) continue;
      if (lz < viewFar - radius) continue;

      const depth = Math.max(-lz, camera.near);

      // view → clip → 屏幕像素（WebGL：y=0 在底，与 gl_FragCoord 一致；官方 WebGPU 另有 flipY）
      const clipX = P[0] * lx + P[8] * lz;
      const clipY = P[5] * ly + P[9] * lz;
      const clipW = P[11] * lz + P[15];
      if (clipW <= 1e-5) continue;

      const ndcX = clipX / clipW;
      const ndcY = clipY / clipW;
      const cx = (ndcX * 0.5 + 0.5) * width;
      const cy = (ndcY * 0.5 + 0.5) * height;

      // 屏幕空间半径（像素）+ 半个 tile 的保守 padding，避免边界误剔
      const pixelRadius = (radius * projScaleY) / depth + this.tileSize * 0.5;

      const tx0 = Math.max(0, Math.floor((cx - pixelRadius) / this.tileSize));
      const tx1 = Math.min(this.tileCountX - 1, Math.floor((cx + pixelRadius) / this.tileSize));
      const ty0 = Math.max(0, Math.floor((cy - pixelRadius) / this.tileSize));
      const ty1 = Math.min(this.tileCountY - 1, Math.floor((cy + pixelRadius) / this.tileSize));
      if (tx1 < tx0 || ty1 < ty0) continue;

      const lightPosDepth = -lz;

      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const tileIndex = ty * this.tileCountX + tx;
          const count = this.counts[tileIndex * 4];
          if (count >= this.maxLightsPerTile) continue;

          // 精确：圆 vs tile AABB（同 three.js circleIntersectsAABB）
          const tileMinX = tx * this.tileSize;
          const tileMinY = ty * this.tileSize;
          const tileMaxX = Math.min(width, tileMinX + this.tileSize);
          const tileMaxY = Math.min(height, tileMinY + this.tileSize);
          if (!circleIntersectsAABB(cx, cy, pixelRadius, tileMinX, tileMinY, tileMaxX, tileMaxY)) {
            continue;
          }

          // 可选 depth bounds：球完全落在 [zMin,zMax] 外才剔
          if (useDepthBounds) {
            const zMin = tilePosDepthMinMax![tileIndex * 2];
            const zMax = tilePosDepthMinMax![tileIndex * 2 + 1];
            if (lightPosDepth + radius < zMin || lightPosDepth - radius > zMax) {
              continue;
            }
          }

          this.indices[(tileIndex * this.maxLightsPerTile + (count | 0)) * 4] = li;
          this.counts[tileIndex * 4] = count + 1;
        }
      }
    }

    if (this.countsTexture) this.countsTexture.needsUpdate = true;
    if (this.indicesTexture) this.indicesTexture.needsUpdate = true;
    this.uploadLights(lights);
  }

  dispose(): void {
    this.countsTexture?.dispose();
    this.indicesTexture?.dispose();
    this.lightsTexture?.dispose();
    this.countsTexture = null;
    this.indicesTexture = null;
    this.lightsTexture = null;
  }
}

/** three.js TiledLightsNode.circleIntersectsAABB */
function circleIntersectsAABB(
  cx: number,
  cy: number,
  radius: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const closestX = Math.max(minX, Math.min(cx, maxX));
  const closestY = Math.max(minY, Math.min(cy, maxY));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= radius * radius;
}
