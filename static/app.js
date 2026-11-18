/* 사진 정리 — 화면 로직 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN = window.PC_TOKEN;

  const state = {
    root: null,            // 탐색기 최상위 경로
    nodes: new Map(),      // path -> {name, path, count, hasChildren, children:[path]|null, open, loading}
    rootChildren: [],
    q: '',
    folder: null,          // 현재 열린 폴더
    photos: [],            // [{name, path, size, mtime, viewable}]
    focus: 0,
    view: 'single',        // single | multi | grid
    nup: 2,                // 나란히 보기 장 수
    gridSize: 'm',
    smooth: 2,             // 전환 부드럽기 0(끄기)~4(아주 느리게)
    fs: false,             // 전체 화면 보기
    marks: new Map(),      // folderPath -> Set(photoPath)
    info: new Map(),
    stripEls: [],
    gridEls: [],
    settings: {},
  };

  // ------------------------------------------------------------ 유틸
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (b) => {
    if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(2) + 'TB';
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + 'GB';
    if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + 'MB';
    return Math.max(1, Math.round(b / 1024)) + 'KB';
  };
  const num3 = (i) => String(i + 1).padStart(3, '0');
  const thumbUrl = (p, size) => `/api/thumb?size=${size}&path=${encodeURIComponent(p)}`;
  const extOf = (name) => (name.split('.').pop() || '').toUpperCase();
  const isUnder = (target, dir) => target === dir || (target.startsWith(dir) && /[\\/]/.test(dir.slice(-1) + target.charAt(dir.length)));
  const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  }
  const post = (path, body) => api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
    body: JSON.stringify(body),
  });

  // 설정 저장(마지막 작업 폴더 등) — 너무 자주 쓰지 않도록 묶어서 저장
  let saveTimer = null; let pending = {};
  function saveSettings(changes) {
    Object.assign(pending, changes);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { const c = pending; pending = {}; post('/api/settings', c).catch(() => {}); }, 400);
  }

  let toastTimer = null;
  function toast(text, isErr = false) {
    const t = $('toast');
    t.textContent = text;
    t.classList.toggle('err', isErr);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 8000 : 5000);
  }

  const marksOf = (folder) => {
    if (!state.marks.has(folder)) state.marks.set(folder, new Set());
    return state.marks.get(folder);
  };

  // 별도 프로그램(pywebview) 창에서 실행 중인지
  const desktop = () => !!(window.pywebview && window.pywebview.api);

  // ------------------------------------------------------------ 확대 / 축소
  // 사진은 틀(box) 안에서만 확대·이동된다. 1배 = 창에 맞춤.
  const MAX_ZOOM = 10;
  function makeZoom(box, img, labelEl, onNav) {
    const z = { s: 1, x: 0, y: 0, moved: false };
    const apply = () => {
      img.style.transform = z.s === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
      box.classList.toggle('zoomed', z.s > 1);
      labelEl.textContent = z.s === 1 ? '맞춤' : `${z.s.toFixed(1)}배`;
      if (z.s >= 1.6) loadOriginal(img);
    };
    // 실제 사진이 그려지는 영역(맞춤 상태에서 여백 제외) 안에서만 움직이게 한다
    const clamp = () => {
      const w = box.clientWidth, h = box.clientHeight;
      const nw = img.naturalWidth || w, nh = img.naturalHeight || h;
      const fit = Math.min(w / nw, h / nh);
      const cw = nw * fit, ch = nh * fit, ox = (w - cw) / 2, oy = (h - ch) / 2;
      const axis = (pos, view, size, off) => (z.s * size <= view
        ? (view - z.s * size) / 2 - z.s * off
        : Math.min(-z.s * off, Math.max(view - z.s * (off + size), pos)));
      z.x = axis(z.x, w, cw, ox);
      z.y = axis(z.y, h, ch, oy);
    };
    const zoomAt = (ns, px, py) => {
      ns = Math.max(1, Math.min(MAX_ZOOM, ns));
      z.x = px - (px - z.x) * (ns / z.s);
      z.y = py - (py - z.y) * (ns / z.s);
      z.s = ns;
      if (ns === 1) { z.x = 0; z.y = 0; }
      clamp(); apply();
    };
    const center = () => [box.clientWidth / 2, box.clientHeight / 2];
    box.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey) {                       // Ctrl+휠 = 확대/축소
        const r = box.getBoundingClientRect();
        zoomAt(z.s * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      } else if (z.s > 1) {                  // 확대 중 휠 = 사진 위아래(Shift: 좌우) 이동
        const k = e.deltaMode === 1 ? 40 : 1;
        if (e.shiftKey) z.x -= e.deltaY * k; else { z.x -= e.deltaX * k; z.y -= e.deltaY * k; }
        clamp(); apply();
      } else if (onNav) {                    // 휠 = 이전/다음 사진
        onNav(e);
      }
    }, { passive: false });
    let drag = null;
    box.addEventListener('pointerdown', (e) => {
      z.moved = false;
      if (z.s <= 1 || e.button !== 0) return;
      drag = { px: e.clientX, py: e.clientY, x: z.x, y: z.y };
      box.setPointerCapture(e.pointerId);
      box.classList.add('dragging');
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
      if (Math.abs(dx) + Math.abs(dy) > 4) z.moved = true;
      z.x = drag.x + dx; z.y = drag.y + dy;
      clamp(); apply();
    });
    const end = () => { drag = null; box.classList.remove('dragging'); };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => { clamp(); apply(); });
    return {
      zoomIn: () => zoomAt(z.s * 1.25, ...center()),
      zoomOut: () => zoomAt(z.s / 1.25, ...center()),
      reset: () => { z.s = 1; z.x = 0; z.y = 0; apply(); },
      toggle: (px, py) => (z.s > 1 ? zoomAt(1, 0, 0) : zoomAt(2, px, py)),
      get dragged() { return z.moved; },
    };
  }

  // 크게 확대하면 원본 파일로 바꿔서 선명하게 보여 준다
  function loadOriginal(img) {
    const path = img.dataset.want;
    if (!path || img.dataset.orig === path) return;
    img.dataset.orig = path;
    const hi = new Image();
    hi.onload = () => { if (img.dataset.want === path) img.src = hi.src; };
    hi.src = `/api/original?path=${encodeURIComponent(path)}`;
  }

  // ------------------------------------------------------------ 전환 부드럽기
  // dur: 사진 바뀌는 시간(ms), slide: 밀리는 거리(px), gap: 휠로 넘기는 최소 간격(ms), move: 스크롤 이동 시간 배율
  const SMOOTH = [
    { dur: 0, slide: 0, gap: 120, move: 0.6 },     // 끄기
    { dur: 180, slide: 24, gap: 170, move: 0.8 },  // 빠르게
    { dur: 300, slide: 36, gap: 260, move: 1 },    // 보통
    { dur: 460, slide: 48, gap: 380, move: 1.4 },  // 느리게
    { dur: 680, slide: 60, gap: 540, move: 1.9 },  // 아주 느리게
  ];
  const smooth = () => SMOOTH[state.smooth] || SMOOTH[2];
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 사진 교체 효과: 이전 사진(복사본)은 dir 반대쪽으로 밀리며 사라지고, 새 사진은 dir 쪽에서 나타난다
  function slideSwap(img, dir) {
    const cfg = smooth();
    img.parentNode.querySelectorAll('.ghost').forEach((g) => g.remove());
    if (!cfg.dur || img.hidden || !img.getAttribute('src')) return;
    const ghost = img.cloneNode(false);
    ghost.removeAttribute('id');
    ghost.classList.add('ghost');
    img.after(ghost);
    const slide = reducedMotion ? 0 : cfg.slide * (dir || 0);
    const op = parseFloat(getComputedStyle(img).opacity) || 1;
    const base = ghost.style.transform || '';
    ghost.animate(
      [{ opacity: op, transform: `translateX(0px) ${base}` }, { opacity: 0, transform: `translateX(${-slide}px) ${base}` }],
      { duration: cfg.dur, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' },
    ).onfinish = () => ghost.remove();
    img.animate(
      [{ opacity: 0, transform: `translateX(${slide}px)` }, { opacity: op, transform: 'translateX(0px)' }],
      { duration: cfg.dur, easing: 'cubic-bezier(.2,.7,.3,1)' },
    );
  }

  // 큰 사진을 미리 받아 두어 넘길 때 흐린 사진이 먼저 보이지 않게 한다
  const loadedUrls = new Set();
  function preload(url) {
    if (loadedUrls.has(url)) return;
    const im = new Image();
    im.onload = () => loadedUrls.add(url);
    im.src = url;
  }
  function preloadAround(size) {
    for (const k of [1, -1, 2, -2]) {
      const p = state.photos[state.focus + k];
      if (p && p.viewable) preload(thumbUrl(p.path, size));
    }
  }

  // ------------------------------------------------------------ 휠 / 던지기
  // 휠 한 칸(또는 터치패드로 일정량)마다 dir(+1/-1)을 한 번 알려 준다
  function wheelStepper(fn) {
    let acc = 0, last = 0;
    return (e) => {
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 40 : 1);
      const now = performance.now();
      if (now - last < smooth().gap) { acc = 0; return; }   // 너무 빨리 넘어가지 않도록
      acc += d;
      if (Math.abs(acc) >= 50) { const dir = Math.sign(acc); acc = 0; last = now; fn(dir); }
    };
  }

  // 가로 스크롤 영역에 휠 좌우 이동과 "잡고 던지기" 관성 이동을 붙인다.
  // pitch()가 값을 주면 그 간격(사진 한 칸)에 맞춰 멈춘다.
  function makeKinetic(el, opts = {}) {
    let raf = null, anim = null, acc = 0;
    const maxPos = () => Math.max(0, el.scrollWidth - el.clientWidth);
    const clampP = (p) => Math.max(0, Math.min(maxPos(), p));
    const pitch = () => (opts.pitch ? opts.pitch() : 0);
    const snapP = (p) => { const s = pitch(); return s ? Math.round(p / s) * s : p; };
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = null; anim = null; };
    // base: 기본 이동 시간(ms). 멀리 갈수록 조금 더 길게, 처음엔 빠르고 끝에서 부드럽게 멈춘다.
    function animateTo(dest, base = 200) {
      dest = clampP(dest);
      const start = el.scrollLeft, t0 = performance.now();
      stop();
      const dist = dest - start;
      if (Math.abs(dist) < 0.5) { el.scrollLeft = dest; if (opts.onSettle) opts.onSettle(); return; }
      const mul = smooth().move;
      const dur = Math.min(base * 2.5, base + Math.abs(dist) * 0.25) * mul;
      anim = { dest };
      const step = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        const k = 1 - Math.pow(1 - t, 4);   // ease-out
        el.scrollLeft = start + dist * k;
        if (t >= 1) { el.scrollLeft = dest; raf = null; anim = null; if (opts.onSettle) opts.onSettle(); return; }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }

    el.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 40 : 1);
      if (!d) return;
      e.preventDefault();
      const base = anim ? anim.dest : el.scrollLeft;
      const s = pitch();
      if (s) {                                         // 한 칸씩
        acc += d;
        if (Math.abs(acc) < 50) return;
        const dir = Math.sign(acc); acc = 0;
        animateTo(snapP(base) + dir * s, 140);
      } else {
        animateTo(base + d * 1.6, 140);                // 부드럽게
      }
    }, { passive: false });

    let drag = null, suppressClick = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      stop();
      drag = { x: e.clientX, left: el.scrollLeft, moving: false, id: e.pointerId, samples: [[performance.now(), e.clientX]] };
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moving) {
        if (Math.abs(dx) < 6) return;
        drag.moving = true;
        try { el.setPointerCapture(drag.id); } catch (_) { /* 무시 */ }
        el.classList.add('flinging');
      }
      el.scrollLeft = drag.left - dx;
      const now = performance.now();
      drag.samples.push([now, e.clientX]);
      while (drag.samples.length > 2 && now - drag.samples[0][0] > 100) drag.samples.shift();
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      el.classList.remove('flinging');
      if (!d.moving) return;
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 60);
      const now = performance.now();
      const last = d.samples[d.samples.length - 1];
      const [t0, x0] = d.samples[0];
      const v = now - last[0] > 90 ? 0 : (x0 - e.clientX) / Math.max(1, now - t0);  // px/ms, 멈췄다 놓으면 0
      animateTo(snapP(el.scrollLeft + v * 350), 300);  // 던진 속도만큼 미끄러지듯 이동
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // 끌어서 던진 뒤에는 사진 클릭으로 처리하지 않는다
    el.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
    el.addEventListener('dblclick', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);

    return { animateTo, stop, get busy() { return !!anim || !!(drag && drag.moving); }, get target() { return anim ? anim.dest : el.scrollLeft; } };
  }

  // ------------------------------------------------------------ 시작
  async function init() {
    const [roots, settings] = await Promise.all([api('/api/roots'), api('/api/settings')]);
    state.settings = settings;
    state.view = ['single', 'multi', 'grid'].includes(settings.view) ? settings.view : 'single';
    state.nup = [2, 3, 4, 5, 6, 8].includes(+settings.nup) ? +settings.nup : 2;
    state.gridSize = ['s', 'm', 'l'].includes(settings.gridSize) ? settings.gridSize : 'm';
    setSidebar(settings.sidebar !== false, false);
    state.smooth = [0, 1, 2, 3, 4].includes(+settings.smooth) ? +settings.smooth : 2;
    $('smooth').value = String(state.smooth);
    $('nup').value = String(state.nup);
    $('gsize').value = state.gridSize;
    applyViewButtons();

    fillRoots(roots.roots);
    const start = roots.start || (roots.roots[0] && roots.roots[0].path);
    if (start) {
      $('root-select').value = start;
      const restore = settings.root === start ? settings : {};
      await setRoot(start, restore.folder, restore.photo);
    }
  }

  function fillRoots(list) {
    const sel = $('root-select');
    sel.innerHTML = list.map((r) => `<option value="${esc(r.path)}">${esc(r.name)}</option>`).join('');
  }

  function addRootOption(path) {
    const sel = $('root-select');
    if (![...sel.options].some((o) => o.value === path)) {
      const o = document.createElement('option');
      o.value = path; o.textContent = path;
      sel.insertBefore(o, sel.firstChild);
    }
    sel.value = path;
  }

  // ------------------------------------------------------------ 좌측 메뉴 숨기기/보이기
  function setSidebar(show, save = true) {
    document.querySelector('.app').classList.toggle('no-sidebar', !show);
    const b = $('sidebar-btn');
    b.setAttribute('aria-pressed', show);
    b.setAttribute('aria-label', show ? '좌측 메뉴 숨기기 (B)' : '좌측 메뉴 보이기 (B)');
    window.dispatchEvent(new Event('resize'));  // 사진 확대 위치 등 다시 계산
    if (save) saveSettings({ sidebar: show });
  }
  const sidebarShown = () => !document.querySelector('.app').classList.contains('no-sidebar');
  $('sidebar-btn').addEventListener('click', () => setSidebar(!sidebarShown()));

  // ------------------------------------------------------------ 탐색기
  async function setRoot(path, restoreFolder, restorePhoto) {
    state.root = path;
    state.nodes.clear();
    state.rootChildren = [];
    $('tree').innerHTML = '<div class="tree-msg">불러오는 중…</div>';
    try {
      const data = await api('/api/dirs?path=' + encodeURIComponent(path));
      state.rootChildren = addNodes(data.dirs);
      $('disk-usage').textContent = data.disk ? `${fmtSize(data.disk.used)} 사용 / ${fmtSize(data.disk.total)}` : '';
      renderTree();
    } catch (e) {
      $('tree').innerHTML = `<div class="tree-msg">${esc(e.message)}</div>`;
      return;
    }
    saveSettings({ root: path });
    if (restoreFolder && isUnder(restoreFolder, path)) {
      const ok = await revealFolder(restoreFolder);
      if (ok) { await openFolder(restoreFolder, false, restorePhoto); return; }
    }
    await openFolder(path, true);
  }

  // 마지막 작업 폴더까지 트리를 차례로 펼친다
  async function revealFolder(target) {
    if (target === state.root) return true;
    let level = state.rootChildren;
    for (let guard = 0; guard < 64; guard++) {
      const hit = level.find((p) => isUnder(target, p));
      if (!hit) return false;
      if (hit === target) {
        renderTree();
        const el = [...document.querySelectorAll('.node')].find((n) => n.dataset.path === target);
        if (el) el.scrollIntoView({ block: 'center' });
        return true;
      }
      const node = state.nodes.get(hit);
      await expand(node);
      level = node.children || [];
    }
    return false;
  }

  function addNodes(dirs) {
    return dirs.map((d) => {
      if (!state.nodes.has(d.path)) state.nodes.set(d.path, { ...d, children: null, open: false, loading: false });
      return d.path;
    });
  }

  async function expand(node) {
    if (node.children === null && node.hasChildren && !node.loading) {
      node.loading = true;
      renderTree();
      try {
        const data = await api('/api/dirs?path=' + encodeURIComponent(node.path));
        node.children = addNodes(data.dirs);
      } catch (e) {
        node.children = [];
        toast(e.message, true);
      }
      node.loading = false;
    }
    node.open = true;
    renderTree();
  }

  function matches(path) {
    const n = state.nodes.get(path);
    if (!state.q) return true;
    if (n.name.toLowerCase().includes(state.q)) return true;
    return (n.children || []).some(matches);
  }

  function renderTree() {
    const rows = [];
    const walk = (paths, depth) => {
      for (const p of paths) {
        if (!matches(p)) continue;
        const n = state.nodes.get(p);
        const open = n.open || (state.q && (n.children || []).some(matches));
        const marked = state.marks.has(p) ? state.marks.get(p).size : 0;
        const chevCls = !n.hasChildren ? 'none' : open ? 'open' : '';
        rows.push(`<button class="node${p === state.folder ? ' sel' : ''}" data-path="${esc(p)}" role="treeitem" aria-expanded="${n.hasChildren ? !!open : ''}" style="padding-left:${10 + depth * 18}px">
          <svg class="chev ${chevCls}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9AA1AA" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          <svg class="folder" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <span class="nm">${esc(n.name)}</span>
          ${n.loading ? '<span class="cnt">…</span>' : n.count ? `<span class="cnt">${n.count}</span>` : ''}
          ${marked ? `<span class="badge" title="삭제 표시">${marked}</span>` : ''}
        </button>`);
        if (open && n.children) walk(n.children, depth + 1);
      }
    };
    walk(state.rootChildren, 0);
    $('tree').innerHTML = rows.join('') || `<div class="tree-msg">${state.q ? '맞는 폴더가 없습니다 (펼쳐 본 폴더 안에서 찾습니다)' : '하위 폴더가 없습니다'}</div>`;
  }

  $('tree').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.node');
    if (!btn) return;
    const n = state.nodes.get(btn.dataset.path);
    const clickedChevron = ev.target.closest('.chev');
    if (n.hasChildren) {
      if (n.open && (clickedChevron || n.path === state.folder)) { n.open = false; renderTree(); }
      else expand(n);
    }
    if (!clickedChevron) openFolder(n.path);
  });

  $('folder-search').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderTree(); });
  $('root-select').addEventListener('change', (e) => { e.target.blur(); setRoot(e.target.value); });

  $('open-folder').addEventListener('click', async () => {
    let path = null;
    if (desktop()) {
      try { path = await window.pywebview.api.pick_folder(); } catch (e) { toast(String(e), true); }
    } else {
      path = window.prompt('열 사진 폴더 경로를 입력하세요 (예: E:\\사진)', state.root || '');
    }
    if (!path) return;
    path = path.trim();
    addRootOption(path);
    setRoot(path);
  });

  // ------------------------------------------------------------ 폴더 열기
  async function openFolder(path, quiet = false, focusName = null) {
    try {
      const data = await api('/api/photos?path=' + encodeURIComponent(path));
      if (quiet && data.photos.length === 0) { showFolder(null, []); return; }
      showFolder(path, data.photos);
      if (focusName) {
        const i = data.photos.findIndex((p) => p.name === focusName);
        if (i > 0) setFocus(i);
      }
      saveSettings({ root: state.root, folder: path, photo: state.photos[state.focus] ? state.photos[state.focus].name : null });
    } catch (e) {
      toast(e.message, true);
    }
  }

  function showFolder(path, photos) {
    state.folder = path;
    state.photos = photos;
    state.focus = 0;
    multiBuiltFor = null;
    const n = path && state.nodes.get(path);
    const name = n ? n.name : path ? baseName(path) : '';
    $('path-label').textContent = path || '';
    $('path-label').title = path || '';
    $('index-title').textContent = path ? `${name} · ${photos.length}장` : '';
    buildStrip();
    buildGrid();
    renderTree();
    renderAll();
  }

  // ------------------------------------------------------------ 인덱스 / 바둑판
  function buildStrip() {
    const strip = $('strip');
    strip.innerHTML = state.photos.map((p, i) => `
      <button class="ix" data-i="${i}" aria-label="${i + 1}번 ${esc(p.name)}">
        <span class="th">${p.viewable ? `<img loading="lazy" draggable="false" src="${thumbUrl(p.path, 's')}" alt="">` : `<span class="ext">${esc(extOf(p.name))}</span>`}
          <span class="x"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1A0E0A" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></span>
        </span>
        <span class="num">${num3(i)}</span>
      </button>`).join('');
    state.stripEls = [...strip.children];
  }

  function buildGrid() {
    const grid = $('grid');
    grid.innerHTML = state.photos.map((p, i) => `
      <div class="cell" data-i="${i}">
        <button class="pic" data-i="${i}" aria-label="${esc(p.name)} 삭제 표시 전환 (더블클릭: 전체 화면)">
          ${p.viewable ? `<img loading="lazy" src="${thumbUrl(p.path, 'm')}" alt="">` : `<span class="ext">${esc(extOf(p.name))}</span>`}
          <span class="tag">${num3(i)}</span>
          <span class="del"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1A0E0A" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>삭제</span>
        </button>
        <div class="row"><input type="checkbox" id="cb-${i}" data-i="${i}"><label for="cb-${i}" title="${esc(p.name)}">${esc(p.name)}</label></div>
        <span class="sub">${esc(p.mtime)} · ${fmtSize(p.size)}</span>
      </div>`).join('');
    state.gridEls = [...grid.children];
  }

  $('strip').addEventListener('click', (ev) => {
    const b = ev.target.closest('.ix');
    if (b) setFocus(+b.dataset.i);
  });
  $('strip').addEventListener('dblclick', (ev) => {
    const b = ev.target.closest('.ix');
    if (b) { setFocus(+b.dataset.i); openFs(); }
  });

  // 클릭 = 삭제 표시 전환, 더블클릭 = 전체 화면 (더블클릭 때는 표시를 바꾸지 않도록 잠깐 기다린다)
  let clickTimer = null;
  function clickOrDbl(i) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; setFocus(i, false); openFs(); return; }
    clickTimer = setTimeout(() => { clickTimer = null; setFocus(i, false); toggleMark(i); }, 230);
  }
  $('grid').addEventListener('click', (ev) => {
    const pic = ev.target.closest('.pic');
    if (pic) clickOrDbl(+pic.dataset.i);
  });
  $('grid').addEventListener('change', (ev) => {
    if (ev.target.matches('input[type=checkbox]')) { const i = +ev.target.dataset.i; setFocus(i, false); toggleMark(i); }
  });

  // ------------------------------------------------------------ 나란히 보기
  // 폴더의 모든 사진을 가로 한 줄로 만들어 두고, 화면 폭에 정한 장 수만큼 보이게 한다.
  const MULTI_GAP = 12;
  let multiBuiltFor = null;
  const multiPitch = () => {
    const c = $('multi').firstElementChild;
    return c ? c.getBoundingClientRect().width + MULTI_GAP : 0;
  };

  function sizeMulti() {
    const box = $('multi');
    const n = Math.max(1, Math.min(state.nup, state.photos.length || 1));
    const cw = Math.max(80, (box.clientWidth - MULTI_GAP * (n - 1)) / n);
    box.style.setProperty('--cw', `${cw}px`);
  }

  function buildMulti() {
    const box = $('multi');
    multiBuiltFor = state.folder;
    box.innerHTML = state.photos.map((p, i) => `<div class="mcell" data-i="${i}">
        <button class="mpic" data-i="${i}" aria-label="${esc(p.name)} (클릭: 선택, 더블클릭: 전체 화면)">
          ${p.viewable ? `<img loading="lazy" draggable="false" src="${thumbUrl(p.path, 'l')}" alt="">` : `<span class="ext">${esc(extOf(p.name))}</span>`}
          <span class="tag">${num3(i)}</span>
          <span class="del"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1A0E0A" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>삭제</span>
        </button>
        <div class="mrow">
          <span class="nm" title="${esc(p.name)}">${esc(p.name)}</span>
          <span class="sub">${fmtSize(p.size)}</span>
          <button class="mtoggle" data-i="${i}"></button>
        </div>
      </div>`).join('');
    state.multiEls = [...box.children];
    sizeMulti();
    box.scrollLeft = 0;
  }

  // 현재 사진이 화면에 보이도록 나란히 보기를 움직인다
  function ensureMultiVisible(instant = false) {
    const box = $('multi');
    const pitch = multiPitch();
    if (!pitch || multiKinetic.busy) return;
    const n = Math.min(state.nup, state.photos.length);
    const first = Math.round(box.scrollLeft / pitch);
    let dest = null;
    if (state.focus < first) dest = state.focus * pitch;
    else if (state.focus > first + n - 1) dest = (state.focus - n + 1) * pitch;
    else if (Math.abs(box.scrollLeft - first * pitch) > 1) dest = first * pitch;  // 칸에 맞춤
    if (dest === null) return;
    if (instant) box.scrollLeft = dest; else multiKinetic.animateTo(dest, 160);
  }

  // 휠/던지기로 움직인 뒤 현재 사진이 화면 밖이면, 보이는 사진으로 옮긴다
  function multiSettled() {
    const pitch = multiPitch();
    if (!pitch || state.view !== 'multi') return;
    const n = Math.min(state.nup, state.photos.length);
    const first = Math.round($('multi').scrollLeft / pitch);
    if (state.focus < first) setFocus(first);
    else if (state.focus > first + n - 1) setFocus(first + n - 1);
  }

  const multiKinetic = makeKinetic($('multi'), { pitch: multiPitch, onSettle: multiSettled });

  function renderMulti(m) {
    if (multiBuiltFor !== state.folder || (state.multiEls || []).length !== state.photos.length) buildMulti();
    state.multiEls.forEach((c, i) => {
      const mk = m.has(state.photos[i].path);
      c.classList.toggle('marked', mk);
      c.classList.toggle('focus', i === state.focus);
      const t = c.querySelector('.mtoggle');
      const label = mk ? '표시 해제' : '삭제 표시';
      if (t.textContent !== label) t.textContent = label;
    });
    ensureMultiVisible();
  }

  $('multi').addEventListener('click', (ev) => {
    const t = ev.target.closest('.mtoggle');
    if (t) { const i = +t.dataset.i; setFocus(i); toggleMark(i); return; }
    const pic = ev.target.closest('.mpic');
    if (pic) setFocus(+pic.dataset.i);
  });
  $('multi').addEventListener('dblclick', (ev) => {
    const pic = ev.target.closest('.mpic');
    if (pic) { setFocus(+pic.dataset.i, false); openFs(); }
  });
  new ResizeObserver(() => {
    if (state.view !== 'multi' || !state.photos.length) return;
    sizeMulti();
    multiKinetic.stop();
    ensureMultiVisible(true);
  }).observe($('multi'));

  // 인덱스: 휠로 좌우 스크롤, 잡고 던지면 관성 이동 (항상)
  const stripKinetic = makeKinetic($('strip'));
  function centerStrip(i) {
    const el = state.stripEls[i];
    if (!el) return;
    const strip = $('strip');
    stripKinetic.animateTo(el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2, 180);
  }

  // ------------------------------------------------------------ 상태 변경
  let navDir = 0;   // 직전 이동 방향 (+1 다음, -1 이전) — 전환 효과 방향
  function setFocus(i, scroll = true) {
    if (!state.photos.length) return;
    const next = Math.max(0, Math.min(state.photos.length - 1, i));
    navDir = Math.sign(next - state.focus);
    state.focus = next;
    renderAll();
    navDir = 0;
    const p = state.photos[state.focus];
    if (p) saveSettings({ photo: p.name });
    if (scroll) {
      centerStrip(state.focus);
      if (state.view === 'grid') {
        const g = state.gridEls[state.focus];
        if (g) g.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  function toggleMark(i) {
    const p = state.photos[i];
    if (!p) return;
    const m = marksOf(state.folder);
    if (m.has(p.path)) m.delete(p.path); else m.add(p.path);
    renderAll();
    renderTree();
  }

  function applyViewButtons() {
    document.querySelectorAll('.seg [data-view]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === state.view));
    $('nup-wrap').hidden = state.view !== 'multi';
    $('gsize-wrap').hidden = state.view !== 'grid';
    $('grid').className = `grid gs-${state.gridSize}`;
  }

  function setView(v) {
    state.view = v;
    applyViewButtons();
    renderAll();
    saveSettings({ view: v });
    if (v === 'grid') { const g = state.gridEls[state.focus]; if (g) g.scrollIntoView({ block: 'nearest' }); }
  }
  document.querySelectorAll('.seg [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('nup').addEventListener('change', (e) => { e.target.blur(); state.nup = +e.target.value; sizeMulti(); multiKinetic.stop(); renderAll(); ensureMultiVisible(true); saveSettings({ nup: state.nup }); });
  $('smooth').addEventListener('change', (e) => { e.target.blur(); state.smooth = +e.target.value; saveSettings({ smooth: state.smooth }); });
  $('gsize').addEventListener('change', (e) => { e.target.blur(); state.gridSize = e.target.value; applyViewButtons(); saveSettings({ gridSize: state.gridSize }); });

  $('prev').addEventListener('click', () => setFocus(state.focus - 1));
  $('next').addEventListener('click', () => setFocus(state.focus + 1));
  $('toggle-btn').addEventListener('click', () => toggleMark(state.focus));
  const navWheel = wheelStepper((dir) => setFocus(state.focus + dir));
  const bigZoom = makeZoom($('big'), $('big-img'), $('zoom-label'), navWheel);
  const fsZoom = makeZoom($('fs-stage'), $('fs-img'), $('fs-zoom-label'), navWheel);
  $('big').addEventListener('dblclick', () => { if (!bigZoom.dragged) openFs(); });
  $('zoom-in').addEventListener('click', () => bigZoom.zoomIn());
  $('zoom-out').addEventListener('click', () => bigZoom.zoomOut());
  $('zoom-label').addEventListener('click', () => bigZoom.reset());
  $('fs-zoom-in').addEventListener('click', () => fsZoom.zoomIn());
  $('fs-zoom-out').addEventListener('click', () => fsZoom.zoomOut());
  $('fs-zoom-label').addEventListener('click', () => fsZoom.reset());
  $('fs-btn').addEventListener('click', () => openFs());

  $('mark-all').addEventListener('click', () => {
    if (!state.folder) return;
    const m = marksOf(state.folder);
    state.photos.forEach((p) => m.add(p.path));
    renderAll(); renderTree();
  });
  $('clear-all').addEventListener('click', () => {
    if (!state.folder) return;
    marksOf(state.folder).clear();
    renderAll(); renderTree();
  });

  // ------------------------------------------------------------ 전체 화면
  function openFs() {
    if (!state.photos.length) return;
    state.fs = true;
    fsFor = null;
    $('fs').hidden = false;
    if (desktop()) window.pywebview.api.set_fullscreen(true).catch(() => {});
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    renderAll();
    $('fs-close').focus();
  }
  function closeFs() {
    state.fs = false;
    $('fs').hidden = true;
    if (desktop()) window.pywebview.api.set_fullscreen(false).catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    renderAll();
    const s = state.stripEls[state.focus];
    if (s) s.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && state.fs && !desktop()) closeFs(); });
  $('fs-close').addEventListener('click', closeFs);
  $('fs-prev').addEventListener('click', () => setFocus(state.focus - 1));
  $('fs-next').addEventListener('click', () => setFocus(state.focus + 1));
  $('fs-toggle').addEventListener('click', () => toggleMark(state.focus));
  $('fs-stage').addEventListener('dblclick', (e) => {
    if (fsZoom.dragged) return;
    const r = $('fs-stage').getBoundingClientRect();
    fsZoom.toggle(e.clientX - r.left, e.clientY - r.top);  // 전체 화면에서 더블클릭 = 2배 확대 / 맞춤
  });

  let fsFor = null;
  function renderFs(m) {
    const p = state.photos[state.focus];
    if (!p) { closeFs(); return; }
    const mk = m.has(p.path);
    $('fs-stage').classList.toggle('marked', mk);
    if (fsFor !== p.path) {
      if (fsFor && navDir) slideSwap($('fs-img'), navDir);
      fsFor = p.path;
      showImage($('fs-img'), $('fs-noprev'), p, 'x');
      preloadAround('x');
    }
    $('fs-pos').textContent = `${state.focus + 1} / ${state.photos.length}`;
    $('fs-name').textContent = p.name;
    $('fs-toggle').textContent = mk ? '삭제 표시 해제' : '삭제 표시';
    $('fs-toggle').classList.toggle('on', mk);
    $('fs-prev').disabled = state.focus === 0;
    $('fs-next').disabled = state.focus >= state.photos.length - 1;
  }

  // 큰 사진: 먼저 작은 썸네일을 보여 주고 큰 사진이 오면 바꾼다
  function showImage(img, noprev, p, size) {
    if (img === $('big-img') && bigZoom) bigZoom.reset();
    if (img === $('fs-img') && fsZoom) fsZoom.reset();
    delete img.dataset.orig;
    if (p.viewable) {
      img.hidden = false; noprev.hidden = true;
      img.alt = p.name;
      img.dataset.want = p.path;
      const bigUrl = thumbUrl(p.path, size);
      if (loadedUrls.has(bigUrl)) { img.src = bigUrl; return; }
      img.src = thumbUrl(p.path, 'm');
      const big = new Image();
      big.onload = () => { loadedUrls.add(bigUrl); if (img.dataset.want === p.path && img.dataset.orig !== p.path) img.src = big.src; };
      big.src = bigUrl;
    } else {
      img.hidden = true; noprev.hidden = false;
      img.removeAttribute('src');
      noprev.textContent = `${extOf(p.name)} 파일은 미리보기를 지원하지 않습니다`;
    }
  }

  // ------------------------------------------------------------ 그리기
  function markedPhotos() {
    if (!state.folder) return [];
    const m = marksOf(state.folder);
    return state.photos.filter((p) => m.has(p.path));
  }

  function renderAll() {
    const has = state.photos.length > 0;
    const m = state.folder ? marksOf(state.folder) : new Set();
    $('empty').hidden = has;
    $('empty').querySelector('.empty-title').textContent = state.folder ? '이 폴더에는 사진이 없습니다' : '왼쪽에서 사진 폴더를 선택하세요';
    $('single').hidden = !has || state.view !== 'single';
    $('multi').hidden = !has || state.view !== 'multi';
    $('grid').hidden = !has || state.view !== 'grid';
    $('fs-btn').disabled = !has;
    $('pos').textContent = has && state.view !== 'grid' ? `${state.focus + 1} / ${state.photos.length}` : '';

    state.photos.forEach((p, i) => {
      const mk = m.has(p.path);
      const f = i === state.focus;
      const s = state.stripEls[i];
      if (s) { s.classList.toggle('marked', mk); s.classList.toggle('focus', f); s.setAttribute('aria-current', f ? 'true' : 'false'); }
      const g = state.gridEls[i];
      if (g) {
        g.classList.toggle('marked', mk); g.classList.toggle('focus', f);
        const cb = g.querySelector('input'); if (cb.checked !== mk) cb.checked = mk;
        g.querySelector('.pic').setAttribute('aria-pressed', mk);
      }
    });

    if (has && state.view === 'single') renderSingle(m);
    if (has && state.view === 'multi') renderMulti(m);
    if (state.fs) renderFs(m);

    const list = markedPhotos();
    const total = list.reduce((a, p) => a + p.size, 0);
    $('marked-count').textContent = `${list.length}장`;
    $('marked-size').textContent = fmtSize(total);
    $('delete-btn').disabled = list.length === 0;
  }

  let bigFor = null;
  function renderSingle(m) {
    const p = state.photos[state.focus];
    const mk = m.has(p.path);
    $('big').classList.toggle('marked', mk);
    if (bigFor !== p.path) {
      if (bigFor && navDir) slideSwap($('big-img'), navDir);
      bigFor = p.path;
      showImage($('big-img'), $('big-noprev'), p, 'l');
      preloadAround('l');
      loadInfo(p);
    }
    $('info-name').textContent = p.name;
    renderMeta(p);
    const btn = $('toggle-btn');
    btn.textContent = mk ? '삭제 표시 해제' : '삭제 표시';
    btn.classList.toggle('on', mk);
    $('prev').disabled = state.focus === 0;
    $('next').disabled = state.focus >= state.photos.length - 1;
  }

  function renderMeta(p) {
    const i = state.info.get(p.path);
    const parts = [];
    parts.push(i && i.taken ? i.taken : p.mtime);
    if (i && i.width) parts.push(`${i.width}×${i.height}`);
    parts.push(fmtSize(p.size));
    if (i && i.camera) parts.push(i.camera);
    $('info-meta').textContent = parts.join(' · ');
  }

  async function loadInfo(p) {
    if (state.info.has(p.path)) return;
    try {
      const info = await api('/api/info?path=' + encodeURIComponent(p.path));
      state.info.set(p.path, info);
      const cur = state.photos[state.focus];
      if (cur && cur.path === p.path) renderMeta(cur);
    } catch (_) { /* 정보가 없어도 진행 */ }
  }

  // ------------------------------------------------------------ 삭제
  function openDialog() {
    const list = markedPhotos();
    if (!list.length) return;
    const total = list.reduce((a, p) => a + p.size, 0);
    const name = $('index-title').textContent.split(' · ')[0];
    $('dlg-title').textContent = `사진 ${list.length}장을 삭제할까요?`;
    $('dlg-desc').textContent = `${name} 폴더에서 ${fmtSize(total)}가 정리됩니다.`;
    $('dlg-list').innerHTML = list.map((p) => `<span>${num3(state.photos.indexOf(p))} · ${esc(p.name)}</span>`).join('');
    $('dlg-permanent').checked = false;
    updateOkLabel();
    $('dialog').hidden = false;
    $('dlg-cancel').focus();
  }
  function closeDialog() { $('dialog').hidden = true; $('delete-btn').focus(); }
  function updateOkLabel() { $('dlg-ok').textContent = $('dlg-permanent').checked ? '영구 삭제' : '휴지통으로 이동'; }

  $('delete-btn').addEventListener('click', openDialog);
  $('dlg-cancel').addEventListener('click', closeDialog);
  $('dlg-permanent').addEventListener('change', updateOkLabel);
  $('dlg-ok').addEventListener('click', async () => {
    const list = markedPhotos();
    const permanent = $('dlg-permanent').checked;
    $('dlg-ok').disabled = true;
    $('dlg-ok').textContent = '삭제 중…';
    try {
      const res = await post('/api/delete', { paths: list.map((p) => p.path), permanent });
      const gone = new Set(res.deleted.map((d) => d.path));
      const m = marksOf(state.folder);
      gone.forEach((p) => m.delete(p));
      const focusPath = state.photos[state.focus] && state.photos[state.focus].path;
      const remaining = state.photos.filter((p) => !gone.has(p.path));
      const node = state.nodes.get(state.folder);
      if (node) node.count = remaining.length;
      const keepFocus = remaining.findIndex((p) => p.path === focusPath);
      const oldFocus = state.focus;
      $('dialog').hidden = true;
      showFolder(state.folder, remaining);
      setFocus(keepFocus >= 0 ? keepFocus : Math.min(oldFocus, Math.max(0, remaining.length - 1)));
      let msg = `${gone.size}장 ${permanent ? '영구 삭제됨' : '휴지통으로 이동됨'} · ${fmtSize(res.freed)} 확보`;
      if (res.failed.length) {
        msg += ` · ${res.failed.length}장 실패: ${res.failed[0].error}`;
        toast(msg, true);
      } else toast(msg);
    } catch (e) {
      toast('삭제하지 못했습니다: ' + e.message, true);
    } finally {
      $('dlg-ok').disabled = false;
      updateOkLabel();
    }
  });

  // ------------------------------------------------------------ 키보드
  document.addEventListener('keydown', (ev) => {
    if (!$('dialog').hidden) {
      if (ev.key === 'Escape') closeDialog();
      return;
    }
    const t = ev.target;
    if (t.matches('input[type=text], select, textarea')) return;
    const step = state.view === 'multi' ? state.nup : 1;
    if (ev.key === 'ArrowRight') { ev.preventDefault(); setFocus(state.focus + 1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); setFocus(state.focus - 1); }
    else if (ev.key === 'PageDown') { ev.preventDefault(); setFocus(state.focus + step); }
    else if (ev.key === 'PageUp') { ev.preventDefault(); setFocus(state.focus - step); }
    else if (ev.key === 'Home') { ev.preventDefault(); setFocus(0); }
    else if (ev.key === 'End') { ev.preventDefault(); setFocus(state.photos.length - 1); }
    else if (ev.key === 'Escape' && state.fs) { ev.preventDefault(); closeFs(); }
    else if ((ev.key === 'b' || ev.key === 'B' || ev.key === 'ㅠ') && !ev.ctrlKey && !state.fs) { ev.preventDefault(); setSidebar(!sidebarShown()); }
    else if (ev.key === '+' || ev.key === '=' || ev.key === '-' || ev.key === '0') {
      const zm = state.fs ? fsZoom : state.view === 'single' ? bigZoom : null;
      if (zm) { ev.preventDefault(); ev.key === '0' ? zm.reset() : ev.key === '-' ? zm.zoomOut() : zm.zoomIn(); }
    }
    else if (ev.key === 'f' || ev.key === 'F' || ev.key === 'ㄹ' || (ev.key === 'Enter' && !t.matches('button'))) { ev.preventDefault(); state.fs ? closeFs() : openFs(); }
    else if (ev.key === ' ' || ev.key === 'Delete') { ev.preventDefault(); toggleMark(state.focus); }
  });

  // 별도 프로그램 창이면 "폴더 열기"가 윈도우 폴더 선택 창을 띄운다
  window.addEventListener('pywebviewready', () => { $('open-folder').title = '폴더 선택 창 열기'; });

  init().catch((e) => toast(e.message, true));
})();
