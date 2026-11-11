// app.js — 화면 전환, 받아쓰기 진행, 입력 처리
(function () {
  'use strict';
  const C = window.YTD_CORE, SUBS = window.YTD_SUBS, P = window.YTD_PLAYER;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const TEST = params.get('test') === '1';

  // ---------------- 저장소 (폰 브라우저에 저장) ----------------
  const store = {
    get(k) { try { return localStorage.getItem('ytdw:' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('ytdw:' + k, v); } catch (e) { /* 용량 초과 등 */ } },
    json(k, d) { try { return JSON.parse(this.get(k)) || d; } catch (e) { return d; } },
  };

  // ================= 처음 화면 =================
  const urlIn = $('url'), subsIn = $('subs'), fileIn = $('file');

  function currentId() { return TEST ? 'TEST' : SUBS.parseVideoId(urlIn.value); }

  function updateSavedNote() {
    const id = currentId();
    $('savedNote').hidden = !(id && store.get('subs:' + id));
  }
  urlIn.addEventListener('input', () => { $('homeMsg').textContent = ''; updateSavedNote(); });

  fileIn.addEventListener('change', () => {
    const f = fileIn.files[0];
    if (!f) return;
    f.text().then(t => { subsIn.value = t; $('fileName').textContent = f.name; $('homeMsg').textContent = ''; });
  });

  function homeError(m) { $('homeMsg').textContent = m; }

  $('start').addEventListener('click', () => {
    const id = currentId();
    if (!id) return homeError('유튜브 링크를 확인해 주세요.');
    const text = subsIn.value.trim() || store.get('subs:' + id);
    if (!text) return homeError('영어 자막을 넣어 주세요. (아래 "자막은 어떻게 구하나요?" 참고)');
    const { segments } = SUBS.parseSubtitles(text);
    if (!segments.length) return homeError('자막을 읽지 못했어요. SRT/VTT 파일이거나 시간(0:01)이 포함된 스크립트인지 확인해 주세요.');
    store.set('subs:' + id, text);
    subsIn.value = ''; $('fileName').textContent = ''; fileIn.value = '';
    enterPractice(id, segments, true);
  });

  function renderRecent() {
    const list = store.json('recent', []);
    $('recentWrap').hidden = !list.length;
    $('recent').innerHTML = '';
    for (const r of list) {
      const b = document.createElement('button');
      b.className = 'recent';
      const pos = +(store.get('pos:' + r.id) || 0);
      b.innerHTML = `<b></b><span>${pos + 1} / ${r.total || '?'} 문장</span>`;
      b.querySelector('b').textContent = r.title || r.id;
      b.addEventListener('click', () => {
        const text = store.get('subs:' + r.id);
        if (!text) return;
        enterPractice(r.id, SUBS.parseSubtitles(text).segments, true);
      });
      $('recent').appendChild(b);
    }
  }

  function saveRecent(id, title, total) {
    let list = store.json('recent', []).filter(r => r.id !== id);
    const old = store.json('recent', []).find(r => r.id === id);
    list.unshift({ id, title: title || (old && old.title) || '', total });
    store.set('recent', JSON.stringify(list.slice(0, 8)));
  }

  // 안드로이드 '공유하기'로 링크를 받은 경우 (?url= 또는 ?text=)
  const shared = params.get('url') || params.get('text') || params.get('v');
  if (shared) {
    const m = /(https?:\/\/\S+)/.exec(shared);
    urlIn.value = m ? m[1] : shared;
    updateSavedNote();
  }

  // ================= 받아쓰기 화면 =================
  const S = {
    id: null, segs: [], target: 0, typing: null, player: null, ready: false,
    awaiting: false, completing: false, everPlayed: false,
    ownPlay: false, ownSeekUntil: 0, slowRestore: null,
    hintSet: new Set(), hintCount: 0, mistakes: 0, lastErrKey: null,
    composing: false, hangul: false, focused: false,
    lastT: 0, lastNow: 0, lastPlaying: false,
  };
  const typer = $('typer');

  function enterPractice(id, segments, push) {
    S.id = id; S.segs = segments; S.ready = false; S.everPlayed = false;
    S.awaiting = false; S.completing = false; S.ownPlay = false; S.slowRestore = null;
    $('home').hidden = true; $('practice').hidden = false;
    if (push) history.pushState({ practice: id }, '', '#v=' + id);
    saveRecent(id, '', segments.length);
    $('videoWrap').innerHTML = '<div id="player"></div>';
    const cb = { onReady, onState, onError };
    S.player = TEST ? new P.VideoPlayer($('player'), params.get('src') || 'tests/video.webm', cb)
                    : new P.YTPlayer($('player'), id, cb);
    const saved = Math.min(+(store.get('pos:' + id) || 0), segments.length - 1);
    setTarget(Math.max(0, saved));
    fitViewport();
  }

  function exitPractice() {
    if (S.player && S.player.p && S.player.p.destroy) { try { S.player.p.destroy(); } catch (e) { /* ignore */ } }
    $('videoWrap').innerHTML = '<div id="player"></div>';
    S.player = null; S.ready = false; S.typing = null;
    $('practice').hidden = true; $('home').hidden = false;
    typer.blur();
    renderRecent(); updateSavedNote();
  }

  window.addEventListener('popstate', () => { if (!$('practice').hidden) exitPractice(); });
  $('back').addEventListener('click', () => { if (history.state && history.state.practice) history.back(); else exitPractice(); });

  function onReady() {
    S.ready = true;
    replay(false);
    setTimeout(() => { if (!S.everPlayed) render(); }, 2500);
  }

  function onError(code) {
    const m = { 2: '영상 주소가 잘못됐어요.', 5: '이 영상은 재생할 수 없어요.', 100: '영상을 찾을 수 없어요 (삭제/비공개).',
      101: '이 영상은 다른 사이트에서 재생이 막혀 있어요. 다른 영상을 써 주세요.', 150: '이 영상은 다른 사이트에서 재생이 막혀 있어요. 다른 영상을 써 주세요.' };
    S.error = m[code] || String(code);
    render();
  }

  function onState(st) {
    if (st === 'playing') {
      const own = S.ownPlay;
      S.ownPlay = false;
      if (!S.everPlayed) {
        S.everPlayed = true;
        // 사용자가 직접 ▶를 처음 눌렀는데 위치가 엉뚱하면 현재 문장 시작으로 이동
        const seg = S.segs[S.target];
        if (!own && seg && Math.abs(S.player.time() - seg.start) > 3) seekOwn(Math.max(0, seg.start - 0.25));
        const t = S.player.title();
        if (t) saveRecent(S.id, t, S.segs.length);
      } else if (!own && S.awaiting && S.typing && !C.isComplete(S.typing)) {
        replay(false); // 입력 대기 중에 ▶ 누르면 다시 듣기
      }
    }
    render();
  }

  // ---------------- 영상 제어 ----------------
  function seekOwn(t) {
    S.ownSeekUntil = performance.now() + 400;
    S.ownSeekTarget = t;
    S.player.seek(t);
    S.lastT = t; S.lastNow = performance.now();
  }

  function play() {
    if (!S.player.isPlaying()) {
      S.ownPlay = true;
      S.player.play();
      setTimeout(() => { S.ownPlay = false; }, 3000);
    }
  }

  function restoreRate() {
    if (S.slowRestore != null && S.player) S.player.setRate(S.slowRestore);
    S.slowRestore = null;
  }

  function replay(slow) {
    const seg = S.segs[S.target];
    if (!seg || !S.player || !S.ready) return;
    restoreRate();
    if (slow) { S.slowRestore = S.player.getRate(); S.player.setRate(0.75); }
    S.awaiting = false;
    seekOwn(Math.max(0, seg.start - 0.25));
    play();
    render();
  }

  function indexAt(t) {
    const i = S.segs.findIndex(s => s.pauseAt > t + 0.05);
    return i === -1 ? S.segs.length : i;
  }

  function setTarget(i) {
    S.target = i;
    S.typing = i < S.segs.length ? C.createTyping(S.segs[i].text) : null;
    S.hintSet = new Set(); S.hintCount = 0; S.mistakes = 0; S.lastErrKey = null;
    S.awaiting = false; S.completing = false; S.hangul = false;
    setValue('');
    if (S.id && i < S.segs.length) store.set('pos:' + S.id, String(i));
    render();
  }

  function goTo(i) {
    i = Math.max(0, Math.min(S.segs.length - 1, i));
    setTarget(i);
    replay(false);
  }

  function onComplete() {
    S.completing = true;
    render();
    setTimeout(() => {
      if (!S.completing) return;
      setTarget(S.target + 1);
      if (S.target >= S.segs.length) store.set('pos:' + S.id, '0');
      if (S.player) play();
    }, 700);
  }

  function tick() {
    if (!S.ready || !S.player || !S.segs.length) return;
    const now = performance.now();
    const t = S.player.time();
    const playing = S.player.isPlaying();
    // 사용자가 재생바로 위치를 옮겼는지 감지 → 그 위치의 문장으로
    if (S.lastNow) {
      const expected = S.lastT + (S.lastPlaying ? (now - S.lastNow) / 1000 * S.player.getRate() : 0);
      const jumped = now <= S.ownSeekUntil ? Math.abs(t - S.ownSeekTarget) > 2 : Math.abs(t - expected) > 1.2;
      if (jumped) {
        S.lastT = t; S.lastNow = now; S.lastPlaying = playing;
        setTarget(indexAt(t));
        return;
      }
    }
    S.lastT = t; S.lastNow = now; S.lastPlaying = playing;
    if (!playing || S.completing) return;
    const seg = S.segs[S.target];
    if (seg && t >= seg.pauseAt) {
      S.player.pause();
      restoreRate();
      if (!S.awaiting) { S.awaiting = true; typer.focus({ preventScroll: true }); render(); }
    }
  }
  setInterval(tick, 30);

  // ---------------- 입력 (폰 키보드 대응) ----------------
  // 입력칸의 글자 전체를 매번 다시 채점하는 방식 → 폰 키보드의 자동완성/조합 입력에도 안전
  function setValue(v) {
    typer.value = v;
    try { typer.setSelectionRange(v.length, v.length); } catch (e) { /* ignore */ }
  }

  function normalizeInput(raw) {
    return raw.replace(/[‘’ʼ`´]/g, "'").replace(/[‐-—]/g, '-');
  }

  function sync() {
    if (!S.typing || S.completing) return;
    const chars = Array.from(normalizeInput(typer.value));
    const st = C.createTyping(S.typing.text);
    st.revealed = S.typing.revealed;
    let used = 0, hangul = false;
    for (const ch of chars) {
      if (/[ᄀ-ᇿㄱ-ㆎ가-힣]/.test(ch)) { hangul = true; break; }
      if (!/^[a-zA-Z0-9' \-/]$/.test(ch)) { used++; continue; } // 그 외 문장부호는 무시
      const r = C.typeChar(st, ch);
      if (r === 'blocked' || r === 'done') break;
      used++;
    }
    for (const i of [...S.hintSet]) { if (i < st.typed.length) st.typed[i].hint = true; else S.hintSet.delete(i); }
    if (C.hasError(st)) {
      const key = st.typed.length + ':' + st.typed[st.typed.length - 1].ch;
      if (key !== S.lastErrKey) { S.mistakes++; S.lastErrKey = key; }
    } else S.lastErrKey = null;
    S.typing = st;
    S.hangul = hangul;
    // 틀린 글자 뒤에 더 친 글자는 지움 (글자 조합 중일 땐 건드리지 않음)
    if (used < chars.length && !S.composing) setValue(chars.slice(0, used).join(''));
    if (C.isComplete(st)) onComplete(); else render();
  }

  // 지금까지 맞게 친 내용을 깔끔한 문자열로
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
    setValue(v);
    sync();
  }

  function action(act) {
    if (!S.player) return;
    if (act === 'replay') replay(false);
    else if (act === 'slow') replay(true);
    else if (act === 'next') { if (S.target + 1 >= S.segs.length) { setTarget(S.segs.length); S.player.pause(); } else goTo(S.target + 1); }
    else if (act === 'prev') goTo(S.target - 1);
    else if (act === 'hint') doHint();
    else if (act === 'reveal' && S.typing) { S.typing.revealed = true; render(); }
  }

  typer.addEventListener('input', sync);
  typer.addEventListener('compositionstart', () => { S.composing = true; });
  typer.addEventListener('compositionend', () => { S.composing = false; sync(); });
  typer.addEventListener('focus', () => { S.focused = true; render(); });
  typer.addEventListener('blur', () => { S.focused = false; render(); });
  typer.addEventListener('keydown', (e) => {
    const map = { Enter: e.shiftKey ? 'slow' : 'replay', ArrowLeft: 'replay', ArrowUp: 'hint', ArrowDown: 'reveal', ArrowRight: 'next' };
    if (map[e.key] && !e.isComposing) { e.preventDefault(); action(map[e.key]); }
  });

  document.querySelectorAll('#tools button').forEach(b => {
    // 버튼을 눌러도 키보드가 내려가지 않게 (입력칸 포커스 유지)
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => action(b.dataset.act));
  });

  // ---------------- 그리기 ----------------
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function renderLine(st) {
    const cur = st.typed.length;
    let html = '<span class="w">';
    for (const it of st.slots.items) {
      if (it.kind === 'punct') { html += `<span class="p">${esc(it.display)}</span>`; continue; }
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
        html += `</span><span class="sp ${cls}">${cls.includes('bad') ? esc(txt) : ' '}</span><span class="w">`;
      } else html += `<span class="${cls}">${esc(txt)}</span>`;
    }
    return html + '</span>';
  }

  function render() {
    if ($('practice').hidden) return;
    const st = S.typing, total = S.segs.length;
    $('progress').textContent = total ? `${Math.min(S.target + 1, total)} / ${total}` : '';
    $('stat').textContent = st ? `오타 ${S.mistakes} · 힌트 ${S.hintCount}${st.revealed ? ' · 정답 봄' : ''}` : '';
    $('line').innerHTML = st ? renderLine(st) : '';
    keepCursorVisible();
    $('practice').classList.toggle('done', !!S.completing);
    document.querySelectorAll('#tools button').forEach(b => {
      b.disabled = !S.ready || (!st && !['prev', 'replay'].includes(b.dataset.act));
    });
    const playing = S.player && S.player.isPlaying();
    let m;
    if (S.error) m = '⚠ ' + S.error;
    else if (!S.ready) m = '영상 불러오는 중…';
    else if (!st) m = '🎉 끝! 모든 대사를 완료했어요';
    else if (!S.everPlayed && !playing) m = '▶ 영상의 재생 버튼을 한 번 눌러 주세요';
    else if (S.completing) m = '✓ 정답! 다음 대사로 넘어가요';
    else if (S.hangul) m = '⌨ 키보드를 영어로 바꿔 주세요';
    else if (C.hasError(st)) m = '빨간 글자를 지우고 다시 입력하세요';
    else if (!S.focused) m = '👆 문장을 눌러서 입력을 시작하세요';
    else if (playing) m = '🎧 듣는 중… (미리 입력해도 돼요)';
    else m = '들은 대로 입력하세요';
    $('msg').textContent = m;
  }

  // 입력 위치가 항상 보이도록 문장 칸을 자동 스크롤 (여러 줄일 때)
  function keepCursorVisible() {
    const sc = $('lineScroll');
    const c = sc.querySelector('.bad') || sc.querySelector('.at');
    if (!c) { if (!S.typing || !S.typing.typed.length) sc.scrollTop = 0; return; }
    const r = c.getBoundingClientRect(), s = sc.getBoundingClientRect();
    const lineH = r.height || 30;
    if (r.bottom > s.bottom - 6) sc.scrollTop += r.bottom - s.bottom + lineH * 0.6;
    else if (r.top < s.top + 4) sc.scrollTop -= s.top - r.top + lineH * 0.3;
  }

  // 폰 키보드가 올라오면 실제로 보이는 영역에 맞춤 (아이폰 대응)
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  function fitViewport() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--vh', h + 'px');
    document.documentElement.style.setProperty('--vt', (vv ? vv.offsetTop : 0) + 'px');
    keepCursorVisible();
  }
  function onFocusChange() {
    document.documentElement.classList.toggle('kb', coarse && S.focused);
    fitViewport();
    [100, 350, 700].forEach(ms => setTimeout(fitViewport, ms)); // 키보드 애니메이션 후 다시 계산
  }
  typer.addEventListener('focus', onFocusChange);
  typer.addEventListener('blur', onFocusChange);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }
  window.addEventListener('resize', fitViewport);

  renderRecent();
  // 주소에 #v=영상ID 가 있고 저장된 자막이 있으면 바로 이어하기
  const hashId = /#v=([\w-]{11}|TEST)/.exec(location.hash);
  if (hashId && store.get('subs:' + hashId[1])) {
    history.replaceState({ practice: hashId[1] }, '', location.href);
    enterPractice(hashId[1], SUBS.parseSubtitles(store.get('subs:' + hashId[1])).segments, false);
  }

  window.__app = { S, action };
})();
