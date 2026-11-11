// subs.js — 사용자가 넣은 자막(SRT, VTT, 유튜브 스크립트 복사본, json3/XML)을 읽어서 문장 목록으로 바꿈
(function (root) {
  'use strict';
  const C = root.YTD_CORE || (typeof require !== 'undefined' ? require('./core.js') : null);

  // "00:01:02,500" / "01:02.5" / "1:02" → 초
  function toSec(s) {
    const parts = s.trim().replace(',', '.').split(':').map(Number);
    if (parts.some(isNaN)) return NaN;
    return parts.reduce((a, b) => a * 60 + b, 0);
  }

  const ARROW_RE = /^\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d+)?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d+)?)/;

  function stripTags(t) {
    return t.replace(/<\d{1,2}:\d{2}[^>]*>/g, '')   // <00:00:01.000> (VTT 단어 타이밍)
            .replace(/<\/?[a-zA-Z][^>]*>/g, '')      // <c>, <i>, <b>, <font ...>
            .replace(/\{\\[^}]*\}/g, '');            // {\an8}
  }

  // SRT / VTT
  function parseTimed(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    const cues = [];
    let lastLine = '';
    for (let i = 0; i < lines.length; i++) {
      const m = ARROW_RE.exec(lines[i]);
      if (!m) continue;
      const start = toSec(m[1]), end = toSec(m[2]);
      const body = [];
      for (i = i + 1; i < lines.length && lines[i].trim() !== ''; i++) {
        if (ARROW_RE.test(lines[i])) { i--; break; }
        body.push(lines[i]);
      }
      // 유튜브 자동자막 VTT는 이전 줄을 반복해서 보여줌 → 중복 줄 제거
      const fresh = body.map(l => stripTags(l).trim()).filter(l => l && l !== lastLine);
      if (body.length) lastLine = stripTags(body[body.length - 1]).trim();
      if (fresh.length) cues.push({ start, end, text: fresh.join(' ') });
    }
    return cues;
  }

  // 유튜브 "스크립트 표시"에서 복사한 텍스트: "0:01\n문장\n0:04\n문장" 또는 "0:01 문장"
  const TS_RE = /^\s*((?:\d+:)?\d{1,2}:\d{2})\s*(.*)$/;
  function parseTranscript(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    const items = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = TS_RE.exec(line);
      if (m) {
        cur = { start: toSec(m[1]), text: m[2] || '' };
        items.push(cur);
      } else if (cur && !/^\d+\s*(초|분|seconds?|minutes?)/i.test(line)) {
        cur.text += (cur.text ? ' ' : '') + line;
      }
    }
    const cues = items.filter(x => x.text.trim());
    for (let i = 0; i < cues.length; i++) {
      const next = cues[i + 1];
      cues[i].end = next ? Math.min(next.start, cues[i].start + 8) : cues[i].start + 5;
    }
    return cues;
  }

  // 반환: { segments, format } — 실패하면 segments가 빈 배열
  function parseSubtitles(text) {
    text = (text || '').replace(/^﻿/, '').trim();
    if (!text) return { segments: [], format: null };
    let parsed = null, format = null;
    if (text[0] === '{' || text[0] === '<') {
      try { parsed = C.parseCaptionBody(text); format = text[0] === '{' ? 'json3' : 'xml'; } catch (e) { parsed = null; }
    }
    if (!parsed || !parsed.cues.length) {
      if (/-->/.test(text)) { parsed = { cues: parseTimed(text), words: null }; format = /^WEBVTT/.test(text) ? 'vtt' : 'srt'; }
      else { parsed = { cues: parseTranscript(text), words: null }; format = 'transcript'; }
    }
    parsed.cues.sort((a, b) => a.start - b.start);
    return { segments: C.buildSegments(parsed, false), format };
  }

  // 유튜브 링크 → 영상 ID
  function parseVideoId(input) {
    input = (input || '').trim();
    if (/^[\w-]{11}$/.test(input)) return input;
    try {
      const u = new URL(input.includes('://') ? input : 'https://' + input);
      const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
      if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
      if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
        const m = /^\/(shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname);
        if (m) return m[2];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  const api = { parseSubtitles, parseVideoId };
  root.YTD_SUBS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
