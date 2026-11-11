// ==UserScript==
// @name         YouTube 받아쓰기
// @namespace    https://github.com/codedoyun
// @version      0.1.8
// @description  유튜브 영어 대사를 듣고 한 글자씩 받아쓰는 듣기 연습
// @match        https://m.youtube.com/*
// @match        https://www.youtube.com/*
// @run-at       document-start
// @inject-into  content
// @noframes
// @grant        none
// @updateURL    https://codedoyun.github.io/yt-dictation-web/yt-dictation.user.js
// @downloadURL  https://codedoyun.github.io/yt-dictation-web/yt-dictation.user.js
// ==/UserScript==

// core.js — 자막 파싱, 문장 나누기, 타이핑 채점 로직 (화면/영상과 무관한 순수 로직)
(function (root) {
  'use strict';

  // ---------- 텍스트 정리 ----------
  function decodeEntities(s) {
    if (!s || s.indexOf('&') === -1) return s;
    return s
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  function cleanText(s) {
    s = decodeEntities(s || '');
    s = s.replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"');
    s = s.replace(/\[[^\]]*\]/g, ' ')          // [Music], [Applause]
         .replace(/\([^)]*\)/g, ' ')           // (laughs)
         .replace(/[♪♫♬]/g, ' ');
    s = s.replace(/\r?\n/g, ' ');
    s = s.replace(/(^|\s)>>\s*/g, '$1');       // >> 화자 표시
    s = s.replace(/^\s*-\s+/, '').replace(/\s+-\s+(?=[A-Z])/g, ' ');
    s = s.replace(/(^|\s)[A-Z][A-Z .'-]{1,24}:\s/g, '$1'); // JOHN: 화자 이름
    return s.replace(/\s+/g, ' ').trim();
  }

  // ---------- 자막 파일 파싱 ----------
  // 반환: { cues: [{start, end, text}], words: [{start, text}] | null }
  function parseCaptionBody(body) {
    body = (body || '').trim();
    if (!body) return null;
    if (body[0] === '{') return parseJson3(JSON.parse(body));
    if (body[0] === '<') return parseXml(body);
    return null;
  }

  function parseJson3(j) {
    const events = (j.events || []).filter(e => e.segs && !e.aAppend);
    const cues = [];
    let wordLevel = false;
    const words = [];
    for (const e of events) {
      const start = (e.tStartMs || 0) / 1000;
      const end = start + (e.dDurationMs || 0) / 1000;
      const text = e.segs.map(s => s.utf8 || '').join('');
      if (!text.trim()) continue;
      cues.push({ start, end, text });
      if (e.segs.length > 1 || e.segs.some(s => s.tOffsetMs !== undefined)) wordLevel = true;
      for (const s of e.segs) {
        const w = (s.utf8 || '').trim();
        if (w) words.push({ start: start + (s.tOffsetMs || 0) / 1000, cueEnd: end, text: w });
      }
    }
    return { cues, words: wordLevel ? words : null };
  }

  function parseXml(body) {
    const cues = [];
    const words = [];
    let wordLevel = false;
    // srv3: <p t="ms" d="ms"><s t="offset">word</s></p>
    const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = pRe.exec(body))) {
      const t = +(attr(m[1], 't') || 0) / 1000;
      const d = +(attr(m[1], 'd') || 0) / 1000;
      const inner = m[2];
      const sRe = /<s\b([^>]*)>([\s\S]*?)<\/s>/g;
      let sm, any = false;
      while ((sm = sRe.exec(inner))) {
        any = true;
        const w = decodeEntities(sm[2].replace(/<[^>]+>/g, '')).trim();
        if (w) words.push({ start: t + +(attr(sm[1], 't') || 0) / 1000, cueEnd: t + d, text: w });
      }
      if (any) wordLevel = true;
      const text = decodeEntities(inner.replace(/<[^>]+>/g, ''));
      if (text.trim()) cues.push({ start: t, end: t + d, text });
    }
    if (!cues.length) {
      // srv1: <text start="s" dur="s">...</text>
      const tRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
      while ((m = tRe.exec(body))) {
        const st = +(attr(m[1], 'start') || 0);
        const du = +(attr(m[1], 'dur') || 0);
        const text = decodeEntities(decodeEntities(m[2].replace(/<[^>]+>/g, '')));
        if (text.trim()) cues.push({ start: st, end: st + du, text });
      }
    }
    return { cues, words: wordLevel ? words : null };
  }

  function attr(s, name) {
    const m = new RegExp('\\b' + name + '="([^"]*)"').exec(s);
    return m ? m[1] : null;
  }

  // ---------- 문장 단위로 묶기 ----------
  const END_RE = /[.?!…]["')\]]*$/;

  function buildSegments(parsed, isAuto) {
    if (!parsed) return [];
    let raw = (isAuto && parsed.words && parsed.words.length) ? segmentWords(parsed.words) : segmentCues(parsed.cues);
    raw = raw
      .map(s => ({ start: s.start, end: s.end, text: cleanText(s.text) }))
      .filter(s => s.text && buildSlots(s.text).inputs.length > 0);
    // 멈출 시각(pauseAt) 계산: 다음 대사가 시작되기 전까지
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i], next = raw[i + 1];
      let p = s.end + 0.1;
      if (next && next.start > s.start + 0.3) p = Math.min(p, next.start - 0.02);
      s.pauseAt = Math.max(p, s.start + 0.4);
    }
    return raw;
  }

  // TED 등 자막 맨 앞의 제작자 표시 (대사가 아님)
  const CREDIT_RE = /^\s*(transcriber|translator|reviewer|transcription|subtitles?\s+(by|and)|captions?\s+(by|and)|caption(ing|s)?\s+by|synced\s+(and|&)|corrected\s+by|subtitle\s+edit)\b/i;

  function segmentCues(cues) {
    const out = [];
    let cur = null;
    const wc = t => cleanText(t).split(' ').filter(Boolean).length;
    cues = cues.filter(c => !CREDIT_RE.test(c.text));
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const startsNewSpeaker = /^\s*(>>|-\s)/.test(c.text);
      if (cur) {
        const gap = c.start - cur.end;
        const tooLong = wc(cur.text) + wc(c.text) > 18 || c.end - cur.start > 12;
        if (gap > 1.2 || tooLong || startsNewSpeaker || END_RE.test(cleanText(cur.text))) {
          out.push(cur); cur = null;
        }
      }
      if (!cur) cur = { start: c.start, end: c.end, text: c.text };
      else { cur.end = Math.max(cur.end, c.end); cur.text += ' ' + c.text; }
    }
    if (cur) out.push(cur);
    // 겹치는 끝 시간 보정
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start && out[i + 1].start > out[i].start) out[i].end = out[i + 1].start;
    }
    return out;
  }

  function segmentWords(words) {
    const out = [];
    let cur = null;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = words[i + 1];
      const wEnd = next ? Math.min(next.start, w.cueEnd || next.start) : (w.cueEnd || w.start + 0.6);
      if (!cur) cur = { start: w.start, end: wEnd, text: w.text, n: 1 };
      else { cur.text += ' ' + w.text; cur.end = wEnd; cur.n++; }
      const gap = next ? next.start - w.start : Infinity;
      const endsSentence = END_RE.test(w.text);
      if (!next || endsSentence || (gap > 1.0 && cur.n >= 3) || cur.n >= 14 || (gap > 1.8)) {
        // 단어 끝 시간 추정: 다음 단어까지 너무 멀면 0.6초로 자름
        if (!next || gap > 1.0) cur.end = Math.min(cur.end, w.start + 0.7);
        out.push(cur); cur = null;
      }
    }
    return out;
  }

  // ---------- 타이핑 슬롯 ----------
  // 문장을 "보여줄 조각"들로 나눔.
  //  char: 사용자가 쳐야 하는 글자 (a-z, 0-9, 단어 안의 ')
  //  sep : 단어 사이 구분 (스페이스 또는 - 로 입력)
  //  punct: 자동으로 채워지는 문장부호
  function isLetter(c) { return /[A-Za-z0-9]/.test(c); }

  function normChar(c) {
    const n = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return n.length === 1 ? n : c;
  }

  function buildSlots(text) {
    const chars = Array.from(text).map(normChar);
    const typ = chars.map((c, i) =>
      isLetter(c) || (c === "'" && i > 0 && i < chars.length - 1 && /[A-Za-z]/.test(chars[i - 1]) && /[A-Za-z]/.test(chars[i + 1]))
    );
    const items = [];
    let i = 0;
    while (i < chars.length) {
      if (typ[i]) { items.push({ kind: 'char', display: chars[i], expect: chars[i].toLowerCase() }); i++; continue; }
      // 타이핑하지 않는 글자들의 묶음
      let j = i;
      while (j < chars.length && !typ[j]) j++;
      const run = chars.slice(i, j);
      const between = i > 0 && j < chars.length; // 양쪽에 단어가 있음
      if (!between) {
        run.forEach(c => { if (c !== ' ') items.push({ kind: 'punct', display: c }); });
      } else if (run.some(c => c === ' ')) {
        const k = run.indexOf(' ');
        run.slice(0, k).forEach(c => items.push({ kind: 'punct', display: c }));
        items.push({ kind: 'sep', display: ' ' });
        run.slice(k).forEach(c => { if (c !== ' ') items.push({ kind: 'punct', display: c }); });
      } else if (/[0-9]/.test(chars[i - 1]) && /[0-9]/.test(chars[j]) && /^[.,:]$/.test(run.join(''))) {
        run.forEach(c => items.push({ kind: 'punct', display: c })); // 5,000 / 3.5 / 10:30
      } else if (run.length === 1 && (run[0] === '-' || run[0] === '/')) {
        items.push({ kind: 'sep', display: run[0] });
      } else {
        run.forEach(c => items.push({ kind: 'punct', display: c }));
        items.push({ kind: 'sep', display: ' ' });
      }
      i = j;
    }
    const inputs = [];
    items.forEach((it, idx) => { if (it.kind !== 'punct') { it.inputIndex = inputs.length; inputs.push(idx); } });
    return { items, inputs };
  }

  // ---------- 타이핑 상태 ----------
  // typed: [{ch, ok, hint}]  — 틀린 글자는 최대 1개(마지막)
  function createTyping(text) {
    const slots = buildSlots(text);
    return { text, slots, typed: [], mistakes: 0, hints: 0, revealed: false };
  }

  function expectedAt(st, pos) {
    const idx = st.slots.inputs[pos];
    return idx === undefined ? null : st.slots.items[idx];
  }

  function hasError(st) { return st.typed.length > 0 && !st.typed[st.typed.length - 1].ok; }
  function isComplete(st) { return !hasError(st) && st.typed.length === st.slots.inputs.length; }

  function matches(item, ch) {
    if (!item) return false;
    if (item.kind === 'sep') return ch === ' ' || ch === '-' || ch === '/';
    return item.expect === ch.toLowerCase();
  }

  // 반환: 'ok' | 'wrong' | 'blocked' | 'done'
  function typeChar(st, ch) {
    if (isComplete(st)) return 'done';
    if (hasError(st)) return 'blocked';
    const pos = st.typed.length;
    const exp = expectedAt(st, pos);
    if (matches(exp, ch)) { st.typed.push({ ch, ok: true }); return 'ok'; }
    // 띄어쓰기나 아포스트로피(don't의 ')를 건너뛰고 다음 글자를 친 경우 → 자동으로 채움
    const skippable = exp && (exp.kind === 'sep' || exp.expect === "'");
    if (skippable && ch !== ' ' && matches(expectedAt(st, pos + 1), ch)) {
      st.typed.push({ ch: exp.kind === 'sep' ? ' ' : "'", ok: true, auto: true });
      st.typed.push({ ch, ok: true });
      return 'ok';
    }
    st.typed.push({ ch, ok: false });
    st.mistakes++;
    return 'wrong';
  }

  function backspace(st) {
    if (!st.typed.length) return;
    st.typed.pop();
    // 자동으로 채운 띄어쓰기는 같이 지움
    while (st.typed.length && st.typed[st.typed.length - 1].auto) st.typed.pop();
  }

  function hint(st) {
    if (isComplete(st)) return;
    if (hasError(st)) st.typed.pop();
    const exp = expectedAt(st, st.typed.length);
    if (!exp) return;
    st.typed.push({ ch: exp.kind === 'sep' ? ' ' : exp.expect, ok: true, hint: true });
    st.hints++;
    // 띄어쓰기만 채운 경우엔 다음 글자까지 같이 보여줌
    if (exp.kind === 'sep') hint(st), st.hints--;
  }

  const api = {
    cleanText, parseCaptionBody, buildSegments, buildSlots,
    createTyping, typeChar, backspace, hint, isComplete, hasError, expectedAt,
  };
  root.YTD_CORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

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
  // 유튜브 플레이어가 요청한 자막 주소(보안 토큰 pot 포함)를 기록 — 페이지 영역이 아니어도 볼 수 있음
  const ttUrls = [];
  function noteUrl(u) { if (u && u.includes('/api/timedtext') && !ttUrls.includes(u)) { ttUrls.push(u); if (ttUrls.length > 50) ttUrls.shift(); } }
  try {
    if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(2000);
    performance.getEntriesByType('resource').forEach(e => noteUrl(e.name));
    new PerformanceObserver(list => list.getEntries().forEach(e => noteUrl(e.name))).observe({ type: 'resource', buffered: true });
  } catch (e) { /* ignore */ }
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

  // 사파리 상단 'YouTube 앱에서 열기' 배너의 원인(meta 태그)을 페이지가 읽기 전에 지움
  function killAppBanner(root) {
    (root.querySelectorAll ? root.querySelectorAll('meta[name="apple-itunes-app"]') : []).forEach(m => m.remove());
  }
  try {
    killAppBanner(document);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.tagName === 'META' && n.getAttribute('name') === 'apple-itunes-app') n.remove(); else killAppBanner(n);
    }))).observe(document, { childList: true, subtree: true });
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

  const last = { track: null, tracks: [], videoId: null };

  // 한글 해석 자막 가져오기: 한국어 자막 트랙 → 없으면 유튜브 자동번역(tlang=ko)
  async function loadKorean(videoId, segs, okUrl) {
    const cands = [];
    const ko = (last.tracks || []).find(t => /^ko\b/i.test(t.languageCode || '') && t.kind !== 'asr');
    const withFmt = (raw, extra) => { try { const u = new URL(raw, location.href); u.searchParams.set('fmt', 'json3'); u.searchParams.delete('tlang'); Object.entries(extra || {}).forEach(([k, v]) => u.searchParams.set(k, v)); return u.toString(); } catch (e) { return null; } };
    if (ko && ko.baseUrl) cands.push(withFmt(ko.baseUrl));
    if (okUrl) cands.push(withFmt(okUrl, { tlang: 'ko' }));
    ttUrls.filter(u => u.includes('v=' + videoId) && u.includes('pot=')).reverse().forEach(u => {
      if (ko) cands.push(withFmt(u, { lang: 'ko', kind: '' }).replace(/([?&])kind=(&|$)/, '$1'));
      cands.push(withFmt(u, last.track ? { lang: last.track.languageCode, ...(last.track.kind ? { kind: last.track.kind } : {}), tlang: 'ko' } : { tlang: 'ko' }));
    });
    if (last.track && last.track.baseUrl) cands.push(withFmt(last.track.baseUrl, { tlang: 'ko' }));
    for (const url of cands.filter(Boolean)) {
      try {
        const body = await (await origFetch(url, { credentials: 'include' })).text();
        if (body.length < 20) continue;
        const parsed = C.parseCaptionBody(body);
        const cues = (parsed && parsed.cues || []).map(c => ({ start: c.start, end: c.end, text: C.cleanText(c.text) })).filter(c => c.text);
        if (!cues.length) continue;
        // 시간이 겹치는 한국어 자막을 각 문장에 붙임
        let hit = 0;
        segs.forEach(sg => {
          const end = Math.max(sg.pauseAt, sg.end);
          const parts = cues.filter(c => { const mid = (c.start + c.end) / 2; return mid >= sg.start - 0.2 && mid <= end + 0.2; }).map(c => c.text);
          sg.ko = [...new Set(parts)].join(' ');
          if (sg.ko) hit++;
        });
        if (hit) return true;
      } catch (e) { /* 다음 후보 */ }
    }
    return false;
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
    last.track = track; last.tracks = tracks; last.videoId = videoId;
    log.push('B:' + (pr ? '트랙' + tracks.length : '정보없음'));

    // C. 자막 주소로 직접 요청
    if (track && track.baseUrl) {
      try {
        let url = track.baseUrl;
        url = /[?&]fmt=/.test(url) ? url.replace(/([?&]fmt=)[^&]*/, '$1json3') : url + '&fmt=json3';
        const body = await (await origFetch(url, { credentials: 'include' })).text();
        const s = body.length > 20 ? segsFrom(body, track.kind === 'asr') : [];
        if (s.length) return { segments: s, source: 'C', auto: track.kind === 'asr', url };
        log.push('C:빈응답');
      } catch (e) { log.push('C:오류'); }
    } else log.push('C:영어트랙없음');

    // F. 플레이어가 이미 요청했던 자막 주소(토큰 포함)를 재사용
    async function tryRecorded() {
      try { performance.getEntriesByType('resource').forEach(e => noteUrl(e.name)); } catch (e) { /* ignore */ }
      const urls = ttUrls.filter(u => u.includes('v=' + videoId)).reverse();
      for (const raw of urls) {
        try {
          const u = new URL(raw, location.href);
          u.searchParams.delete('tlang');
          u.searchParams.set('fmt', 'json3');
          if (track && !/^en\b/i.test(u.searchParams.get('lang') || '')) {
            u.searchParams.set('lang', track.languageCode);
            if (track.kind) u.searchParams.set('kind', track.kind); else u.searchParams.delete('kind');
          }
          const isAuto = u.searchParams.get('kind') === 'asr';
          const body = await (await origFetch(u.toString(), { credentials: 'include' })).text();
          const s = body.length > 20 ? segsFrom(body, isAuto) : [];
          if (s.length) return { segments: s, auto: isAuto, url: u.toString() };
        } catch (e) { /* 다음 주소 */ }
      }
      return null;
    }
    let rec = await tryRecorded();
    if (rec) return { ...rec, source: 'F1' };
    log.push('F1:' + ttUrls.filter(u => u.includes('v=' + videoId)).length);

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

    // F2. 플레이어의 CC 버튼을 대신 눌러서 자막을 요청하게 만든 뒤, 그 주소를 재사용
    if (track) {
      const btn = document.querySelector('.ytp-subtitles-button, button.ytmClosedCaptioningButtonButton, ytm-closed-captioning-button button, button[aria-label*="aption"], button[aria-label*="자막"]');
      if (btn) {
        const before = ttUrls.length;
        try { btn.click(); } catch (e) { /* ignore */ }
        for (let i = 0; i < 25 && ttUrls.length === before; i++) {
          await new Promise(r => setTimeout(r, 200));
          try { performance.getEntriesByType('resource').forEach(e => noteUrl(e.name)); } catch (e) { /* ignore */ }
        }
        rec = await tryRecorded();
        if (rec) return { ...rec, source: 'F2' };
        log.push('F2:실패');
      } else log.push('F2:CC버튼없음');
    }

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
#ytd-fab { position: fixed; right: 14px; bottom: calc(96px + env(safe-area-inset-bottom)); z-index: 2147483000;
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
#ytd-panel .ytd-ko { display: none; margin: 6px 10px 0; padding: 8px 12px; border-radius: 10px; background: #1e2240; color: #c7d2fe;
  font-size: 15px; line-height: 1.5; max-height: 30%; overflow-y: auto; flex-shrink: 0; }
#ytd-panel .ytd-ko.show { display: block; }
#ytd-panel .ytd-msg { padding: 5px 14px; font-size: 13px; color: #8b93a3; flex-shrink: 0; min-height: 1.6em; }
#ytd-panel.ytd-done .ytd-msg { color: #6ee7b7; font-weight: 700; }
#ytd-panel .ytd-log { font-size: 11px; color: #6b7280; padding: 0 14px 4px; word-break: break-all; }
#ytd-panel .ytd-tools { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; padding: 0 10px calc(8px + env(safe-area-inset-bottom)); flex-shrink: 0; }
#ytd-panel .ytd-tools button { padding: 8px 0; border-radius: 10px; border: 1px solid #262c38; background: #151922; color: #e8eaef; font-size: 17px; line-height: 1.1; }
#ytd-panel .ytd-tools button span { display: block; font-size: 10px; white-space: nowrap; color: #8b93a3; margin-top: 2px; }
#ytd-panel .ytd-tools button:disabled { opacity: .35; }
#ytd-panel .ytd-mini { display: none; width: 100%; background: #000; flex-shrink: 0; }
#ytd-panel.ytd-kb .ytd-mini { display: block; order: -1; }
#ytd-panel.ytd-kb .ytd-bar { order: 0; padding: 3px 12px; }
#ytd-panel.ytd-kb .ytd-msg { order: 1; padding: 0 14px 3px; font-size: 12px; min-height: 0; }
#ytd-panel.ytd-kb .ytd-wrap { order: 2; }
#ytd-panel.ytd-kb .ytd-ko { order: 3; }
#ytd-panel.ytd-kb .ytd-log { order: 4; }
#ytd-panel.ytd-kb .ytd-tools { order: 5; padding: 5px 10px 5px; }
#ytd-panel.ytd-kb .ytd-tools button { padding: 6px 0; }
#ytd-panel .ytd-scroll { overscroll-behavior: contain; }
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
    const wrap = el('div', 'ytd-wrap'); ui.scroll = el('div', 'ytd-scroll'); ui.line = el('div', 'ytd-line'); ui.ko = el('div', 'ytd-ko');
    ui.scroll.append(ui.line);
    ui.input = el('input', 'ytd-in');
    Object.assign(ui.input, { type: 'text', autocomplete: 'off', spellcheck: false });
    ui.input.setAttribute('autocorrect', 'off'); ui.input.setAttribute('autocapitalize', 'off'); ui.input.setAttribute('enterkeyhint', 'go');
    wrap.append(ui.scroll, ui.input);
    ui.msg = el('div', 'ytd-msg'); ui.log = el('div', 'ytd-log');
    ui.tools = el('div', 'ytd-tools');
    [['replay', '↺', '다시'], ['slow', '🐢', '느리게'], ['hint', '💡', '한 글자'], ['reveal', '👁', '정답'], ['ko', '가', '해석'], ['prev', '⏮', '이전'], ['next', '⏭', '다음']].forEach(([act, ic, lb]) => {
      const b = el('button', '', ic); b.type = 'button'; b.dataset.act = act; b.appendChild(el('span', '', lb));
      b.addEventListener('mousedown', e => e.preventDefault()); // 키보드 내려가지 않게
      b.addEventListener('click', () => action(act));
      ui.tools.appendChild(b);
    });
    ui.canvas = el('canvas', 'ytd-mini');
    panel.append(ui.canvas, bar, wrap, ui.ko, ui.msg, ui.log, ui.tools);
    // 패널 터치가 유튜브 쪽으로 전달되지 않게
    ['click', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress'].forEach(t =>
      panel.addEventListener(t, e => e.stopPropagation()));

    let touchY = null, touchEl = null;
    panel.addEventListener('touchstart', e => {
      const t = e.target;
      touchEl = (t === ui.input || ui.scroll.contains(t)) ? ui.scroll : ui.ko.contains(t) ? ui.ko : null;
      touchY = e.touches[0].clientY;
    }, { passive: true });
    panel.addEventListener('touchmove', e => {
      e.preventDefault(); // 뒤의 유튜브 페이지가 같이 움직이지 않게
      if (touchEl && touchY != null) { const y = e.touches[0].clientY; touchEl.scrollTop += touchY - y; touchY = y; }
    }, { passive: false });
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
  // 키보드가 올라와 영상이 가려질 때, 패널 맨 위에 영상을 작게 그려서 보여줌
  let miniBroken = false;
  function drawMini() {
    const v = getVideo(), c = ui.canvas;
    if (!v || miniBroken || !v.videoWidth) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    const scale = Math.min(W / v.videoWidth, H / v.videoHeight);
    const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
    try { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh); }
    catch (e) { miniBroken = true; c.style.display = 'none'; }
  }
  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function layout() {
    if (!panel || panel.style.display === 'none') return;
    const vv = window.visualViewport;
    const vTop = vv ? vv.offsetTop : 0, vH = vv ? vv.height : window.innerHeight;
    // 키보드가 올라와 있으면: 화면(보이는 영역) 전체에 고정, 버튼은 위쪽에 → 스크롤해도 안 움직이고 키보드 위 바에 안 가려짐
    const kb = !!(S.focused && vv && (window.innerHeight - vH > 120 || window.__ytdKb));
    panel.classList.toggle('ytd-kb', kb);
    if (kb) {
      panel.style.top = vTop + 'px';
      panel.style.height = Math.max(160, vH) + 'px';
      // 영상 미니 화면 높이: 화면의 28% 정도
      const w = panel.clientWidth || window.innerWidth;
      const ch = Math.round(Math.min(vH * 0.28, w * 9 / 16));
      if (ui.canvas.style.height !== ch + 'px') ui.canvas.style.height = ch + 'px';
      drawMini();
      return;
    }
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
      S.koState = 'loading';
      loadKorean(id, r.segments, r.url).then(ok => { if (id === S.videoId) { S.koState = ok ? 'ok' : 'none'; render(); } });
      if (S.on) start();
    } else {
      S.status = 'error';
      S.msg = r.noTrack ? '이 영상에는 영어 자막이 없는 것 같아요.' : '자막을 가져오지 못했어요. 영상을 잠깐 재생하고 자막(CC)을 켠 다음, ✕로 닫고 받아쓰기를 다시 눌러 보세요.';
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
    S.awaiting = false; S.completing = false; S.hangul = false; S.showKo = false;
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
    else if (act === 'ko' && S.typing) { S.showKo = !S.showKo; render(); }
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
    const pad = 0;
    if (r.bottom > s.bottom - 6 - pad) sc.scrollTop += r.bottom - (s.bottom - pad) + r.height * 0.6;
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
    const seg = S.segs[S.target];
    ui.ko.textContent = ready && st && S.showKo
      ? (seg && seg.ko ? seg.ko : S.koState === 'loading' ? '한글 해석 불러오는 중…' : '이 영상은 한글 해석을 가져오지 못했어요')
      : '';
    ui.ko.classList.toggle('show', !!ui.ko.textContent);
    if (ui.ko.textContent) { ui.ko.scrollTop = 0; keepCursorVisible(); }
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
    killAppBanner(document);
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
