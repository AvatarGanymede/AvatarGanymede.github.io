import GUI from 'lil-gui';
import type { GraphicsFeature, RenderContext } from './types';

/**
 * 管理所有可开关的图形学 Feature，并驱动 lil-gui。
 * 全部关闭时，平台走默认 Three.js 基础渲染管线。
 */
export class FeatureManager {
  readonly features = new Map<string, GraphicsFeature>();
  private gui: GUI;
  private featuresFolder: GUI;
  private getContext: () => RenderContext;

  constructor(getContext: () => RenderContext) {
    this.getContext = getContext;
    this.gui = new GUI({ title: 'CG Lab' });
    this.featuresFolder = this.gui.addFolder('Features');
    this.featuresFolder.open();
  }

  register(feature: GraphicsFeature): void {
    if (this.features.has(feature.id)) {
      throw new Error(`Feature already registered: ${feature.id}`);
    }
    this.features.set(feature.id, feature);

    const folder = this.featuresFolder.addFolder(feature.name);
    folder
      .add(feature, 'enabled')
      .name('启用')
      .onChange((enabled: boolean) => {
        const ctx = this.getContext();
        if (enabled) feature.onEnable(ctx);
        else feature.onDisable(ctx);
      });

    const record = feature as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!key.startsWith('dbg_')) continue;
      const value = record[key];
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
        const controller = folder.add(record, key);
        controller.name(key.replace(/^dbg_/, ''));
        if (typeof value === 'number' || typeof value === 'string') controller.listen();
      }
    }

    folder.domElement.title = feature.description;
  }

  update(ctx: RenderContext): void {
    for (const feature of this.features.values()) {
      if (feature.enabled) feature.update?.(ctx);
    }
  }

  /** @returns true 表示已有 Feature 接管渲染 */
  render(ctx: RenderContext): boolean {
    let handled = false;
    for (const feature of this.features.values()) {
      if (!feature.enabled || !feature.render) continue;
      if (feature.render(ctx)) handled = true;
    }
    return handled;
  }

  dispose(): void {
    for (const feature of this.features.values()) {
      feature.dispose?.();
    }
    this.gui.destroy();
  }

  getGui(): GUI {
    return this.gui;
  }
}
