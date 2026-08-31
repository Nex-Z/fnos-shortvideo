/* 飞牛随机短视频 - 前端逻辑（抖音风格 3 槽轮播 + 预加载） */
(() => {
  'use strict';

  // 服务端基础路径：取当前页面所在目录（统一网关 /app/shortvideo/ 或本地 /）
  const BASE = location.pathname.replace(/[^/]*$/, '');
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
  const btnMute = $('#btn-mute'), btnFav = $('#btn-fav');
  const btnLoopSetting = $('#btn-loop-setting');
  const centerHint = $('#center-hint'), playTap = $('#play-tap');
  const emptyState = $('#empty-state');

  // ---------- 状态 ----------
  const state = {
    current: null,   // {id,name,size,mtime,favorite,progress}
    prevId: '',
    nextId: '',
    total: 0,
    // iOS 先以静音方式启动，避免无用户手势的有声 play() 被系统播放器接管。
    muted: IS_IOS,
    loop: true,
    busy: false,      // 动画/切换中，拒绝新滑动
    panelOpen: false,
    landscape: false, // 横屏观影模式
    lastSaveTs: 0,
  };

  // ---------- API ----------
  async function api(path, opts) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const requestOpts = Object.assign({}, opts || {});
    if (controller) requestOpts.signal = controller.signal;
    const timeout = controller ? setTimeout(() => controller.abort(), 12000) : 0;
    try {
      const res = await fetch(BASE + path.replace(/^\//, ''), requestOpts);
      if (!res.ok) throw new Error('API ' + path + ' -> ' + res.status);
      return await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('请求超时，请重试');
      throw e;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
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
  function configureInlineVideo(v) {
    // 属性必须在设置 src / play 之前存在；部分 iOS WebView 只读取 attribute。
    v.playsInline = true;
    v.setAttribute('playsinline', 'playsinline');
    v.setAttribute('webkit-playsinline', 'webkit-playsinline');
    v.setAttribute('x-webkit-airplay', 'deny');
    v.controls = false;
    v.removeAttribute('controls');
    v.disablePictureInPicture = true;
    v.setAttribute('disablepictureinpicture', '');
    v.defaultMuted = state.muted;
    v.muted = state.muted;
  }

  document.querySelectorAll('.slot video').forEach(configureInlineVideo);

  function setVideo(slot, info) {
    const v = videoOf(slot);
    configureInlineVideo(v);
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

  function syncMuteUI() {
    btnMute.classList.toggle('active', !state.muted);
    $('.ico-muted').style.display = state.muted ? '' : 'none';
    $('.ico-sound').style.display = state.muted ? 'none' : '';
  }

  // 尝试播放；有声自动播放被拒绝时，统一切换为静音内联播放。
  function tryPlay(v) {
    v.play().then(() => {
      playTap.style.display = 'none';
    }).catch(() => {
      if (!state.muted) {
        state.muted = true;
        for (const k of ['prev', 'current', 'next']) videoOf(slots[k]).muted = true;
        syncMuteUI();
        v.play().then(() => {
          playTap.style.display = 'none';
          toast('已静音播放，点右下角开启声音');
        }).catch(showPlayTap);
      } else {
        showPlayTap();
      }
    });
  }

  function showPlayTap() { playTap.style.display = 'flex'; }

  // 恢复保存的播放进度（仅当元素尚无自身位置时；保留状态的元素自带位置不覆盖）
  function resumeProgress(v, prog) {
    if (!prog || !prog.pos || prog.pos < 3) return;
    const apply = () => {
      if (!v.duration) return;
      if (v.currentTime > 3) return; // 元素已有位置（如立即回切保留的状态），不覆盖
      if (prog.pos < v.duration - 2) {
        try { v.currentTime = prog.pos; } catch (e) {}
      }
    };
    if (v.readyState >= 1) apply();
    else v.addEventListener('loadedmetadata', apply, { once: true });
  }

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
  // 视频流高度（= 单槽高度）。用实际像素而非 vh：移动端地址栏显隐时 vh(含浏览器栏)
  // 与 dvh(动态视口) 不一致，会导致轮播 translate 量与槽高错位、画面偏移。
  function feedHeight() { return document.getElementById('feed').clientHeight; }
  function snapToCurrent(noAnim) {
    track.classList.toggle('no-anim', !!noAnim);
    track.style.transform = 'translateY(-' + feedHeight() + 'px)';
    if (noAnim) void track.offsetWidth; // 强制重排
    track.classList.remove('no-anim');
  }

  async function swipe(direction) {
    if (state.busy || state.panelOpen || state.landscape) return;
    // direction: 'up' = 下一个, 'down' = 上一个
    const targetSlot = direction === 'up' ? slots.next : slots.prev;
    const targetId = direction === 'up' ? state.nextId : state.prevId;
    if (!targetId) return; // 到边界
    state.busy = true;
    try {
      const h = feedHeight();
      const targetY = direction === 'up' ? -(2 * h) : 0;
      track.style.transform = 'translateY(' + targetY + 'px)';
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

      // 保存旧当前进度（强制：切走时确保位置最新，便于多步回切续播）
      saveProgressOfCurrent(true);

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
      // 回切(direction='down')时恢复进度：
      //   - 立即回切：元素保留状态，currentTime 已在 3s 后，resumeProgress 内部跳过不覆盖
      //   - 多步回切：元素被预加载/回收重载，currentTime≈0，按后端保存的进度恢复
      //   - 前进(direction='up')不恢复，保持新视频从头播放
      if (direction === 'down') resumeProgress(v, newCur.progress);
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
  function saveProgressOfCurrent(force) {
    const v = videoOf(slots.current);
    const c = state.current;
    if (!v || !c) return;
    const now = Date.now();
    if (!force && now - state.lastSaveTs < 2000) return; // 节流
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
    syncMuteUI();
    toast(state.muted ? '已静音' : '已开启声音');
  }
  function toggleLoop() {
    state.loop = !state.loop;
    for (const k of ['prev', 'current', 'next']) videoOf(slots[k]).loop = state.loop;
    syncLoopUI();
    toast(state.loop ? '循环播放' : '单次播放');
  }
  function syncLoopUI() {
    if (!btnLoopSetting) return;
    btnLoopSetting.classList.toggle('on', state.loop);
    btnLoopSetting.setAttribute('aria-pressed', state.loop ? 'true' : 'false');
  }

  // ---------- 进度条拖动 ----------
  let dragging = false;
  function seekFromEvent(e) {
    const v = videoOf(slots.current);
    if (!v || !v.duration) return;
    const rect = progressBar.getBoundingClientRect();
    let ratio;
    if (state.landscape) {
      // 横屏模式：进度条随容器旋转 90°，屏幕上呈竖直方向，按 Y 轴定位
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      ratio = (y - rect.top) / rect.height;
    } else {
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      ratio = x / rect.width;
    }
    v.currentTime = Math.max(0, Math.min(1, ratio)) * v.duration;
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
  let touchStartY = 0, touchStartX = 0, touchStartT = 0, moved = false, touchActive = false, lastTouchEnd = 0;
  const feed = $('#feed');
  function resetTouchGesture() {
    touchActive = false;
    touchStartT = 0;
    moved = false;
  }
  function resetInteractionState() {
    resetTouchGesture();
    dragging = false;
    progressBar.classList.remove('dragging');
    state.busy = false;
    snapToCurrent(true);
  }
  feed.addEventListener('touchstart', (e) => {
    resetTouchGesture();
    if (e.touches.length !== 1 || e.target.closest('.right-rail, .top-bar, .bottom-bar, .side-panel, .progress, .corner-mute')) return;
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchStartT = Date.now();
    moved = false;
    touchActive = true;
  }, { passive: true });
  feed.addEventListener('touchmove', (e) => {
    if (!touchActive || e.touches.length !== 1) return;
    if (Math.abs(e.touches[0].clientY - touchStartY) > 8) moved = true;
    // 老版本 iOS WebView 不完整支持 touch-action，显式阻止视频/页面接管手势。
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  feed.addEventListener('touchend', (e) => {
    if (!touchActive || touchStartT === 0 || !e.changedTouches.length) return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dt = Date.now() - touchStartT;
    const wasMoved = moved;
    resetTouchGesture();
    if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx)) {
      swipe(dy < 0 ? 'up' : 'down');
    } else if (!wasMoved && dt < 300) {
      lastTouchEnd = Date.now();
      handleTap(e);
    }
  }, { passive: true });
  feed.addEventListener('touchcancel', resetTouchGesture, { passive: true });

  // iOS 系统播放器、切后台或 WebView 页面缓存返回后，确保不会残留 busy/拖动锁。
  window.addEventListener('pageshow', resetInteractionState);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resetInteractionState();
  });
  document.querySelectorAll('.slot video').forEach((v) => {
    v.addEventListener('webkitbeginfullscreen', () => {
      if (IS_IOS) toast('当前客户端强制使用系统播放器，可尝试在 Safari 中打开');
    });
    v.addEventListener('webkitendfullscreen', resetInteractionState);
  });

  // 鼠标点击（桌面）：单击暂停/播放、双击收藏。触摸已处理时忽略浏览器合成的 click。
  feed.addEventListener('click', (e) => {
    if (Date.now() - lastTouchEnd < 500) return;
    if (state.panelOpen || state.busy) return;
    if (e.target.closest('.right-rail, .top-bar, .bottom-bar, .side-panel, .progress, .panel-center, .corner-mute')) return;
    handleTap(e);
  });

  // 鼠标滚轮（桌面）
  let wheelLock = false;
  feed.addEventListener('wheel', (e) => {
    if (state.busy || state.panelOpen || state.landscape) return;
    if (Math.abs(e.deltaY) < 24) return;
    if (wheelLock) return;
    wheelLock = true;
    setTimeout(() => wheelLock = false, 500);
    swipe(e.deltaY > 0 ? 'up' : 'down');
  }, { passive: true });

  // 视口变化（旋转 / 移动端地址栏显隐）后重新对齐当前槽，防错位
  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (!state.busy) snapToCurrent(true); }, 150);
  });

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

  // ---------- 封面缩略图（前端隐藏 video seek + canvas 抓帧，零后端依赖） ----------
  const thumbCache = new Map();      // id -> dataURL | null
  const thumbPending = new Map();    // id -> Promise
  const thumbQueue = [];
  let thumbWorking = false;
  const thumbVideo = document.createElement('video');
  thumbVideo.muted = true;
  thumbVideo.playsInline = true;
  thumbVideo.preload = 'metadata';
  thumbVideo.style.cssText = 'position:absolute;width:1px;height:1px;left:-9999px;top:0;opacity:0;pointer-events:none';
  document.body.appendChild(thumbVideo);
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 240; thumbCanvas.height = 426;

  const thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const el = e.target;
        thumbObserver.unobserve(el);
        ensureThumb(el.dataset.id).then((url) => applyThumb(el, url));
      }
    }
  }, { root: $('#library-body'), rootMargin: '300px 0px' });

  function ensureThumb(id) {
    if (thumbCache.has(id)) return Promise.resolve(thumbCache.get(id));
    if (thumbPending.has(id)) return thumbPending.get(id);
    const p = new Promise((resolve) => {
      thumbQueue.push({ id, resolve });
      runThumbQueue();
    });
    thumbPending.set(id, p);
    return p;
  }

  function runThumbQueue() {
    if (thumbWorking) return;
    const job = thumbQueue.shift();
    if (!job) return;
    thumbWorking = true;
    generateThumb(job.id).then((url) => {
      thumbCache.set(job.id, url);
      thumbPending.delete(job.id);
      job.resolve(url);
      thumbWorking = false;
      runThumbQueue();
    });
  }

  function generateThumb(id) {
    return new Promise((resolve) => {
      const v = thumbVideo;
      let settled = false;
      const finish = (val) => {
        if (settled) return; settled = true;
        v.removeEventListener('loadedmetadata', onMeta);
        v.removeEventListener('seeked', onSeeked);
        v.removeEventListener('error', onErr);
        resolve(val);
      };
      const onMeta = () => {
        const d = v.duration || 0;
        const t = d > 6 ? 1 : (d > 0 ? d * 0.1 : 0);
        try { v.currentTime = t; } catch (e) { finish(null); }
      };
      const onSeeked = () => {
        try {
          const ctx = thumbCanvas.getContext('2d');
          if (!drawCover(ctx, v, thumbCanvas.width, thumbCanvas.height)) { finish(null); return; }
          finish(thumbCanvas.toDataURL('image/jpeg', 0.7));
        } catch (e) { finish(null); } // 跨域污染或解码失败 -> 留占位图
      };
      const onErr = () => finish(null);
      v.addEventListener('loadedmetadata', onMeta);
      v.addEventListener('seeked', onSeeked);
      v.addEventListener('error', onErr);
      v.src = streamUrl(id);
      v.load();
      setTimeout(() => finish(null), 7000); // 安全超时
    });
  }

  function drawCover(ctx, v, dw, dh) {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return false;
    const sr = vw / vh, dr = dw / dh;
    let sx, sy, sw, sh;
    if (sr > dr) { sh = vh; sw = vh * dr; sx = (vw - sw) / 2; sy = 0; }
    else { sw = vw; sh = vw / dr; sx = 0; sy = (vh - sh) / 2; }
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, dw, dh);
    return true;
  }

  function applyThumb(el, url) {
    if (!url) return;
    el.style.backgroundImage = "url('" + url + "')";
    const ph = el.querySelector('.lib-ph');
    if (ph) ph.style.display = 'none';
  }

  function fmtLibTime(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    const hm = d.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return hm;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + hm;
  }

  // ---------- 面板：历史 / 收藏 ----------
  const libState = { tab: 'history', data: null };

  async function openLibrary(tab) {
    if (tab) libState.tab = tab;
    const panel = $('#panel-library');
    panel.style.display = 'flex';
    requestAnimationFrame(() => panel.classList.add('open'));
    state.panelOpen = true;
    syncLibTabs();
    libState.data = null; // 每次打开重新拉取，保证收藏/历史最新
    await renderLibrary();
  }

  function syncLibTabs() {
    document.querySelectorAll('#panel-library .tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === libState.tab);
    });
  }

  async function renderLibrary() {
    const grid = $('#library-grid');
    if (!libState.data) {
      grid.innerHTML = '<div class="lib-empty">加载中...</div>';
      try {
        libState.data = await api('api/state');
      } catch (e) {
        grid.innerHTML = '<div class="lib-empty">加载失败</div>';
        return;
      }
    }
    const s = libState.data;
    let items = libState.tab === 'favorites' ? s.favorites : s.history;
    // 历史为空但收藏有内容时，自动切到收藏页
    if ((!items || !items.length) && libState.tab === 'history' && s.favorites && s.favorites.length) {
      libState.tab = 'favorites';
      syncLibTabs();
      items = s.favorites;
    }
    if (!items || !items.length) {
      grid.innerHTML = '<div class="lib-empty">' + (libState.tab === 'favorites' ? '暂无收藏' : '暂无历史记录') + '</div>';
      return;
    }
    grid.innerHTML = '';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'lib-item';
      el.dataset.id = it.id;
      el.innerHTML =
        '<div class="lib-ph"><svg viewBox="0 0 24 24" class="ico"><path d="M4 6h16v12H4z" fill="none" stroke="currentColor" stroke-width="1"/><path d="M10 9l5 3-5 3z"/></svg></div>' +
        (it.favorite ? '<span class="lib-fav">♥</span>' : '') +
        '<div class="lib-meta"><div class="lib-name">' + escapeHtml(it.name || '') + '</div>' +
        (it.ts ? '<div class="lib-time">' + fmtLibTime(it.ts) + '</div>' : '') + '</div>';
      el.onclick = () => { closePanels(); jumpTo(it.id); };
      grid.appendChild(el);
      thumbObserver.observe(el);
    }
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

  // ---------- 横屏观影 ----------
  // 进入横屏：视频旋转 90° 充满屏幕，把标题/进度条移到横屏 UI（复用同一组元素，
  // 保留事件绑定与更新逻辑），禁用滑动切换。
  function enterLandscape() {
    if (state.landscape) return;
    state.landscape = true;
    document.getElementById('app').classList.add('landscape-mode');
    const lsBottom = document.querySelector('.landscape-bottom');
    lsBottom.appendChild($('#video-title'));
    lsBottom.appendChild(document.querySelector('.progress-row'));
  }
  function exitLandscape() {
    if (!state.landscape) return;
    state.landscape = false;
    document.getElementById('app').classList.remove('landscape-mode');
    const bb = document.querySelector('.bottom-bar');
    bb.appendChild($('#video-title'));
    bb.appendChild(document.querySelector('.progress-row'));
  }

  // ---------- 绑定按钮 ----------
  btnMute.onclick = toggleMute;
  btnFav.onclick = toggleFavorite;
  if (btnLoopSetting) btnLoopSetting.onclick = toggleLoop;
  $('#btn-history').onclick = () => openLibrary('history');
  $('#btn-settings').onclick = openSettings;
  $('#btn-empty-rescan').onclick = rescan;
  $('#btn-setting-rescan').onclick = rescan;
  $('#btn-close-library').onclick = closePanels;
  $('#btn-close-settings').onclick = closePanels;
  $('#btn-landscape').onclick = enterLandscape;
  $('#btn-portrait').onclick = exitLandscape;
  document.querySelectorAll('#panel-library .tab').forEach((t) => {
    t.onclick = () => { libState.tab = t.dataset.tab; syncLibTabs(); renderLibrary(); };
  });

  // 初始状态：默认开循环；iOS 静音启动以争取内联播放。
  syncLoopUI();
  syncMuteUI();

  // 启动
  snapToCurrent(true);
  loadInitial();
})();
