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
  function makeZoom(box, img, labelEl) {
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
      const r = box.getBoundingClientRect();
      zoomAt(z.s * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
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

  // ------------------------------------------------------------ 시작
  async function init() {
    const [roots, settings] = await Promise.all([api('/api/roots'), api('/api/settings')]);
    state.settings = settings;
    state.view = ['single', 'multi', 'grid'].includes(settings.view) ? settings.view : 'single';
    state.nup = [2, 3, 4, 5, 6, 8].includes(+settings.nup) ? +settings.nup : 2;
    state.gridSize = ['s', 'm', 'l'].includes(settings.gridSize) ? settings.gridSize : 'm';
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
    multiKey = null;
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
        <span class="th">${p.viewable ? `<img loading="lazy" src="${thumbUrl(p.path, 's')}" alt="">` : `<span class="ext">${esc(extOf(p.name))}</span>`}
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
  let multiKey = null;
  function multiRange() {
    const n = Math.min(state.nup, state.photos.length);
    // 현재 사진이 화면 안에 들어오도록 시작 위치를 정한다
    let start = multiStart;
    if (state.focus < start) start = state.focus;
    if (state.focus >= start + n) start = state.focus - n + 1;
    start = Math.max(0, Math.min(start, state.photos.length - n));
    multiStart = start;
    return { start, n };
  }
  let multiStart = 0;

  function renderMulti(m) {
    const box = $('multi');
    const { start, n } = multiRange();
    const cols = n <= 4 ? n : Math.ceil(n / 2);
    const rows = n <= 4 ? 1 : 2;
    const key = `${state.folder}|${start}|${n}`;
    if (key !== multiKey) {
      multiKey = key;
      box.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      box.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
      const items = state.photos.slice(start, start + n);
      box.innerHTML = items.map((p, k) => {
        const i = start + k;
        return `<div class="mcell" data-i="${i}">
          <button class="mpic" data-i="${i}" aria-label="${esc(p.name)} (클릭: 선택, 더블클릭: 전체 화면)">
            ${p.viewable ? `<img src="${thumbUrl(p.path, 'l')}" alt="">` : `<span class="ext">${esc(extOf(p.name))}</span>`}
            <span class="tag">${num3(i)}</span>
            <span class="del"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1A0E0A" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>삭제</span>
          </button>
          <div class="mrow">
            <span class="nm" title="${esc(p.name)}">${esc(p.name)}</span>
            <span class="sub">${fmtSize(p.size)}</span>
            <button class="mtoggle" data-i="${i}"></button>
          </div>
        </div>`;
      }).join('');
    }
    [...box.children].forEach((c) => {
      const i = +c.dataset.i;
      const mk = m.has(state.photos[i].path);
      c.classList.toggle('marked', mk);
      c.classList.toggle('focus', i === state.focus);
      c.querySelector('.mtoggle').textContent = mk ? '표시 해제' : '삭제 표시';
    });
  }

  $('multi').addEventListener('click', (ev) => {
    const t = ev.target.closest('.mtoggle');
    if (t) { const i = +t.dataset.i; setFocus(i, false); toggleMark(i); return; }
    const pic = ev.target.closest('.mpic');
    if (pic) setFocus(+pic.dataset.i, false);
  });
  $('multi').addEventListener('dblclick', (ev) => {
    const pic = ev.target.closest('.mpic');
    if (pic) { setFocus(+pic.dataset.i, false); openFs(); }
  });

  // ------------------------------------------------------------ 상태 변경
  function setFocus(i, scroll = true) {
    if (!state.photos.length) return;
    state.focus = Math.max(0, Math.min(state.photos.length - 1, i));
    renderAll();
    const p = state.photos[state.focus];
    if (p) saveSettings({ photo: p.name });
    if (scroll) {
      const s = state.stripEls[state.focus];
      if (s) s.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
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
  $('nup').addEventListener('change', (e) => { e.target.blur(); state.nup = +e.target.value; multiKey = null; renderAll(); saveSettings({ nup: state.nup }); });
  $('gsize').addEventListener('change', (e) => { e.target.blur(); state.gridSize = e.target.value; applyViewButtons(); saveSettings({ gridSize: state.gridSize }); });

  $('prev').addEventListener('click', () => setFocus(state.focus - 1));
  $('next').addEventListener('click', () => setFocus(state.focus + 1));
  $('toggle-btn').addEventListener('click', () => toggleMark(state.focus));
  const bigZoom = makeZoom($('big'), $('big-img'), $('zoom-label'));
  const fsZoom = makeZoom($('fs-stage'), $('fs-img'), $('fs-zoom-label'));
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
      fsFor = p.path;
      showImage($('fs-img'), $('fs-noprev'), p, 'x');
      const nx = state.photos[state.focus + 1];
      if (nx && nx.viewable) { const pre = new Image(); pre.src = thumbUrl(nx.path, 'x'); }
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
      img.src = thumbUrl(p.path, 'm');
      const big = new Image();
      big.onload = () => { if (img.dataset.want === p.path && img.dataset.orig !== p.path) img.src = big.src; };
      img.dataset.want = p.path;
      big.src = thumbUrl(p.path, size);
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
      bigFor = p.path;
      showImage($('big-img'), $('big-noprev'), p, 'l');
      const nx = state.photos[state.focus + 1];
      if (nx && nx.viewable) { const pre = new Image(); pre.src = thumbUrl(nx.path, 'l'); }
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
    else if (ev.key === '+' || ev.key === '=' || ev.key === '-' || ev.key === '0') {
      const zm = state.fs ? fsZoom : state.view === 'single' ? bigZoom : null;
      if (zm) { ev.preventDefault(); ev.key === '0' ? zm.reset() : ev.key === '-' ? zm.zoomOut() : zm.zoomIn(); }
    }
    else if (ev.key === 'f' || ev.key === 'F' || (ev.key === 'Enter' && !t.matches('button'))) { ev.preventDefault(); state.fs ? closeFs() : openFs(); }
    else if (ev.key === ' ' || ev.key === 'Delete') { ev.preventDefault(); toggleMark(state.focus); }
  });

  // 별도 프로그램 창이면 "폴더 열기"가 윈도우 폴더 선택 창을 띄운다
  window.addEventListener('pywebviewready', () => { $('open-folder').title = '폴더 선택 창 열기'; });

  init().catch((e) => toast(e.message, true));
})();
