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

  function segmentCues(cues) {
    const out = [];
    let cur = null;
    const wc = t => cleanText(t).split(' ').filter(Boolean).length;
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
    // 띄어쓰기를 깜빡하고 다음 단어 첫 글자를 친 경우 → 자동으로 띄어쓰기 채움
    if (exp && exp.kind === 'sep' && ch !== ' ' && matches(expectedAt(st, pos + 1), ch)) {
      st.typed.push({ ch: ' ', ok: true, auto: true });
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
