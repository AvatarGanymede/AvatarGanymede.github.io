import type { Camera, Scene, WebGLRenderer } from 'three';

/** 每帧渲染上下文，Feature 通过它访问场景与渲染器 */
export interface RenderContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  width: number;
  height: number;
  time: number;
}

/**
 * 图形学 Feature 插件接口。
 * 全部关闭时走默认 Three.js 基础渲染管线。
 */
export interface GraphicsFeature {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  enabled: boolean;

  onEnable(ctx: RenderContext): void;
  onDisable(ctx: RenderContext): void;
  update?(ctx: RenderContext): void;

  /**
   * 若返回 true，表示本 Feature 已接管本帧渲染，平台不再调用默认 render。
   */
  render?(ctx: RenderContext): boolean;

  dispose?(): void;
}
