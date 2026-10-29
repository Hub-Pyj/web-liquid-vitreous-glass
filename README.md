# Web Liquid Vitreous Glass
## 若此版本不可用请退回至1.4.0 当前版本1.5.0
液态玻璃JavaScript库：单文件、零依赖、无需构建，真实地**弯折**元素背后的内容，而不是只做一层模糊。

MIT License · v1.5.0

```
web-liquid-vitreous-glass/
├── vitreous.js   # 库本体（一个文件，约 23KB 未压缩）
├── demo.html     # 演示页：可拖动悬浮窗 + 参数面板
├── README.md
└── LICENSE
```

---

## 1. 它做了什么

大多数「玻璃拟态」只是 `backdrop-filter: blur()` —— 背景被模糊掉，但几何上是平的，看不出玻璃的厚度和边缘。真正的液态玻璃需要**边缘把背后的画面折射进来**：靠近边框的像素应该看到比它更靠外的内容，于是边框看起来像一圈透镜。

Vitreous 的做法：

1. 把元素看成一枚圆角矩形透镜。
2. 对元素内每个像素计算它到边界的**有符号距离**，负值表示在内侧。
3. 用自有剖面函数把「离边界多深」换算成「往哪个方向拉多少像素」：

   ```
   t  = depth / edge
   p(t) = (1 - t)^(1 + curve)  -  lobe * sin(π t)
   ```

   第一项让边缘处拉扯最强、向内快速衰减；第二项是可选的**内层反向回流**，它让玻璃边缘出现一圈反向的微凸，也就是「旋涡」感的来源。`curve` 控制衰减陡峭程度，`lobe` 控制回流强度。

4. 把二维位移向量编码进 PNG 的 R/G 通道（128 = 不偏移），用 `feImage` 拉伸到元素实际尺寸，再交给 `feDisplacementMap` 去弯折 `SourceGraphic`（对 `backdrop-filter` 来说，那就是元素背后的画面）。
5. 色散由三遍位移完成：R、G、B 各用略微不同的位移强度跑一次，再从每遍里各取一个通道叠加，于是边缘自然出现红蓝色边——和真实玻璃的色散一致。

位移贴图按尺寸分桶缓存，同一尺寸的玻璃只算一次。

---

## 2. 快速开始

```html
<script src="./vitreous.js"></script>

<style>
  .glass {
    border-radius: 22px;
    background: rgba(255,255,255,.1);   /* 库会接管底色，这行只是兜底 */
  }
</style>

<div class="glass" data-vitreous>玻璃</div>

<script>
  Vitreous.scan();                       // 处理所有 [data-vitreous]
</script>
```

或者用自定义元素：

```html
<script src="./vitreous.js"></script>
<script>Vitreous.define();</script>

<web-liquid-vitreous-glass edge="30" bend="18" lobe="0.25" chroma="1.4"
                style="width:300px;height:160px;border-radius:24px">
  内容
</web-liquid-vitreous-glass>
```

或者用 JS：

```js
const ctrl = Vitreous.apply(el, { bend: 20, chroma: 1.6 });
ctrl.update({ frost: 6 });   // 增量更新
ctrl.destroy();
```

---

## 3. 注入到已有项目

这一章是「怎么把它塞进你自己的页面」。前面第 2 章是最短路径，这里按真实项目的三种需求展开：**悬浮窗控件**、**按钮**、**两者共用同一套参数**。

先说清楚一个前提：库本身只负责「让一个已存在的元素变成液态玻璃」，它不会替你创建 DOM、不会管拖动、也不会管点击动画。所以下面每一节都是 **HTML 结构 + CSS 外观 + 一行 apply**，拖动和点击动效是附带的十几行 JS，可以直接抄。

### 3.1 引入文件

**方式一：script 标签（最省事，推荐）**

```html
<script src="./vitreous.js"></script>
<script>
  // 此时 window.Vitreous 已可用
  Vitreous.scan();
</script>
```

库是 UMD 风格，加载后挂在 `window.Vitreous` 上。没有依赖，不需要构建。

**方式二：按需异步加载（只在某些页面用）**

```js
function loadVitreous() {
  if (window.Vitreous) return Promise.resolve(window.Vitreous);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/assets/vitreous.js';
    s.onload = () => resolve(window.Vitreous);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

loadVitreous().then(Vitreous => {
  Vitreous.apply(document.querySelector('.vg-panel'), { bend: 20 });
});
```

**方式三：打包器（Vite / webpack / Rollup）**

UMD 文件用副作用导入，取全局变量即可：

```js
import './vendor/vitreous.js';
const Vitreous = window.Vitreous;

Vitreous.apply(el, { bend: 20 });
```

如果项目开启了严格的 CSP，注意库会在运行时向 `<head>` 注入一小段 `<style>`（用来放 `[data-vitreous]` 的边光规则），以及一个 SVG `<defs>`。若不允许内联样式，改用 `Vitreous.force(false)` 关闭折射、只保留 CSS 降级外观，或把这部分样式自行内联到你的样式表里。

### 3.2 注入悬浮窗控件

**第一步：HTML。** 一个普通 `div` 就够，不需要特殊标签：

```html
<div class="vg-panel" id="panel">
  <h3>Web Liquid Vitreous Glass</h3>
  <p>按住任意处拖动</p>
</div>
```

**第二步：CSS。** 圆角**必须写在 CSS 上**——库是从 `getComputedStyle(el)` 读 `border-radius` 来生成距离场的，不是从 JS 参数里读。底色写一层半透明白作为兜底，滤镜不可用时也不会变成透明块：

```css
.vg-panel {
  position: fixed;
  left: 24px;
  top: 80px;
  width: 320px;
  padding: 18px 20px;
  box-sizing: border-box;

  border-radius: 24px;              /* 关键：库从这里读半径 */
  background: rgba(255, 255, 255, .10);

  /* 边光 + 投影，这几层是「像玻璃」的关键，别省 */
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .16),
    inset 0 -1px 0 rgba(255, 255, 255, .16),
    inset 0 0 0 1px rgba(255, 255, 255, .32),
    0 22px 55px rgba(0, 0, 0, .45);

  color: #fff;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.vg-panel.is-dragging { cursor: grabbing; }
```

**第三步：JS。** 一行上玻璃：

```js
const panel = document.querySelector('#panel');

const ctrl = Vitreous.apply(panel, {
  edge: 28,                        // 折射带宽度
  bend: 20,                        // 弯折强度
  chroma: 1.0,                     // 色散
  lobe: 0.65,                      // 旋涡回流
  frost: 12,                       // 中间区域磨砂
  tint: 'rgba(255,255,255,.10)'    // 底色，要跟 CSS 的 background 一致
});
```

**第四步：拖动（库不管，自己接）。** 要点是把移动监听挂在 `window` 上而不是元素上，否则指针一离开卡片就丢事件：

```js
let drag = null;

panel.addEventListener('pointerdown', e => {
  // 不要抢走内部控件（滑杆、按钮、链接）的点击
  if (e.target.closest('input, button, a, select, textarea')) return;

  const r = panel.getBoundingClientRect();
  drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
  panel.setPointerCapture(e.pointerId);
  panel.classList.add('is-dragging');
});

window.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  panel.style.left = (e.clientX - drag.dx) + 'px';
  panel.style.top = (e.clientY - drag.dy) + 'px';
});

window.addEventListener('pointerup', e => {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  panel.classList.remove('is-dragging');
});
```

拖动只改位置，**不需要**重建位移贴图。只有**尺寸变了**才需要 `ctrl.refresh()`：

```js
new ResizeObserver(() => ctrl.refresh()).observe(panel);
```

### 3.3 注入玻璃按钮

按钮和悬浮窗走的是同一套机制，区别只在两处：**圆角是胶囊形**，以及**尺寸小**（这会引出 3.5 的坑）。

**第一步：HTML。** 用真正的 `<button>`，别用 `div`——这样键盘、表单、无障碍都是原生行为。内层 `span` 是为了让水波被裁切、文字浮在最上面：

```html
<button class="vg-chip" type="button">
  <span class="vg-chip__ink"></span>
  <span class="vg-chip__label">Subscribe</span>
</button>
```

**第二步：CSS。** 胶囊圆角写 `999px` 即可，库会把每个角钳制到 `min(w, h) / 2`，所以写多大都安全。另外 `button` 的默认外观必须清掉：

```css
.vg-chip {
  -webkit-appearance: none;
  appearance: none;
  border: 0;                        /* 清掉原生边框 */
  padding: 13px 26px;
  border-radius: 999px;             /* 胶囊，库会自动钳到短边一半 */

  color: #fff;
  font: 500 13.5px/1 system-ui, -apple-system, sans-serif;
  background: rgba(255, 255, 255, .13);

  position: relative;
  isolation: isolate;               /* 让内层 z-index:-1 的模糊层留在按钮内部 */
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;

  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .18),
    inset 0 -1px 0 rgba(255, 255, 255, .18),
    inset 0 0 0 1px rgba(255, 255, 255, .36),
    0 16px 36px rgba(0, 0, 0, .38);

  text-shadow: 0 1px 3px rgba(0, 0, 0, .55);

  /* 回弹曲线：按下快、回弹带一点过冲 */
  transition:
    transform .26s cubic-bezier(.34, 1.56, .64, 1),
    box-shadow .26s ease;
}

.vg-chip:hover { transform: scale(1.035); }
.vg-chip:active,
.vg-chip.is-press { transform: scale(.955); }
```

**第三步：上玻璃。** 小控件要把 `edge` 调小，原因见 3.5：

```js
const chip = document.querySelector('.vg-chip');

Vitreous.apply(chip, {
  edge: 14,          // 按钮高度只有 45px 左右，折射带别开太大
  bend: 12,
  chroma: 1.0,
  lobe: 0.6,
  tint: 'rgba(255,255,255,.13)',
  sheen: 0.7         // 鼠标跟随高光，可关掉
});
```

**第四步：点击动效（库不管，自己接）。** 这套是纯 CSS 动画 + 十几行 JS，直接抄：

```css
/* 内层墨水池：只裁水波，不影响向外扩散的光晕 */
.vg-chip__ink {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: none;
}

/* 水波：从落点扩散 */
.vg-chip__ripple {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(circle,
    rgba(255,255,255,.85),
    rgba(255,255,255,.25) 45%,
    rgba(255,255,255,0) 72%);
  transform: translate(-50%, -50%) scale(0);
  animation: vgRipple .62s cubic-bezier(.22, .61, .36, 1) forwards;
}
@keyframes vgRipple {
  0%   { transform: translate(-50%, -50%) scale(0); opacity: .95; }
  70%  { opacity: .45; }
  100% { transform: translate(-50%, -50%) scale(1); opacity: 0; }
}

/* 外圈脉冲：一圈光晕向外散开 */
.vg-chip__pulse {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  box-shadow: 0 0 0 0 rgba(255,255,255,.55);
  animation: vgPulse .6s ease-out forwards;
}
@keyframes vgPulse {
  0%   { box-shadow: 0 0 0 0 rgba(255,255,255,.5); }
  100% { box-shadow: 0 0 0 14px rgba(255,255,255,0); }
}

.vg-chip__label { position: relative; z-index: 2; }

@media (prefers-reduced-motion: reduce) {
  .vg-chip,
  .vg-chip__ripple,
  .vg-chip__pulse { animation: none !important; transition: none !important; }
}
```

```js
function burst(chip, x, y) {
  const ink = chip.querySelector('.vg-chip__ink');
  const d = Math.max(chip.offsetWidth, chip.offsetHeight) * 2.2;

  const rp = document.createElement('span');
  rp.className = 'vg-chip__ripple';
  rp.style.cssText = `width:${d}px;height:${d}px;left:${x}px;top:${y}px`;
  ink.appendChild(rp);
  rp.addEventListener('animationend', () => rp.remove());

  const pl = document.createElement('span');
  pl.className = 'vg-chip__pulse';
  chip.appendChild(pl);
  pl.addEventListener('animationend', () => pl.remove());

  chip.classList.add('is-press');
  setTimeout(() => chip.classList.remove('is-press'), 190);
}

document.querySelectorAll('.vg-chip').forEach(chip => {
  chip.addEventListener('pointerdown', e => {
    const r = chip.getBoundingClientRect();
    burst(chip, e.clientX - r.left, e.clientY - r.top);
  });
  // 键盘等价：Enter / 空格
  chip.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      burst(chip, chip.offsetWidth / 2, chip.offsetHeight / 2);
    }
  });
});
```

> 如果你只想要「按下挤压」而不要水波，把 `press` 参数打开就行，库自带：`Vitreous.apply(chip, { press: 1 })`。它会按点击位置设 `transform-origin`，按下时压扁、松开用弹性曲线回弹。

### 3.4 控件与按钮共用一套参数

演示页里那个「拖滑杆，卡片和按钮同时变」的效果，本质是**同一份参数喂给多个实例**。库没有全局状态，实例之间彼此独立，所以要自己聚合：

```js
const targets = [
  { el: document.querySelector('#panel'), rad: 0 },   // rad 只是备注，半径来自 CSS
  { el: document.querySelector('.vg-chip') }
];

// 按控件尺寸给不同基准参数：大卡片和胶囊按钮不能用同一组值
const base = {
  panel: { edge: 28, bend: 20, chroma: 1.0, lobe: 0.65, frost: 12 },
  chip:  { edge: 14, bend: 12, chroma: 1.0, lobe: 0.60, frost: 8  }
};

const ctrlPanel = Vitreous.apply(targets[0].el, base.panel);
const ctrlChip  = Vitreous.apply(targets[1].el, base.chip);

// 滑杆只改「强度倍数」，各实例按自己的基准等比缩放，
// 这样同一个弯折强度作用在大卡片和小按钮上观感才一致
function setBend(v) {
  ctrlPanel.update({ bend: v });
  ctrlChip.update({ bend: Math.round(v * 0.6) });
}

document.querySelector('#bend').addEventListener('input', e => setBend(+e.target.value));
```

同一份参数字典逐个 `update()` 是最直白的做法；比例缩放则是让大小控件观感接近的关键——**绝对像素值不能直接共享**。

### 3.5 四个必须知道的约束

这几条是踩过的坑，写进这里省得你重复调试：

**① 圆角只能来自 CSS。** 库从 `getComputedStyle` 读 `border-top-left-radius` 等四个角，`%` 会按短边换算，超过 `min(w, h)/2` 会被钳制。给元素传 JS 半径参数是无效的——`Vitreous.apply()` 的参数表里没有 `radius`。

**② 弯折带不能超过控件一半短边。** `edge` 是折射带宽度。如果 `edge` 大于 `min(w, h) / 2`，整个控件都落在弯折带里，没有平坦中部，背景会被一路掰到底，小按钮上会出现一条硬边亮条，看起来像贴了张塑料膜。经验值：**`edge ≤ min(w, h) * 0.55`**。320×180 的卡片用 28 没问题；115×45 的胶囊按钮就该用 12–14。

**③ 祖先元素会切断采样。** `backdrop-filter` 采样的是「backdrop root」，一旦祖先链上有 `transform`、`filter`、`backdrop-filter` 或 `opacity < 1`，就会形成新的 backdrop root，玻璃只能采样到那个祖先内部的像素。如果玻璃突然变得「什么都没折射」，先往上找这几类属性。同理，元素自身必须有非零宽高——`display: none` 或尺寸为 0 时 `apply()` 会直接跳过。

**④ 只有 Chromium 会真的弯折。** `backdrop-filter: url(#svg)` 目前只有 Chrome / Edge / Arc / Brave / Electron 会绘制。Safari 和 Firefox 接受语法但丢弃滤镜，库会自动降级成 `blur() + tint` 的普通毛玻璃。用 `Vitreous.supported()` 可以查询，`Vitreous.force(true)` 可以强制开着做对比。

### 3.6 在框架里用

**React**：在 `ref` 挂载后 `apply`，卸载时 `destroy`。

```jsx
import { useEffect, useRef } from 'react';

export function GlassPanel({ bend = 20 }) {
  const ref = useRef(null);
  const ctrl = useRef(null);

  useEffect(() => {
    ctrl.current = window.Vitreous.apply(ref.current, { bend });
    return () => ctrl.current?.destroy();     // 必须销毁，否则 SVG 滤镜会泄漏
  }, []);

  useEffect(() => {
    ctrl.current?.update({ bend });           // 参数变化走增量更新
  }, [bend]);

  return <div ref={ref} className="vg-panel">...</div>;
}
```

**Vue 3**：

```vue
<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';

const el = ref(null);
let ctrl = null;

onMounted(() => { ctrl = window.Vitreous.apply(el.value, { bend: 20 }); });
onBeforeUnmount(() => ctrl?.destroy());
</script>

<template><div ref="el" class="vg-panel">...</div></template>
```

**动态插入的节点**：用 `Vitreous.watch()` 让新节点自动生效，不必手动扫。

```js
Vitreous.watch(document.body, '.vg-panel', { bend: 20 });
```

---

## 4. API

| 方法 | 说明 |
| --- | --- |
| `Vitreous.apply(el, options)` | 给元素上玻璃，返回控制器。重复调用是增量更新。 |
| `Vitreous.scan(root, selector, options)` | 批量处理，默认 `[data-vitreous]`。 |
| `Vitreous.watch(root, selector, options)` | 监听 DOM 变化，新插入的玻璃自动生效。 |
| `Vitreous.remove(el)` | 移除玻璃并还原样式。 |
| `Vitreous.define(tag)` | 注册自定义元素，默认 `web-liquid-vitreous-glass`（旧标签 `vitreous-glass` 自动兼容注册）。 |
| `Vitreous.supported()` | 当前环境是否会真的折射。 |
| `Vitreous.force(bool)` | 强制开启/关闭折射，`null` 恢复自动判断。常用于做「开/关对比」。 |
| `Vitreous.map(el)` | 取当前元素生成的位移贴图（data URL），便于调试。 |

控制器对象：

```js
{
  update(patch),   // 增量合并参数并重建
  refresh(),       // 尺寸/样式变了就重建
  options(),       // 当前参数副本
  geometry(),      // { width, height, radii }
  refracting(),    // 这个元素当前是否真在折射
  destroy()
}
```

### 参数

| 名称 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `edge` | `26` | 0–200 | 折射带宽度（px）。越大，玻璃「厚度」看起来越宽 |
| `bend` | `15` | 0–80 | 边缘最大拉扯量（px），即折射强度 |
| `curve` | `1.5` | 0–4 | 剖面衰减指数，越大边缘越锐利 |
| `lobe` | `0.22` | 0–0.9 | 内层反向回流强度，产生旋涡/双影 |
| `frost` | `0` | 0–20 | 中间平整区域的模糊量（px） |
| `chroma` | `1.2` | 0–8 | 色散宽度（px），R/B 通道分离量 |
| `sat` | `1.08` | 0–3 | 背景饱和度补偿 |
| `tint` | `rgba(255,255,255,0.10)` | — | 玻璃底色，建议保持半透明。设为 `rgba(255,255,255,0)` 时底色完全消失，只剩边缘高光与折射，可用于观察纯折射效果 |
| `rim` | `0.45` | 0–2 | CSS 边光强度（高光描边） |
| `light` | `-120` | ±360 | 光源角度（度），决定静止时高光方位 |
| `sheen` | `0.55` | 0–1.5 | 跟随鼠标的高光强度 |
| `press` | `0` | 0–1 | 按下时挤压回弹动画强度 |
| `quality` | `1` | 0.2–1 | 位移贴图分辨率倍数，低配设备可下调 |

---

## 5. 浏览器支持与降级

`backdrop-filter: url(#svg)` 这个组合目前只有 **Chromium 内核**会真正绘制（Chrome / Edge / Arc / Brave / Electron）。Safari 和 Firefox 接受语法但会丢弃滤镜，所以库内置了引擎判断：

- **Chromium**：走 SVG 位移滤镜，真实折射 + 色散。
- **其他**：自动降级为 `backdrop-filter: blur() saturate()` 的磨砂玻璃，视觉上依然成立，不会出现「什么都看不见」的空白。
- 想验证降级效果，调 `Vitreous.force(false)`，演示页里就是那颗「折射：开/关」按钮。

降级值写在 CSS 变量 `--vitreous-fb` 上，可以自己覆盖：

```css
.my-glass { --vitreous-fb: blur(18px) saturate(1.3); }
```

### 使用注意

- 元素必须有**明确的尺寸**和 `border-radius`，库会读取 `offsetWidth/offsetHeight` 与四角圆角。圆角用 px 最准，百分比会按短边近似。
- 玻璃需要有内容可弯折。纯色平铺背景上看不出折射，背景越热闹效果越好（渐变、图片、视频、文字、条纹）。
- 库会给元素加 `data-vitreous` 属性并写入 `background-color` / `background-image`（sheen 高光）。如果你需要自己控制背景，把 `tint` 设为 `'transparent'`、`sheen` 设为 `0`。
- 边光用 `::after` 伪元素实现，元素自身的 `::after` 会被占用；不需要时设 `rim: 0` 或加 `data-vitreous-rim="off"`。
- 位移贴图按尺寸分桶缓存（最多 40 张），大量不同尺寸的玻璃会各自生成一张。

---

## 6. 设计取舍

- **不做 WebGL。** 位移贴图 + SVG 滤镜完全走合成器，不需要额外渲染上下文，能和普通 DOM、滚动、`position: sticky` 共存，也不会和别的 canvas 抢 GPU。
- **贴图按尺寸分桶。** 位移图只和「尺寸 + 圆角 + 剖面参数」有关，与内容无关，所以同一尺寸的玻璃可以共用一张图。分辨率按元素面积自动下调，避免大面板生成 4K 贴图。
- **色散用三遍位移而不是后处理。** 这样色散宽度直接等于像素宽度，和 `bend` 解耦，调参更直观。
- **降级优先。** 任何不支持的环境都退到磨砂玻璃，而不是留一个没样式的透明块。

---

## 7. 更新日志

### v1.5.0 (2026-10-29)

本次**只改名称与版本号，功能代码无任何改动**。

**改名**

- 项目名称由 `Vitreous Glass` 统一更名为 **Web Liquid Vitreous Glass**：README 标题与示例、演示页卡片标题及底部标识、`vitreous.js` 文件头与版权行、`LICENSE` 版权行全部同步更新。
- 包目录名与默认自定义元素标签由 `vitreous-glass` 改为 `web-liquid-vitreous-glass`。
- 为避免已按旧版接入的页面失效，`vitreous.js` 在注册新标签的同时，仍会注册旧的 `<vitreous-glass>` 作为兼容别名，两套标签行为完全一致。
- `VERSION` 常量同步为 `1.5.0`。

### v1.4.0 (2026-10-29)

**修复**

- **控件顶部多出一条白边**：控件的边光原来用的是不对称写法——顶部 `inset 0 1.5px 0 rgba(255,255,255,.55~.6)`，底部只有 `inset 0 -1px 0 rgba(255,255,255,.16~.18)`。于是卡片与胶囊按钮的顶边是一条又亮又粗的白线，底边几乎没有，上下明显失衡。
- 现在顶部与底部统一为 `inset 0 1px 0` + 同一透明度（卡片 `.16`、按钮 `.18`，hover `.2`、按下 `.12`），边光上下对称，顶部不再有独立亮线。
- `vitreous.js` 里运行时生成的边光变量 `--vitreous-rim` 同步修正：顶部系数原本是底部的近 4 倍（`0.55` vs `0.14`），现统一为 `0.14`，注入的 `<vitreous-glass>` 元素与小控件同样不会顶边发亮。
- `README` 3.2 / 3.3 两段示例 CSS 一并改为对称写法，复制即可得到修正后的效果。
- 无 API 变更，`VERSION` 常量同步为 `1.4.0`。

### v1.3.0 (2026-10-29)

本次只改文档与版本号，**功能代码无任何改动**。

**新增**

- **README 新增「3. 注入到已有项目」整章**，把此前只散落在演示页里的用法补成可抄的落地方案：
  - 3.1 引入文件的三种方式（script 标签 / 按需异步加载 / 打包器副作用导入），并说明 CSP 下会注入的 `<style>` 与 SVG `<defs>`
  - 3.2 悬浮窗控件：HTML 结构 + CSS（含边光与投影）+ 一行 `apply()`，附把指针事件挂到 `window` 的拖动实现与 `ResizeObserver` 刷新
  - 3.3 玻璃按钮：改用原生 `<button>`、胶囊圆角、清掉原生外观、上玻璃参数，并附水波纹 / 外圈脉冲 / 回弹按下的完整 CSS 与 JS
  - 3.4 控件与按钮共用一套参数：多实例聚合与按尺寸等比缩放，说明绝对像素值不能直接共享
  - 3.5 四个必须知道的约束：圆角只能来自 CSS、`edge ≤ min(w, h) * 0.55`、祖先 `transform/filter` 会切断采样、只有 Chromium 真弯折
  - 3.6 React / Vue 3 的挂载与销毁写法、动态节点用 `watch()`
- 后续章节顺延：API → 4，浏览器支持 → 5，设计取舍 → 6，更新日志 → 7，许可 → 8。
- `vitreous.js` 的 `VERSION` 常量同步为 `1.3.0`，仅为版本标识一致，无逻辑改动。

### v1.2.0 (2026-10-29)

这一版主要修掉了渲染问题，并让演示页的按钮成为真正可交互的控件。

**修复**

- **边缘黑框**：位移向量的方向原来指向元素外侧，导致边框处采样到轮廓外的空白像素，渲染成一圈黑边。改为向内侧采样（位移取负）。
- **角部浅色凸起**：位移像素一旦超过到边界的距离，就会在圆角处采到轮廓外的像素，糊出一块浅色凸起。加入物理约束 `cap = (depth - 1.2) / bend`，让透镜不再采到自身轮廓之外。
- **胶囊控件圆角失效**：演示页给按钮传的圆角半径是写死的 `999`，对 45px 高的胶囊是无效半径。改为 `rad` 传负值时按 `min(w, h) / 2` 计算，按钮的折射贴图才真正生成（`map` 从 482B 增至约 4KB）。
- **小控件被整块掰弯**：边缘带宽固定 90px 时，45px 高的按钮整个落在弯折带内，没有平坦中部，折射带在内部拼成一条硬边亮条。现在弯折带会被限制在短边一半的 `0.55` 倍以内，大卡片照旧，小控件自动收窄。
- **透光度数值显示异常**：显示代码用 `slice(1)` 去掉前导零，把 `0` 也切掉了，只剩一个孤立小数点。改为标准 `toFixed(2)`。
- **内层模糊两个前缀默认值不一致**：`-webkit-` 分支是 `30px`，标准属性是 `0px`，导致两种内核表现不同。已统一。

**新增**

- **`frost` 参数接入演示页**：新增「玻璃模糊」滑杆（0–30px），通过内层 `::before` 的 `backdrop-filter: blur()` 与父级折射叠加，磨砂和折射可以同时存在，不必二选一。
- **透光度下限放开到 0**：`tint` 的 alpha 可取 `0`，此时底色完全消失，只剩边缘高光与折射，用于观察纯折射效果。
- **按钮点击动效**：Subscribe 从静态 `div` 升级为 `role="button"` + `tabindex` 的可聚焦控件，并加入三类反馈——落点扩散的水波纹、向外散开的环形脉冲、以及带过冲回弹的按下形变（`cubic-bezier(.34,1.56,.64,1)`）。键盘 `Enter` / `Space` 同样可触发。
- **演示页默认参数**：弯折强度 `20`、色散强度 `1.0`、旋涡回流 `6.5`、边缘带宽 `90`、玻璃模糊 `30`、透光度 `0.00`。

### v1.1.0 (2026-10-29)

这一版主要修改默认值和使用更好观察效果的背景。

**新增**
- **演示页背景改为浮动彩球**：从斜向彩条换成 10 颗缓慢漂浮的彩色光球（`mix-blend-mode: screen`，无模糊）。多种颜色的交界穿过卡片边缘时，折射的弯折效果比单一色带更容易看出来。
- **演示页默认参数**：弯折强度 `15`、色散强度 `1.0`、旋涡回流 `6.5`、边缘带宽 `90`、玻璃模糊 `30`、透光度 `0.00`。

### v1.0.0 (2026-10-29)

首个版本。单文件、零依赖的液态玻璃实现，SDF 圆角矩形距离场生成位移贴图，驱动 SVG `feDisplacementMap` 弯折 `backdrop-filter` 采样的背景；色散用三遍不同强度的位移各取一个通道合成。

---

## 8. 许可

MIT。见 `LICENSE`。

本库为独立实现：折射的**技术前提**（用 SDF 位移贴图驱动 `feDisplacementMap` 来弯折 `backdrop-filter` 的背景）是公开的图形学常识，此前的开源项目各自用不同方式实现过；本库的剖面函数、旋涡回流项、参数模型、API 设计、指针高光、挤压弹簧、缓存策略均为自行编写，未复制任何项目的源码或注释。
