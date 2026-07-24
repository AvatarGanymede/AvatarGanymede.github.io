import {
  Clock,
  MOUSE,
  PerspectiveCamera,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FeatureManager } from './core/FeatureManager';
import { SceneManager } from './core/SceneManager';
import type { RenderContext } from './core/types';
import { ForwardPlusFeature } from './features/forward-plus/ForwardPlusFeature';

const MOVE_SPEED = 8;
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);

export class App {
  private renderer: WebGLRenderer;
  private camera: PerspectiveCamera;
  private controls: OrbitControls;
  private sceneManager = new SceneManager();
  private features!: FeatureManager;
  private clock = new Clock();
  private raf = 0;
  private width = 1;
  private height = 1;
  private latestCtx!: RenderContext;
  private pressedKeys = new Set<string>();
  private readonly moveForward = new Vector3();
  private readonly moveRight = new Vector3();
  private readonly moveOffset = new Vector3();

  private loadingEl: HTMLElement;
  private loadingBar: HTMLElement;
  private hudPipeline: HTMLElement;
  private root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="loading" id="loading">
        <div class="loading-card">
          <h2>CG Lab</h2>
          <p>正在加载 Sponza Atrium…</p>
          <div class="bar"><span id="loading-bar"></span></div>
        </div>
      </div>
      <div class="overlay">
        <div class="hud">
          <h1>图形学学习平台</h1>
          <p id="hud-pipeline">当前：默认基础渲染管线</p>
          <p class="muted">WASD 移动 · 滚轮缩放 · 右键旋转 · 右侧 GUI 开关 Feature</p>
        </div>
      </div>
    `;

    this.loadingEl = this.root.querySelector('#loading')!;
    this.loadingBar = this.root.querySelector('#loading-bar')!;
    this.hudPipeline = this.root.querySelector('#hud-pipeline')!;

    this.renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.classList.add('cg-canvas');
    this.root.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(60, 1, 0.1, 200);
    // Sponza 沿 X 轴展开，站在中庭中央朝 +X 看
    this.camera.position.set(0, 2.5, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(4, 2.5, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 40;
    // 右键旋转、滚轮缩放；平移改由 WASD 负责
    this.controls.enablePan = false;
    this.controls.mouseButtons = {
      LEFT: null as unknown as MOUSE,
      MIDDLE: MOUSE.DOLLY,
      RIGHT: MOUSE.ROTATE,
    };

    this.onResize = this.onResize.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.renderer.domElement.addEventListener('contextmenu', this.onContextMenu);
    this.onResize();

    this.latestCtx = this.makeContext(0);
    this.features = new FeatureManager(() => this.latestCtx);
  }

  async init(): Promise<void> {
    await this.sceneManager.loadSponza((p) => {
      const ratio = p.total > 0 ? p.loaded / p.total : 0;
      this.loadingBar.style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`;
    });

    this.features.register(new ForwardPlusFeature(this.sceneManager));

    const info = this.features.getGui().addFolder('场景');
    info.add({ resetCamera: () => this.resetCamera() }, 'resetCamera').name('重置相机');

    this.loadingEl.classList.add('hidden');
    this.clock.start();
    this.tick();
  }

  private resetCamera(): void {
    this.camera.position.set(0, 2.5, 0);
    this.controls.target.set(4, 2.5, 0);
    this.controls.update();
  }

  private makeContext(time: number): RenderContext {
    return {
      renderer: this.renderer,
      scene: this.sceneManager.scene,
      camera: this.camera,
      width: this.width,
      height: this.height,
      time,
    };
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const delta = this.clock.getDelta();
    const time = this.clock.elapsedTime;
    this.updateMovement(delta);
    this.controls.update();

    this.latestCtx = this.makeContext(time);
    this.features.update(this.latestCtx);

    const handled = this.features.render(this.latestCtx);
    if (!handled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.sceneManager.scene, this.camera);
    }

    this.updateHud();
  };

  /** WASD：沿水平面相对朝向平移相机与 orbit target */
  private updateMovement(delta: number): void {
    if (this.pressedKeys.size === 0) return;

    this.camera.getWorldDirection(this.moveForward);
    this.moveForward.y = 0;
    if (this.moveForward.lengthSq() < 1e-8) {
      this.moveForward.set(0, 0, -1);
    } else {
      this.moveForward.normalize();
    }
    this.moveRight.crossVectors(this.camera.up, this.moveForward).normalize();

    this.moveOffset.set(0, 0, 0);
    if (this.pressedKeys.has('KeyW')) this.moveOffset.add(this.moveForward);
    if (this.pressedKeys.has('KeyS')) this.moveOffset.sub(this.moveForward);
    if (this.pressedKeys.has('KeyD')) this.moveOffset.add(this.moveRight);
    if (this.pressedKeys.has('KeyA')) this.moveOffset.sub(this.moveRight);
    if (this.moveOffset.lengthSq() < 1e-8) return;

    this.moveOffset.normalize().multiplyScalar(MOVE_SPEED * delta);
    this.camera.position.add(this.moveOffset);
    this.controls.target.add(this.moveOffset);
  }

  private updateHud(): void {
    const enabled = [...this.features.features.values()].filter((f) => f.enabled).map((f) => f.name);
    this.hudPipeline.textContent = enabled.length
      ? `当前：${enabled.join(' + ')}`
      : '当前：默认基础渲染管线';
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.isTypingTarget(event.target) || !MOVE_KEYS.has(event.code)) return;
    event.preventDefault();
    this.pressedKeys.add(event.code);
  }

  private onKeyUp(event: KeyboardEvent): void {
    this.pressedKeys.delete(event.code);
  }

  private onContextMenu(event: Event): void {
    event.preventDefault();
  }

  private onResize(): void {
    this.width = this.root.clientWidth || window.innerWidth;
    this.height = this.root.clientHeight || window.innerHeight;
    this.camera.aspect = this.width / Math.max(this.height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.renderer.domElement.removeEventListener('contextmenu', this.onContextMenu);
    this.features.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
