/* 飞牛随机短视频 - 前端逻辑（抖音风格 3 槽轮播 + 预加载） */
(() => {
  'use strict';

  // 服务端基础路径：取当前页面所在目录（统一网关 /app/shortvideo/ 或本地 /）
  const BASE = location.pathname.replace(/[^/]*$/, '');

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const track = $('#track');
  const slots = {
    prev:    document.querySelector('.slot[data-pos="prev"]'),
    current: document.querySelector('.slot[data-pos="current"]'),
    next:    document.querySelector('.slot[data-pos="next"]'),
  };
  const videoOf = (slot) => slot.querySelector('video');
  const overlay = $('#overlay');
  const elTitle = $('#video-title');
  const elTimeCur = $('#time-cur');
  const elTimeDur = $('#time-dur');
  const elPlayed = $('#progress-played');
  const elBuffered = $('#progress-buffered');
  const elThumb = $('#progress-thumb');
  const progressBar = $('#progress');
  const btnMute = $('#btn-mute'), btnLoop = $('#btn-loop'), btnFav = $('#btn-fav');
  const centerHint = $('#center-hint'), playTap = $('#play-tap');
  const emptyState = $('#empty-state');

  // ---------- 状态 ----------
  const state = {
    current: null,   // {id,name,size,mtime,favorite,progress}
    prevId: '',
    nextId: '',
    total: 0,
    muted: false,
    loop: true,
    busy: false,      // 动画/切换中，拒绝新滑动
    panelOpen: false,
    lastSaveTs: 0,
  };

  // ---------- API ----------
  async function api(path, opts) {
    const res = await fetch(BASE + path.replace(/^\//, ''), opts);
    if (!res.ok) throw new Error('API ' + path + ' -> ' + res.status);
    return res.json();
  }
  const apiPost = (path, body) => api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}',
  });
  const streamUrl = (id) => BASE + 'api/stream/' + encodeURIComponent(id);

  // ---------- 工具 ----------
  function fmtTime(s) {
    if (!s || !isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.style.display = 'none', 1600);
  }
  function showLoading(on) { centerHint.style.display = on ? 'flex' : 'none'; }

  // ---------- 视频元素管理 ----------
  function setVideo(slot, info) {
    const v = videoOf(slot);
    if (!info || !info.id) { v.removeAttribute('src'); v.load(); return; }
    if (v.dataset.id !== info.id) {
      v.src = streamUrl(info.id);
      v.dataset.id = info.id;
      v.load();
    }
  }

  function pauseAll(except) {
    for (const k of ['prev', 'current', 'next']) {
      const v = videoOf(slots[k]);
      if (v !== except) v.pause();
    }
  }

  function playCurrent() {
    const v = videoOf(slots.current);
    v.muted = state.muted;
    v.loop = state.loop;
    tryPlay(v);
    pauseAll(v);
  }

  // 尝试播放；若被浏览器自动播放策略拒绝（未静音且无用户手势），显示播放按钮引导点击。
  function tryPlay(v) {
    v.play().then(() => {
      playTap.style.display = 'none';
    }).catch(() => {
      // 通常是自动播放策略阻止；静音后可播放，并提示用户点击开声音
      if (!state.muted) {
        v.muted = true;
        v.play().catch(() => {});
        showPlayTap();
        toast('点击视频开启声音');
      } else {
        showPlayTap();
      }
    });
  }

  function showPlayTap() { playTap.style.display = 'flex'; }

  // ---------- 覆盖层更新 ----------
  function updateOverlay() {
    const c = state.current;
    if (!c) return;
    elTitle.textContent = c.name || '';
    btnFav.classList.toggle('active', !!c.favorite);
    const v = videoOf(slots.current);
    elTimeDur.textContent = fmtTime(v.duration);
    updateProgress();
  }

  function updateProgress() {
    const v = videoOf(slots.current);
    if (!v || !v.duration) return;
    const p = v.currentTime / v.duration;
    elPlayed.style.width = (p * 100) + '%';
    elThumb.style.left = (p * 100) + '%';
    elTimeCur.textContent = fmtTime(v.currentTime);
    if (v.buffered.length) {
      const b = v.buffered.end(v.buffered.length - 1) / v.duration;
      elBuffered.style.width = (b * 100) + '%';
    }
  }

  // ---------- 会话渲染 ----------
  function applySession(data) {
    state.current = data.current;
    state.prevId = data.prevId || '';
    state.nextId = data.nextId || '';
    state.total = data.total || 0;
    if (data.empty || !data.current) {
      showEmpty(true);
      return false;
    }
    showEmpty(false);
    return true;
  }

  function showEmpty(on) {
    emptyState.style.display = on ? 'flex' : 'none';
    overlay.style.display = on ? 'none' : '';
  }

  // 初始加载当前 + 邻居预加载
  async function loadInitial() {
    showLoading(true);
    try {
      let data = await api('api/session');
      // 退出续播：若存在最近播放，跳转过去
      if (data.last && data.last.id && (!data.current || data.last.id !== data.current.id)) {
        data = await apiPost('api/session/jump', { id: data.last.id });
      }
      if (!applySession(data)) { showLoading(false); return; }
      const cur = state.current;

      // 当前视频：加载并播放，恢复进度
      const v = videoOf(slots.current);
      v.src = streamUrl(cur.id);
      v.dataset.id = cur.id;
      v.muted = state.muted;
      v.loop = state.loop;
      v.load();
      const resumePos = (data.last && data.last.id === cur.id) ? data.last.pos
                       : (cur.progress && cur.progress.pos) || 0;
      v.addEventListener('loadedmetadata', () => {
        if (resumePos > 0 && resumePos < (v.duration - 1)) {
          try { v.currentTime = resumePos; } catch (e) {}
        }
        updateOverlay();
      }, { once: true });
      tryPlay(v);
      attachVideoEvents(v);

      // 预加载邻居
      preloadNeighbor('prev', state.prevId);
      preloadNeighbor('next', state.nextId);

      updateOverlay();
    } catch (e) {
      toast('加载失败：' + e.message);
    } finally {
      showLoading(false);
    }
  }

  function preloadNeighbor(pos, id) {
    if (!id) { setVideo(slots[pos], null); return; }
    setVideo(slots[pos], { id });
  }

  // ---------- 滑动切换 ----------
  function snapToCurrent(noAnim) {
    track.classList.toggle('no-anim', !!noAnim);
    track.style.transform = 'translateY(-100vh)';
    if (noAnim) void track.offsetWidth; // 强制重排
    track.classList.remove('no-anim');
  }

  async function swipe(direction) {
    if (state.busy || state.panelOpen) return;
    // direction: 'up' = 下一个, 'down' = 上一个
    const targetSlot = direction === 'up' ? slots.next : slots.prev;
    const targetId = direction === 'up' ? state.nextId : state.prevId;
    if (!targetId) return; // 到边界
    state.busy = true;
    try {
      const targetY = direction === 'up' ? '-200vh' : '0vh';
      track.style.transform = 'translateY(' + targetY + ')';
      await waitTransition(track, 340);

      // 推进服务端游标，拿新当前 + 新邻居
      let data;
      try {
        data = direction === 'up'
          ? await apiPost('api/session/next')
          : await apiPost('api/session/prev');
      } catch (e) {
        toast('切换失败：' + e.message);
        snapToCurrent(true);
        return;
      }

      // 保存旧当前进度
      saveProgressOfCurrent();

      // DOM 节点轮换：
      //   up:  next槽视频->当前, 当前视频->prev槽, prev槽视频->next槽(腾空,装新next)
      //   down: prev槽视频->当前, 当前视频->next槽, next槽视频->prev槽(腾空,装新prev)
      const targetVid = videoOf(targetSlot);
      const curVid = videoOf(slots.current);
      const otherSlot = direction === 'up' ? slots.prev : slots.next;
      const otherVid = videoOf(otherSlot);
      slots.current.appendChild(targetVid);   // 新当前
      otherSlot.appendChild(curVid);           // 旧当前 -> 对侧(成为新邻居)
      otherVid.pause();
      targetSlot.appendChild(otherVid);        // 腾空槽 -> 装 direction 方向上的新邻居

      // 应用新会话
      applySession(data);
      const newCur = state.current;

      // 当前槽视频应已是 newCur；若不一致则修正
      const v = videoOf(slots.current);
      if (v.dataset.id !== newCur.id) {
        v.src = streamUrl(newCur.id);
        v.dataset.id = newCur.id;
        v.load();
      }
      v.muted = state.muted;
      v.loop = state.loop;
      attachVideoEvents(v);
      playCurrent();

      // 对侧槽(旧当前)已是新邻居，校验
      const otherExpected = direction === 'up' ? state.prevId : state.nextId;
      if (otherExpected && videoOf(otherSlot).dataset.id !== otherExpected) {
        setVideo(otherSlot, { id: otherExpected });
      }
      // 腾空槽预加载 direction 方向上的新邻居
      const newNeighborId = direction === 'up' ? state.nextId : state.prevId;
      setVideo(targetSlot, newNeighborId ? { id: newNeighborId } : null);

      snapToCurrent(true);
      updateOverlay();
    } finally {
      state.busy = false;
    }
  }

  function waitTransition(el, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      el.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, ms);
    });
  }

  // ---------- 进度保存 ----------
  function saveProgressOfCurrent() {
    const v = videoOf(slots.current);
    const c = state.current;
    if (!v || !c) return;
    const now = Date.now();
    if (now - state.lastSaveTs < 2000) return; // 节流
    state.lastSaveTs = now;
    apiPost('api/progress', { id: c.id, pos: v.currentTime || 0, dur: v.duration || 0 }).catch(() => {});
  }

  // ---------- 视频事件绑定 ----------
  function attachVideoEvents(v) {
    if (v.dataset.bound) return;
    v.dataset.bound = '1';
    v.addEventListener('timeupdate', () => {
      if (v === videoOf(slots.current)) {
        updateProgress();
        saveProgressOfCurrent();
      }
    });
    v.addEventListener('loadedmetadata', () => {
      if (v === videoOf(slots.current)) updateOverlay();
    });
    v.addEventListener('ended', () => {
      // loop 由 video.loop 属性处理；未开循环时停在末尾
      if (!state.loop) {
        playTap.style.display = 'flex';
      }
    });
    v.addEventListener('play', () => {
      if (v === videoOf(slots.current)) playTap.style.display = 'none';
    });
    v.addEventListener('pause', () => {
      if (v === videoOf(slots.current) && !v.ended) {
        // 仅在用户主动暂停时显示，滑动切换中的 pause 不显示
      }
    });
    v.addEventListener('waiting', () => {
      if (v === videoOf(slots.current)) showLoading(true);
    });
    v.addEventListener('playing', () => {
      if (v === videoOf(slots.current)) showLoading(false);
    });
  }

  // ---------- 播放/暂停 ----------
  function togglePlay() {
    const v = videoOf(slots.current);
    if (!v) return;
    if (v.paused) {
      // 用户手势下可恢复声音（若之前因自动播放策略被强制静音）
      if (v.muted && !state.muted) v.muted = false;
      tryPlay(v);
      playTap.style.display = 'none';
    } else {
      v.pause();
      playTap.style.display = 'flex';
    }
  }

  // ---------- 收藏 ----------
  async function toggleFavorite() {
    const c = state.current;
    if (!c) return;
    try {
      const r = await apiPost('api/favorite', { id: c.id, favorite: !c.favorite });
      c.favorite = r.favorite;
      btnFav.classList.toggle('active', c.favorite);
      toast(c.favorite ? '已收藏' : '已取消收藏');
    } catch (e) { toast('操作失败'); }
  }

  // ---------- 静音 / 循环 ----------
  function toggleMute() {
    state.muted = !state.muted;
    for (const k of ['prev', 'current', 'next']) videoOf(slots[k]).muted = state.muted;
    btnMute.classList.toggle('active', !state.muted);
    $('.ico-muted').style.display = state.muted ? '' : 'none';
    $('.ico-sound').style.display = state.muted ? 'none' : '';
    toast(state.muted ? '已静音' : '已开启声音');
  }
  function toggleLoop() {
    state.loop = !state.loop;
    for (const k of ['prev', 'current', 'next']) videoOf(slots[k]).loop = state.loop;
    btnLoop.classList.toggle('active', state.loop);
    toast(state.loop ? '循环播放' : '单次播放');
  }

  // ---------- 进度条拖动 ----------
  let dragging = false;
  function seekFromEvent(e) {
    const v = videoOf(slots.current);
    if (!v || !v.duration) return;
    const rect = progressBar.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    v.currentTime = ratio * v.duration;
    updateProgress();
  }
  progressBar.addEventListener('pointerdown', (e) => {
    dragging = true; progressBar.classList.add('dragging'); seekFromEvent(e);
  });
  window.addEventListener('pointermove', (e) => { if (dragging) seekFromEvent(e); });
  window.addEventListener('pointerup', () => {
    if (dragging) { dragging = false; progressBar.classList.remove('dragging'); saveProgressOfCurrent(); }
  });

  // ---------- 滑动手势 ----------
  let touchStartY = 0, touchStartX = 0, touchStartT = 0, moved = false;
  const feed = $('#feed');
  feed.addEventListener('touchstart', (e) => {
    if (e.target.closest('.right-rail, .top-bar, .bottom-bar, .side-panel, .progress')) return;
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchStartT = Date.now();
    moved = false;
  }, { passive: true });
  feed.addEventListener('touchmove', (e) => {
    if (Math.abs(e.touches[0].clientY - touchStartY) > 8) moved = true;
  }, { passive: true });
  feed.addEventListener('touchend', (e) => {
    if (touchStartT === 0) return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dt = Date.now() - touchStartT;
    touchStartT = 0;
    if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx)) {
      swipe(dy < 0 ? 'up' : 'down');
    } else if (!moved && dt < 300) {
      handleTap(e);
    }
  }, { passive: true });

  // 鼠标滚轮（桌面）
  let wheelLock = false;
  feed.addEventListener('wheel', (e) => {
    if (state.busy || state.panelOpen) return;
    if (Math.abs(e.deltaY) < 24) return;
    if (wheelLock) return;
    wheelLock = true;
    setTimeout(() => wheelLock = false, 500);
    swipe(e.deltaY > 0 ? 'up' : 'down');
  }, { passive: true });

  // 键盘
  window.addEventListener('keydown', (e) => {
    if (state.panelOpen) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); swipe('down'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); swipe('up'); }
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'm') toggleMute();
    else if (e.key === 'f') toggleFavorite();
  });

  // 单击/双击
  let lastTap = 0;
  function handleTap(e) {
    const now = Date.now();
    if (now - lastTap < 300) {
      // 双击 -> 收藏
      lastTap = 0;
      toggleFavorite();
    } else {
      lastTap = now;
      setTimeout(() => {
        if (lastTap && Date.now() - lastTap >= 280) {
          lastTap = 0;
          togglePlay();
        }
      }, 300);
    }
  }

  // ---------- 面板：历史 ----------
  async function openHistory() {
    const panel = $('#panel-history');
    panel.style.display = 'flex';
    requestAnimationFrame(() => panel.classList.add('open'));
    state.panelOpen = true;
    const list = $('#history-list');
    list.innerHTML = '<div class="history-empty">加载中...</div>';
    try {
      const s = await api('api/state');
      if (!s.history || !s.history.length) {
        list.innerHTML = '<div class="history-empty">暂无历史记录</div>';
        return;
      }
      list.innerHTML = '';
      for (const h of s.history) {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML =
          '<span class="h-name">' + escapeHtml(h.name) + '</span>' +
          (h.favorite ? '<span class="h-fav">♥</span>' : '') +
          '<span class="h-time">' + new Date(h.ts * 1000).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) + '</span>';
        item.onclick = () => { closePanels(); jumpTo(h.id); };
        list.appendChild(item);
      }
    } catch (e) { list.innerHTML = '<div class="history-empty">加载失败</div>'; }
  }

  async function openSettings() {
    const panel = $('#panel-settings');
    panel.style.display = 'flex';
    requestAnimationFrame(() => panel.classList.add('open'));
    state.panelOpen = true;
    try {
      const c = await api('api/config');
      $('#setting-roots').textContent = (c.roots && c.roots.length) ? c.roots.join(' ; ') : '未授权任何目录';
      $('#setting-count').textContent = c.total + ' 个';
      $('#setting-scan').textContent = c.scan.running ? '扫描中...' : (c.scan.lastAt || '未扫描');
    } catch (e) {}
  }

  function closePanels() {
    document.querySelectorAll('.side-panel').forEach(p => {
      p.classList.remove('open');
      setTimeout(() => p.style.display = 'none', 300);
    });
    state.panelOpen = false;
  }

  async function jumpTo(id) {
    if (!id) return;
    showLoading(true);
    try {
      const data = await apiPost('api/session/jump', { id });
      saveProgressOfCurrent();
      // 重新铺三个槽
      applySession(data);
      const v = videoOf(slots.current);
      v.src = streamUrl(state.current.id);
      v.dataset.id = state.current.id;
      v.muted = state.muted; v.loop = state.loop;
      v.load();
      const pos = (state.current.progress && state.current.progress.pos) || 0;
      v.addEventListener('loadedmetadata', () => {
        if (pos > 0 && pos < v.duration - 1) try { v.currentTime = pos; } catch (e) {}
        updateOverlay();
      }, { once: true });
      attachVideoEvents(v);
      playCurrent();
      preloadNeighbor('prev', state.prevId);
      preloadNeighbor('next', state.nextId);
      snapToCurrent(true);
      updateOverlay();
    } catch (e) { toast('跳转失败'); }
    finally { showLoading(false); }
  }

  // ---------- 重扫 ----------
  async function rescan() {
    toast('已触发重新扫描');
    try {
      await apiPost('api/rescan');
      // 轮询扫描状态
      let n = 0;
      const poll = async () => {
        n++;
        const c = await api('api/config');
        if (!c.scan.running || n > 30) {
          toast('扫描完成，共 ' + c.total + ' 个视频');
          if (c.total > 0 && (!state.current)) loadInitial();
          return;
        }
        setTimeout(poll, 1000);
      };
      setTimeout(poll, 1000);
    } catch (e) { toast('扫描失败'); }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- 绑定按钮 ----------
  btnMute.onclick = toggleMute;
  btnLoop.onclick = toggleLoop;
  btnFav.onclick = toggleFavorite;
  $('#btn-history').onclick = openHistory;
  $('#btn-settings').onclick = openSettings;
  $('#btn-rescan').onclick = rescan;
  $('#btn-empty-rescan').onclick = rescan;
  $('#btn-setting-rescan').onclick = rescan;
  $('#btn-close-history').onclick = closePanels;
  $('#btn-close-settings').onclick = closePanels;

  // 初始状态：默认开循环、非静音
  btnLoop.classList.add('active');
  $('.ico-sound').style.display = '';
  $('.ico-muted').style.display = 'none';

  // 启动
  snapToCurrent(true);
  loadInitial();
})();
