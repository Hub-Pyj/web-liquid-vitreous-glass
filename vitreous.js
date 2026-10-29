/*!
 * Vitreous Glass v1.0.0
 * Real-refraction "liquid glass" for the web — one file, no dependencies, no build step.
 * MIT License · Copyright (c) 2026 Vitreous Glass Authors
 *
 * How it works (this library's own approach):
 *   1. An element is treated as a lens slab with a rounded-rect boundary.
 *   2. For every pixel of that boundary we compute the signed distance to the
 *      nearest edge, then map it through an original profile:
 *          p(t) = (1 - t)^(1 + curve) - lobe * sin(pi * t)      t = depth / edge
 *      The first term pulls the backdrop inward at the rim; the second term is an
 *      optional inner lobe that reverses the pull and gives the glass its swirl.
 *   3. The 2D offset (direction * p(t)) is packed into R/G of a PNG, where 128
 *      means "no offset". A stretched SVG feImage turns that map into a
 *      feDisplacementMap that bends whatever is behind the element.
 *   4. Colour fringing is done by running the displacement three times at three
 *      slightly different strengths and summing one channel from each pass.
 *
 * Anything that is not necessary for the browser to do the bending — the profile,
 * the lobe, the sheen that follows the pointer, the squash spring, the map cache,
 * the option model — is written for this library.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define(factory);
  } else {
    root.Vitreous = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var DEFAULTS = {
    edge: 26,                      // px — how wide the bending band is
    bend: 15,                      // px — peak inward pull at the rim
    curve: 1.5,                    // profile falloff exponent
    lobe: 0.22,                    // 0..0.9 — inner reversal (the swirl)
    frost: 0,                      // px — blur in the flat middle
    chroma: 1.2,                   // px — colour fringing
    sat: 1.08,                     // backdrop saturation
    tint: 'rgba(255,255,255,0.10)',
    rim: 0.45,                     // 0..2 — CSS rim light strength
    light: -120,                   // degrees — where the light comes from
    sheen: 0.55,                   // 0..1.5 — pointer-following highlight
    press: 0,                      // 0..1 — squash on press
    quality: 1                     // 0.2..1 — map resolution
  };

  var BOUNDS = {
    edge: [0, 200], bend: [0, 80], curve: [0, 4], lobe: [0, 0.9],
    frost: [0, 20], chroma: [0, 8], sat: [0, 3], rim: [0, 2],
    light: [-360, 360], sheen: [0, 1.5], press: [0, 1], quality: [0.2, 1]
  };

  var states = new WeakMap();
  var live = [];            // 存活实例，强制切换折射开关时需要整体重绘
  var seq = 0;
  var svgHost = null;
  var stylesInjected = false;

  /* ---------------------------------------------------------------- helpers */

  function clampNum(v, lo, hi, dflt) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) n = dflt;
    return n < lo ? lo : n > hi ? hi : n;
  }

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  function normalize(opts, base) {
    var o = assign({}, DEFAULTS, base || null, opts || null), k;
    for (k in BOUNDS) {
      if (Object.prototype.hasOwnProperty.call(BOUNDS, k)) {
        o[k] = clampNum(o[k], BOUNDS[k][0], BOUNDS[k][1], DEFAULTS[k]);
      }
    }
    if (typeof o.tint !== 'string') o.tint = DEFAULTS.tint;
    return o;
  }

  /* ------------------------------------------------------- engine detection */

  var supportCache = null;
  var forced = null;

  function isChromium() {
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    return /Chrome\/|Chromium\/|HeadlessChrome\//.test(ua) && !/Firefox\//.test(ua);
  }

  /**
   * True only where an SVG filter graph inside backdrop-filter actually paints.
   * Safari and Firefox accept the syntax and drop the filter, so the UA is part
   * of the verdict. `Vitreous.force(true|false|null)` overrides it.
   */
  function supported() {
    if (forced !== null) return forced;
    if (supportCache !== null) return supportCache;
    var ok = false;
    try {
      ok = typeof CSS !== 'undefined' && !!CSS.supports &&
        CSS.supports('backdrop-filter', 'url(#vitreous-probe)') &&
        isChromium();
    } catch (e) {
      ok = false;
    }
    supportCache = ok;
    return ok;
  }

  function force(state) {
    forced = state === true ? true : state === false ? false : null;
    supportCache = null;
    for (var i = 0; i < live.length; i++) {
      if (live[i].el && live[i].el.isConnected) writeBackdrop(live[i]);
    }
    return supported();
  }

  /* ------------------------------------------------------------------- math */

  /** Signed distance to a rounded rectangle; negative inside. radii=[tl,tr,br,bl] */
  function sdRoundRect(px, py, w, h, radii) {
    var hw = w * 0.5, hh = h * 0.5;
    var qx = px - hw, qy = py - hh;
    var rr = qx < 0
      ? (qy < 0 ? radii[0] : radii[3])
      : (qy < 0 ? radii[1] : radii[2]);
    var cx = hw - rr, cy = hh - rr;
    var ax = Math.abs(qx) - cx;
    var ay = Math.abs(qy) - cy;
    var mx = ax > 0 ? ax : 0;
    var my = ay > 0 ? ay : 0;
    var outer = Math.sqrt(mx * mx + my * my);
    var inner = Math.min(Math.max(ax, ay), 0);
    return outer + inner - rr;
  }

  /* -------------------------------------------------------------- map build */

  var MAP_LIMIT = 40;
  var mapCache = new Map();
  var mapOrder = [];

  function mapKeyOf(w, h, radii, o) {
    return [w, h, radii.join(','), o.edge.toFixed(1), o.bend.toFixed(1),
      o.curve.toFixed(2), o.lobe.toFixed(2), o.quality.toFixed(2)].join('|');
  }

  function rememberMap(key, entry) {
    mapCache.set(key, entry);
    mapOrder.push(key);
    while (mapOrder.length > MAP_LIMIT) {
      var old = mapOrder.shift();
      if (old !== key) mapCache.delete(old);
    }
  }

  function renderMap(w, h, radii, o) {
    var budget = 220000;
    var q = Math.min(1, o.quality) * Math.min(1, Math.sqrt(budget / Math.max(1, w * h)));
    q = q < 0.2 ? 0.2 : q;
    var mw = Math.max(6, Math.min(600, Math.round(w * q)));
    var mh = Math.max(6, Math.min(600, Math.round(h * q)));

    var cv = document.createElement('canvas');
    cv.width = mw;
    cv.height = mh;
    var ctx = cv.getContext('2d');
    if (!ctx) return '';
    var img = ctx.createImageData(mw, mh);
    var data = img.data;
    var sx = w / mw, sy = h / mh;
    var band = Math.max(0.5, o.edge);
    var eps = Math.max(0.4, Math.min(sx, sy) * 0.5);
    var twoPi = Math.PI;

    for (var y = 0; y < mh; y++) {
      var py = (y + 0.5) * sy;
      for (var x = 0; x < mw; x++) {
        var px = (x + 0.5) * sx;
        var i = (y * mw + x) * 4;
        var depth = -sdRoundRect(px, py, w, h, radii);
        var rv = 128, gv = 128;

        if (depth < band) {
          var t = depth > 0 ? depth / band : 0;
          if (t > 1) t = 1;
          var prof = Math.pow(1 - t, 1 + o.curve) - o.lobe * Math.sin(twoPi * t);
          // Physical cap: the lens may not sample past its own rim, otherwise the
          // displacement reads pixels outside the element and smears a pale bump
          // past the corner. Limit |prof| so bend*|prof| <= distance to the edge.
          var cap = Math.max(0, depth - 1.2) / Math.max(0.001, o.bend);
          if (prof > cap) prof = cap; else if (prof < -cap) prof = -cap;
          if (prof > 0.97) prof = 0.97;
          if (prof < -0.97) prof = -0.97;

          var gx = sdRoundRect(px + eps, py, w, h, radii) - sdRoundRect(px - eps, py, w, h, radii);
          var gy = sdRoundRect(px, py + eps, w, h, radii) - sdRoundRect(px, py - eps, w, h, radii);
          var len = Math.sqrt(gx * gx + gy * gy);

          if (len > 1e-6) {
            // 位移必须指回元素内部。梯度指向外侧，所以取负号。
            // 若朝外采样，取到的是元素边界以外的空像素，边框会糊成一圈黑边。
            var ox = -(gx / len) * prof;
            var oy = -(gy / len) * prof;
            if (ox < -1) ox = -1; else if (ox > 1) ox = 1;
            if (oy < -1) oy = -1; else if (oy > 1) oy = 1;
            rv = 128 + ox * 127;
            gv = 128 + oy * 127;
          }
        }

        data[i] = rv;
        data[i + 1] = gv;
        data[i + 2] = 128;
        data[i + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }

  function mapFor(geom, o) {
    var bucket = geom.w * geom.h > 40000 ? 4 : 2;
    var bw = Math.max(1, Math.round(geom.w / bucket) * bucket);
    var bh = Math.max(1, Math.round(geom.h / bucket) * bucket);
    var key = mapKeyOf(bw, bh, geom.radii, o);
    var hit = mapCache.get(key);
    if (hit) return hit;
    var entry = { url: renderMap(bw, bh, geom.radii, o), w: bw, h: bh };
    rememberMap(key, entry);
    return entry;
  }

  /* ----------------------------------------------------------- svg plumbing */

  function ensureSvg() {
    if (svgHost && svgHost.isConnected) return svgHost;
    if (!document.body) return null;
    svgHost = document.createElementNS(SVG_NS, 'svg');
    svgHost.setAttribute('aria-hidden', 'true');
    svgHost.setAttribute('focusable', 'false');
    svgHost.setAttribute('width', '0');
    svgHost.setAttribute('height', '0');
    svgHost.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';
    document.body.appendChild(svgHost);
    return svgHost;
  }

  function filterMarkup(o, geom, mapUrl) {
    var w = geom.w.toFixed(2);
    var h = geom.h.toFixed(2);
    var s = 2 * o.bend;
    var spread = 2 * o.chroma;
    var p = [];

    p.push('<feImage href="' + mapUrl + '" x="0" y="0" width="' + w + '" height="' + h +
      '" preserveAspectRatio="none" result="VMAP"/>');
    p.push('<feGaussianBlur in="SourceGraphic" stdDeviation="' +
      (o.frost / 2).toFixed(2) + '" result="VBASE"/>');

    if (o.chroma > 0.1) {
      var sHi = s + spread;
      var sLo = Math.max(0.01, s - spread);
      p.push('<feDisplacementMap in="VBASE" in2="VMAP" scale="' + sHi.toFixed(2) +
        '" xChannelSelector="R" yChannelSelector="G" result="VDR"/>');
      p.push('<feColorMatrix in="VDR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1" result="VCR"/>');
      p.push('<feDisplacementMap in="VBASE" in2="VMAP" scale="' + s.toFixed(2) +
        '" xChannelSelector="R" yChannelSelector="G" result="VDG"/>');
      p.push('<feColorMatrix in="VDG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 1" result="VCG"/>');
      p.push('<feDisplacementMap in="VBASE" in2="VMAP" scale="' + sLo.toFixed(2) +
        '" xChannelSelector="R" yChannelSelector="G" result="VDB"/>');
      p.push('<feColorMatrix in="VDB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0 1" result="VCB"/>');
      p.push('<feComposite in="VCR" in2="VCG" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="VRG"/>');
      p.push('<feComposite in="VRG" in2="VCB" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="VMIX"/>');
    } else {
      p.push('<feDisplacementMap in="VBASE" in2="VMAP" scale="' + s.toFixed(2) +
        '" xChannelSelector="R" yChannelSelector="G" result="VMIX"/>');
    }

    if (Math.abs(o.sat - 1) > 0.01) {
      p.push('<feColorMatrix in="VMIX" type="saturate" values="' + o.sat.toFixed(2) + '"/>');
    }
    return p.join('');
  }

  /* ------------------------------------------------------------- geometry */

  function geomOf(el) {
    var w = el.offsetWidth || 0;
    var h = el.offsetHeight || 0;
    if (!w || !h) {
      var r = el.getBoundingClientRect();
      w = Math.round(r.width);
      h = Math.round(r.height);
    }
    var cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    var raw = cs
      ? [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
      : ['0px', '0px', '0px', '0px'];
    var lim = Math.min(w, h) / 2;
    var radii = raw.map(function (v) {
      var n = parseFloat(v);
      if (!isFinite(n)) return 0;
      if (String(v).indexOf('%') >= 0) n = n / 100 * lim;
      return n < 0 ? 0 : n > lim ? lim : n;
    });
    return { w: w, h: h, radii: radii };
  }

  /* ---------------------------------------------------------------- styling */

  function injectStyles() {
    if (stylesInjected || !document.head) return;
    stylesInjected = true;
    var css = [
      '[data-vitreous]{position:relative;',
      '-webkit-backdrop-filter:var(--vitreous-fb,blur(10px)) saturate(1.1);',
      'backdrop-filter:var(--vitreous-fb,blur(10px)) saturate(1.1);}',
      '[data-vitreous]::after{content:"";position:absolute;inset:0;border-radius:inherit;',
      'pointer-events:none;box-shadow:var(--vitreous-rim,none);}',
      '[data-vitreous][data-vitreous-rim="off"]::after{display:none;}',
      'vitreous-glass{display:block;box-sizing:border-box;}'
    ].join('');
    var tag = document.createElement('style');
    tag.setAttribute('data-vitreous-style', '');
    tag.appendChild(document.createTextNode(css));
    document.head.appendChild(tag);
  }

  function paintSurface(st, mx, my) {
    var el = st.el, o = st.o;
    var px = mx, py = my;
    if (px == null || py == null) {
      var rad = (o.light * Math.PI) / 180;
      px = 50 + Math.cos(rad) * 26;
      py = 50 + Math.sin(rad) * 26;
    }
    el.style.backgroundColor = o.tint;
    if (o.sheen > 0) {
      el.style.backgroundImage = 'radial-gradient(circle at ' + px.toFixed(1) + '% ' +
        py.toFixed(1) + '%, rgba(255,255,255,' + (0.28 * o.sheen).toFixed(3) +
        '), rgba(255,255,255,0) 62%)';
    } else {
      el.style.backgroundImage = 'none';
    }
    if (o.rim > 0) {
      var a = Math.min(1, 0.55 * o.rim);
      var b = Math.min(1, 0.14 * o.rim);
      var c = Math.min(1, 0.26 * o.rim);
      el.style.setProperty('--vitreous-rim',
        'inset 0 1px 0 rgba(255,255,255,' + a.toFixed(3) + '),' +
        'inset 0 -1px 0 rgba(255,255,255,' + b.toFixed(3) + '),' +
        'inset 0 0 0 1px rgba(255,255,255,' + c.toFixed(3) + ')');
    } else {
      el.style.setProperty('--vitreous-rim', 'none');
    }
  }

  function writeBackdrop(st) {
    var el = st.el, o = st.o;
    var fallback = 'blur(' + Math.max(2, o.frost || 10) + 'px) saturate(' + o.sat + ')';
    el.style.setProperty('--vitreous-fb', fallback);
    if (supported() && st.mapUrl) {
      el.style.webkitBackdropFilter = 'url(#' + st.filterId + ')';
      el.style.backdropFilter = 'url(#' + st.filterId + ')';
    } else {
      el.style.webkitBackdropFilter = '';
      el.style.backdropFilter = '';
    }
  }

  /* ------------------------------------------------------------------ build */

  function build(st) {
    var el = st.el;
    st.geom = geomOf(el);
    if (!st.geom.w || !st.geom.h) return;

    var host = ensureSvg();
    if (!host) return;

    var entry = mapFor(st.geom, st.o);
    st.mapUrl = entry.url;
    if (!st.mapUrl) return;

    if (!st.filterEl || !st.filterEl.isConnected) {
      st.filterEl = document.createElementNS(SVG_NS, 'filter');
      st.filterEl.setAttribute('id', st.filterId);
      host.appendChild(st.filterEl);
    }
    var f = st.filterEl;
    f.setAttribute('x', '0');
    f.setAttribute('y', '0');
    f.setAttribute('width', '1');
    f.setAttribute('height', '1');
    f.setAttribute('filterUnits', 'objectBoundingBox');
    f.setAttribute('color-interpolation-filters', 'sRGB');
    f.innerHTML = filterMarkup(st.o, st.geom, st.mapUrl);

    injectStyles();
    el.setAttribute('data-vitreous', '');
    writeBackdrop(st);
    paintSurface(st);
  }

  /* ------------------------------------------------------------ interaction */

  function bindPointer(st) {
    var el = st.el;
    var lastX = null, lastY = null, frame = 0;

    function onMove(e) {
      if (st.o.sheen <= 0) return;
      lastX = e.clientX;
      lastY = e.clientY;
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        paintSurface(st, ((lastX - r.left) / r.width) * 100, ((lastY - r.top) / r.height) * 100);
      });
    }

    function onLeave() {
      paintSurface(st);
    }

    function onDown(e) {
      if (!st.o.press) return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var ox = ((e.clientX - r.left) / r.width) * 100;
      var oy = ((e.clientY - r.top) / r.height) * 100;
      el.style.transformOrigin = ox.toFixed(1) + '% ' + oy.toFixed(1) + '%';
      el.style.transition = 'transform 110ms ease-out';
      el.style.transform = 'scale(' + (1 + 0.045 * st.o.press).toFixed(3) + ',' +
        (1 - 0.075 * st.o.press).toFixed(3) + ')';
      window.addEventListener('pointerup', onUp, { once: true });
    }

    function onUp() {
      el.style.transition = 'transform 520ms cubic-bezier(.18,1.55,.4,1)';
      el.style.transform = 'scale(1,1)';
    }

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerdown', onDown);
    st.unbind = function () {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onDown);
      if (frame) cancelAnimationFrame(frame);
    };
  }

  /* -------------------------------------------------------------------- api */

  var resizeObserver = null;
  var resizeQueue = [];

  function observeResize(st) {
    if (typeof ResizeObserver === 'undefined') return;
    if (!resizeObserver) {
      resizeObserver = new ResizeObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var s = states.get(entries[i].target);
          if (!s) continue;
          var w = Math.round(entries[i].contentRect.width);
          var h = Math.round(entries[i].contentRect.height);
          if (w === s.lastW && h === s.lastH) continue;
          s.lastW = w;
          s.lastH = h;
          build(s);
        }
      });
    }
    resizeObserver.observe(st.el);
  }

  function apply(el, opts) {
    if (!el || el.nodeType !== 1) return null;
    injectStyles();

    var existing = states.get(el);
    if (existing) {
      existing.o = normalize(opts, existing.o);
      build(existing);
      return existing.api;
    }

    var st = {
      el: el,
      o: normalize(opts),
      filterId: 'vitreous-' + (++seq),
      filterEl: null,
      mapUrl: '',
      geom: { w: 0, h: 0, radii: [0, 0, 0, 0] },
      lastW: -1,
      lastH: -1,
      unbind: null
    };

    st.api = {
      el: el,
      version: VERSION,
      update: function (patch) {
        st.o = normalize(patch, st.o);
        build(st);
        return st.api;
      },
      refresh: function () {
        build(st);
        return st.api;
      },
      options: function () {
        return assign({}, st.o);
      },
      geometry: function () {
        return { width: st.geom.w, height: st.geom.h, radii: st.geom.radii.slice() };
      },
      refracting: function () {
        return supported();
      },
      destroy: function () {
        remove(el);
      }
    };

    states.set(el, st);
    live.push(st);
    build(st);
    bindPointer(st);
    observeResize(st);
    return st.api;
  }

  function remove(el) {
    var st = states.get(el);
    if (!st) return;
    states.delete(el);
    var idx = live.indexOf(st);
    if (idx >= 0) live.splice(idx, 1);
    if (st.unbind) st.unbind();
    if (resizeObserver) {
      try { resizeObserver.unobserve(el); } catch (e) { /* noop */ }
    }
    if (st.filterEl && st.filterEl.parentNode) st.filterEl.parentNode.removeChild(st.filterEl);
    el.removeAttribute('data-vitreous');
    el.style.webkitBackdropFilter = '';
    el.style.backdropFilter = '';
    el.style.backgroundImage = '';
    el.style.removeProperty('--vitreous-fb');
    el.style.removeProperty('--vitreous-rim');
  }

  function scanAll(root, selector, opts) {
    var scope = root || document;
    var nodeList = scope.querySelectorAll(selector || '[data-vitreous]');
    for (var i = 0; i < nodeList.length; i++) apply(nodeList[i], opts);
    return nodeList.length;
  }

  function watch(root, selector, opts) {
    var scope = root || document;
    var found = [];
    function scan() {
      var nodes = scope.querySelectorAll(selector || '[data-vitreous]');
      for (var i = 0; i < nodes.length; i++) {
        if (found.indexOf(nodes[i]) >= 0) continue;
        found.push(nodes[i]);
        apply(nodes[i], opts);
      }
    }
    scan();
    var mo = null;
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(scan);
      mo.observe(scope === document ? document.body : scope, { childList: true, subtree: true });
    }
    return {
      refresh: scan,
      stop: function () {
        if (mo) mo.disconnect();
        for (var i = 0; i < found.length; i++) remove(found[i]);
        found.length = 0;
      }
    };
  }

  /* -------------------------------------------------------- custom element */

  var ATTR_MAP = {
    edge: 'edge', bend: 'bend', curve: 'curve', lobe: 'lobe', frost: 'frost',
    chroma: 'chroma', sat: 'sat', tint: 'tint', rim: 'rim', light: 'light',
    sheen: 'sheen', press: 'press', quality: 'quality'
  };

  function readAttrs(el) {
    var out = {};
    for (var attr in ATTR_MAP) {
      if (!Object.prototype.hasOwnProperty.call(ATTR_MAP, attr)) continue;
      var v = el.getAttribute(attr);
      if (v === null) continue;
      if (attr === 'tint') out.tint = v;
      else {
        var n = parseFloat(v);
        if (isFinite(n)) out[attr] = n;
      }
    }
    return out;
  }

  function define(tagName) {
    var name = tagName || 'vitreous-glass';
    if (typeof customElements === 'undefined' || customElements.get(name)) return false;

    var Klass = function () {
      var self = Reflect.construct(HTMLElement, [], Klass);
      self._api = null;
      return self;
    };
    Klass.prototype = Object.create(HTMLElement.prototype);
    Klass.prototype.constructor = Klass;
    Object.setPrototypeOf(Klass, HTMLElement);

    Klass.observedAttributes = Object.keys(ATTR_MAP);

    Klass.prototype.connectedCallback = function () {
      this._api = apply(this, readAttrs(this));
    };
    Klass.prototype.disconnectedCallback = function () {
      if (this._api) { this._api.destroy(); this._api = null; }
    };
    Klass.prototype.attributeChangedCallback = function (name, oldValue, newValue) {
      if (!this._api || oldValue === newValue) return;
      this._api.update(readAttrs(this));
    };

    customElements.define(name, Klass);
    return true;
  }

  return {
    version: VERSION,
    defaults: assign({}, DEFAULTS),
    supported: supported,
    force: force,
    apply: apply,
    remove: remove,
    scan: scanAll,
    watch: watch,
    define: define,
    map: function (el) {
      var st = states.get(el);
      if (!st) return null;
      var entry = mapFor(st.geom, st.o);
      return { url: entry.url, width: entry.w, height: entry.h, filterId: st.filterId };
    }
  };
});
