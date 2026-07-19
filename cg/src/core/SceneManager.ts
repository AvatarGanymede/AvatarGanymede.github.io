import {
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  Scene,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Khronos glTF Sample Assets — Sponza（未压缩 glTF，无需 Draco） */
const SPONZA_URL =
  'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/Sponza/glTF/Sponza.gltf';

export interface LoadProgress {
  loaded: number;
  total: number;
  url: string;
}

/**
 * 负责场景内容：基础灯光 + Sponza 加载。
 * Feature 关闭时，仅这些灯光参与 Three.js 默认光照。
 */
export class SceneManager {
  readonly scene = new Scene();
  private basicLights: Array<AmbientLight | HemisphereLight | DirectionalLight> = [];
  private savedIntensities = new Map<object, number>();

  constructor() {
    this.scene.background = new Color(0x87a0b8);
    this.setupBasicLights();
  }

  private setupBasicLights(): void {
    const ambient = new AmbientLight(0xffffff, 0.25);
    const hemi = new HemisphereLight(0xddeeff, 0x334455, 0.55);
    const sun = new DirectionalLight(0xfff2e0, 1.6);
    sun.position.set(8, 18, 4);

    this.basicLights = [ambient, hemi, sun];
    for (const light of this.basicLights) this.scene.add(light);
  }

  /** Forward+ 开启时关闭 Three.js 内置灯光，避免与自定义着色重复 */
  setBasicLightsEnabled(enabled: boolean): void {
    for (const light of this.basicLights) {
      if (enabled) {
        const saved = this.savedIntensities.get(light);
        if (saved != null) light.intensity = saved;
        light.visible = true;
      } else {
        this.savedIntensities.set(light, light.intensity);
        light.intensity = 0;
        light.visible = false;
      }
    }
  }

  async loadSponza(onProgress?: (p: LoadProgress) => void): Promise<void> {
    const loader = new GLTFLoader();

    const gltf = await loader.loadAsync(SPONZA_URL, (event) => {
      onProgress?.({
        loaded: event.loaded,
        total: event.total || event.loaded,
        url: SPONZA_URL,
      });
    });

    const root = gltf.scene;
    root.name = 'Sponza';
    this.scene.add(root);
  }
}
