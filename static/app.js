/* 사진 정리 — 화면 로직 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN = window.PC_TOKEN;

  const state = {
    root: null,            // 탐색기 최상위 경로
    nodes: new Map(),      // path -> {name, path, count, hasChildren, children:[path]|null, open, loading}
    rootChildren: [],      // 최상위 바로 아래 폴더 경로들
    q: '',
    folder: null,          // 현재 열린 폴더 경로
    photos: [],            // 현재 폴더 사진 [{name, path, size, mtime, viewable}]
    focus: 0,
    view: 'single',
    marks: new Map(),      // folderPath -> Set(photoPath)
    info: new Map(),       // photoPath -> info
    stripEls: [],
    gridEls: [],
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

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
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

  // ------------------------------------------------------------ 드라이브 / 탐색기
  async function loadRoots() {
    const data = await api('/api/roots');
    const sel = $('root-select');
    sel.innerHTML = data.roots.map((r) => `<option value="${esc(r.path)}">${esc(r.name)}</option>`).join('');
    const start = data.start || (data.roots[0] && data.roots[0].path);
    if (start) { sel.value = start; await setRoot(start); }
  }

  async function setRoot(path) {
    state.root = path;
    state.nodes.clear();
    state.rootChildren = [];
    $('tree').innerHTML = '<div class="tree-msg">불러오는 중…</div>';
    try {
      const data = await api('/api/dirs?path=' + encodeURIComponent(path));
      state.rootChildren = addNodes(data.dirs);
      $('disk-usage').textContent = data.disk ? `${fmtSize(data.disk.used)} 사용 / ${fmtSize(data.disk.total)}` : '';
      renderTree();
      // 최상위 폴더 자체에 사진이 있으면 바로 연다
      openFolder(path, true);
    } catch (e) {
      $('tree').innerHTML = `<div class="tree-msg">${esc(e.message)}</div>`;
    }
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

  // 검색어에 맞는 폴더(또는 맞는 하위 폴더를 가진 폴더)만 보여 준다. 이미 펼쳐 본 폴더 안에서 찾는다.
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
  $('root-select').addEventListener('change', (e) => setRoot(e.target.value));

  // ------------------------------------------------------------ 폴더 열기
  async function openFolder(path, quiet = false) {
    try {
      const data = await api('/api/photos?path=' + encodeURIComponent(path));
      if (quiet && data.photos.length === 0) { showFolder(null, []); return; }
      showFolder(path, data.photos);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function showFolder(path, photos) {
    state.folder = path;
    state.photos = photos;
    state.focus = 0;
    const n = path && state.nodes.get(path);
    const name = n ? n.name : path ? path.split(/[\\/]/).filter(Boolean).pop() || path : '';
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
        <button class="pic" data-i="${i}" aria-label="${esc(p.name)} 삭제 표시 전환">
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
  $('grid').addEventListener('click', (ev) => {
    const pic = ev.target.closest('.pic');
    if (pic) { const i = +pic.dataset.i; setFocus(i, false); toggleMark(i); }
  });
  $('grid').addEventListener('change', (ev) => {
    if (ev.target.matches('input[type=checkbox]')) { const i = +ev.target.dataset.i; setFocus(i, false); toggleMark(i); }
  });

  // ------------------------------------------------------------ 상태 변경
  function setFocus(i, scroll = true) {
    if (!state.photos.length) return;
    state.focus = Math.max(0, Math.min(state.photos.length - 1, i));
    renderAll();
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

  function setView(v) {
    state.view = v;
    $('view-single').setAttribute('aria-pressed', v === 'single');
    $('view-grid').setAttribute('aria-pressed', v === 'grid');
    renderAll();
    if (v === 'grid') { const g = state.gridEls[state.focus]; if (g) g.scrollIntoView({ block: 'nearest' }); }
  }
  $('view-single').addEventListener('click', () => setView('single'));
  $('view-grid').addEventListener('click', () => setView('grid'));
  $('prev').addEventListener('click', () => setFocus(state.focus - 1));
  $('next').addEventListener('click', () => setFocus(state.focus + 1));
  $('toggle-btn').addEventListener('click', () => toggleMark(state.focus));
  $('big').addEventListener('click', () => toggleMark(state.focus));

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
    $('grid').hidden = !has || state.view !== 'grid';
    $('pos').textContent = has && state.view === 'single' ? `${state.focus + 1} / ${state.photos.length}` : '';

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

    if (has) renderSingle(m);

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
      const img = $('big-img');
      const np = $('big-noprev');
      if (p.viewable) {
        img.hidden = false; np.hidden = true;
        img.src = thumbUrl(p.path, 'l');
        img.alt = p.name;
      } else {
        img.hidden = true; np.hidden = false;
        img.removeAttribute('src');
        np.textContent = `${extOf(p.name)} 파일은 미리보기를 지원하지 않습니다`;
      }
      // 다음 사진 미리 받아 두기
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
      const res = await api('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN },
        body: JSON.stringify({ paths: list.map((p) => p.path), permanent }),
      });
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
      state.focus = keepFocus >= 0 ? keepFocus : Math.min(oldFocus, Math.max(0, remaining.length - 1));
      renderAll();
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
    if (ev.key === 'ArrowRight') { ev.preventDefault(); setFocus(state.focus + 1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); setFocus(state.focus - 1); }
    else if ((ev.key === ' ' && !t.closest('.actionbar, .toolbar, .topbar, .sidebar')) || ev.key === 'Delete') { ev.preventDefault(); toggleMark(state.focus); }
  });

  loadRoots().catch((e) => toast(e.message, true));
})();
