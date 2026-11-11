// ==UserScript==
// @name         DMM/FANZA 游戏画面全屏
// @name:ja      DMM/FANZA ゲーム画面フルスクリーン
// @namespace    dsh.local.dmm.fullscreen
// @version      1.0
// @description  通过跨帧握手精确定位游戏画布，把 osapi 里的游戏 iframe 全屏（不需要权限链），再让画布铺满。点画布进全屏，右上角 A/F 切换。
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* 设计要点
 * 1) 顶层页面什么都不做。全屏动作由 osapi 帧发起：osapi 全屏它自己的子 iframe 元素，
 *    只需要 osapi 自己的全屏权限，不需要子文档的 allow/allowfullscreen（权限链）。
 * 2) 不靠启发式猜"哪个 iframe 是游戏"。用 who/have 握手：有 canvas 的帧回传坐标，
 *    包装层逐级加上自己这个 iframe 的偏移往上抛，最终得到画布在 osapi 视口里的精确矩形。
 * 3) 消息一律是纯字符串（部分页面把 e.data 当字符串 indexOf，发对象会让它抛错）。
 * 4) @grant none：合成 resize 必须能传到 Unity 引擎。
 */
(() => {
  'use strict';

  if (window.__DMMFS6__) return;
  window.__DMMFS6__ = true;
  if (window.top === window) return;            // 顶层不参与

  const NS = 'DMMFS6';
  const P = NS + '|';
  const m = (t, b) => P + t + (b ? '|' + b : '');
  const isM = (d) => typeof d === 'string' && d.indexOf(P) === 0;
  const typeOf = (d) => d.slice(P.length).split('|')[0];
  const bodyOf = (d) => {
    const s = d.slice(P.length);
    const i = s.indexOf('|');
    return i < 0 ? '' : s.slice(i + 1);
  };

  const T = { WHO: 'who', HAVE: 'have', NONE: 'none', ENTER: 'enter', EXIT: 'exit', RESIZE: 'resize' };
  const HOST = location.hostname;
  const IS_OSAPI = /^osapi\.(games\.)?dmm\.com$/i.test(HOST);

  /* 脚本会注入到所有页面，但只有"DMM 游戏页的框架树"里才继续干活。
     location.ancestorOrigins 列出全部祖先源，所以任意深度的游戏画布帧都能认出来。
     其它网站（以及顶层页面）在这里立即返回，开销只有一次正则匹配。 */
  const ANCESTORS = [...(location.ancestorOrigins || [])];
  const IN_DMM_TREE = ANCESTORS.some((o) => /play\.games\.dmm\.co\.jp|osapi\.(games\.)?dmm\.com/i.test(o));
  if (!IS_OSAPI && !IN_DMM_TREE) return;

  const Z_OV = 2147483600;

  const log = (...a) => { if (window.__DMMFS6_DEBUG__) console.log('[DMMFS6]', ...a); };

  const qa = (s, r = document) => Array.prototype.slice.call(r.querySelectorAll(s));

  /* ============ 拦截 Unity 的报错弹窗 ============
   * girlscreationr（Unity 6000.3.8f1）只要视口变化就抛 Script error，
   * Unity 的 error handler 会弹一个 alert："An error occurred running the Unity content…"。
   * 游戏本身没死，关掉弹窗继续跑就行 —— 这里按文案过滤，非 Unity 文案一律放行。
   * 同时清掉 DOM 版的遮罩（有些构建不走 alert，而是盖一层 div）。
   */
  const UNITY_ERR_RE = /An error occurred running the Unity content|See your browser JavaScript console for more info/i;

  function installDialogGuard() {
    ['alert', 'confirm', 'prompt'].forEach((name) => {
      const orig = window[name];
      if (typeof orig !== 'function') return;
      if (orig.__dmmfs6Wrapped) return;
      const wrapped = function (...args) {
        const text = String(args[0] == null ? '' : args[0]);
        if (UNITY_ERR_RE.test(text)) {
          log('拦截 Unity 报错弹窗：' + name);
          return name === 'confirm' ? false : undefined;
        }
        return orig.apply(window, args);
      };
      wrapped.__dmmfs6Wrapped = true;
      try { window[name] = wrapped; } catch (e) {}
    });

    const hideOne = (el) => {
      if (!el || el.nodeType !== 1 || el.dataset.__dmmfs6Hidden === '1') return;
      let box = el, p = el;
      for (let i = 0; i < 6 && p && p !== document.body; i++) {
        const cs = getComputedStyle(p);
        if (cs.position === 'fixed' || cs.position === 'absolute') box = p;
        p = p.parentElement;
      }
      box.dataset.__dmmfs6Hidden = '1';
      box.style.setProperty('display', 'none', 'important');
      box.style.setProperty('visibility', 'hidden', 'important');
      box.style.setProperty('pointer-events', 'none', 'important');
      log('移除 Unity 报错遮罩');
    };

    const scan = (root) => {
      if (!root || root.nodeType !== 1) return;
      const txt = (root.textContent || '').slice(0, 400);
      if (!UNITY_ERR_RE.test(txt)) return;
      const inner = Array.prototype.slice
        .call(root.querySelectorAll('div,p,span,section,h1,h2,pre'))
        .filter((n) => UNITY_ERR_RE.test((n.textContent || '').slice(0, 400)))
        .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
      hideOne(inner || root);
    };

    const start = () => {
      try {
        scan(document.body || document.documentElement);
        new MutationObserver((recs) => {
          recs.forEach((r) => r.addedNodes && r.addedNodes.forEach((n) => scan(n)));
        }).observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }


  /** 挑游戏画布：优先 #unity-canvas，其次面积最大且可见的 */
  function pickCanvas() {
    const explicit = document.getElementById('unity-canvas') ||
      document.querySelector('#unity-canvas') ||
      document.querySelector('#webgl-content canvas') ||
      document.querySelector('#unity-container canvas');
    if (explicit) return explicit;
    let best = null, bestArea = 0;
    qa('canvas').forEach((c) => {
      const r = c.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      if (getComputedStyle(c).visibility === 'hidden' || getComputedStyle(c).display === 'none') return;
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = c; }
    });
    return best;
  }

  const isNonGameFrame = (el) => {
    const src = el.getAttribute('src') || '';
    let path = src;
    try { const u = new URL(src, location.href); path = u.host + u.pathname; } catch (e) {}
    const sig = [el.id, el.name, el.className, path].join(' ');
    return /(bottom|information|banner|advert|recommend|ranking|news|footer|twitter|social|share|comment|tracking|analytics|pixel|rcv\.|doubleclick|googletag)/i.test(sig);
  };

  // ══════════════════════════════════════════════════════════
  //  游戏层 / 包装层
  // ══════════════════════════════════════════════════════════
  function runNode() {
    let savedCanvas = null;   // { el, style }
    let pathChild = null;     // 通往画布的那个直接子 iframe
    let childSaved = null;    // { el, style } 包装层撑开子 iframe 前的快照
    let applied = null;

    function reportSelf() {
      const c = pickCanvas();
      if (!c) return null;
      const r = c.getBoundingClientRect();
      if (r.width < 80 || r.height < 60) return null;
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',');
    }

    function childrenFrames() {
      return qa('iframe').filter((f) => {
        const r = f.getBoundingClientRect();
        return r.width > 40 && r.height > 40 && f.contentWindow;
      });
    }

    function forwardUp(type, body) {
      try { window.parent.postMessage(m(type, body), '*'); } catch (e) {}
    }

    // 「你有画布吗」：自己有就回坐标；没有就问孩子，收到后加上孩子 iframe 的偏移再往上抛
    function askChildren() {
      const kids = childrenFrames();
      if (!kids.length) { forwardUp(T.NONE); return; }
      const mine = new Map();
      let pending = kids.length;

      const onReply = (ev) => {
        const d = ev.data;
        if (!isM(d)) return;
        const t = typeOf(d);
        if (t === T.HAVE) {
          const src = kids.find((f) => f.contentWindow === ev.source);
          if (!src) return;
          const p = bodyOf(d).split(',').map(Number);
          if (p.length !== 4 || p.some((n) => !isFinite(n))) return;
          const fr = src.getBoundingClientRect();
          const cs = getComputedStyle(src);
          const bl = parseFloat(cs.borderLeftWidth) || 0;
          const bt = parseFloat(cs.borderTopWidth) || 0;
          mine.set(src, [p[0] + fr.left + bl, p[1] + fr.top + bt, p[2], p[3]]);
          finish();
        } else if (t === T.NONE) {
          finish();
        }
      };

      let done = false;
      function finish() {
        if (done) return;
        done = true;
        window.removeEventListener('message', onReply, true);
        if (!mine.size) { forwardUp(T.NONE); return; }
        let best = null, area = 0, bestSrc = null;
        mine.forEach((v, el) => { const a = v[2] * v[3]; if (a > area) { area = a; best = v; bestSrc = el; } });
        pathChild = bestSrc;
        forwardUp(T.HAVE, best.map(Math.round).join(','));
      }

      window.addEventListener('message', onReply, true);
      kids.forEach((f) => { try { f.contentWindow.postMessage(m(T.WHO), '*'); } catch (e) {} });
      setTimeout(finish, 900);
    }

    function broadcast(type) {
      childrenFrames().forEach((f) => { try { f.contentWindow.postMessage(m(type), '*'); } catch (e) {} });
    }

    function sendTo(el, type) {
      if (!el || !el.contentWindow) return;
      try { el.contentWindow.postMessage(m(type), '*'); } catch (e) {}
    }

    /* ---------- 包装层：把通往画布的子 iframe 撑满 ---------- */
    function coverChild() {
      const el = pathChild;
      if (!el || !el.isConnected) return;
      if (!childSaved || childSaved.el !== el) childSaved = { el, style: el.getAttribute('style') };
      const s = el.style;
      s.setProperty('position', 'fixed', 'important');
      s.setProperty('left', '0', 'important');
      s.setProperty('top', '0', 'important');
      s.setProperty('width', '100vw', 'important');
      s.setProperty('height', '100vh', 'important');
      s.setProperty('max-width', 'none', 'important');
      s.setProperty('max-height', 'none', 'important');
      s.setProperty('margin', '0', 'important');
      s.setProperty('padding', '0', 'important');
      s.setProperty('border', '0', 'important');
      s.setProperty('transform', 'none', 'important');
      s.setProperty('z-index', '2147483000', 'important');
      if (!document.documentElement.style.overflow) {
        document.documentElement.dataset.dmmfs6Overflow = '1';
      }
      document.documentElement.style.setProperty('overflow', 'hidden', 'important');
      log('cover child', (el.src || '').slice(0, 40));
    }

    function restoreChild() {
      if (childSaved && childSaved.el) {
        const { el, style } = childSaved;
        if (style === null) el.removeAttribute('style');
        else el.setAttribute('style', style);
      }
      childSaved = null;
      if (document.documentElement.dataset.dmmfs6Overflow) {
        document.documentElement.style.removeProperty('overflow');
        delete document.documentElement.dataset.dmmfs6Overflow;
      }
    }

    /* ---------- 画布铺满 ---------- */
    const NEUTRAL_ATTR = 'data-dmmfs6-neutral';
    let neutralized = [];

    function injectFrameCss() {
      if (document.getElementById('dmmfs6-css')) return;
      const st = document.createElement('style');
      st.id = 'dmmfs6-css';
      st.textContent = `
        [${NEUTRAL_ATTR}] {
          transform: none !important;
          filter: none !important;
          perspective: none !important;
          will-change: auto !important;
          contain: none !important;
        }
        html[data-dmmfs6-on], html[data-dmmfs6-on] body {
          overflow: hidden !important;
          margin: 0 !important; padding: 0 !important;
          background: #000 !important;
          width: 100vw !important; height: 100vh !important;
        }
      `;
      (document.head || document.documentElement).appendChild(st);
    }

    /* position:fixed 的定位基准会被祖先的 transform/filter/will-change/contain 劫持，
       Unity 模板的 #unity-container 常带 translate(-50%,-50%) —— 不中和就会偏到右下角并溢出。 */
    function neutralizeAncestors(c) {
      neutralized.forEach((el) => { try { el.removeAttribute(NEUTRAL_ATTR); } catch (e) {} });
      neutralized = [];
      let p = c.parentElement, hops = 0;
      while (p && p !== document.body && p !== document.documentElement && hops < 10) {
        let cs;
        try { cs = getComputedStyle(p); } catch (e) { break; }
        const bad =
          cs.transform !== 'none' ||
          cs.filter !== 'none' ||
          cs.perspective !== 'none' ||
          cs.willChange !== 'auto' ||
          (cs.contain || '').indexOf('paint') >= 0;
        if (bad) { p.setAttribute(NEUTRAL_ATTR, '1'); neutralized.push(p); }
        p = p.parentElement;
        hops++;
      }
      if (neutralized.length) log('中和祖先', neutralized.length);
    }

    function freezeSiteFit(on) {
      try {
        if (on) {
          if (typeof window.fitGameCanvas !== 'function' || window.__dmmfs6FitFrozen) return;
          window.__dmmfs6FitOrig = window.fitGameCanvas;
          window.fitGameCanvas = function () {};
          window.__dmmfs6FitFrozen = true;
          log('冻结站点 fitGameCanvas');
        } else if (window.__dmmfs6FitFrozen) {
          window.fitGameCanvas = window.__dmmfs6FitOrig;
          window.__dmmfs6FitFrozen = false;
          window.__dmmfs6FitOrig = null;
          log('还原站点 fitGameCanvas');
        }
      } catch (e) {}
    }

    function stretch() {
      const c = pickCanvas();
      if (!c) { broadcast(T.ENTER); return; }
      injectFrameCss();
      if (!savedCanvas || savedCanvas.el !== c) {
        savedCanvas = { el: c, style: c.getAttribute('style') };
      }
      freezeSiteFit(true);
      neutralizeAncestors(c);
      document.documentElement.setAttribute('data-dmmfs6-on', '1');

      const vw = Math.max(1, window.innerWidth);
      const vh = Math.max(1, window.innerHeight);
      const bw = c.width || 1280;
      const bh = c.height || 720;
      const scale = Math.min(vw / bw, vh / bh);
      const w = Math.min(vw, Math.round(bw * scale));
      const h = Math.min(vh, Math.round(bh * scale));

      const s = c.style;
      s.setProperty('position', 'fixed', 'important');
      s.setProperty('left', Math.round((vw - w) / 2) + 'px', 'important');
      s.setProperty('top', Math.round((vh - h) / 2) + 'px', 'important');
      s.setProperty('width', w + 'px', 'important');
      s.setProperty('height', h + 'px', 'important');
      s.setProperty('max-width', 'none', 'important');
      s.setProperty('max-height', 'none', 'important');
      s.setProperty('margin', '0', 'important');
      s.setProperty('transform', 'none', 'important');
      s.setProperty('z-index', '2147483000', 'important');
      applied = { w: vw, h: vh };

      try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      broadcast(T.RESIZE);
      log('stretch', w + 'x' + h);
    }

    function unstretch() {
      if (savedCanvas && savedCanvas.el) {
        const { el, style } = savedCanvas;
        if (style === null) el.removeAttribute('style');
        else el.setAttribute('style', style);
      }
      neutralized.forEach((el) => { try { el.removeAttribute(NEUTRAL_ATTR); } catch (e) {} });
      neutralized = [];
      document.documentElement.removeAttribute('data-dmmfs6-on');
      freezeSiteFit(false);
      savedCanvas = null;
      applied = null;
      try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      broadcast(T.EXIT);
    }

    /* ---------- 消息 ---------- */
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!isM(d)) return;
      const t = typeOf(d);

      if (t === T.WHO) {
        const self = reportSelf();
        if (self) { forwardUp(T.HAVE, self); return; }
        askChildren();
        return;
      }

      if (e.source !== window.parent) return;
      if (t === T.ENTER) {
        if (pickCanvas()) {
          stretch();
          // 站点自己的自适应函数可能在 resize 后再改回来，多压几次
          [150, 400, 900, 1600].forEach((ms) => setTimeout(() => { if (savedCanvas) stretch(); }, ms));
          return;
        }
        if (pathChild) { coverChild(); sendTo(pathChild, T.ENTER); return; }
        broadcast(T.ENTER);
      } else if (t === T.EXIT) {
        if (savedCanvas) unstretch();
        if (childSaved) restoreChild();
        if (pathChild) sendTo(pathChild, T.EXIT);
        else broadcast(T.EXIT);
      } else if (t === T.RESIZE) {
        if (pickCanvas()) stretch();
        else if (pathChild) { coverChild(); sendTo(pathChild, T.RESIZE); }
      }
    });

    window.addEventListener('resize', () => {
      if (savedCanvas) stretch();
      else if (childSaved && pathChild) coverChild();
    });
  }

  // ══════════════════════════════════════════════════════════
  //  osapi 协调层
  // ══════════════════════════════════════════════════════════
  function runCoordinator() {
    const LS_KEY = 'dmmfs6:auto';
    let auto = true;
    try { auto = localStorage.getItem(LS_KEY) !== '0'; } catch (e) {}

    let target = null;        // 直接子 iframe（全屏对象）
    let rect = null;          // 画布在 osapi 视口里的绝对矩形 {x,y,w,h}
    let mode = 'off';         // off | native | css

    // UI
    const host = document.createElement('div');
    host.id = 'dmmfs6-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:' + Z_OV + ';pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .ov { position: fixed; box-sizing: border-box; background: transparent; cursor: pointer; pointer-events: auto; display: none; }
        .ov.pass { pointer-events: none; cursor: auto; }
        .btn {
          position: fixed; box-sizing: border-box; width: 32px; height: 32px; padding: 0;
          border-radius: 9px; border: 1px solid rgba(255,255,255,.32); background: rgba(0,0,0,.55);
          color: #ddd; font: 700 15px/1 "Segoe UI", system-ui, sans-serif;
          display: none; align-items: center; justify-content: center; cursor: pointer;
          pointer-events: auto; user-select: none; box-shadow: 0 2px 10px rgba(0,0,0,.4);
        }
        .btn.on { color: #6ef59b; border-color: rgba(110,245,155,.6); }
        .btn.off { color: #9a9a9a; }
      </style>
      <div class="ov"></div>
      <div class="btn">A</div>
    `;
    const ov = shadow.querySelector('.ov');
    const btn = shadow.querySelector('.btn');

    function mount() {
      if (document.documentElement.contains(host)) return;
      (document.body || document.documentElement).appendChild(host);
    }

    function apply() {
      btn.textContent = auto ? 'A' : 'F';
      btn.className = 'btn ' + (auto ? 'on' : 'off');
      btn.title = auto
        ? '自动全屏：开 — 点游戏画面即全屏（点此切到 F）'
        : '自动全屏：关 — 点游戏画面不全屏（点此切到 A）';
      ov.classList.toggle('pass', !auto);
    }

    function layout() {
      if (!rect) {
        ov.style.display = 'none';
        btn.style.display = 'none';
        return;
      }
      const fs = !!document.fullscreenElement;
      if (fs) { ov.style.display = 'none'; btn.style.display = 'none'; return; }
      ov.style.display = 'block';
      ov.style.left = rect.x + 'px';
      ov.style.top = rect.y + 'px';
      ov.style.width = rect.w + 'px';
      ov.style.height = rect.h + 'px';
      btn.style.display = 'flex';
      btn.style.left = Math.max(2, rect.x + rect.w - 44) + 'px';
      btn.style.top = Math.max(2, rect.y + 10) + 'px';
    }

    function kids() {
      return qa('iframe').filter((f) => {
        const r = f.getBoundingClientRect();
        return r.width > 40 && r.height > 40 && f.contentWindow;
      });
    }

    /* ---------- 握手：确定哪个子 iframe 通往画布，以及画布矩形 ---------- */
    function handshake() {
      const list = kids();
      if (!list.length) return;
      const found = new Map();
      let done = false;

      const onReply = (ev) => {
        const d = ev.data;
        if (!isM(d)) return;
        const t = typeOf(d);
        if (t !== T.HAVE) return;
        const src = list.find((f) => f.contentWindow === ev.source);
        if (!src) return;
        const p = bodyOf(d).split(',').map(Number);
        if (p.length !== 4 || p.some((n) => !isFinite(n))) return;
        const fr = src.getBoundingClientRect();
        const cs = getComputedStyle(src);
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const bt = parseFloat(cs.borderTopWidth) || 0;
        found.set(src, { x: p[0] + fr.left + bl, y: p[1] + fr.top + bt, w: p[2], h: p[3] });
        finish();
      };

      function finish() {
        if (done) return;
        done = true;
        window.removeEventListener('message', onReply, true);
        if (!found.size) {
          document.documentElement.dataset.dmmfs6 = 'noframe';
          return;
        }
        let bestEl = null, best = null, area = 0;
        found.forEach((v, el) => { const a = v.w * v.h; if (a > area) { area = a; bestEl = el; best = v; } });
        target = bestEl;
        rect = best;
        document.documentElement.dataset.dmmfs6 =
          [Math.round(best.x), Math.round(best.y), Math.round(best.w), Math.round(best.h)].join(',');
        mount();
        apply();
        layout();
        log('resolved', document.documentElement.dataset.dmmfs6);
      }

      window.addEventListener('message', onReply, true);
      list.forEach((f) => { try { f.contentWindow.postMessage(m(T.WHO), '*'); } catch (e) {} });
      setTimeout(finish, 900);
    }

    /* ---------- 进入 / 退出全屏 ---------- */
    function send(type) {
      if (!target) return;
      try { target.contentWindow.postMessage(m(type), '*'); } catch (e) {}
    }

    function enter() {
      if (!target || mode !== 'off') return;
      const req = target.requestFullscreen || target.webkitRequestFullscreen;
      const fallback = (err) => {
        log('native failed', err);
        mode = 'css';
        const s = target.style;
        s.setProperty('position', 'fixed', 'important');
        s.setProperty('left', '0', 'important');
        s.setProperty('top', '0', 'important');
        s.setProperty('width', '100vw', 'important');
        s.setProperty('height', '100vh', 'important');
        s.setProperty('max-width', 'none', 'important');
        s.setProperty('max-height', 'none', 'important');
        s.setProperty('margin', '0', 'important');
        s.setProperty('border', '0', 'important');
        s.setProperty('z-index', '2147483000', 'important');
        document.documentElement.style.setProperty('overflow', 'hidden', 'important');
        send(T.ENTER);
        layout();
      };
      if (!req) { fallback(new Error('no requestFullscreen')); return; }
      let p;
      try { p = req.call(target); } catch (e) { fallback(e); return; }
      Promise.resolve(p).then(() => {
        mode = 'native';
        send(T.ENTER);
        layout();
      }, fallback);
    }

    function exit() {
      const wasNative = mode === 'native' || !!document.fullscreenElement;
      mode = 'off';
      send(T.EXIT);
      if (target) target.removeAttribute('style');
      document.documentElement.style.removeProperty('overflow');
      layout();
      if (wasNative) {
        const ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (ex) { try { const p = ex.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
      }
    }

    ov.addEventListener('click', (e) => {
      if (!auto) return;
      e.preventDefault();
      e.stopPropagation();
      enter();
    }, true);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      auto = !auto;
      try { localStorage.setItem(LS_KEY, auto ? '1' : '0'); } catch (err) {}
      apply();
    }, true);

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && mode === 'native') { mode = 'off'; send(T.EXIT); }
      layout();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mode === 'css') { e.preventDefault(); exit(); }
    }, true);

    /* 兜底：走完握手仍找不到画布（非 canvas 游戏 / 帧不可达）时，
       退回到"最像游戏窗口"的那个 iframe（面积大、比例接近 16:9、排除广告统计帧）。 */
    function fallbackPick() {
      if (target) return;
      const list = qa('iframe').filter((f) => {
        const r = f.getBoundingClientRect();
        return r.width > 300 && r.height > 200 && f.contentWindow;
      }).filter((f) => !isNonGameFrame(f));
      if (!list.length) return;
      let best = null, bestScore = -1;
      list.forEach((f) => {
        const r = f.getBoundingClientRect();
        const ratio = r.height / r.width;
        const fit = 1 - Math.min(1, Math.abs(ratio - 9 / 16) * 2);
        const score = fit * r.width * r.height;
        if (score > bestScore) { bestScore = score; best = { f, r }; }
      });
      if (!best) return;
      target = best.f;
      rect = { x: best.r.left, y: best.r.top, w: best.r.width, h: best.r.height };
      document.documentElement.dataset.dmmfs6 = 'fallback';
      mount();
      apply();
      layout();
      log('fallback pick', (best.f.src || '').slice(0, 50));
    }

    /* ---------- 启动 ---------- */
    const boot = () => {
      mount();
      handshake();
      setTimeout(() => { if (!target) fallbackPick(); }, 8000);
      setInterval(() => {
        if (target && !document.documentElement.contains(target)) { target = null; rect = null; }
        if (!target) handshake();
      }, 2500);
      setInterval(() => { if (rect && target) layout(); }, 800);
      window.addEventListener('resize', () => { if (rect) layout(); }, { passive: true });
      window.addEventListener('scroll', () => { if (rect) layout(); }, { passive: true, capture: true });
    };
    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
  }

  installDialogGuard();

  if (IS_OSAPI) runCoordinator();
  else runNode();
})();
