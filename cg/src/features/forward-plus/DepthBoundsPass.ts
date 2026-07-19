import {
  DoubleSide,
  HalfFloatType,
  Mesh,
  NearestFilter,
  NoBlending,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type WebGLRenderer,
  type Scene as ThreeScene,
} from 'three';

const depthVertex = /* glsl */ `
varying float vPosDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPosDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const depthFragment = /* glsl */ `
precision highp float;
varying float vPosDepth;
void main() {
  // 正线性深度（米）；仅 GPU 采样，不走 CPU readPixels
  gl_FragColor = vec4(vPosDepth, 0.0, 0.0, 1.0);
}
`;

const reduceVertex = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * 输出 UnsignedByte 可读的 min/max：
 * RG = zMin/far 的 16bit，BA = zMax/far 的 16bit
 * （Three.js readRenderTargetPixels 只支持 UnsignedByteType）
 */
const reduceFragment = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uTileSize;
uniform float uCameraNear;
uniform float uCameraFar;

vec2 pack16(float t) {
  t = clamp(t, 0.0, 1.0);
  float n = floor(t * 65535.0 + 0.5);
  float hi = floor(n / 256.0);
  float lo = mod(n, 256.0);
  return vec2(hi, lo) / 255.0;
}

void main() {
  vec2 tileCoord = floor(gl_FragCoord.xy);
  float zMin = 1.0e20;
  float zMax = 0.0;
  bool any = false;

  for (int y = 0; y < 32; y++) {
    if (float(y) >= uTileSize) break;
    for (int x = 0; x < 32; x++) {
      if (float(x) >= uTileSize) break;
      vec2 pixel = tileCoord * uTileSize + vec2(float(x), float(y)) + 0.5;
      if (pixel.x >= uResolution.x || pixel.y >= uResolution.y) continue;
      float d = texture2D(uDepth, pixel / uResolution).r;
      if (d > 1.0e-4) {
        any = true;
        zMin = min(zMin, d);
        zMax = max(zMax, d);
      }
    }
  }

  if (!any) {
    zMin = uCameraNear;
    zMax = uCameraFar;
  }
  zMax = max(zMax, zMin + 1.0e-3);

  float invFar = 1.0 / max(uCameraFar, 1.0e-3);
  vec2 pMin = pack16(zMin * invFar);
  vec2 pMax = pack16(zMax * invFar);
  gl_FragColor = vec4(pMin, pMax);
}
`;

function unpack16(hi: number, lo: number, far: number): number {
  return ((hi * 256 + lo) / 65535) * far;
}

/**
 * Depth-bounded frustum 数据：
 * 1) HalfFloat 线性深度 Prepass（仅 GPU）
 * 2) 归约到 tile 网格，打包成 RGBA8
 * 3) readPixels(Uint8) → CPU 正线性 [zMin,zMax]
 */
export class DepthBoundsPass {
  tileSize: number;
  private depthRT: WebGLRenderTarget | null = null;
  private minMaxRT: WebGLRenderTarget | null = null;
  private depthMaterial = new ShaderMaterial({
    vertexShader: depthVertex,
    fragmentShader: depthFragment,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
    toneMapped: false,
    blending: NoBlending,
  });
  private reduceMaterial = new ShaderMaterial({
    vertexShader: reduceVertex,
    fragmentShader: reduceFragment,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: NoBlending,
    uniforms: {
      uDepth: { value: null as unknown },
      uResolution: { value: new Vector2(1, 1) },
      uTileSize: { value: 16 },
      uCameraNear: { value: 0.1 },
      uCameraFar: { value: 200 },
    },
  });
  private reduceScene = new Scene();
  private reduceCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private reduceMesh: Mesh;
  private readBuffer = new Uint8Array(0);
  private width = 0;
  private height = 0;
  private tileCountX = 0;
  private tileCountY = 0;

  /** 交错正线性深度 [zMin, zMax, ...] */
  tileMinMax = new Float32Array(0);

  constructor(tileSize = 16) {
    this.tileSize = tileSize;
    const geo = new PlaneGeometry(2, 2);
    this.reduceMesh = new Mesh(geo, this.reduceMaterial);
    this.reduceScene.add(this.reduceMesh);
  }

  ensureSize(width: number, height: number, tileCountX: number, tileCountY: number): void {
    if (
      this.width === width &&
      this.height === height &&
      this.tileCountX === tileCountX &&
      this.tileCountY === tileCountY &&
      this.depthRT &&
      this.minMaxRT
    ) {
      return;
    }

    this.width = width;
    this.height = height;
    this.tileCountX = tileCountX;
    this.tileCountY = tileCountY;

    this.depthRT?.dispose();
    this.minMaxRT?.dispose();

    // 深度 RT：HalfFloat，只给 GPU 采样（不 readPixels）
    this.depthRT = new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.depthRT.texture.colorSpace = NoColorSpace;
    this.depthRT.texture.generateMipmaps = false;

    // min/max RT：必须 UnsignedByte，才能 readRenderTargetPixels
    this.minMaxRT = new WebGLRenderTarget(tileCountX, tileCountY, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.minMaxRT.texture.colorSpace = NoColorSpace;
    this.minMaxRT.texture.generateMipmaps = false;

    this.readBuffer = new Uint8Array(tileCountX * tileCountY * 4);
    this.tileMinMax = new Float32Array(tileCountX * tileCountY * 2);
  }

  render(
    renderer: WebGLRenderer,
    scene: ThreeScene,
    camera: PerspectiveCamera,
    tileSize: number,
    tileCountX: number,
    tileCountY: number,
  ): Float32Array {
    this.tileSize = tileSize;
    const size = new Vector2();
    renderer.getDrawingBufferSize(size);
    this.ensureSize(size.x, size.y, tileCountX, tileCountY);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    renderer.setRenderTarget(this.depthRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.depthMaterial;
    renderer.render(scene, camera);
    scene.overrideMaterial = prevOverride;

    this.reduceMaterial.uniforms.uDepth.value = this.depthRT!.texture;
    this.reduceMaterial.uniforms.uResolution.value.set(size.x, size.y);
    this.reduceMaterial.uniforms.uTileSize.value = tileSize;
    this.reduceMaterial.uniforms.uCameraNear.value = camera.near;
    this.reduceMaterial.uniforms.uCameraFar.value = camera.far;

    renderer.setRenderTarget(this.minMaxRT);
    renderer.clear(true, true, true);
    renderer.render(this.reduceScene, this.reduceCamera);

    renderer.readRenderTargetPixels(
      this.minMaxRT!,
      0,
      0,
      tileCountX,
      tileCountY,
      this.readBuffer,
    );

    const far = camera.far;
    for (let i = 0; i < tileCountX * tileCountY; i++) {
      const o = i * 4;
      let zMin = unpack16(this.readBuffer[o], this.readBuffer[o + 1], far);
      let zMax = unpack16(this.readBuffer[o + 2], this.readBuffer[o + 3], far);
      if (!(zMin > 0) || !(zMax > 0) || !Number.isFinite(zMin) || !Number.isFinite(zMax)) {
        zMin = camera.near;
        zMax = far;
      }
      if (zMax < zMin) {
        const t = zMin;
        zMin = zMax;
        zMax = t;
      }
      this.tileMinMax[i * 2] = zMin;
      this.tileMinMax[i * 2 + 1] = zMax;
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    return this.tileMinMax;
  }

  dispose(): void {
    this.depthRT?.dispose();
    this.minMaxRT?.dispose();
    this.depthMaterial.dispose();
    this.reduceMaterial.dispose();
    (this.reduceMesh.geometry as PlaneGeometry).dispose();
  }
}
