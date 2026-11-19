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
    allPhotos: [],         // 폴더(또는 모아 보기)의 전체 사진. photos는 별점 필터를 거친 목록
    rfilter: 'all',        // 별점 필터: 'all' 또는 0~5
    defaultStars: 3,       // 별점을 매기지 않은 사진의 별점
    collection: null,      // 별점 모아 보기 중이면 별 개수
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
  // 메인 사진 전환과 인덱스 이동이 같은 곡선(ease-out quart)으로 움직이도록 맞춘다
  const EASE = 'cubic-bezier(.25,1,.5,1)';
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
      { duration: cfg.dur, easing: EASE, fill: 'forwards' },
    ).onfinish = () => ghost.remove();
    img.animate(
      [{ opacity: 0, transform: `translateX(${slide}px)` }, { opacity: op, transform: 'translateX(0px)' }],
      { duration: cfg.dur, easing: EASE },
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

  // ------------------------------------------------------------ 별점
  const effStars = (p) => p.rating || state.defaultStars;
  // i: 사진 번호(state.photos 기준). 직접 매긴 별점은 진하게, 기본 별점은 흐리게.
  function starsHtml(i, p) {
    const v = effStars(p);
    let h = '';
    for (let s = 1; s <= 5; s++) {
      h += `<button class="star${s <= v ? ' on' : ''}" data-i="${i}" data-s="${s}" aria-label="별 ${s}개${p.rating === s ? ' (지우기)' : ''}">★</button>`;
    }
    return h;
  }
  function paintStars(el, i, p) {
    if (!el) return;
    const key = `${i}|${p.rating}|${state.defaultStars}`;
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    el.innerHTML = starsHtml(i, p);
    el.classList.toggle('dflt', !p.rating);
    el.title = p.rating ? `별점 ${p.rating}` : (state.defaultStars ? `별점 없음 (기본 ★${state.defaultStars})` : '별점 없음');
  }

  // 같은 별을 다시 누르면 지운다(기본 별점으로)
  async function setRating(i, stars) {
    const p = state.photos[i];
    if (!p) return;
    if (stars && p.rating === stars) stars = 0;
    const before = p.rating;
    p.rating = stars;
    renderAll();
    try {
      await post('/api/rating', { paths: [p.path], stars });
      refreshSummary();
      if (state.photos[state.focus] === p) { ipFor = undefined; scheduleInfoPanel(); }
    } catch (e) {
      p.rating = before; renderAll();
      toast('별점을 저장하지 못했습니다: ' + e.message, true);
    }
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('.star');
    if (!b) return;
    ev.stopPropagation();
    const i = b.dataset.i === 'cur' ? state.focus : +b.dataset.i;
    setFocus(i, false);
    setRating(i, +b.dataset.s);
  }, true);

  // 별점 모아 보기 목록 (드라이브 전체, 직접 매긴 별점만)
  let summaryTimer = null;
  function refreshSummary() {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(async () => {
      if (!state.root) return;
      try {
        const d = await api('/api/ratings/summary?root=' + encodeURIComponent(state.root));
        renderCollect(d.counts);
      } catch (_) { /* 무시 */ }
    }, 300);
  }
  let lastCounts = {};
  function renderCollect(counts) {
    if (counts) lastCounts = counts;
    $('collect').innerHTML = [5, 4, 3, 2, 1].map((n) => {
      const stars = '★'.repeat(n) + `<span class="off">${'★'.repeat(5 - n)}</span>`;
      return `<button class="crow${state.collection === n ? ' sel' : ''}" data-n="${n}" aria-label="별 ${n}개 사진 모아 보기">
        <span class="cs">${stars}</span><span class="cnt">${lastCounts[n] || 0}</span></button>`;
    }).join('');
  }
  $('collect').addEventListener('click', (ev) => {
    const b = ev.target.closest('.crow');
    if (b) openCollection(+b.dataset.n);
  });

  async function openCollection(n) {
    try {
      const d = await api(`/api/ratings/collect?root=${encodeURIComponent(state.root)}&stars=${n}`);
      state.collection = n;
      showFolder(`★${n}`, d.photos, `★${n} 모아 보기`);
      $('path-label').textContent = `별점 ${n}개 모아 보기 · ${state.root} 전체`;
      refreshSummary();
    } catch (e) { toast(e.message, true); }
  }

  // 별점 필터
  function filterOptions() {
    const all = state.allPhotos;
    const cnt = (n) => all.filter((p) => effStars(p) === n).length;
    const opts = [['all', `전체 (${all.length})`]];
    for (let n = 5; n >= 1; n--) opts.push([String(n), `${'★'.repeat(n)} (${cnt(n)})`]);
    if (state.defaultStars === 0) opts.push(['0', `별점 없음 (${cnt(0)})`]);
    const sel = $('rfilter');
    const html = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    if (sel.dataset.h !== html) { sel.innerHTML = html; sel.dataset.h = html; }
    if (![...sel.options].some((o) => o.value === String(state.rfilter))) state.rfilter = 'all';
    sel.value = String(state.rfilter);
    $('rfilter-wrap').hidden = state.collection !== null || !state.folder;
  }

  // 필터를 적용해 화면 목록을 다시 만든다. keepPath 사진이 남아 있으면 그 사진을 계속 보여 준다.
  function applyFilter(keepPath = null, fallbackIndex = 0) {
    const f = state.rfilter;
    state.photos = f === 'all' ? state.allPhotos.slice() : state.allPhotos.filter((p) => effStars(p) === +f);
    let i = keepPath ? state.photos.findIndex((p) => p.path === keepPath) : -1;
    if (i < 0) i = Math.min(fallbackIndex, Math.max(0, state.photos.length - 1));
    state.focus = i;
    multiBuiltFor = null;
    bigFor = null; fsFor = null;
    buildStrip();
    buildGrid();
    renderAll();
    centerStrip(state.focus);
  }
  $('rfilter').addEventListener('change', (e) => {
    e.target.blur();
    const cur = state.photos[state.focus];
    state.rfilter = e.target.value === 'all' ? 'all' : +e.target.value;
    applyFilter(cur && cur.path);
  });

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
    function animateTo(dest, base = 200, exactDur = null) {
      dest = clampP(dest);
      const start = el.scrollLeft, t0 = performance.now();
      stop();
      const dist = dest - start;
      if (Math.abs(dist) < 0.5) { el.scrollLeft = dest; if (opts.onSettle) opts.onSettle(); return; }
      if (exactDur === 0) { el.scrollLeft = dest; if (opts.onSettle) opts.onSettle(); return; }
      const dur = exactDur || Math.min(base * 2.5, base + Math.abs(dist) * 0.25) * smooth().move;
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

    return {
      animateTo, stop,
      get busy() { return !!anim || !!(drag && drag.moving); },
      get dragging() { return !!(drag && drag.moving); },
      get target() { return anim ? anim.dest : el.scrollLeft; },
    };
  }

  // ------------------------------------------------------------ 시작
  async function init() {
    const [roots, settings] = await Promise.all([api('/api/roots'), api('/api/settings')]);
    state.settings = settings;
    state.view = ['single', 'multi', 'grid'].includes(settings.view) ? settings.view : 'single';
    state.nup = [2, 3, 4, 5, 6, 8].includes(+settings.nup) ? +settings.nup : 2;
    state.gridSize = ['s', 'm', 'l'].includes(settings.gridSize) ? settings.gridSize : 'm';
    setSidebar(settings.sidebar !== false, false);
    setIndexBar(settings.indexBar !== false, false);
    setIndexSize(settings.indexSize || 'm', false);
    setInfoPanel(settings.infoPanel === true, false);
    state.smooth = [0, 1, 2, 3, 4].includes(+settings.smooth) ? +settings.smooth : 2;
    state.defaultStars = [0, 1, 2, 3, 4, 5].includes(+settings.defaultStars) ? +settings.defaultStars : 3;
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
    document.querySelector('.app').classList.remove('reveal-left');
    document.querySelector('.app').classList.toggle('no-sidebar', !show);
    const b = $('sidebar-btn');
    b.setAttribute('aria-pressed', show);
    b.setAttribute('aria-label', show ? '좌측 메뉴 숨기기 (B)' : '좌측 메뉴 보이기 (B)');
    window.dispatchEvent(new Event('resize'));  // 사진 확대 위치 등 다시 계산
    if (save) saveSettings({ sidebar: show });
  }
  const sidebarShown = () => !document.querySelector('.app').classList.contains('no-sidebar');

  // 인덱스 숨기기/보이기
  function setIndexBar(show, save = true) {
    document.querySelector('.app').classList.toggle('no-index', !show);
    const b = $('index-btn');
    b.setAttribute('aria-pressed', show);
    b.setAttribute('aria-label', show ? '인덱스 숨기기 (I)' : '인덱스 보이기 (I)');
    window.dispatchEvent(new Event('resize'));
    if (show) centerStrip(state.focus);
    if (save) saveSettings({ indexBar: show });
  }
  const indexShown = () => !document.querySelector('.app').classList.contains('no-index');

  // 인덱스 크기 (설정)
  function setIndexSize(v, save = true) {
    if (!['s', 'm', 'l', 'xl'].includes(v)) v = 'm';
    const app = document.querySelector('.app');
    ['s', 'l', 'xl'].forEach((k) => app.classList.toggle('ix-' + k, k === v));
    state.indexSize = v;
    $('set-ixsize').value = v;
    requestAnimationFrame(() => centerStrip(state.focus));
    if (save) saveSettings({ indexSize: v });
  }
  $('set-ixsize').addEventListener('change', (e) => setIndexSize(e.target.value));

  // ------------------------------------------------------------ 사진 속성 창
  const appEl = document.querySelector('.app');
  // 평소에는 [속성] 상태, 전체 화면에서는 오른쪽 끝에서 꺼냈을 때
  // 속성 창이 "화면 끝에서 꺼내는" 방식인지 (사진 전체 화면, 또는 창 최대화 + 속성 창 숨김)
  const infoOverlay = () => appEl.classList.contains('fs-mode') || (appEl.classList.contains('max-mode') && appEl.classList.contains('no-info'));
  const menuOverlay = () => appEl.classList.contains('fs-mode') || (appEl.classList.contains('max-mode') && appEl.classList.contains('no-sidebar'));
  const infoShown = () => (infoOverlay() ? appEl.classList.contains('reveal-right') : !appEl.classList.contains('no-info'));
  function setInfoPanel(show, save = true) {
    appEl.classList.remove('reveal-right');
    appEl.classList.toggle('no-info', !show);
    $('info-btn').setAttribute('aria-pressed', show);
    window.dispatchEvent(new Event('resize'));
    if (show) { ipFor = undefined; scheduleInfoPanel(); }
    if (save) saveSettings({ infoPanel: show });
  }
  $('info-btn').addEventListener('click', () => setInfoPanel(!infoShown()));
  $('ip-close').addEventListener('click', () => (infoOverlay() ? appEl.classList.remove('reveal-right') : setInfoPanel(false)));

  let ipFor, ipTimer = null;
  const histCache = new Map();
  // 빠르게 넘길 때는 멈춘 사진만 읽도록 잠깐 기다린다
  function scheduleInfoPanel() {
    if (!infoShown()) return;
    const p = state.photos[state.focus] || null;
    const key = p ? p.path : null;
    if (key === ipFor) return;
    ipFor = key;
    clearTimeout(ipTimer);
    ipTimer = setTimeout(() => renderInfoPanel(p), 150);
  }

  async function getInfo(p) {
    if (state.info.has(p.path)) return state.info.get(p.path);
    const info = await api('/api/info?path=' + encodeURIComponent(p.path));
    state.info.set(p.path, info);
    return info;
  }
  async function getHist(p) {
    if (histCache.has(p.path)) return histCache.get(p.path);
    const h = await api('/api/histogram?path=' + encodeURIComponent(p.path));
    if (histCache.size > 300) histCache.clear();
    histCache.set(p.path, h);
    return h;
  }

  const dl = (rows) => rows.filter((r) => r[1] !== null && r[1] !== undefined && r[1] !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const PROGRAM = { 1: '수동', 2: '프로그램', 3: '조리개 우선', 4: '셔터 우선', 5: '크리에이티브', 6: '액션', 7: '인물', 8: '풍경' };
  const METERING = { 1: '평균', 2: '중앙 중점', 3: '스팟', 4: '멀티 스팟', 5: '평가(패턴)', 6: '부분' };
  const fmtExp = (t) => (t >= 1 ? `${+t.toFixed(1)}초` : `1/${Math.round(1 / t)}초`);

  async function renderInfoPanel(p) {
    $('ip-empty').hidden = !!p;
    $('ip-body').hidden = !p;
    if (!p) return;
    const folder = p.path.slice(0, p.path.length - p.name.length).replace(/[\\/]$/, '');
    let vm = null;
    const fileRows = (info) => [
      ['파일 이름', p.name],
      ['폴더', folder],
      ['크기', fmtSize(p.size)],
      ['종류', p.video ? `동영상 (${extOf(p.name)})` : null],
      ['코덱', info && info.video ? [info.video.videoName, info.video.audioName].filter(Boolean).join(' / ') : null],
      ['길이', vm ? fmtDur(vm.duration) : null],
      ['해상도', info && info.width ? `${info.width} × ${info.height} (${((info.width * info.height) / 1e6).toFixed(1)}MP)` : vm && vm.w ? `${vm.w} × ${vm.h}` : null],
      ['형식', info && info.format ? info.format : extOf(p.name)],
      ['촬영 일시', info && info.taken],
      ['수정 일시', p.mtime],
      ['별점', p.rating ? '★'.repeat(p.rating) : `없음${state.defaultStars ? ` (기본 ★${state.defaultStars})` : ''}`],
    ];
    $('ip-file').innerHTML = dl(fileRows(null));

    let info = null;
    try { info = await getInfo(p); } catch (_) { /* 정보 없음 */ }
    if (p.video) vm = await getVMeta(p.path);
    if (ipFor !== p.path) return;
    $('ip-file').innerHTML = dl(fileRows(info));

    const e = (info && info.exif) || {};
    const camera = e.model ? (e.make && !e.model.toLowerCase().startsWith(e.make.toLowerCase()) ? `${e.make} ${e.model}` : e.model) : null;
    const shot = [
      ['카메라', camera],
      ['렌즈', e.lens],
      ['초점 거리', e.focal ? `${+e.focal.toFixed(1)}mm${e.focal35 ? ` (35mm 환산 ${e.focal35}mm)` : ''}` : null],
      ['조리개', e.fnumber ? `f/${e.fnumber.toFixed(1)}` : null],
      ['셔터 속도', e.exposure ? fmtExp(e.exposure) : null],
      ['ISO', e.iso],
      ['노출 보정', e.bias !== undefined ? `${e.bias > 0 ? '+' : ''}${e.bias.toFixed(1)} EV` : null],
      ['노출 모드', PROGRAM[e.program]],
      ['측광', METERING[e.metering]],
      ['플래시', e.flash !== undefined ? (e.flash & 1 ? '발광' : '발광 안 함') : null],
      ['화이트밸런스', e.whiteBalance !== undefined ? (e.whiteBalance ? '수동' : '자동') : null],
      ['소프트웨어', e.software],
    ];
    const shotHtml = dl(shot);
    $('ip-shot').innerHTML = shotHtml;
    $('ip-shot-none').hidden = !!shotHtml;

    renderGps(info && info.gps);

    const msg = $('ip-hist-msg');
    if (!p.viewable) {
      clearHist(); msg.textContent = p.video ? '동영상은 히스토그램이 없습니다' : '이 형식은 히스토그램을 만들 수 없습니다'; msg.hidden = false; return;
    }
    try {
      const h = await getHist(p);
      if (ipFor !== p.path) return;
      drawHist(h); msg.hidden = true;
    } catch (_) {
      clearHist(); msg.textContent = '히스토그램을 만들 수 없습니다'; msg.hidden = false;
    }
  }

  function clearHist() { const c = $('ip-hist'); c.getContext('2d').clearRect(0, 0, c.width, c.height); }
  function drawHist(h) {
    const c = $('ip-hist');
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    // 양 끝(완전 검정/흰색) 칸은 튀는 경우가 많아 높이 기준에서 뺀다
    let max = 1;
    for (const a of [h.r, h.g, h.b, h.l]) for (let i = 1; i < 255; i++) if (a[i] > max) max = a[i];
    const draw = (arr, stroke, fill) => {
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, arr[i] / max) * H * 0.95);
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke();
    };
    draw(h.l, 'rgba(201,206,212,.85)', 'rgba(201,206,212,.14)');
    ctx.globalCompositeOperation = 'lighter';
    draw(h.r, 'rgba(229,72,77,.9)', 'rgba(229,72,77,.22)');
    draw(h.g, 'rgba(70,167,88,.9)', 'rgba(70,167,88,.22)');
    draw(h.b, 'rgba(62,123,250,.9)', 'rgba(62,123,250,.22)');
    ctx.globalCompositeOperation = 'source-over';
  }

  function renderGps(g) {
    const box = $('ip-gps');
    if (!g) {
      box.dataset.k = '';
      box.innerHTML = '<p class="muted ip-small">위치 정보가 없습니다</p>';
      return;
    }
    const key = `${g.lat},${g.lon}`;
    if (box.dataset.k === key) return;   // 같은 위치면 지도를 다시 불러오지 않는다
    box.dataset.k = key;
    const d = 0.008;
    const bbox = [g.lon - d * 1.6, g.lat - d, g.lon + d * 1.6, g.lat + d].map((v) => v.toFixed(6)).join(',');
    const osm = `https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lon}#map=16/${g.lat}/${g.lon}`;
    const gmap = `https://www.google.com/maps?q=${g.lat},${g.lon}`;
    box.innerHTML = `<dl class="ip-dl">${dl([['위도', g.lat.toFixed(6)], ['경도', g.lon.toFixed(6)], ['고도', g.alt !== null && g.alt !== undefined ? `${g.alt}m` : null]])}</dl>
      <iframe class="ip-map" title="촬영 위치 지도" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&amp;layer=mapnik&amp;marker=${g.lat},${g.lon}"></iframe>
      <div class="ip-links">
        <button class="btn" data-url="${esc(osm)}">OpenStreetMap에서 열기</button>
        <button class="btn" data-url="${esc(gmap)}">Google 지도에서 열기</button>
      </div>
      <p class="muted ip-small">지도는 인터넷이 연결되어 있을 때 보입니다</p>`;
  }
  $('ip-gps').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-url]');
    if (!b) return;
    const url = b.dataset.url;
    if (desktop()) window.pywebview.api.open_url(url).catch(() => {});
    else window.open(url, '_blank', 'noopener');
  });
  $('index-btn').addEventListener('click', () => setIndexBar(!indexShown()));
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
    refreshSummary();
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
          ${n.loading ? '<span class="cnt">…</span>' : n.count ? `<span class="cnt" title="이 폴더의 사진·동영상 ${n.count}개, ${fmtSize(n.size || 0)}">${n.count}<span class="sz"> · ${fmtSize(n.size || 0)}</span></span>` : ''}
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
    // 전체 화면에서는 사진이 없는 폴더(연도 폴더 등)는 펼치기만 한다 (빈 폴더를 열면 전체 화면이 닫히므로)
    if (!clickedChevron && !(state.fs && !n.count)) openFolder(n.path);
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
      state.collection = null;
      if (quiet && data.photos.length === 0) { showFolder(null, []); return; }
      showFolder(path, data.photos);
      if (focusName) {
        const i = state.photos.findIndex((p) => p.name === focusName);
        if (i > 0) setFocus(i);
      }
      saveSettings({ root: state.root, folder: path, photo: state.photos[state.focus] ? state.photos[state.focus].name : null });
    } catch (e) {
      toast(e.message, true);
    }
  }

  function showFolder(path, photos, title = null) {
    state.folder = path;
    state.allPhotos = photos;
    if (state.collection !== null) state.rfilter = 'all';
    const n = path && state.nodes.get(path);
    const name = title || (n ? n.name : path ? baseName(path) : '');
    state.folderName = name;
    $('path-label').textContent = path || '';
    $('path-label').title = path || '';
    renderTree();
    renderCollect();
    applyFilter();
  }

  // ------------------------------------------------------------ 썸네일 (사진 / 동영상)
  // 동영상은 서버에 저장된 첫 화면을 쓰고, 없으면 화면이 동영상을 읽어 첫 화면을 만들어 올린다
  function thumbHtml(p, size, lazy = true) {
    const ld = lazy ? 'loading="lazy" ' : '';
    if (p.video) {
      const src = vthumbUrls.get(p.path) || thumbUrl(p.path, 's');
      return `<span class="ext">${esc(extOf(p.name))}</span><img ${ld}draggable="false" class="vimg${vfail.has(p.path) ? ' broken' : ''}" data-v="${esc(p.path)}" src="${src}" alt="">${PLAY_ICON}`;
    }
    return p.viewable ? `<img ${ld}draggable="false" src="${thumbUrl(p.path, size)}" alt="">` : `<span class="ext">${esc(extOf(p.name))}</span>`;
  }
  const PLAY_ICON = '<span class="play" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><path d="M6 4l14 8-14 8z"/></svg></span>';
  const vthumbUrls = new Map();   // 동영상 경로 -> 첫 화면(이번 실행에서 만든 것)
  const vmeta = new Map();        // 동영상 경로 -> {duration, w, h}
  const vfail = new Set();        // 재생할 수 없는 동영상
  const vqueue = [];
  let vbusy = 0;
  function forVImgs(path, fn) { document.querySelectorAll('img[data-v]').forEach((im) => { if (im.dataset.v === path) fn(im); }); }
  function requestVThumb(path) {
    if (vthumbUrls.has(path) || vfail.has(path) || vqueue.includes(path)) return;
    vqueue.push(path);
    pumpV();
  }
  function pumpV() {
    while (vbusy < 2 && vqueue.length) {
      const path = vqueue.shift();
      vbusy++;
      makeVThumb(path).finally(() => { vbusy--; pumpV(); });
    }
  }
  function makeVThumb(path) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true; clearTimeout(timer);
        v.removeAttribute('src'); v.load();
        if (!ok) { vfail.add(path); forVImgs(path, (im) => im.classList.add('broken')); }
        resolve();
      };
      const timer = setTimeout(() => finish(false), 15000);
      v.onerror = () => finish(false);
      v.onloadedmetadata = () => {
        vmeta.set(path, { duration: v.duration, w: v.videoWidth, h: v.videoHeight });
        v.currentTime = Math.min(1, (isFinite(v.duration) ? v.duration : 2) * 0.1);   // 맨 앞 검은 화면을 피해 조금 뒤
      };
      v.onseeked = () => {
        try {
          if (!v.videoWidth) return finish(false);
          const k = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
          const c = document.createElement('canvas');
          c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          c.toBlob((blob) => {
            if (!blob) return finish(false);
            const url = URL.createObjectURL(blob);
            vthumbUrls.set(path, url);
            forVImgs(path, (im) => { im.classList.remove('broken'); im.src = url; });
            fetch('/api/vthumb?path=' + encodeURIComponent(path), { method: 'POST', headers: { 'X-Token': TOKEN, 'Content-Type': 'image/jpeg' }, body: blob }).catch(() => {});
            finish(true);
          }, 'image/jpeg', 0.85);
        } catch (_) { finish(false); }
      };
      v.src = '/api/video?path=' + encodeURIComponent(path);
    });
  }
  // 저장된 첫 화면이 없으면(404) 만들기 시작
  document.addEventListener('error', (e) => {
    const im = e.target;
    if (!im || im.tagName !== 'IMG' || !im.dataset.v) return;
    const path = im.dataset.v;
    if (vthumbUrls.has(path)) { im.src = vthumbUrls.get(path); return; }
    im.classList.add('broken');
    if (!vfail.has(path)) requestVThumb(path);
  }, true);
  // 동영상 길이·해상도 (속성 창용)
  function getVMeta(path) {
    if (vmeta.has(path)) return Promise.resolve(vmeta.get(path));
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true;
      const t = setTimeout(() => { v.removeAttribute('src'); resolve(null); }, 8000);
      v.onloadedmetadata = () => { clearTimeout(t); const m = { duration: v.duration, w: v.videoWidth, h: v.videoHeight }; vmeta.set(path, m); v.removeAttribute('src'); v.load(); resolve(m); };
      v.onerror = () => { clearTimeout(t); resolve(null); };
      v.src = '/api/video?path=' + encodeURIComponent(path);
    });
  }
  const fmtDur = (sec) => {
    if (!isFinite(sec)) return null;
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}` : `${m}:${String(s2).padStart(2, '0')}`;
  };

  // ------------------------------------------------------------ 인덱스 / 바둑판
  function buildStrip() {
    const strip = $('strip');
    strip.innerHTML = state.photos.map((p, i) => `
      <button class="ix" data-i="${i}" aria-label="${i + 1}번 ${esc(p.name)}">
        <span class="th">${thumbHtml(p, 's')}
          <span class="x"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1A0E0A" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></span>
          <span class="rb" hidden></span>
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
          ${thumbHtml(p, 'm')}
          <span class="tag">${num3(i)}</span>
          <span class="del"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1A0E0A" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>삭제</span>
        </button>
        <div class="row"><input type="checkbox" id="cb-${i}" data-i="${i}"><label for="cb-${i}" title="${esc(p.name)}">${esc(p.name)}</label></div>
        <div class="row2"><span class="sub">${p.dir ? esc(p.dir) + ' · ' : ''}${fmtSize(p.size)}</span><span class="stars"></span></div>
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
          ${thumbHtml(p, 'l')}
          <span class="tag">${num3(i)}</span>
          <span class="del"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1A0E0A" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>삭제</span>
        </button>
        <div class="mrow">
          <span class="nm" title="${esc(p.name)}">${esc(p.name)}</span>
          <span class="stars mstars"></span>
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
    // 손으로 끄는 중일 때만 건드리지 않는다. 움직이는 중이면 목적지를 기준으로 다시 맞춘다
    // (예전에는 이동 중에 누른 화살표를 무시해서 두 번 눌러야 하는 경우가 있었다)
    if (!pitch || multiKinetic.dragging) return;
    const n = Math.min(state.nup, state.photos.length);
    const goal = multiKinetic.target;
    const first = Math.round(goal / pitch);
    let dest = null;
    if (state.focus < first) dest = state.focus * pitch;
    else if (state.focus > first + n - 1) dest = (state.focus - n + 1) * pitch;
    else if (Math.abs(goal - first * pitch) > 1) dest = first * pitch;  // 칸에 맞춤
    if (dest === null) return;
    if (multiKinetic.busy && Math.abs(multiKinetic.target - dest) < 1) return;  // 이미 그쪽으로 가는 중
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
      paintStars(c.querySelector('.mstars'), i, state.photos[i]);
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
    // 메인 사진이 바뀌는 시간과 똑같이 움직인다 (끄기면 바로)
    stripKinetic.animateTo(el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2, 0, smooth().dur || 0);
  }

  // 나란히 보기가 움직이는 동안 인덱스가 실시간으로 따라간다 (화면 가운데 사진을 인덱스 가운데에)
  $('multi').addEventListener('scroll', () => {
    if (state.view !== 'multi') return;
    const pitch = multiPitch();
    const a = state.stripEls[0];
    if (!pitch || !a) return;
    const b = state.stripEls[1];
    const sp = b ? b.offsetLeft - a.offsetLeft : a.offsetWidth;
    const n = Math.min(state.nup, state.photos.length);
    const c = $('multi').scrollLeft / pitch + (n - 1) / 2;
    const strip = $('strip');
    stripKinetic.stop();
    strip.scrollLeft = a.offsetLeft + c * sp + a.offsetWidth / 2 - strip.clientWidth / 2;
  }, { passive: true });

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
      if (state.view !== 'multi') centerStrip(state.focus);   // 나란히 보기는 스크롤에 맞춰 따라감
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
  function setSmooth(v) {
    state.smooth = v;
    $('smooth').value = String(v); $('set-smooth').value = String(v);
    saveSettings({ smooth: v });
  }
  $('smooth').addEventListener('change', (e) => { e.target.blur(); setSmooth(+e.target.value); });
  $('set-smooth').addEventListener('change', (e) => setSmooth(+e.target.value));
  $('set-default').addEventListener('change', (e) => {
    state.defaultStars = +e.target.value;
    saveSettings({ defaultStars: state.defaultStars });
    const cur = state.photos[state.focus];
    applyFilter(cur && cur.path, state.focus);
  });
  function openSettings() {
    $('set-default').value = String(state.defaultStars);
    $('set-ixsize').value = state.indexSize || 'm';
    $('set-smooth').value = String(state.smooth);
    $('settings').hidden = false;
    $('set-default').focus();
  }
  function closeSettings() { $('settings').hidden = true; $('settings-btn').focus(); }
  $('settings-btn').addEventListener('click', openSettings);
  $('set-close').addEventListener('click', closeSettings);
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
    appEl.classList.add('fs-mode');
    if (desktop()) window.pywebview.api.set_fullscreen(true).catch(() => {});
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    renderAll();
    $('fs-close').focus();
  }
  function closeFs() {
    state.fs = false;
    $('fs').hidden = true;
    appEl.classList.remove('fs-mode', 'reveal-left', 'reveal-right');
    ipFor = undefined;
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
    paintStars($('fs-stars'), 'cur', p);
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
    const vid = img.parentNode.querySelector('video');
    if (p.video) {
      img.hidden = true; noprev.hidden = true;
      img.removeAttribute('src'); img.dataset.want = '';
      if (vid.dataset.p !== p.path) {
        vid.pause();
        vid.dataset.p = p.path;
        vid.poster = vthumbUrls.get(p.path) || thumbUrl(p.path, 'm');
        vid.src = '/api/video?path=' + encodeURIComponent(p.path);
      }
      vid.hidden = false;
      requestVThumb(p.path);
      return;
    }
    stopVideo(vid);
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

  // ------------------------------------------------------------ 전체 화면: 화면 끝 메뉴
  // 마우스가 왼쪽 끝에 닿으면 폴더 메뉴, 오른쪽 끝에 닿으면 속성 창. 창에서 벗어나면 숨긴다.
  const EDGE = 6;
  const hideTimer = { left: null, right: null };
  function reveal(side, on) {
    const cls = side === 'left' ? 'reveal-left' : 'reveal-right';
    clearTimeout(hideTimer[side]);
    if (on) {
      if (!appEl.classList.contains(cls)) {
        appEl.classList.add(cls);
        if (side === 'right') { ipFor = undefined; scheduleInfoPanel(); }
      }
    } else if (appEl.classList.contains(cls)) {
      hideTimer[side] = setTimeout(() => appEl.classList.remove(cls), 250);   // 살짝 벗어난 경우는 바로 닫지 않음
    }
  }
  document.addEventListener('mousemove', (e) => {
    if (!$('dialog').hidden || !$('settings').hidden) return;
    const x = e.clientX, y = e.clientY, w = window.innerWidth;
    // 창 최대화 상태에서는 상단 바 아래쪽 가장자리만 (맨 위 버튼을 가리지 않게)
    const top = state.fs ? 0 : edgeTop();
    if (menuOverlay()) {
      const leftW = document.querySelector('.sidebar').offsetWidth || 300;
      if (x <= EDGE && y >= top) reveal('left', true);
      else if (appEl.classList.contains('reveal-left')) reveal('left', x <= leftW + 16 && y >= top - 8);
    }
    if (infoOverlay()) {
      const rightW = $('infopanel').offsetWidth || 300;
      if (x >= w - 1 - EDGE && y >= top) reveal('right', true);
      else if (appEl.classList.contains('reveal-right')) reveal('right', x >= w - rightW - 16 && y >= top - 8);
    }
  }, { passive: true });
  // 마우스가 창 밖으로 나가면 닫기
  document.addEventListener('mouseleave', () => { reveal('left', false); reveal('right', false); });

  // 숨겨 둔 메뉴/속성 창은 창 크기와 상관없이 화면 끝에서 꺼낼 수 있다.
  // (예전에는 창 최대화를 크기로 판단했는데, Windows 창은 제목 표시줄 때문에 최대화로 인식되지 않았다.
  //  창 크기 조절 테두리는 프로그램 화면 바깥쪽에 있어서 안쪽 가장자리와 겹치지 않는다.)
  const edgeTop = () => Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom);
  function updateMaxMode() {
    appEl.classList.add('max-mode');
    appEl.style.setProperty('--edge-top', `${edgeTop()}px`);
  }
  window.addEventListener('resize', updateMaxMode);
  updateMaxMode();

  // 동영상 플레이어 멈추고 비우기
  function stopVideo(vid) {
    if (!vid || !vid.dataset.p) { if (vid) vid.hidden = true; return; }
    vid.pause(); vid.removeAttribute('src'); vid.removeAttribute('poster'); vid.load();
    vid.dataset.p = ''; vid.hidden = true;
  }
  // 재생할 수 없는 동영상이면 안내
  const HEVC_STORE = 'https://apps.microsoft.com/detail/9n4wgh0z6vhq';
  // 재생할 수 없거나 소리만 나는 동영상: 멈추고 원인과 방법을 보여 준다
  async function showVideoProblem(vid, np, kind) {
    const path = vid.dataset.p;
    if (!path) return;
    vid.pause();
    vid.hidden = true;
    np.hidden = false;
    np.innerHTML = '<span class="muted">동영상 정보를 확인하는 중…</span>';
    let v = null;
    try { v = (await getInfo({ path })).video; } catch (_) { /* 무시 */ }
    if (vid.dataset.p !== path) return;
    const codec = v && v.videoName ? v.videoName : null;
    let msg;
    if (v && v.hevc) {
      msg = `<strong>이 동영상은 ${esc(codec)} 코덱으로 찍혀 있어 화면이 나오지 않습니다.</strong>
        <span>휴대폰의 '고효율 동영상'이나 고화질(4K·HDR) 촬영에서 쓰는 형식입니다.<br>
        Windows에 <b>HEVC 비디오 확장</b>을 설치하면 이 프로그램에서도 재생될 수 있습니다 (그래픽 카드가 지원해야 함).</span>`;
    } else if (kind === 'novideo') {
      msg = `<strong>소리만 재생되고 화면을 표시할 수 없는 동영상입니다${codec ? ` (${esc(codec)})` : ''}.</strong>`;
    } else {
      msg = `<strong>${esc(extOf(path))} 동영상은 이 프로그램에서 재생할 수 없습니다${codec ? ` (${esc(codec)})` : ''}.</strong>`;
    }
    np.innerHTML = `<div class="vproblem">${msg}
      <div class="vp-actions">
        <button class="btn" data-act="open">기본 동영상 프로그램으로 열기</button>
        ${v && v.hevc ? '<button class="btn" data-act="hevc">HEVC 확장 설치 안내</button>' : ''}
      </div></div>`;
  }
  for (const [vid, np] of [[$('big-video'), $('big-noprev')], [$('fs-video'), $('fs-noprev')]]) {
    vid.addEventListener('error', () => showVideoProblem(vid, np, 'error'));
    np.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      ev.stopPropagation();
      const path = vid.dataset.p;
      if (b.dataset.act === 'open' && path) post('/api/open', { path }).catch((e) => toast(e.message, true));
      if (b.dataset.act === 'hevc') {
        if (desktop()) window.pywebview.api.open_url(HEVC_STORE).catch(() => {});
        else window.open(HEVC_STORE, '_blank', 'noopener');
      }
    });
    vid.addEventListener('loadedmetadata', () => {
      if (vid.dataset.p && vid.videoWidth === 0) { showVideoProblem(vid, np, 'novideo'); return; }   // 소리만 나는 경우
      vmeta.set(vid.dataset.p, { duration: vid.duration, w: vid.videoWidth, h: vid.videoHeight });
      const cur = state.photos[state.focus];
      if (cur && cur.path === vid.dataset.p) renderMeta(cur);
    });
  }
  // 보이지 않는 플레이어는 멈춘다 (보기 전환, 전체 화면 열고 닫기)
  function pauseHiddenVideos() {
    if (state.view !== 'single' || state.fs) $('big-video').pause();
    if (!state.fs) $('fs-video').pause();
  }
  function toggleCurrentVideo() {
    const vid = state.fs ? $('fs-video') : state.view === 'single' ? $('big-video') : null;
    if (!vid || vid.hidden || !vid.dataset.p) return false;
    if (vid.paused) vid.play().catch(() => {}); else vid.pause();
    return true;
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
      if (s) {
        s.classList.toggle('marked', mk); s.classList.toggle('focus', f); s.setAttribute('aria-current', f ? 'true' : 'false');
        const rb = s.querySelector('.rb');
        const txt = p.rating ? `★${p.rating}` : '';
        if (rb.textContent !== txt) { rb.textContent = txt; rb.hidden = !txt; }
      }
      const g = state.gridEls[i];
      if (g) {
        g.classList.toggle('marked', mk); g.classList.toggle('focus', f);
        const cb = g.querySelector('input'); if (cb.checked !== mk) cb.checked = mk;
        g.querySelector('.pic').setAttribute('aria-pressed', mk);
        paintStars(g.querySelector('.stars'), i, p);
      }
    });

    $('index-title').textContent = state.folder
      ? `${state.folderName} · ${state.photos.length !== state.allPhotos.length ? `${state.photos.length}/${state.allPhotos.length}장` : `${state.photos.length}장`}`
      : '';
    filterOptions();
    if (has && state.view === 'single') renderSingle(m);
    if (has && state.view === 'multi') renderMulti(m);
    if (state.fs) renderFs(m);

    const list = markedPhotos();
    const total = list.reduce((a, p) => a + p.size, 0);
    $('marked-count').textContent = `${list.length}장`;
    $('marked-size').textContent = fmtSize(total);
    $('delete-btn').disabled = list.length === 0;
    pauseHiddenVideos();
    scheduleInfoPanel();
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
    paintStars($('stars'), 'cur', p);
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
    if (p.dir) parts.push(p.dir);
    parts.push(i && i.taken ? i.taken : p.mtime);
    const vm = p.video && vmeta.get(p.path);
    if (p.video) parts.push('동영상' + (vm ? ` ${fmtDur(vm.duration)}${vm.w ? ` · ${vm.w}×${vm.h}` : ''}` : ''));
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
      const oldFocus = state.focus;
      state.allPhotos = state.allPhotos.filter((p) => !gone.has(p.path));
      // 탐색기의 폴더별 사진 수 줄이기 (모아 보기에서는 여러 폴더)
      gone.forEach((gp) => {
        const node = state.nodes.get(gp.replace(/[\\/][^\\/]*$/, ''));
        if (node && node.count) {
          node.count -= 1;
          const d = res.deleted.find((x) => x.path === gp);
          if (d && node.size) node.size = Math.max(0, node.size - d.size);
        }
      });
      $('dialog').hidden = true;
      applyFilter(gone.has(focusPath) ? null : focusPath, oldFocus);
      renderTree();
      refreshSummary();
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
    if (!$('settings').hidden) {
      if (ev.key === 'Escape') closeSettings();
      return;
    }
    const t = ev.target;
    // 선택 상자에 포커스가 남아 있어도 ← → 는 사진 이동 (상자 값이 바뀌지 않게)
    if (t.matches('select') && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) t.blur();
    else if (t.matches('input[type=text], select, textarea')) return;
    const step = state.view === 'multi' ? state.nup : 1;
    if (ev.key === 'ArrowRight') { ev.preventDefault(); setFocus(state.focus + 1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); setFocus(state.focus - 1); }
    else if (ev.key === 'PageDown') { ev.preventDefault(); setFocus(state.focus + step); }
    else if (ev.key === 'PageUp') { ev.preventDefault(); setFocus(state.focus - step); }
    else if (ev.key === 'Home') { ev.preventDefault(); setFocus(0); }
    else if (ev.key === 'End') { ev.preventDefault(); setFocus(state.photos.length - 1); }
    else if (ev.key === 'Escape' && state.fs) { ev.preventDefault(); closeFs(); }
    else if ((ev.key === 'k' || ev.key === 'K' || ev.key === 'ㅏ') && !ev.ctrlKey) { if (toggleCurrentVideo()) ev.preventDefault(); }
    else if ((ev.key === 'b' || ev.key === 'B' || ev.key === 'ㅠ') && !ev.ctrlKey && !state.fs) { ev.preventDefault(); setSidebar(!sidebarShown()); }
    else if ((ev.key === 'i' || ev.key === 'I' || ev.key === 'ㅑ') && !ev.ctrlKey && !state.fs) { ev.preventDefault(); setIndexBar(!indexShown()); }
    else if ((ev.key === 'p' || ev.key === 'P' || ev.key === 'ㅔ') && !ev.ctrlKey && !state.fs) { ev.preventDefault(); setInfoPanel(!infoShown()); }
    else if (/^[0-5]$/.test(ev.key) && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      if (state.photos.length) {
        const p = state.photos[state.focus];
        const n = +ev.key;
        if (n === 0 || p.rating !== n) setRating(state.focus, n);   // 키는 다시 눌러도 지우지 않음
      }
    }
    else if (ev.key === '+' || ev.key === '=' || ev.key === '-' || ev.key === 'z' || ev.key === 'Z' || ev.key === 'ㅋ') {
      const zm = state.fs ? fsZoom : state.view === 'single' ? bigZoom : null;
      if (zm) { ev.preventDefault(); (ev.key === '-') ? zm.zoomOut() : (ev.key === '+' || ev.key === '=') ? zm.zoomIn() : zm.reset(); }
    }
    else if (ev.key === 'f' || ev.key === 'F' || ev.key === 'ㄹ' || (ev.key === 'Enter' && !t.matches('button'))) { ev.preventDefault(); state.fs ? closeFs() : openFs(); }
    else if (ev.key === ' ' || ev.key === 'Delete') { ev.preventDefault(); toggleMark(state.focus); }
  });

  // 별도 프로그램 창이면 "폴더 열기"가 윈도우 폴더 선택 창을 띄운다
  window.addEventListener('pywebviewready', () => { $('open-folder').title = '폴더 선택 창 열기'; });

  init().catch((e) => toast(e.message, true));
})();
