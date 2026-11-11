// 유튜브(모바일/PC) 사이트 위에서 바로 돌아가는 받아쓰기
// - 자막: 유튜브 페이지 안에서 직접 가져옴 (여러 방법을 차례로 시도)
// - innerHTML을 쓰지 않음 (유튜브의 Trusted Types 보안 정책 때문)
(function () {
  'use strict';
  if (window.__ytdUserscript) return;
  window.__ytdUserscript = true;

  const C = (typeof YTD_CORE !== 'undefined') ? YTD_CORE : window.YTD_CORE;
  // 페이지 영역에서 실행 중인지 (유튜브 자체 변수에 접근 가능한지)
  // (페이지 영역이면 유튜브의 ytcfg 변수가 보이고, 확장 프로그램 영역이면 안 보임 — 로딩 후에 판단)
  const isPage = () => !window.__ytdForceContent && typeof window.ytcfg !== 'undefined';

  // ================= 1. 유튜브가 받아오는 자막 응답 엿보기 (페이지 영역일 때만 가능) =================
  const ttCache = []; // {v, lang, kind, tlang, body}
  const ttListeners = [];
  function onTimedText(url, body) {
    if (!body || body.length < 20) return;
    try {
      const u = new URL(url, location.href);
      const item = { v: u.searchParams.get('v'), lang: u.searchParams.get('lang') || '', kind: u.searchParams.get('kind') || '', tlang: u.searchParams.get('tlang') || '', body };
      ttCache.push(item); if (ttCache.length > 20) ttCache.shift();
      ttListeners.forEach(f => f(item));
    } catch (e) { /* ignore */ }
  }
  const origFetch = window.fetch.bind(window);
  try {
    window.fetch = function (input, init) {
      const p = origFetch(input, init);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (url.includes('/api/timedtext')) p.then(r => r.clone().text()).then(t => onTimedText(url, t)).catch(() => {});
      } catch (e) { /* ignore */ }
      return p;
    };
    const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, url) { this.__ytdUrl = String(url); return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      if (this.__ytdUrl && this.__ytdUrl.includes('/api/timedtext')) {
        this.addEventListener('load', () => {
          try {
            const rt = this.responseType;
            const body = (rt === '' || rt === 'text') ? this.responseText : rt === 'json' ? JSON.stringify(this.response)
              : rt === 'arraybuffer' ? new TextDecoder().decode(this.response) : '';
            onTimedText(this.__ytdUrl, body);
          } catch (e) { /* ignore */ }
        });
      }
      return XS.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }

  // ================= 2. 자막 가져오기 =================
  // 자바스크립트 문자열('...') 안의 이스케이프(\x22, \', \\ 등)를 풀기
  function unescapeJs(inner) {
    const j = inner.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1').replace(/\\'/g, "'").replace(/"/g, '\\"');
    return JSON.parse('"' + j + '"');
  }
  function decodeHex(s) { return s.replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))); }

  // text 안의 start 위치부터 시작하는 JSON 객체를 잘라서 파싱
  function extractJSON(text, start) {
    const i0 = text.indexOf('{', start);
    if (i0 < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = i0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(i0, i + 1)); } catch (e) { return null; } } }
    }
    return null;
  }

  function findVar(html, name) {
    const re = new RegExp(name + '\\s*=\\s*([\'{])', 'g');
    let m;
    while ((m = re.exec(html))) {
      if (m[1] === '{') { const j = extractJSON(html, m.index); if (j) return j; }
      else { // '...' 로 감싼 문자열 (모바일 유튜브)
        const end = html.indexOf("';", m.index + m[0].length);
        if (end > 0) { try { return JSON.parse(unescapeJs(html.slice(m.index + m[0].length, end))); } catch (e) { /* 다음 */ } }
      }
    }
    return null;
  }

  function walk(obj, key, out) {
    if (!obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) { obj.forEach(x => walk(x, key, out)); return out; }
    for (const k in obj) { if (k === key) out.push(obj[k]); else walk(obj[k], key, out); }
    return out;
  }

  function pickTrack(tracks) {
    const en = (tracks || []).filter(t => /^en\b/i.test(t.languageCode || ''));
    const score = t => (t.kind === 'asr' ? 0 : 10) + (t.languageCode === 'en' ? 2 : /^en-(US|GB)/i.test(t.languageCode) ? 1 : 0);
    en.sort((a, b) => score(b) - score(a));
    return en[0] || null;
  }

  function player() { return document.getElementById('movie_player') || document.querySelector('.html5-video-player'); }

  // 결과: { segments, source, track } 또는 오류(로그 포함)
  async function loadCaptions(videoId, log) {
    const segsFrom = (body, isAuto) => { try { return C.buildSegments(C.parseCaptionBody(body), isAuto); } catch (e) { return []; } };

    // A. 이미 유튜브가 받아둔 자막
    const cached = ttCache.find(x => x.v === videoId && /^en\b/i.test(x.lang) && !x.tlang);
    if (cached) { const s = segsFrom(cached.body, cached.kind === 'asr'); if (s.length) return { segments: s, source: 'A', auto: cached.kind === 'asr' }; }
    log.push('A:' + (isPage() ? '없음' : '건너뜀'));

    // B. 영상 페이지 정보 읽기
    let html = '', pr = null;
    try {
      const p = player();
      if (isPage() && p && p.getPlayerResponse) { const r = p.getPlayerResponse(); if (r && r.videoDetails && r.videoDetails.videoId === videoId) pr = r; }
    } catch (e) { /* ignore */ }
    try {
      const res = await origFetch('/watch?v=' + videoId + '&hl=en', { credentials: 'include' });
      html = await res.text();
      if (!pr) pr = findVar(html, 'ytInitialPlayerResponse');
    } catch (e) { log.push('B:페이지오류'); }
    const tracks = pr ? walk(pr, 'captionTracks', [])[0] || [] : [];
    const track = pickTrack(tracks);
    log.push('B:' + (pr ? '트랙' + tracks.length : '정보없음'));

    // C. 자막 주소로 직접 요청
    if (track && track.baseUrl) {
      try {
        let url = track.baseUrl;
        url = /[?&]fmt=/.test(url) ? url.replace(/([?&]fmt=)[^&]*/, '$1json3') : url + '&fmt=json3';
        const body = await (await origFetch(url, { credentials: 'include' })).text();
        const s = body.length > 20 ? segsFrom(body, track.kind === 'asr') : [];
        if (s.length) return { segments: s, source: 'C', auto: track.kind === 'asr' };
        log.push('C:빈응답');
      } catch (e) { log.push('C:오류'); }
    } else log.push('C:영어트랙없음');

    // E. 유튜브 '스크립트 표시' 기능으로 가져오기
    try {
      const dec = decodeHex(html);
      const pm = /"getTranscriptEndpoint"\s*:\s*\{\s*"params"\s*:\s*"([^"]+)"/.exec(dec) || /getTranscriptEndpoint\\?"\s*:\s*\{\s*\\?"params\\?"\s*:\s*\\?"([^"\\]+)/.exec(dec);
      if (!pm) log.push('E:파라미터없음');
      else {
        let ctx = null, key = null;
        if (isPage() && window.ytcfg && window.ytcfg.get) { ctx = window.ytcfg.get('INNERTUBE_CONTEXT'); key = window.ytcfg.get('INNERTUBE_API_KEY'); }
        if (!ctx) { const i = dec.indexOf('"INNERTUBE_CONTEXT"'); if (i >= 0) ctx = extractJSON(dec, i + 19); }
        if (!key) { const km = /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(dec); key = km && km[1]; }
        if (!ctx) ctx = { client: { clientName: 'WEB', clientVersion: '2.20251101.00.00', hl: 'en' } };
        const params = pm[1].includes('%') ? decodeURIComponent(pm[1]) : pm[1];
        const res = await origFetch('/youtubei/v1/get_transcript?prettyPrint=false' + (key ? '&key=' + key : ''), {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: ctx, params }),
        });
        if (!res.ok) log.push('E:' + res.status);
        else {
          const j = await res.json();
          const cues = walk(j, 'transcriptSegmentRenderer', []).map(r => ({
            start: (+r.startMs || 0) / 1000, end: (+r.endMs || 0) / 1000,
            text: r.snippet ? (r.snippet.simpleText || (r.snippet.runs || []).map(x => x.text).join('')) : '',
          })).filter(c => c.text && c.text.trim());
          const s = cues.length ? C.buildSegments({ cues, words: null }, false) : [];
          if (s.length) return { segments: s, source: 'E', auto: false };
          log.push('E:자막없음');
        }
      }
    } catch (e) { log.push('E:오류'); }

    // D. 유튜브 플레이어의 자막을 켜서 받아오기 (페이지 영역일 때만)
    if (isPage() && track) {
      const got = await new Promise(resolve => {
        const t = setTimeout(() => resolve(null), 8000);
        ttListeners.push(item => { if (item.v === videoId && /^en\b/i.test(item.lang) && !item.tlang) { clearTimeout(t); resolve(item); } });
        try {
          const p = player();
          if (p.loadModule) p.loadModule('captions');
          setTimeout(() => {
            try {
              const list = (p.getOption && p.getOption('captions', 'tracklist')) || [];
              const tr = list.find(x => x.languageCode === track.languageCode && (x.kind || '') === (track.kind || '')) || list.find(x => /^en/.test(x.languageCode));
              p.setOption('captions', 'track', tr || { languageCode: track.languageCode });
            } catch (e) { /* ignore */ }
          }, 600);
        } catch (e) { /* ignore */ }
      });
      if (got) { const s = segsFrom(got.body, got.kind === 'asr'); if (s.length) return { segments: s, source: 'D', auto: got.kind === 'asr' }; }
      log.push('D:실패');
    } else log.push('D:건너뜀');

    return { segments: [], noTrack: !track };
  }

  // ================= 3. 화면 =================
  const CSS = `
html.ytd-on .ytp-caption-window-container, html.ytd-on .caption-window, html.ytd-on .ytp-caption-segment { display: none !important; }
#ytd-fab { position: fixed; right: 14px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 2147483000;
  padding: 11px 16px; border-radius: 999px; border: 0; background: #2563eb; color: #fff; font: 700 15px/1 -apple-system, system-ui, sans-serif;
  box-shadow: 0 4px 16px rgba(0,0,0,.35); -webkit-tap-highlight-color: transparent; }
#ytd-panel { position: fixed; left: 0; right: 0; z-index: 2147483001; display: flex; flex-direction: column; background: #0b0d12; color: #e8eaef;
  font-family: -apple-system, system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; box-shadow: 0 -4px 20px rgba(0,0,0,.4); }
#ytd-panel * { box-sizing: border-box; }
#ytd-panel .ytd-bar { display: flex; align-items: center; gap: 10px; padding: 6px 12px; font-size: 13px; color: #8b93a3; flex-shrink: 0; }
#ytd-panel .ytd-prog { font-weight: 700; color: #e8eaef; }
#ytd-panel .ytd-stat { margin-left: auto; }
#ytd-panel .ytd-x { background: none; border: 0; color: #e8eaef; font-size: 20px; padding: 0 4px; }
#ytd-panel .ytd-wrap { position: relative; flex: 1 1 auto; min-height: 50px; margin: 0 10px; background: #151922; border-radius: 12px; }
#ytd-panel.ytd-done .ytd-wrap { background: #064e3b; }
#ytd-panel .ytd-scroll { position: absolute; inset: 0; overflow-y: auto; padding: 8px 14px; }
#ytd-panel .ytd-line { font-family: ui-monospace, Menlo, monospace; font-size: 22px; line-height: 1.65; white-space: pre-wrap; color: #e8eaef; }
#ytd-panel .ytd-in { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; font-size: 16px; border: 0; padding: 0; margin: 0;
  background: transparent; color: transparent; caret-color: transparent; z-index: 1; }
#ytd-panel .w { white-space: nowrap; }
#ytd-panel .ytd-line span { position: relative; }
#ytd-panel .p { color: #8b93a3; } #ytd-panel .ok { color: #fff; } #ytd-panel .hinted { color: #fbbf24; }
#ytd-panel .bad { color: #fff; background: #dc2626; border-radius: 3px; }
#ytd-panel .blank { color: transparent; background: linear-gradient(#5b6474, #5b6474) center bottom / 78% 2px no-repeat; }
#ytd-panel .ghost, #ytd-panel .sepb { color: #5b6474; }
#ytd-panel .cur::after { content: ""; position: absolute; left: 0; right: 0; bottom: -2px; height: 3px; background: #3b82f6; animation: ytdblink 1s steps(1) infinite; }
@keyframes ytdblink { 50% { opacity: 0; } }
#ytd-panel .ytd-msg { padding: 5px 14px; font-size: 13px; color: #8b93a3; flex-shrink: 0; min-height: 1.6em; }
#ytd-panel.ytd-done .ytd-msg { color: #6ee7b7; font-weight: 700; }
#ytd-panel .ytd-log { font-size: 11px; color: #6b7280; padding: 0 14px 4px; word-break: break-all; }
#ytd-panel .ytd-tools { display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; padding: 0 10px calc(8px + env(safe-area-inset-bottom)); flex-shrink: 0; }
#ytd-panel .ytd-tools button { padding: 8px 0; border-radius: 10px; border: 1px solid #262c38; background: #151922; color: #e8eaef; font-size: 17px; line-height: 1.1; }
#ytd-panel .ytd-tools button span { display: block; font-size: 10px; color: #8b93a3; margin-top: 2px; }
#ytd-panel .ytd-tools button:disabled { opacity: .35; }
`;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  let fab, panel, ui = {};
  function buildUI() {
    const st = el('style'); st.textContent = CSS; (document.head || document.documentElement).appendChild(st);
    fab = el('button', '', '받아쓰기'); fab.id = 'ytd-fab'; fab.type = 'button';
    fab.addEventListener('click', () => toggle(true));

    panel = el('div'); panel.id = 'ytd-panel'; panel.style.display = 'none';
    const bar = el('div', 'ytd-bar');
    ui.prog = el('span', 'ytd-prog'); ui.stat = el('span', 'ytd-stat');
    const x = el('button', 'ytd-x', '✕'); x.type = 'button'; x.addEventListener('click', () => toggle(false));
    bar.append(ui.prog, ui.stat, x);
    const wrap = el('div', 'ytd-wrap'); ui.scroll = el('div', 'ytd-scroll'); ui.line = el('div', 'ytd-line'); ui.scroll.appendChild(ui.line);
    ui.input = el('input', 'ytd-in');
    Object.assign(ui.input, { type: 'text', autocomplete: 'off', spellcheck: false });
    ui.input.setAttribute('autocorrect', 'off'); ui.input.setAttribute('autocapitalize', 'off'); ui.input.setAttribute('enterkeyhint', 'go');
    wrap.append(ui.scroll, ui.input);
    ui.msg = el('div', 'ytd-msg'); ui.log = el('div', 'ytd-log');
    ui.tools = el('div', 'ytd-tools');
    [['replay', '↺', '다시'], ['slow', '🐢', '느리게'], ['hint', '💡', '한 글자'], ['reveal', '👁', '정답'], ['prev', '⏮', '이전'], ['next', '⏭', '다음']].forEach(([act, ic, lb]) => {
      const b = el('button', '', ic); b.type = 'button'; b.dataset.act = act; b.appendChild(el('span', '', lb));
      b.addEventListener('mousedown', e => e.preventDefault()); // 키보드 내려가지 않게
      b.addEventListener('click', () => action(act));
      ui.tools.appendChild(b);
    });
    panel.append(bar, wrap, ui.msg, ui.log, ui.tools);
    // 패널 터치가 유튜브 쪽으로 전달되지 않게
    ['click', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress'].forEach(t =>
      panel.addEventListener(t, e => e.stopPropagation()));

    ui.input.addEventListener('input', sync);
    ui.input.addEventListener('compositionstart', () => { S.composing = true; });
    ui.input.addEventListener('compositionend', () => { S.composing = false; sync(); });
    ui.input.addEventListener('focus', () => { S.focused = true; render(); });
    ui.input.addEventListener('blur', () => { S.focused = false; render(); });
    ui.input.addEventListener('keydown', (e) => {
      const map = { Enter: e.shiftKey ? 'slow' : 'replay', ArrowLeft: 'replay', ArrowUp: 'hint', ArrowDown: 'reveal', ArrowRight: 'next' };
      if (map[e.key] && !e.isComposing) { e.preventDefault(); action(map[e.key]); }
    });
    document.body.append(fab, panel);
  }

  // 패널 위치: 영상 바로 아래부터 (키보드 위) 화면 끝까지
  function layout() {
    if (!panel || panel.style.display === 'none') return;
    const vv = window.visualViewport;
    const vTop = vv ? vv.offsetTop : 0, vH = vv ? vv.height : window.innerHeight;
    const v = getVideo();
    const p = (v && (v.closest('#player-container-id') || v.closest('.html5-video-player'))) || v;
    let top = p ? p.getBoundingClientRect().bottom : vTop;
    const minH = Math.min(260, vH * 0.6);
    top = Math.max(top, vTop);
    if (vTop + vH - top < minH) top = vTop + vH - minH;
    panel.style.top = top + 'px';
    panel.style.height = (vTop + vH - top) + 'px';
  }

  // ================= 4. 받아쓰기 진행 =================
  const S = {
    on: false, videoId: null, status: 'idle', msg: '', log: [], segs: [], auto: false, target: 0, typing: null,
    awaiting: false, completing: false, ownSeek: false, ownPlay: false, slowRestore: null,
    hintSet: new Set(), hintCount: 0, mistakes: 0, lastErrKey: null, composing: false, focused: false, hangul: false, boundVideo: null,
  };

  const getVideo = () => document.querySelector('#movie_player video, .html5-video-player video, video');
  const isAd = () => { const p = player(); return !!(p && p.classList && p.classList.contains('ad-showing')); };
  function urlVideoId() {
    const m = /[?&]v=([\w-]{11})/.exec(location.search);
    return (location.pathname === '/watch' && m) ? m[1] : null;
  }

  function toggle(on) {
    S.on = on;
    if (on && !S.videoId) S.videoId = urlVideoId();
    document.documentElement.classList.toggle('ytd-on', on);
    panel.style.display = on ? 'flex' : 'none';
    fab.style.display = on ? 'none' : (urlVideoId() ? '' : 'none');
    if (on) {
      if (S.status === 'ready') start();
      else if (S.status !== 'loading') load();
      layout();
    } else { restoreRate(); S.awaiting = false; ui.input.blur(); }
    render();
  }

  async function load() {
    const id = S.videoId;
    if (!id) return;
    S.status = 'loading'; S.msg = '자막 불러오는 중…'; S.log = []; render();
    const r = await loadCaptions(id, S.log);
    if (id !== S.videoId) return;
    if (r.segments.length) {
      S.segs = r.segments; S.auto = r.auto; S.status = 'ready'; S.log.push('OK:' + r.source);
      if (S.on) start();
    } else {
      S.status = 'error';
      S.msg = r.noTrack ? '이 영상에는 영어 자막이 없는 것 같아요.' : '자막을 가져오지 못했어요. 영상의 자막(CC) 버튼을 켰다가 ✕로 닫고 다시 열어 보세요.';
      if (isPage()) { // 사용자가 CC를 켜면 자동으로 다시 시도
        ttListeners.push(item => { if (S.status === 'error' && item.v === S.videoId && /^en\b/i.test(item.lang) && !item.tlang) { S.status = 'idle'; if (S.on) load(); } });
      }
    }
    render();
  }

  function indexAt(t) { const i = S.segs.findIndex(s => s.pauseAt > t + 0.05); return i === -1 ? S.segs.length : i; }

  function setTarget(i) {
    S.target = i;
    S.typing = i < S.segs.length ? C.createTyping(S.segs[i].text) : null;
    S.hintSet = new Set(); S.hintCount = 0; S.mistakes = 0; S.lastErrKey = null;
    S.awaiting = false; S.completing = false; S.hangul = false;
    setValue('');
    render();
  }

  function start() { const v = getVideo(); setTarget(indexAt(v ? v.currentTime : 0)); replay(false); }

  function seekTo(v, t) { S.ownSeek = true; v.currentTime = t; setTimeout(() => { S.ownSeek = false; }, 1500); }
  function play(v) { if (v.paused) { S.ownPlay = true; const p = v.play(); if (p && p.catch) p.catch(() => { S.ownPlay = false; }); } }
  function restoreRate() { const v = getVideo(); if (v && S.slowRestore != null) v.playbackRate = S.slowRestore; S.slowRestore = null; }

  function replay(slow) {
    const seg = S.segs[S.target], v = getVideo();
    if (!seg || !v) return;
    restoreRate();
    if (slow) { S.slowRestore = v.playbackRate; v.playbackRate = 0.75; }
    seekTo(v, Math.max(0, seg.start - 0.25));
    S.awaiting = false;
    play(v);
    render();
  }

  function goTo(i) {
    if (i >= S.segs.length) { setTarget(S.segs.length); const v = getVideo(); if (v) v.pause(); return; }
    setTarget(Math.max(0, i)); replay(false);
  }

  function onComplete() {
    S.completing = true; render();
    setTimeout(() => { if (!S.completing) return; setTarget(S.target + 1); const v = getVideo(); if (v) play(v); }, 700);
  }

  function tick() {
    if (S.on) layout();
    if (!S.on || S.status !== 'ready' || S.completing) return;
    const v = getVideo();
    if (!v || v.paused || isAd()) return;
    if (v !== S.boundVideo) bindVideo(v);
    const seg = S.segs[S.target];
    if (!seg) return;
    const t = v.currentTime;
    if (t > seg.pauseAt + 1.5) { setTarget(indexAt(t)); return; }
    if (t >= seg.pauseAt) {
      v.pause(); restoreRate();
      if (!S.awaiting) { S.awaiting = true; ui.input.focus({ preventScroll: true }); render(); }
    }
  }

  function bindVideo(v) {
    S.boundVideo = v;
    v.addEventListener('timeupdate', tick);
    v.addEventListener('seeked', () => {
      if (S.ownSeek) { S.ownSeek = false; return; }
      if (!S.on || S.status !== 'ready' || isAd()) return;
      setTarget(indexAt(v.currentTime));
    });
    v.addEventListener('play', () => {
      if (S.ownPlay) { S.ownPlay = false; return; }
      if (S.on && S.status === 'ready' && S.awaiting && S.typing && !C.isComplete(S.typing)) replay(false);
    });
    v.addEventListener('pause', render);
    v.addEventListener('playing', render);
  }

  // ---------- 입력 (입력칸 전체를 매번 다시 채점) ----------
  function setValue(v) { if (!ui.input) return; ui.input.value = v; try { ui.input.setSelectionRange(v.length, v.length); } catch (e) { /* ignore */ } }
  const normalizeInput = raw => raw.replace(/[\u2018\u2019\u02BC`´]/g, "'").replace(/[\u2010-\u2014]/g, '-');

  function sync() {
    if (!S.typing || S.completing) return;
    const chars = Array.from(normalizeInput(ui.input.value));
    const st = C.createTyping(S.typing.text);
    st.revealed = S.typing.revealed;
    let used = 0, hangul = false;
    for (const ch of chars) {
      if (/[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]/.test(ch)) { hangul = true; break; }
      if (!/^[a-zA-Z0-9' \-/]$/.test(ch)) { used++; continue; }
      const r = C.typeChar(st, ch);
      if (r === 'blocked' || r === 'done') break;
      used++;
    }
    for (const i of [...S.hintSet]) { if (i < st.typed.length) st.typed[i].hint = true; else S.hintSet.delete(i); }
    if (C.hasError(st)) { const k = st.typed.length + ':' + st.typed[st.typed.length - 1].ch; if (k !== S.lastErrKey) { S.mistakes++; S.lastErrKey = k; } }
    else S.lastErrKey = null;
    S.typing = st; S.hangul = hangul;
    if (used < chars.length && !S.composing) setValue(chars.slice(0, used).join(''));
    if (C.isComplete(st)) onComplete(); else render();
  }

  function canonicalValue(st) {
    const ok = C.hasError(st) ? st.typed.slice(0, -1) : st.typed;
    return ok.map(t => (t.ch === '-' || t.ch === '/' || t.ch === ' ') ? ' ' : t.ch.toLowerCase()).join('');
  }

  function doHint() {
    const st = S.typing;
    if (!st || C.isComplete(st) || S.completing) return;
    let v = canonicalValue(st);
    let pos = st.typed.length - (C.hasError(st) ? 1 : 0);
    let exp = C.expectedAt(st, pos);
    if (!exp) return;
    if (exp.kind === 'sep') { v += ' '; S.hintSet.add(pos); pos++; exp = C.expectedAt(st, pos); }
    if (exp) { v += exp.expect; S.hintSet.add(pos); }
    S.hintCount++;
    setValue(v); sync();
  }

  function action(act) {
    if (S.status !== 'ready') return;
    if (act === 'replay') replay(false);
    else if (act === 'slow') replay(true);
    else if (act === 'next') goTo(S.target + 1);
    else if (act === 'prev') goTo(S.target - 1);
    else if (act === 'hint') doHint();
    else if (act === 'reveal' && S.typing) { S.typing.revealed = true; render(); }
  }

  // ---------- 그리기 (DOM 직접 생성) ----------
  function renderLine(st) {
    const frag = document.createDocumentFragment();
    const cur = st.typed.length;
    let word = el('span', 'w'); frag.appendChild(word);
    for (const it of st.slots.items) {
      if (it.kind === 'punct') { word.appendChild(el('span', 'p', it.display)); continue; }
      const pos = it.inputIndex;
      let cls, txt;
      if (pos < cur) {
        const t = st.typed[pos];
        if (t.ok) { cls = t.hint ? 'ok hinted' : 'ok'; txt = it.display; }
        else { cls = 'bad'; txt = t.ch === ' ' ? '␣' : t.ch; }
      } else if (it.kind === 'sep') { cls = 'sepb'; txt = it.display; }
      else if (st.revealed) { cls = 'ghost'; txt = it.display; }
      else { cls = 'blank'; txt = it.display; }
      if (pos === cur) cls += S.focused ? ' at cur' : ' at';
      if (it.kind === 'sep' && it.display === ' ') {
        frag.appendChild(el('span', 'sp ' + cls, cls.includes('bad') ? txt : ' '));
        word = el('span', 'w'); frag.appendChild(word);
      } else word.appendChild(el('span', cls, txt));
    }
    return frag;
  }

  function keepCursorVisible() {
    const sc = ui.scroll;
    const c = sc.querySelector('.bad') || sc.querySelector('.at');
    if (!c) { sc.scrollTop = 0; return; }
    const r = c.getBoundingClientRect(), s = sc.getBoundingClientRect();
    if (r.bottom > s.bottom - 6) sc.scrollTop += r.bottom - s.bottom + r.height * 0.6;
    else if (r.top < s.top + 4) sc.scrollTop -= s.top - r.top + r.height * 0.3;
  }

  function render() {
    if (!panel) return;
    fab.style.display = (!S.on && urlVideoId()) ? '' : 'none';
    if (!S.on) return;
    const st = S.typing, total = S.segs.length, ready = S.status === 'ready';
    ui.prog.textContent = ready ? `${Math.min(S.target + 1, total)} / ${total}${S.auto ? ' · 자동자막' : ''}` : '';
    ui.stat.textContent = st && ready ? `오타 ${S.mistakes} · 힌트 ${S.hintCount}${st.revealed ? ' · 정답 봄' : ''}` : '';
    ui.line.replaceChildren(ready && st ? renderLine(st) : document.createTextNode(''));
    keepCursorVisible();
    panel.classList.toggle('ytd-done', !!S.completing);
    ui.tools.querySelectorAll('button').forEach(b => { b.disabled = !ready || (!st && !['prev', 'replay'].includes(b.dataset.act)); });
    ui.log.textContent = S.status === 'error' ? '진단: ' + S.log.join(' / ') + (isPage() ? ' (P)' : ' (C)') : '';
    const v = getVideo();
    let m;
    if (!ready) m = S.msg;
    else if (!st) m = '🎉 끝! 모든 대사를 완료했어요';
    else if (S.completing) m = '✓ 정답! 다음 대사로 넘어가요';
    else if (S.hangul) m = '⌨ 키보드를 영어로 바꿔 주세요';
    else if (C.hasError(st)) m = '빨간 글자를 지우고 다시 입력하세요';
    else if (!S.focused) m = '👆 문장을 눌러서 입력을 시작하세요';
    else if (v && !v.paused) m = '🎧 듣는 중… (미리 입력해도 돼요)';
    else m = '들은 대로 입력하세요';
    ui.msg.textContent = m;
  }

  // ================= 5. 시작 =================
  function boot() {
    if (!document.body) return setTimeout(boot, 100);
    buildUI();
    setInterval(() => {
      const id = urlVideoId();
      if (id !== S.videoId) {
        S.videoId = id; S.status = 'idle'; S.segs = []; S.typing = null; S.awaiting = false; S.completing = false;
        if (!id && S.on) toggle(false);
        else if (id && S.on) load();
        render();
      }
      const v = getVideo();
      if (v && v !== S.boundVideo) bindVideo(v);
    }, 500);
    (function loop() { tick(); requestAnimationFrame(loop); })();
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', layout); window.visualViewport.addEventListener('scroll', layout); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.__ytdUS = { S, action, loadCaptions };
})();
