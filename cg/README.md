# CG Lab · 图形学学习平台

基于 Three.js 的图形学 Feature 实验平台，默认使用经典 **Sponza Atrium** 场景。

线上地址（博客子路径，无主页导航入口）：

https://avatarganymede.github.io/cg/

## 本地开发

```bash
cd cg
npm install
npm run dev
```

## 发布到 GitHub Pages

```bash
cd cg
npm run build   # 生成 dist/，并同步为 cg/index.html + cg/assets/
```

然后在仓库根目录提交并推送 `cg/index.html`、`cg/assets/` 等产物即可。

Vite `base` 为 `/cg/`；Jekyll 会排除 `cg/src`、`cg/node_modules` 等源码与依赖，只发布静态产物。

右侧 GUI：

- **Features / Forward+**：开关 Forward+ 管线
- 未开启任何 Feature 时，走 Three.js 默认基础渲染（环境光 + 半球光 + 平行光）

## Forward+

实现论文 [Forward+: Bringing Deferred Lighting to the Next Level](https://takahiroharada.wordpress.com/wp-content/uploads/2015/04/forward_plus.pdf) 的 tiled light culling：

1. **Depth Prepass** — 写入正线性深度（`-viewZ`）
2. **Tile min/max** — GPU 归约得到每 tile 的 `[zmin, zmax]`（depth-bounded，始终开启）
3. **Tiled Light Culling** — 屏幕空间 **圆 vs tile AABB**（对齐 three.js TiledLightsNode）；近光优先填列表
4. **Final Shading** — 每像素只遍历本 tile 灯光列表

调试选项：灯光数量、tile 大小、热力图、灯光标记、动画。Depth-bounded frustum 默认始终开启。

## 扩展新 Feature

实现 `GraphicsFeature` 接口并在 `App.init` 中 `features.register(...)` 即可，GUI 会自动生成开关。
