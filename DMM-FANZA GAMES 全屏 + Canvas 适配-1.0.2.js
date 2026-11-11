// ==UserScript==

// @name         DMM/FANZA GAMES 全屏 + Canvas 适配
// @namespace    https://play.games.dmm.co.jp/
// @version      1.0.2
// @description  点游戏画面任意位置即全屏（透明覆盖层），并把 canvas 显示尺寸同步为屏幕实际大小
// @author       you
// @license      MIT
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ============================================================================
 * DMM/FANZA GAMES 全屏 + Canvas 适配（精简发布版）
 *
 * 帧结构：outer(play.games.dmm.co.jp) → osapi.dmm.com → 游戏域名 → canvas
 *
 * 分工
 *   · 中转层（osapi / 含 #gameHTML5Canvas 的帧）：透明覆盖层 + 全屏请求 + 总开关
 *     全屏必须在 click 调用栈里发起（transient activation），否则必被拒绝。
 *   · 游戏层（其余 iframe，待机）：收到 enter 才注入样式并同步尺寸；
 *     本层没有 canvas 时，找出承载游戏的 iframe 顶满视口，再把 enter 转下去。
 *     包装页（如 /gadget）自带 fitGameCanvas() 会在 resize / ResizeObserver /
 *     MutationObserver 里把 iframe 缩回设计尺寸（scale 上限 1），会和我们互相
 *     覆盖导致掉帧 —— 所以全屏期间冻结它，退出时还原。
 *
 * 关键约束
 *   1. 不要加任何 @grant：进沙箱后合成 resize 传不到引擎。
 *   2. 非全屏态绝不碰 canvas：退出时视口缩回会触发真实 resize，
 *      此时改样式会和站点容器的 transform 叠加，画面会跑偏。
 *   3. 跨帧消息必须是「字符串」：iv-n-tight 等页面把 e.data 当字符串处理
 *      （e.data.indexOf），发对象会让它抛 TypeError 并打断自己的 RPC 链。
 *   4. 只改 CSS 显示尺寸，默认不动 canvas.width/height：
 *      不同 Unity 构建对 backing store 的处理不一致，强改容易错位。
 *   5. 视口一变立刻跟 CSS；派发合成 resize 只在尺寸真的变化时做一次，
 *      并屏蔽自己的监听器，避免自激循环。
 *
 * 兼容
 *   · girlscreationr 的构建对任何视口变化都会抛 TypeError 并弹 Unity 错误遮罩，
 *     脚本会移除遮罩 / 拦截该 alert，但那是游戏自身缺陷，无法根治。
 *   · canvas 的自定义 cursor 不要覆盖（站点用它挂 base64 .cur）。
 * ========================================================================== */

(() => {
  'use strict';

  if (window.parent === window) return;   // 顶层页面立即退出

  // ─────────────────────────── 配置 ───────────────────────────
  const CONFIG = {
    // 日志总开关：发布版保持 false。
    // log() 依然会被调用（保持与 9.2.0 相同的执行时序），但不再往 Console 写任何东西，
    // 长时间挂着页面也不会出现日志累积。排查问题时改成 true 即可恢复全部日志。
    // ⚠️ warn() 不受此开关影响，只在真的出错时打印。
    debug: true,

    // 显示尺寸铺法
    //   'stretch' : canvas 直接撑满视口（16:9 屏 + 16:9 游戏时等于 1:1）
    //   'contain' : 保持游戏原始画面比例居中，四周留黑边
    cssFit: 'stretch',

    // 渲染分辨率
    //   'auto'（默认）：不碰 canvas.width / height，由引擎自己适配，只读取并打印
    //   true          ：强制 canvas.width/height = 视口 × dpr。
    //                  ⚠️ 仅适用于会跟随视口重设的构建；对 lilyange 会导致画面锁在左下角
    //   false         ：完全不碰，也不打印
    forceBackingStore: 'auto',

    // 渲染倍率，仅 forceBackingStore = true 时生效
    pixelRatio: 'auto',

    // 自动移除 Unity 的错误遮罩框（DOM 版）。
    // 有些构建（如 girlscreationr / Unity 6000.3.8f1）只要视口变化就抛
    //   TypeError: Cannot read properties of undefined (reading 'id')
    // 然后 Unity 的 error handler 会盖一层 "An error occurred running the Unity content…"
    // 的遮罩。但游戏本身没死（关掉遮罩能正常玩），所以这里直接把遮罩移除，
    // 让它继续跑 —— 不碰引擎，只清理 UI。
    hideUnityErrorDialog: true,

    // 拦截浏览器原生弹窗（alert/confirm/prompt）里的 Unity 报错。
    // 有些构建不走 DOM 遮罩，而是直接 alert 一句
    //   "An error occurred running the Unity content on this page…"
    // 这种弹窗是浏览器级模态框，DOM 清理器拿它没办法，只能替换 window.alert。
    // 只按文案过滤：不含 Unity 报错文案的弹窗一律放行。
    suppressBrowserDialogs: true,

    // 进入全屏时临时清掉 canvas 祖先的 transform/filter
    neutralizeAncestors: true,

    // 铺满方式（Unity WebGL 的固定结构：iframe → #webgl-content → #unity-container → canvas#unity-canvas）
    //   'auto'   （默认，最不侵入）：先把 #webgl-content/#unity-container 容器铺满，
    //            canvas 只给 width/height:100%，由引擎自己按新尺寸重设；
    //            如果模板给 canvas 写死了 px、它没跟着长，才退回 9.1 的画布铺法。
    //   'canvas' ：只用 9.1 的画布铺法（canvas 直接 position:fixed + 100vw/100vh）
    //   'both'   ：容器与画布都强制铺满
    // ⚠️ 排查用：某个游戏一改尺寸就报 Unity 错时，先切 'canvas' 看是否复现，
    //    再切 'auto' 对比，就能确定是"容器"还是"画布"那一步触发的。
    resizeMode: 'canvas',

    // 包装页顶满（1.0.2，按 9.1 调整）
    //   'auto'（默认）：只有当包装页 iframe 看起来是「游戏窗口形状」(h/w ≤ 1.2) 时才顶满转发；
    //                  整页布局的包装页（如 muvluv 的 #atom-frame 100%×2524px）跳过，等同 9.1。
    //   true           ：任何包装页都顶满（girlscreationr 这类需要的老行为）。
    relayWrapperFrames: 'auto',

    // 点击层（覆盖层）是否只铺在游戏画面上
    //   true（默认）：游戏层会上报游戏窗口的位置，覆盖层收缩到该矩形，
    //                  两侧装饰（如 pjivn 的推特按钮）仍可点击。
    //   false         ：老的满屏覆盖，点游戏以外的地方也会进全屏。
    useOverlay: true,          // osapi 满屏覆盖（1.0.2 行为）
    overlayFollowGame: false,

    // 在「游戏 iframe 所在的那个文档」里放点击层，位置 = 游戏画面本身（同文档直接量，跨域无关）
    gameCover: false,

    // 是否复用 DMM 游戏自带的 fullScreen@1/@0 协议（1.0.2 没有，保持 false）
    nativeFullscreenMsg: false,
  };

  const ON_CLASS = 'dmm-canvas-fs';
  const CSS_CLASS = 'dmm-canvas-fs-css';
  const TARGET_CLASS = 'dmm-canvas-fs-target';
  const NEUTRAL_CLASS = 'dmm-canvas-fs-neutral';
  const NS = 'DMM_CANVAS_FS/1';
  const T = { TOGGLE: 'toggle', RESIZE: 'resize', ENTER: 'enter', EXIT: 'exit', RECT: 'rect' };
  const BTN_ID = 'dmm-canvas-fs-btn';
  const OVERLAY_ID = 'dmm-canvas-fs-overlay';
  const STYLE_ID = 'dmm-canvas-fs-style';
  const LS_KEY = 'dmm-canvas-fs:disabled';
  const CANVAS_FRAME_SEL = 'iframe#gameHTML5Canvas';
  const Z_TOP = 2147483647;
  const APPLY_DELAY = 350;
  const CHECK_DELAY = 200;
  const HOTKEY = { alt: true, ctrl: false, shift: false, meta: false, key: 'f' };

  // ─────────────────────────── 工具 ───────────────────────────
  const log = (...a) => { if (CONFIG.debug) console.log('%c[DMM CanvasFS]', 'color:#0a0', ...a); };
  const warn = (...a) => console.warn('[DMM CanvasFS]', ...a);
  const noop = () => {};
  const byId = (id) => document.getElementById(id);
  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => Array.prototype.slice.call(root.querySelectorAll(sel));

  // ⚠️ 消息载荷必须是「字符串」，不能用对象。
  // 目标页面自己的 message 监听器经常直接对 e.data 做字符串操作 ——
  // iv-n-tight 的 app_data 页（第 305 行）就是 `e.data.indexOf(...)`：
  // 我们发对象过去它立刻抛 "TypeError: e.data.indexOf is not a function"，
  // 把它自己的 RPC/尺寸协商处理链打断，游戏就卡在异常状态里。
  // 字符串对这类页面是安全的（indexOf 找不到只会返回 -1）。
  const msg = (type) => NS + '|' + type;
  const isMsg = (d) => typeof d === 'string' && d.indexOf(NS + '|') === 0;
  const msgType = (d) => d.slice(NS.length + 1).split('|')[0];
  const msgBody = (d) => { const s = d.slice(NS.length + 1); const i = s.indexOf('|'); return i < 0 ? '' : s.slice(i + 1); };

  function originOf(frame) {
    const src = frame.getAttribute('src') || '';
    if (!src || /^(about|javascript|blob|data):/i.test(src)) return '*';
    try {
      const o = new URL(src, location.href).origin;
      return o && o !== 'null' ? o : '*';
    } catch { return '*'; }
  }

  /** 发原始字符串给指定帧（DMM 自家协议用，不带我们的命名空间前缀） */
  function postRaw(frame, text) {
    if (!frame || !frame.contentWindow) return false;
    try { frame.contentWindow.postMessage(text, '*'); return true; }
    catch (e) { return false; }
  }

  function postTo(frame, data) {
    if (!frame || !frame.contentWindow) return false;
    try { frame.contentWindow.postMessage(data, originOf(frame)); return true; }
    catch (e) { warn('postMessage 失败', e); return false; }
  }

  function injectStyle(css) {
    if (byId(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  function debounce(fn, wait) {
    let t = 0;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); };
  }

  function waitFor(getEl, timeoutMs = 20000, stepMs = 500) {
    return new Promise((resolve) => {
      if (getEl()) return resolve(getEl());
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = getEl();
        if (el) { clearInterval(iv); resolve(el); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(null); }
      }, stepMs);
    });
  }

  const PARENT_ORIGIN = (() => {
    try { return document.referrer ? new URL(document.referrer).origin : '*'; } catch { return '*'; }
  })();

  function matchHotkey(e) {
    return e.altKey === HOTKEY.alt && e.ctrlKey === HOTKEY.ctrl &&
           e.shiftKey === HOTKEY.shift && e.metaKey === HOTKEY.meta &&
           e.key.toLowerCase() === HOTKEY.key;
  }

  /**
   * 挑游戏画面用的 canvas。
   * Unity WebGL 模板的固定套路是：
   *     #webgl-content  >  #unity-container  >  canvas#unity-canvas
   * 所以先认 #unity-canvas，再认 #webgl-content / #unity-container 里的 canvas，
   * 最后才退回 9.1 的「面积最大」——那一层容易抓到广告 / 统计用的 canvas，
   * 所以顺手剃掉 1×1 和不可见的。
   */
  function pickCanvas(root = document) {
    const explicit = byId('unity-canvas') || q('#unity-canvas', root) || q('canvas#unity-canvas', root);
    if (explicit) return explicit;

    const inWebgl = q('#webgl-content canvas', root) ||
                    q('#unity-container canvas', root) ||
                    q('.webgl-content canvas', root);
    if (inWebgl) return inWebgl;

    const list = qa('canvas', root).filter((c) => {
      const w = c.clientWidth || c.width || 0;
      const h = c.clientHeight || c.height || 0;
      return w > 2 && h > 2;      // 1×1 统计像素、隐藏的广告 canvas 一律不要
    });
    if (!list.length) return null;
    let best = list[0], bestArea = -1;
    list.forEach((c) => {
      const area = (c.clientWidth || c.width || 0) * (c.clientHeight || c.height || 0);
      if (area > bestArea) { bestArea = area; best = c; }
    });
    return best;
  }

  /**
   * canvas 所属的 Unity 容器（#webgl-content / #unity-container）。
   * 容器不跟着一起铺满时，引擎按容器算尺寸、画布却是整屏，两边不一致很容易报错。
   */
  function webglContainerOf(c) {
    let p = c && c.parentElement;
    let hops = 0;
    while (p && p !== document.body && p !== document.documentElement && hops < 4) {
      if (p.id === 'webgl-content' || p.id === 'unity-container' ||
          (p.classList && (p.classList.contains('webgl-content') || p.classList.contains('unity-container')))) {
        return p;
      }
      p = p.parentElement;
      hops++;
    }
    return null;
  }

  /** 排除公告 / 广告 / 分享 / 统计类 iframe */
  function isNonGameFrame(el) {
    const src = el.getAttribute('src') || '';
    let path = src;
    try {
      const u = new URL(src, location.href);
      path = u.host + u.pathname;
    } catch { /* keep src */ }
    const sig = [el.id, el.name, el.className, path].join(' ');
    return /(bottom|information|banner|advert|ads?[-_/.]|recommend|ranking|rank|news|footer|header|twitter|social|share|comment|tracking|analytics|pixel|beacon|rcv\.|rufous|doubleclick|googlesyndication|googletag|amazon-adsystem|i-mobile|popin|zucks|adingo|fluct|admax|microad|nend|gmossp|applovin)/i.test(sig);
  }

  /**
   * osapi 帧自身 URL 里的 ?url= 参数，就是游戏 gadget 的地址
   * （girlscreationr 是 https://www-r18.gc.dmmgames.com/gadget）。
   * 用它按 origin 认本体，比「取面积最大的 iframe」可靠得多。
   */
  function osapiGadgetOrigin() {
    try {
      const raw = new URLSearchParams(location.search).get('url');
      if (!raw) return null;
      const o = new URL(raw, location.href).origin;
      return o && o !== 'null' ? o : null;
    } catch { return null; }
  }

  /**
   * 找承载游戏本体的 iframe（跳过 about:blank）。
   * ⚠️ 不能取「面积最大的 iframe」：girlscreationr 的公告框
   *    #bottomframe（1280×1326）比游戏窗口 #iframe（1296×736）还大。
   */
  function pickFrame(root = document) {
    const all = qa('iframe', root).filter((el) => {
      const src = el.getAttribute('src') || '';
      return !!src && !/^about:/i.test(src);
    });
    if (!all.length) return null;

    // 先排除公告/广告/统计帧；万一全被排除，退回全集，避免一个都认不出来
    const game = all.filter((el) => !isNonGameFrame(el));
    const pool = game.length ? game : all;

    const prefer = [
      'iframe.main-contents',        // girlscreationr 的游戏窗口
      'iframe#gameHTML5Canvas',
      'iframe#iframe',
      'iframe[name="iframe"]',
      'iframe[id*="game" i]',
      'iframe[name*="game" i]',
      'iframe[src*="/iframe" i]',
      'iframe[src*="app_data" i]',
      'iframe[src*="/gadget" i]',
    ];

    let chosen = null;
    for (const sel of prefer) {
      const hit = qa(sel, root).find((el) => pool.indexOf(el) !== -1);
      if (hit) { chosen = hit; break; }
    }

    if (!chosen) {
      // 兜底：剩余候选里取面积最大
      let best = null, bestArea = -1;
      pool.forEach((el) => {
        const r = el.getBoundingClientRect();
        const area = Math.max(r.width, 1) * Math.max(r.height, 1);
        if (area > bestArea) { bestArea = area; best = el; }
      });
      chosen = best;
    }

    return chosen;
  }

  /** 把元素祖先里有 transform/filter 等的节点中和掉，返回被加类的祖先列表 */
  function neutralizeChain(el) {
    const list = [];
    if (!CONFIG.neutralizeAncestors) return list;
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      const isContainingBlock =
        cs.transform !== 'none' || cs.filter !== 'none' ||
        cs.perspective !== 'none' || cs.willChange !== 'auto' ||
        (cs.contain || '').includes('paint');
      if (isContainingBlock) {
        p.classList.add(NEUTRAL_CLASS);
        list.push(p);
        log('中和包含块祖先：', p.id || p.className || p.tagName);
      }
      p = p.parentElement;
    }
    return list;
  }

  /** 用内联 !important 把元素顶满视口 */
  function coverFrame(el) {
    const s = el.style;
    s.setProperty('position', 'fixed', 'important');
    s.setProperty('top', '0', 'important');
    s.setProperty('left', '0', 'important');
    s.setProperty('width', '100vw', 'important');
    s.setProperty('height', '100vh', 'important');
    s.setProperty('max-width', 'none', 'important');
    s.setProperty('max-height', 'none', 'important');
    s.setProperty('min-width', '0', 'important');
    s.setProperty('min-height', '0', 'important');
    s.setProperty('padding', '0', 'important');
    s.setProperty('margin', '0', 'important');
    s.setProperty('border', '0', 'important');
    s.setProperty('z-index', '2147483000', 'important');
    // 站点模板（如 iv-n-tight 的 fitGameCanvas）会用 transform: scale() 把 iframe
    // 缩回设计尺寸并居中；不清掉它，我们的铺满会被它盖回去。
    s.setProperty('transform', 'none', 'important');
    s.setProperty('transform-origin', '0 0', 'important');
  }

  /**
   * 站点自带的「自适应缩放」函数（iv-n-tight 的 window.fitGameCanvas）会在
   * resize / ResizeObserver / MutationObserver 里反复把 iframe 的 transform 改回去，
   * 而且 scale 上限写死为 1（永不放大）——和我们铺满的操作互相覆盖，形成抖动循环。
   * 全屏期间把它换成空函数，退出时原样还原。
   */
  function freezeSiteFit(on) {
    try {
      if (on) {
        if (typeof window.fitGameCanvas !== 'function' || window.__dmmfsFitFrozen) return false;
        window.__dmmfsFitOrigFit = window.fitGameCanvas;
        window.fitGameCanvas = function () { /* 全屏期间由脚本接管 */ };
        window.__dmmfsFitFrozen = true;
        log('已冻结站点的 fitGameCanvas');
        return true;
      }
      if (window.__dmmfsFitFrozen) {
        window.fitGameCanvas = window.__dmmfsFitOrigFit;
        window.__dmmfsFitFrozen = false;
        window.__dmmfsFitOrigFit = null;
        log('已还原站点的 fitGameCanvas');
      }
    } catch (e) { warn('冻结/还原 fitGameCanvas 失败：', e); }
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  //  中转层：osapi.dmm.com / osapi.games.dmm.com
  // ═══════════════════════════════════════════════════════════
  function runOsapi() {
    injectStyle(`
      html.${ON_CLASS},
      html.${ON_CLASS} body {
        overflow: hidden !important;
        margin: 0 !important; padding: 0 !important;
        background: #000 !important;
      }

      /* 几何强制只在 CSS 兜底模式生效。
         原生全屏时元素处于 top layer，尺寸由 UA 的 :fullscreen 规则决定；
         作者 !important 优先级高于 UA 规则，写死 100vw/100vh 会把全屏元素
         钉成 osapi 视口大小（= #game_frame 尺寸），表现为"只占一小块"。 */
      html.${CSS_CLASS} iframe.${TARGET_CLASS} {
        position: fixed !important;
        top: 0 !important; left: 0 !important;
        width: 100vw !important; height: 100vh !important;
        max-width: none !important; max-height: none !important;
        margin: 0 !important; padding: 0 !important; border: 0 !important;
        transform: none !important; transform-origin: 0 0 !important;
        background: #000 !important;
        z-index: ${Z_TOP} !important;
      }

      #${OVERLAY_ID} {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        width: 100vw; height: 100vh;
        z-index: ${Z_TOP - 2};
        background: transparent;
        cursor: default;
      }
      html.${ON_CLASS} #${OVERLAY_ID},
      #${OVERLAY_ID}[data-enabled="0"] {
        pointer-events: none !important;
      }

      #${BTN_ID} {
        position: fixed; top: 12px; right: 12px; z-index: ${Z_TOP - 1};
        width: 40px; height: 40px; padding: 0; border: 0; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        color: #fff; background: rgba(0, 0, 0, .5);
        cursor: pointer; opacity: .18;
        box-shadow: 0 2px 8px rgba(0, 0, 0, .35);
        transition: opacity .2s, transform .2s, background .2s;
        user-select: none; -webkit-user-select: none;
        touch-action: none;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      #${BTN_ID}::before {
        content: '⛶';
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 32px; line-height: 1;
        opacity: .95;
        pointer-events: none;
      }
      #${BTN_ID}::after {
        content: attr(data-letter);
        position: relative;
        font-size: 13px; font-weight: 700; line-height: 1;
        pointer-events: none;
      }
      #${BTN_ID}:hover { opacity: .95; transform: scale(1.06); }
      #${BTN_ID}[data-enabled="0"] { opacity: .85; background: rgba(120, 120, 120, .75); }
    `);

    // 本版唯一改动的一段（其余 300 行与 9.1 逐字一致）：
    // 9.1 在找不到 #gameHTML5Canvas 时直接退回「面积最大的 iframe」，
    // 在 girlscreationr 这类 osapi 页里会选中广告/官方资讯帧。
    // 改成先用自身 URL 的 ?url= 参数按 origin 认本体，认不到才退回 pickFrame()。
    function getGameFrame() {
      const direct = byId('gameHTML5Canvas') || q('iframe#gameHTML5Canvas');
      if (direct) return direct;

      const gadgetOrigin = osapiGadgetOrigin();
      if (gadgetOrigin) {
        const hit = qa('iframe').find((f) => {
          const src = f.getAttribute('src') || '';
          try { return new URL(src, location.href).origin === gadgetOrigin; } catch { return false; }
        });
        if (hit) {
          log('游戏帧按 ?url= 参数命中：', hit.id || hit.getAttribute('src'));
          return hit;
        }
      }

      return pickFrame();
    }

    let mode = 'off';       // 'off' | 'native' | 'css'
    let busy = false;
    let enabled = loadEnabled();

    function loadEnabled() {
      try { return localStorage.getItem(LS_KEY) !== '1'; } catch { return true; }
    }
    function saveEnabled(on) {
      try { on ? localStorage.removeItem(LS_KEY) : localStorage.setItem(LS_KEY, '1'); } catch { /* ignore */ }
    }

    /* ---------- 透明覆盖层（主入口） ---------- */
    function createOverlay() {
      if (byId(OVERLAY_ID) || !document.body) return;

      const ov = document.createElement('div');
      ov.id = OVERLAY_ID;
      ov.dataset.enabled = enabled ? '1' : '0';
      ov.setAttribute('aria-hidden', 'true');

      ov.addEventListener('click', (e) => {
        if (!enabled) return;
        e.preventDefault();
        e.stopPropagation();
        reconcile();
        if (mode === 'off') enter();
      });

      document.body.appendChild(ov);
      log('覆盖层已创建');
    }

    /**
     * 覆盖层只铺在「游戏画面」上，而不是整个视口。
     * pjivn 这类包装页两侧有装饰（推特按钮），满屏覆盖会把它们挡住、点不到。
     * 游戏画面在跨域的下一层里，读不到它的位置 —— 只能由游戏层用 RECT 消息告诉我们。
     */
    /* ---------- 手动校准：点两个角就“刚刚好”，不靠推算 ---------- */
    const CALIB_KEY = 'dmm-canvas-fs:rect';

    function loadCalib() {
      try {
        const v = JSON.parse(localStorage.getItem(CALIB_KEY) || 'null');
        if (!v || typeof v.x1 !== 'number') return null;
        return v;                       // 存的是视口比例 0..1，窗口缩放后仍对齐
      } catch (e) { return null; }
    }

    /** 有校准值就把点击层钉到该矩形；返回是否生效 */
    function applyCalibRect() {
      const v = loadCalib();
      const ov = byId(OVERLAY_ID);
      if (!v || !ov) return false;
      const vw = window.innerWidth, vh = window.innerHeight;
      const left = Math.min(v.x1, v.x2) * vw, top = Math.min(v.y1, v.y2) * vh;
      const right = Math.max(v.x1, v.x2) * vw, bottom = Math.max(v.y1, v.y2) * vh;
      const s = ov.style;
      s.setProperty('left', Math.round(left) + 'px', 'important');
      s.setProperty('top', Math.round(top) + 'px', 'important');
      s.setProperty('right', 'auto', 'important');
      s.setProperty('bottom', 'auto', 'important');
      s.setProperty('width', Math.round(right - left) + 'px', 'important');
      s.setProperty('height', Math.round(bottom - top) + 'px', 'important');
      return true;
    }

    function startCalibration() {
      if (!document.body) return;
      const cv = document.createElement('div');
      cv.id = 'dmm-canvas-fs-calib';
      const st = cv.style;
      st.setProperty('position', 'fixed', 'important');
      st.setProperty('inset', '0', 'important');
      st.setProperty('z-index', String(Z_TOP), 'important');
      st.setProperty('cursor', 'crosshair', 'important');
      st.setProperty('background', 'rgba(0,0,0,0.12)', 'important');

      const box = document.createElement('div');
      const bs = box.style;
      bs.setProperty('position', 'fixed', 'important');
      bs.setProperty('border', '2px solid #00ff88', 'important');
      bs.setProperty('background', 'rgba(0,255,136,0.18)', 'important');
      bs.setProperty('pointer-events', 'none', 'important');
      cv.appendChild(box);
      document.body.appendChild(cv);

      let p1 = null;
      const done = () => { if (cv.isConnected) cv.remove(); };

      cv.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!p1) { p1 = { x: e.clientX, y: e.clientY }; return; }
        const vw = window.innerWidth, vh = window.innerHeight;
        const v = { x1: p1.x / vw, y1: p1.y / vh, x2: e.clientX / vw, y2: e.clientY / vh };
        try { localStorage.setItem(CALIB_KEY, JSON.stringify(v)); } catch (err) { /* 忽略 */ }
        done();
        applyCalibRect();
        warn('游戏画面已校准并保存：点该矩形内=全屏，矩形外不响应');
      }, true);

      cv.addEventListener('mousemove', (e) => {
        if (!p1) return;
        bs.setProperty('left', Math.min(p1.x, e.clientX) + 'px', 'important');
        bs.setProperty('top', Math.min(p1.y, e.clientY) + 'px', 'important');
        bs.setProperty('width', Math.abs(e.clientX - p1.x) + 'px', 'important');
        bs.setProperty('height', Math.abs(e.clientY - p1.y) + 'px', 'important');
      });

      window.addEventListener('keydown', function esc(e) {
        if (e.key !== 'Escape') return;
        window.removeEventListener('keydown', esc, true);
        done();
        warn('校准已取消');
      }, true);

      warn('校准模式：先点游戏画面左上角，再点右下角（Esc 取消）');
    }

    function applyOverlayRect(payload) {
      if (loadCalib()) return;   // 已手动校准，自动上报不再覆盖
      if (!CONFIG.overlayFollowGame) return;
      if (document.documentElement.classList.contains(ON_CLASS)) return;   // 全屏态覆盖层本来就是 pointer-events:none
      const ov = byId(OVERLAY_ID);
      if (!ov) return;
      const p = String(payload || '').split(',').map(Number);
      if (p.length !== 4 || p.some((n) => !isFinite(n))) return;
      const x = p[0], y = p[1], w = p[2], h = p[3];   // 严格贴合，不加任何容差
      if (w < 80 || h < 60) return;                 // 明显不合理的矩形直接忽略
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.max(0, Math.min(x, vw - 40));
      const top = Math.max(0, Math.min(y, vh - 40));
      const ws = Math.max(40, Math.min(w, vw - left));
      const hs = Math.max(40, Math.min(h, vh - top));
      const s = ov.style;
      s.setProperty('left', left + 'px', 'important');
      s.setProperty('top', top + 'px', 'important');
      s.setProperty('right', 'auto', 'important');
      s.setProperty('bottom', 'auto', 'important');
      s.setProperty('width', ws + 'px', 'important');
      s.setProperty('height', hs + 'px', 'important');
    }

    /* ---------- 总开关按钮 ---------- */
    function createButton() {
      if (byId(BTN_ID) || !document.body) return;
      const btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';

      const drag = makeDraggable(btn);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (drag.wasDrag()) return;
        setEnabled(!enabled);
      });

      document.body.appendChild(btn);
      updateButton();
    }

    function setEnabled(on) {
      enabled = !!on;
      saveEnabled(enabled);

      const ov = byId(OVERLAY_ID);
      if (ov) ov.dataset.enabled = enabled ? '1' : '0';

      updateButton();
      if (!enabled && mode !== 'off') exit();
      log('脚本已' + (enabled ? '开启（A）' : '关闭（F）'));
    }

    function updateButton() {
      const btn = byId(BTN_ID);
      if (!btn) return;
      btn.dataset.enabled = enabled ? '1' : '0';
      btn.dataset.letter = enabled ? 'A' : 'F';
      btn.title = enabled
        ? '自动全屏：开（A）\n点游戏画面即全屏，Alt+F 也可；点此关闭脚本'
        : '自动全屏：关（F）\n点此重新开启';
      btn.setAttribute('aria-label', enabled ? '自动全屏已开启，点击关闭脚本' : '自动全屏已关闭，点击开启脚本');
    }

    function makeDraggable(el) {
      let sx = 0, sy = 0, ox = 0, oy = 0;
      let dragging = false, moved = false;

      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const r = el.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        dragging = true; moved = false;
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      });
      el.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true;
        el.style.left = (ox + dx) + 'px';
        el.style.top = (oy + dy) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);

      return {
        wasDrag() {
          if (!moved) return false;
          moved = false;
          return true;
        },
      };
    }

    /* ---------- 状态同步 ---------- */
    function syncClasses(on, cssFallback) {
      const de = document.documentElement;
      de.classList.toggle(ON_CLASS, !!on);
      de.classList.toggle(CSS_CLASS, !!(on && cssFallback));
    }

    function toGame(type) {
      const f = getGameFrame();
      if (!f) { warn('没找到承载游戏的 iframe'); return false; }
      return postTo(f, msg(type));
    }

    function reconcile() {
      const f = getGameFrame();
      if (f && document.fullscreenElement === f) {
        if (mode !== 'native') { mode = 'native'; syncClasses(true, false); }
        return;
      }
      if (mode === 'native') { markOff(); return; }
      if (mode === 'css' && !document.documentElement.classList.contains(ON_CLASS)) markOff();
    }

    function markOff() {
      mode = 'off';
      syncClasses(false, false);
      toGame(T.EXIT);
    }

    function enter() {
      const f = getGameFrame();
      if (!f) { warn('没找到承载游戏的 iframe'); return; }
      if (busy) return;
      busy = true;

      f.classList.add(TARGET_CLASS);
      syncClasses(false, false);

      const fallback = (e) => {
        warn('原生全屏不可用，改用 CSS 全屏：', (e && e.message) || e);
        mode = 'css';
        syncClasses(true, true);
        toGame(T.ENTER);
        setTimeout(() => { if (mode === 'css') toGame(T.RESIZE); }, APPLY_DELAY);
        busy = false;
      };

      const req = f.requestFullscreen || f.webkitRequestFullscreen ||
                  f.mozRequestFullScreen || f.msRequestFullscreen;
      if (!req) { fallback(new Error('requestFullscreen 不存在')); return; }

      let p;
      try { p = req.call(f); } catch (e) { fallback(e); return; }

      Promise.resolve(p).then(() => {
        mode = 'native';
        syncClasses(true, false);
        toGame(T.ENTER);
        busy = false;
      }, fallback);
    }

    function exit() {
      const needNativeExit = mode === 'native' || !!document.fullscreenElement;
      markOff();

      if (!needNativeExit) return;
      const ex = document.exitFullscreen || document.webkitExitFullscreen ||
                 document.mozCancelFullScreen || document.msExitFullscreen;
      if (!ex) return;
      try {
        const p = ex.call(document);
        if (p && typeof p.catch === 'function') p.catch(noop);
      } catch (e) { warn('exitFullscreen 异常：', e); }
    }

    function toggle() {
      if (!enabled) return;
      reconcile();
      if (mode === 'off') enter();
      else exit();
    }

    /* ---------- 事件 ---------- */
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!isMsg(d)) return;
      const child = getGameFrame();
      if (!child || e.source !== child.contentWindow) return;
      if (msgType(d) === T.TOGGLE) toggle();
      else if (msgType(d) === T.RECT) applyOverlayRect(msgBody(d));
    });

    document.addEventListener('keydown', (e) => {
      if (e.isComposing || e.repeat) return;
      if (matchHotkey(e)) { e.preventDefault(); toggle(); return; }
      if (e.key === 'Escape' && mode === 'css') exit();
    }, true);

    document.addEventListener('fullscreenchange', () => {
      const f = getGameFrame();

      if (f && document.fullscreenElement === f) {
        mode = 'native';
        syncClasses(true, false);
        toGame(T.RESIZE);
        setTimeout(() => { if (mode === 'native') toGame(T.RESIZE); }, APPLY_DELAY);
      } else if (!document.fullscreenElement && mode !== 'off') {
        markOff();
      }
    });

    const relayResize = debounce(() => {
      if (mode !== 'off') toGame(T.RESIZE);
    }, 120);
    window.addEventListener('resize', relayResize);
    window.addEventListener('resize', debounce(() => { if (!isOn()) reportGameRect(); }, 200));

    applyCalibRect();   // 有校准值就立刻钉住点击层
    window.addEventListener('resize', debounce(() => applyCalibRect(), 200));
    // 点击层是否创建：false 时页面上不留任何透明层，所有元素都能正常点击，
    // 全屏入口 = 右上角 ⛶ 按钮 / Alt+F。true 时才用覆盖层「点画面即全屏」。
    if (document.body) { createButton(); if (CONFIG.useOverlay) createOverlay(); }
    else waitFor(() => document.body).then(() => { createButton(); if (CONFIG.useOverlay) createOverlay(); });
  }

  // ═══════════════════════════════════════════════════════════
  //  游戏层：其余所有 iframe（待机，收到 enter 才激活）
  // ═══════════════════════════════════════════════════════════
  function runGame() {
    let armed = false;
    let saved = null;                 // { el, width, height, style, ancestors: [] }
    let relay = null;                 // 本层无 canvas 时：承载游戏的 iframe { el, style, ancestors }
    let selfResize = false;           // 正在派发自己造的 resize 事件
    let appliedCss = { w: 0, h: 0 };  // 上一次派发 resize 时的视口尺寸
    let engineLogged = false;

    // 先把浏览器原生弹窗拦住（要在用户点击、引擎报错之前就装好）
    suppressNativeDialogs();

    const isOn = () => document.documentElement.classList.contains(ON_CLASS);

    /**
     * 本帧视口是否已接近整屏 —— 只有原生全屏真生效时才是 true。
     * 用来挡住「全屏没成功却把游戏拉成竖长条」这种会把 Unity 弄崩的操作。
     */
    function viewportIsScreen() {
      const sw = (window.screen && window.screen.width) || 0;
      const sh = (window.screen && window.screen.height) || 0;
      if (!sw || !sh) return false;
      return window.innerWidth >= sw - 8 && window.innerHeight >= sh - 8;
    }

    /** 统一出口：派发 resize 时屏蔽自己的监听器，避免自激循环 */
    function fireResize() {
      selfResize = true;
      try { window.dispatchEvent(new Event('resize')); }
      finally { selfResize = false; }
    }
    /**
     * 自动移除 Unity 的错误遮罩框。
     * 这个构建只要视口变化就抛 TypeError，Unity 的 error handler 随后盖一层
     * "An error occurred running the Unity content…" 的遮罩；但引擎并没有死，
     * 关掉遮罩就能继续玩 —— 所以这里直接把它移除，别让它挡着画面。
     * 只清 UI，不碰 canvas / 引擎。
     */
    function hideUnityErrorDialogs() {
      if (!CONFIG.hideUnityErrorDialog) return;
      const MARK = /An error occurred running the Unity content/i;

      const hideOne = (el) => {
        if (!el || el.nodeType !== 1) return;
        if (el.dataset && el.dataset.__dmmfsHidden === '1') return;

        // 向上找最外层的固定/绝对定位祖先，那就是整块遮罩
        let box = el, p = el;
        for (let i = 0; i < 6 && p && p !== document.body; i++) {
          const cs = getComputedStyle(p);
          if (cs.position === 'fixed' || cs.position === 'absolute') box = p;
          p = p.parentElement;
        }
        if (box.dataset) box.dataset.__dmmfsHidden = '1';
        box.style.setProperty('display', 'none', 'important');
        box.style.setProperty('visibility', 'hidden', 'important');
        box.style.setProperty('pointer-events', 'none', 'important');
        log('已移除 Unity 报错遮罩（引擎未受影响，游戏继续运行）');
      };

      const scan = (root) => {
        if (!root || root.nodeType !== 1) return;
        if (MARK.test((root.textContent || '').slice(0, 300))) {
          // 命中的可能是整块容器，取最内层的最小匹配元素再向上找遮罩
          const inner = Array.prototype.slice.call(
            root.querySelectorAll('div,p,span,section,h1,h2,pre'))
            .filter((n) => MARK.test((n.textContent || '').slice(0, 300)))
            .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
          hideOne(inner || root);
        }
      };

      // 打全量扫描：脚本可能在遮罩出现之后才注入
      scan(document.body || document.documentElement);

      const mo = new MutationObserver((recs) => {
        recs.forEach((r) => {
          if (!r.addedNodes) return;
          r.addedNodes.forEach((n) => scan(n));
        });
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      log('已挂上 Unity 报错遮罩清理器');
    }

    /**
     * 拦截浏览器原生弹窗里的 Unity 报错。
     * alert/confirm/prompt 是浏览器级模态框，DOM 清理器碰不到，只能替换这些函数。
     * 过滤器只认 Unity 报错的文案，其它弹窗（游戏自己的提示）原样放行。
     */
    function suppressNativeDialogs() {
      if (!CONFIG.suppressBrowserDialogs) return;
      const MARK = /An error occurred running the Unity content|See your browser JavaScript console for more info/i;

      ['alert', 'confirm', 'prompt'].forEach((name) => {
        const orig = window[name];
        if (typeof orig !== 'function') return;
        window[name] = function (...args) {
          const text = String(args[0] == null ? '' : args[0]);
          if (MARK.test(text)) {
            // 用 log（受 debug 开关）而不是 warn：游戏每次 resize 都可能抛一次，
            // 这里若打成 warning，长时间挂着页面会刷满 Console。
            log(`已拦截浏览器弹窗 ${name}()`);
            return name === 'confirm' ? false : undefined;
          }
          return orig.apply(window, args);
        };
      });
      log('已拦截 Unity 的浏览器原生弹窗（只拦报错文案，其它放行）');
    }


    function arm() {
      if (armed) return;
      armed = true;

      hideUnityErrorDialogs();

      injectStyle(`
        html.${ON_CLASS},
        html.${ON_CLASS} body {
          overflow: hidden !important;
          margin: 0 !important; padding: 0 !important;
          background: #000 !important;
          width: 100vw !important; height: 100vh !important;
        }
        /* transform / filter / perspective / will-change / contain 都会让
           position:fixed 相对该祖先定位。Unity 默认模板的
           #unity-container.unity-desktop 带 translate(-50%,-50%)，必须中和，
           否则 fixed 的定位基准会跑偏。 */
        html.${ON_CLASS} .${NEUTRAL_CLASS} {
          transform: none !important;
          filter: none !important;
          perspective: none !important;
          will-change: auto !important;
          contain: none !important;
        }
      `);

      window.addEventListener('resize', () => {
        if (selfResize) return;   // 自己派发的，忽略
        if (!isOn()) return;      // 不在全屏态，一律不碰 canvas
        if (relay) { relayResizeDown(); return; }   // 本层无 canvas：顶满并转给下层
        followViewport();         // 立刻跟随视口，画面不会停在旧尺寸/角落
        scheduleSettle();         // 过渡结束后只派发一次 resize
      });

      log('游戏层已激活 | host =', location.host);
    }

    /* ---------- 记录原始状态 ---------- */
    function capture(c) {
      if (!c) return;
      if (saved && saved.el === c) return;
      saved = {
        el: c,
        width: c.getAttribute('width'),
        height: c.getAttribute('height'),
        style: c.getAttribute('style'),   // 含站点自定义 cursor（base64 .cur），原样保留
        boxEl: null,                      // #webgl-content / #unity-container
        boxStyle: null,
        ancestors: neutralizeChain(c),
      };

      // Unity 模板：连同容器一起记录，退出时才能还原
      const box = webglContainerOf(c);
      if (box) {
        saved.boxEl = box;
        saved.boxStyle = box.getAttribute('style');
        log('Unity 容器：', box.id ? '#' + box.id : box.tagName.toLowerCase(),
          '| 原始', Math.round(box.getBoundingClientRect().width) + 'x' + Math.round(box.getBoundingClientRect().height));
      }
    }

    /* ---------- 恢复 ---------- */
    function restoreCanvasSize() {
      const o = saved;
      if (!o) {
        sweepNeutral();
        return;
      }
      const c = o.el;

      if (c) {
        // 整体还原 style 属性，一并撤销 width/height/position 等内联改动，
        // 也把站点原生的自定义 cursor 恢复回去
        if (o.style === null) c.removeAttribute('style');
        else c.setAttribute('style', o.style);

        if (o.width === null) c.removeAttribute('width'); else c.setAttribute('width', o.width);
        if (o.height === null) c.removeAttribute('height'); else c.setAttribute('height', o.height);
      }

      // 容器也还原
      if (o.boxEl && o.boxEl.isConnected) {
        if (o.boxStyle === null) o.boxEl.removeAttribute('style');
        else o.boxEl.setAttribute('style', o.boxStyle);
      }
      sweepNeutral();

      saved = null;
      appliedCss = { w: 0, h: 0 };
      engineLogged = false;
      fireResize();
      log('已恢复原始 canvas 尺寸');
      setTimeout(reportGameRect, 80);   // 回到窗口态后重新上报游戏区域
    }

    /**
     * 上报「游戏画面在屏幕上的位置和大小」，供上层把点击层收缩到游戏画面上。
     * 有 canvas 的层报 canvas 本身；包装页报承载游戏的 iframe。
     * 每层都只报自己坐标系里的矩形，由上层逐层累加 iframe 偏移，最终精确对齐。
     */
    /* ---------- 在本层（和游戏 iframe 同一个文档）放点击层 ---------- */
    // 关键：覆盖层必须建在「游戏 iframe 所在的那个文档」里，
    // 这样能直接 getBoundingClientRect() 拿到游戏画面，不需要跨域换算。
    function installGameCover() {
      if (!CONFIG.gameCover) return;
      if (pickCanvas()) return;                 // canvas 层不需要
      let cv = byId('dmm-canvas-fs-cover');
      if (!cv) {
        cv = document.createElement('div');
        cv.id = 'dmm-canvas-fs-cover';
        cv.style.cssText = 'position:fixed;z-index:2147483000;background:transparent;cursor:pointer;';
        cv.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const f = pickFrame();
          if (!f) return;
          const req = f.requestFullscreen || f.webkitRequestFullscreen;
          if (!req) return;
          try { req.call(f); } catch (err) { warn('本层全屏失败：', err); }
        });
        (document.body || document.documentElement).appendChild(cv);
      }
      const f = pickFrame();
      if (!f) return;
      const r = f.getBoundingClientRect();
      const st = cv.style;
      st.left = Math.round(r.left) + 'px';
      st.top = Math.round(r.top) + 'px';
      st.width = Math.round(r.width) + 'px';
      st.height = Math.round(r.height) + 'px';
    }

    function reportGameRect() {
      try {
        if (window.parent === window) return;   // 顶层没有上层可报
        if (isOn()) return;                     // 全屏态矩形是满屏的，不能拿来当窗口态尺寸
        const f = (relay && relay.el && relay.el.isConnected) ? relay.el : pickFrame();

        // 直接用「承载游戏的那个 iframe」的矩形 —— 它就是游戏画面本身。
        // 不要用 canvas 的内框：canvas 常带留白/缩放，会比可见画面小一圈，
        // 导致画面边缘点不到。
        if (!f) return;
        const r = f.getBoundingClientRect();
        if (r.width > 0 && r.height / r.width > 1.2) return;   // 整页式包装（muvluv）不收缩
        sendRect(r.width, r.height, r.left, r.top);
      } catch (e) { /* 上报失败无所谓，覆盖层保持原样 */ }

      function sendRect(w, h, x, y) {
        if (w < 80 || h < 60) return;
        window.parent.postMessage(
          msg(T.RECT) + '|' + [Math.round(x), Math.round(y),
                               Math.round(w), Math.round(h)].join(','),
          PARENT_ORIGIN);
      }
    }


    /** 兜底清扫：把页面上所有残留的中和类都去掉，避免任何遗漏导致定位偏移 */
    function sweepNeutral() {
      qa('.' + NEUTRAL_CLASS).forEach((el) => el.classList.remove(NEUTRAL_CLASS));
    }

    /* ---------- 本层无 canvas 时：承载游戏的 iframe 快照 / 恢复 ---------- */
    function restoreFrame() {
      const o = relay;
      if (!o) { freezeSiteFit(false); sweepNeutral(); return; }
      const f = o.el;
      if (f && f.isConnected) {
        if (o.style === null) f.removeAttribute('style');
        else f.setAttribute('style', o.style);
      }
      freezeSiteFit(false);   // 先还原站点自己的自适应函数，再让它按新尺寸重算一次
      sweepNeutral();
      relay = null;
      try { if (typeof window.fitGameCanvas === 'function') window.fitGameCanvas(); } catch (e) { /* ignore */ }
      log('已恢复原始游戏 iframe 尺寸');
    }

    /** 视口变了：重新顶满并往下转发（包装页可能把 iframe 重新渲染了） */
    function relayResizeDown() {
      try {
        // 自愈：如果本层后来自己长出了 canvas，退回 9.1 的 canvas 路径
        if (pickCanvas()) {
          restoreFrame();
          followViewport();
          scheduleSettle();
          return;
        }
        if (!relay.el || !relay.el.isConnected) {
          const f = pickFrame();
          if (!f) return;
          relay = { el: f, style: f.getAttribute('style'), ancestors: neutralizeChain(f) };
        }
        coverFrame(relay.el);
        postTo(relay.el, msg(T.RESIZE));
      } catch (e) { warn('转发 resize 失败：', e); }
    }

    /* ---------- 显示尺寸（纯 CSS，不碰 canvas.width） ---------- */

    /** 把 Unity 容器（#webgl-content / #unity-container）钉满视口 */
    function applyBox(box, cssW, cssH) {
      const bs = box.style;
      bs.setProperty('position', 'fixed', 'important');
      bs.setProperty('left', '0', 'important');
      bs.setProperty('top', '0', 'important');
      bs.setProperty('width', cssW + 'px', 'important');
      bs.setProperty('height', cssH + 'px', 'important');
      bs.setProperty('max-width', 'none', 'important');
      bs.setProperty('max-height', 'none', 'important');
      bs.setProperty('margin', '0', 'important');
      bs.setProperty('padding', '0', 'important');
      bs.setProperty('transform', 'none', 'important');
      bs.setProperty('z-index', '2147483000', 'important');   // 压过页面里的头部/装饰层
    }

    /** 9.1 原样：直接把 canvas 铺满（position:fixed + 100vw/100vh） */
    function applyCanvasHard(c, cssW, cssH) {
      const s = c.style;
      s.setProperty('position', 'fixed', 'important');
      s.setProperty('margin', '0', 'important');
      s.setProperty('max-width', 'none', 'important');
      s.setProperty('max-height', 'none', 'important');
      s.setProperty('min-width', '0', 'important');
      s.setProperty('min-height', '0', 'important');
      s.setProperty('z-index', '2147483000', 'important');
      // 注意：不碰 cursor（站点用自定义 .cur）

      if (CONFIG.cssFit === 'contain') {
        const bw = c.width || 1920;
        const bh = c.height || 1080;
        const scale = Math.min(cssW / bw, cssH / bh);
        const w = Math.round(bw * scale);
        const h = Math.round(bh * scale);
        s.setProperty('width', w + 'px', 'important');
        s.setProperty('height', h + 'px', 'important');
        s.setProperty('left', Math.round((cssW - w) / 2) + 'px', 'important');
        s.setProperty('top', Math.round((cssH - h) / 2) + 'px', 'important');
      } else {
        s.setProperty('width', cssW + 'px', 'important');
        s.setProperty('height', cssH + 'px', 'important');
        s.setProperty('left', '0', 'important');
        s.setProperty('top', '0', 'important');
      }
    }

    function applyCssSize(c, cssW, cssH) {
      const box = saved && saved.boxEl;
      const mode = CONFIG.resizeMode;

      // ① 容器优先：Unity 是按 #webgl-content 的尺寸算视口和指针坐标的
      if (box && box.isConnected && mode !== 'canvas') {
        applyBox(box, cssW, cssH);

        if (mode === 'auto') {
          // 容器铺满了，canvas 只要跟着长；不动 position，让引擎自己排版
          const s = c.style;
          s.setProperty('width', '100%', 'important');
          s.setProperty('height', '100%', 'important');
          s.setProperty('max-width', 'none', 'important');
          s.setProperty('max-height', 'none', 'important');
          return;
        }
      }

      // ② 没有容器 / 'canvas' / 'both'：走 9.1 的画布铺法
      applyCanvasHard(c, cssW, cssH);
    }

    /** 只跟随视口改 CSS，不派发事件。⚠️ 非全屏态直接返回，绝不碰 canvas */
    function followViewport() {
      if (!isOn()) return;
      const c = pickCanvas();
      if (!c) return;
      capture(c);
      applyCssSize(c, Math.max(1, Math.round(window.innerWidth)), Math.max(1, Math.round(window.innerHeight)));
    }

    /** 视口稳定后的收尾：必要时派发一次 resize，并按配置决定是否强制 backing store */
    function settle() {
      if (!isOn()) return;      // 非全屏态直接返回
      const c = pickCanvas();
      if (!c) return;
      capture(c);

      const cssW = Math.max(1, Math.round(window.innerWidth));
      const cssH = Math.max(1, Math.round(window.innerHeight));
      applyCssSize(c, cssW, cssH);

      // 'auto' 模式的自愈：容器已铺满、canvas 却没跟上（模板给它写死了 px）
      // → 才退回 9.1 的画布铺法。容器自己都还没量出来时不动，避免误判。
      if (CONFIG.resizeMode === 'auto' && saved && saved.boxEl) {
        const boxW = saved.boxEl.clientWidth || 0;
        const boxH = saved.boxEl.clientHeight || 0;
        const canW = c.clientWidth || 0;
        const canH = c.clientHeight || 0;
        if (Math.abs(boxW - cssW) <= 8 && Math.abs(boxH - cssH) <= 8 &&
            (Math.abs(canW - cssW) > 8 || Math.abs(canH - cssH) > 8)) {
          if (!saved.hardCanvas) {
            saved.hardCanvas = true;
            warn(`容器已 ${boxW}x${boxH}，canvas 却是 ${canW}x${canH}，退回 9.1 的画布铺法`);
          }
          applyCanvasHard(c, cssW, cssH);
        }
      }

      // 派发合成 resize 的门控：
      //   默认只在视口尺寸真的变了才派发（9.2.0 行为）。
      //   7.7 是"每次 apply 都派发"，对引擎来说是更频繁的强制重算信号；
      //   个别构建（pjivn 切窗口回来）可能需要这种更频繁的推动 → 置 true 对比。
      if (cssW !== appliedCss.w || cssH !== appliedCss.h) {
        appliedCss = { w: cssW, h: cssH };
        log(`视口 ${cssW}x${cssH}，显示尺寸已同步`);
        fireResize();
      }

      // 强制模式：仅适用于会跟随视口重设的构建
      if (CONFIG.forceBackingStore === true) {
        const dpr = CONFIG.pixelRatio === 'auto'
          ? (window.devicePixelRatio || 1)
          : Number(CONFIG.pixelRatio);
        const w = Math.round(cssW * dpr);
        const h = Math.round(cssH * dpr);
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        fireResize();
        return;
      }

      // 'auto'：只观测，不干预
      if (CONFIG.forceBackingStore === 'auto' && !engineLogged) {
        engineLogged = true;
        setTimeout(() => {
          if (isOn() && saved && saved.el === c) {
            log(`引擎渲染分辨率 ${c.width}x${c.height}（显示 ${cssW}x${cssH}，dpr ${window.devicePixelRatio || 1}）`);
          }
        }, CHECK_DELAY);
      }
    }

    const scheduleSettle = debounce(settle, 120);

    /* ---------- 进入 / 退出 ---------- */
    function enter() {
      arm();
      if (saved) restoreCanvasSize();   // 上次 exit 若丢失，先复原再重新记录
      if (relay) restoreFrame();        // iframe 快照同理
      appliedCss = { w: 0, h: 0 };
      engineLogged = false;
      document.documentElement.classList.add(ON_CLASS);

      // 先按 9.1 的老路径处理「本层有 canvas」
      followViewport();     // 立刻铺一次（此时视口可能还是旧的，画面无变化）
      setTimeout(() => {    // 过渡结束后再铺一次并收尾
        if (!isOn()) return;
        if (pickCanvas()) { followViewport(); scheduleSettle(); return; }

        // 仍然没有 canvas：本层只是包装页，游戏在更下一层。
        // 等一拍再判定，是为了避开「canvas 建得比 enter 晚」的游戏被误判成包装页。
        // 这段是本版新增的唯一逻辑，用 try 包住：任何意外都只 warn，不抛到页面上
        try {
          const f = pickFrame();
          if (!f) { warn('本层既没有 canvas 也没有可转发的 iframe'); return; }

          // 只有原生全屏真的生效（本帧视口 = 整屏）时才顶满。
          // 未生效时视口只是 iframe 的布局尺寸（girlscreationr 是 1296×2027），
          // 这时顶满会把游戏拉成竖长条，某些 Unity 构建会直接抛错。
          if (!viewportIsScreen()) {
            warn(`本帧视口 ${window.innerWidth}x${window.innerHeight} 不是整屏（原生全屏未生效），` +
                 '不顶满也不转发，保持 9.1 的“什么都不做”');
            return;
          }

          // ⚠️ 再按 9.1 的判断：包装页的 iframe 如果不是「游戏窗口的形状」，就别顶满。
          // muvluv_ggx 的 #atom-frame 是 100% × 2524px（整页：头部 + 游戏 + 下方内容），
          // 顶满会把头部一起框进画面、游戏被挤到下面并切掉底部。
          // 游戏窗口通常是 16:9 左右（h/w ≈ 0.6），所以 h/w 明显偏大就跳过。
          if (CONFIG.relayWrapperFrames !== true) {
            const r = f.getBoundingClientRect();
            const ratio = r.width > 0 ? r.height / r.width : 99;
            if (ratio > 1.2) {
              log(`包装页 iframe 是整页布局（h/w = ${ratio.toFixed(2)}），按 9.1 的做法跳过顶满与转发`);
              return;
            }
          }

          relay = { el: f, style: f.getAttribute('style'), ancestors: neutralizeChain(f) };
          freezeSiteFit(true);   // 先停掉站点的自适应缩放，免得它把我们的铺满改回去
          coverFrame(f);         // 再顶满（coverFrame 会清掉残留的 transform: scale）
          log('本层无 canvas → 已顶满游戏 iframe 并转发 | src =', f.getAttribute('src'));
          postTo(f, msg(T.ENTER));
          // DMM 游戏自己的全屏协议：gadget 页监听字符串 'fullScreen_command'，
          // 并转发 'fullScreen@1' / 'fullScreen@0' 给 Unity 本体。用 @1/@0 直接置位
          // （不用 command，那是 toggle，进出不同步就会反）。由游戏自己摆画面，最准。
          if (CONFIG.nativeFullscreenMsg) postRaw(f, 'fullScreen@1');
        } catch (e) { warn('顶满/转发游戏 iframe 失败：', e); }
      }, APPLY_DELAY);
    }

    function exit() {
      document.documentElement.classList.remove(ON_CLASS);

      if (relay) {
        const f = relay.el;
        if (f && f.isConnected) { postTo(f, msg(T.EXIT)); if (CONFIG.nativeFullscreenMsg) postRaw(f, 'fullScreen@0'); }
        restoreFrame();
        return;
      }

      restoreCanvasSize();
      sweepNeutral();
      setTimeout(reportGameRect, 120);   // 退出后立刻按窗口态重新对准点击层
    }

    /* ---------- 消息 ---------- */
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!isMsg(d)) return;
      const type = msgType(d);

      // 子层上报「游戏画面在哪、多大」：加上本层这个 iframe 的偏移后继续往上抛，
      // 一路累加到最上层，覆盖层就能动态、精确地对准游戏画面。
      if (type === T.RECT) {
        const f = pickFrame();
        if (f && e.source === f.contentWindow) forwardRect(msgBody(d));
        return;
      }

      if (e.source !== window.parent) return;
      if (type === T.ENTER) enter();
      else if (type === T.EXIT) exit();
      else if (type === T.RESIZE) {
        if (!isOn()) return;
        if (relay) { relayResizeDown(); return; }
        scheduleSettle();
      }
    });

    /**
     * 把子层报上来的矩形换算到本帧坐标，再抛给上层。
     * 每层只做「加上自己这个 iframe 的边框偏移」这一件事，逐层累加即可对齐到屏幕。
     */
    function forwardRect(payload) {
      try {
        if (window.parent === window) return;
        const p = String(payload || '').split(',').map(Number);
        if (p.length !== 4 || p.some((n) => !isFinite(n))) return;
        if (p[2] < 40 || p[3] < 30) return;
        const f = pickFrame();
        if (!f) return;
        const r = f.getBoundingClientRect();
        const cs = getComputedStyle(f);
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const bt = parseFloat(cs.borderTopWidth) || 0;
        window.parent.postMessage(
          msg(T.RECT) + '|' + [Math.round(r.left + bl + p[0]), Math.round(r.top + bt + p[1]),
                               Math.round(p[2]), Math.round(p[3])].join(','),
          PARENT_ORIGIN);
      } catch (err) { /* 换算失败就放弃，覆盖层保持原样 */ }
    }

    // 首次上报（等布局稳定）：让上层把点击层收缩到游戏画面上，
    // 否则 pjivn 这类包装页两侧的装饰/推特按钮会被满屏覆盖层挡住。
    // 首次上报 + 动态跟随：布局变化（边框加载、--page-shift 位移、公告高度变化等）
    // 不会触发 resize，所以额外观察一次尺寸，并在延迟点补报几次。
    const rectTarget = () => pickCanvas() || ((relay && relay.el) || pickFrame());
    let rectRO = null;
    try {
      if (window.ResizeObserver) {
        rectRO = new ResizeObserver(() => reportGameRect());
        const el0 = rectTarget();
        if (el0) rectRO.observe(el0);
      }
    } catch (err) { /* 忽略 */ }

    [600, 1500, 3000, 6000].forEach((ms) => setTimeout(() => {
      if (rectRO && rectRO.disconnect) { /* 重新挂到最新元素 */ }
      const el = rectTarget();
      if (rectRO && el) { try { rectRO.disconnect(); rectRO.observe(el); } catch (err) {} }
      reportGameRect();
    }, ms));
    installGameCover();
    window.addEventListener('resize', debounce(() => { if (!document.documentElement.classList.contains('dmm-canvas-fs')) installGameCover(); }, 200));
    window.addEventListener('load', () => setTimeout(reportGameRect, 400));

    // Alt+F：键盘焦点通常在本帧，keydown 会把激活上传给中转层
    window.addEventListener('keydown', (e) => {
      if (!armed) return;
      if (e.isComposing || e.repeat) return;
      if (!matchHotkey(e)) return;
      e.preventDefault();
      try { window.parent.postMessage(msg(T.TOGGLE), PARENT_ORIGIN); } catch (err) { warn(err); }
    }, true);
  }

  // ─────────────────────────── 分派 ───────────────────────────
  const HOST = location.host;
  const OSAPI_HOST_RE = /^osapi\.[a-z0-9.-]*dmm\.com$/i;
  const hasCanvasFrame = () => !!(byId('gameHTML5Canvas') || q(CANVAS_FRAME_SEL));
  const isGadgetWrapper = () => /\/gadgets\/ifr\b/i.test(location.pathname + location.search);

  if (OSAPI_HOST_RE.test(HOST) || hasCanvasFrame() || isGadgetWrapper()) {
    log('role = osapi | host =', HOST);
    runOsapi();
    return;
  }

  runGame();
})();
