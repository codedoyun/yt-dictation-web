// player.js — 영상 플레이어를 똑같은 방식으로 다루기 위한 껍데기
//   YTPlayer   : 유튜브 임베드 (실제 사용)
//   VideoPlayer: 일반 <video> (테스트용, 주소에 ?test=1)
// 공통 기능: play, pause, seek, time, isPlaying, setRate, getRate, title
(function (root) {
  'use strict';

  let apiPromise = null;
  function loadYTApi() {
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      if (root.YT && root.YT.Player) return resolve(root.YT);
      const prev = root.onYouTubeIframeAPIReady;
      root.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(root.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => reject(new Error('유튜브 플레이어를 불러오지 못했어요 (인터넷 연결 확인)'));
      document.head.appendChild(s);
    });
    return apiPromise;
  }

  class YTPlayer {
    // onState(state): 'playing' | 'paused' | 'buffering' | 'ended' | 'other'
    constructor(el, videoId, { onReady, onState, onError }) {
      this._lastT = 0; this._lastAt = 0; this._state = 'other';
      loadYTApi().then(YT => {
        this.p = new YT.Player(el, {
          videoId,
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, cc_load_policy: 0, iv_load_policy: 3, fs: 0 },
          events: {
            onReady: () => { this._hideCaptions(); onReady && onReady(); },
            onStateChange: (e) => {
              const S = YT.PlayerState;
              this._state = e.data === S.PLAYING ? 'playing' : e.data === S.PAUSED ? 'paused'
                : e.data === S.BUFFERING ? 'buffering' : e.data === S.ENDED ? 'ended' : 'other';
              this._lastAt = performance.now(); this._lastT = this.p.getCurrentTime();
              if (this._state === 'playing') this._hideCaptions();
              onState && onState(this._state);
            },
            onError: (e) => onError && onError(e.data),
          },
        });
      }).catch(err => onError && onError(err.message));
    }
    _hideCaptions() {
      // 유튜브 자체 자막이 켜져 있으면 정답이 보이니까 끔 (공식 기능은 아니라 실패할 수도 있음)
      try { this.p.unloadModule('captions'); this.p.unloadModule('cc'); } catch (e) { /* ignore */ }
    }
    play() { this.p && this.p.playVideo(); }
    pause() { this.p && this.p.pauseVideo(); }
    seek(t) {
      if (!this.p) return;
      this.p.seekTo(t, true);
      this._seekTarget = t; this._seekAt = performance.now();
    }
    isPlaying() { return this._state === 'playing'; }
    // 유튜브 임베드는 현재 시간이 0.1~0.25초 간격으로만 갱신돼서, 그 사이는 추정함
    time() {
      if (!this.p || !this.p.getCurrentTime) return 0;
      let t = this.p.getCurrentTime();
      const now = performance.now();
      // 이동 직후엔 예전 시간이 잠깐 보고되므로, 새 위치가 반영될 때까지 이동한 위치를 사용
      if (this._seekTarget != null) {
        if (Math.abs(t - this._seekTarget) < 1 || now - this._seekAt > 2000) this._seekTarget = null;
        else return this._seekTarget;
      }
      if (t !== this._lastT) { this._lastT = t; this._lastAt = now; }
      if (!this.isPlaying()) return t;
      return t + Math.min(0.5, (now - this._lastAt) / 1000) * this.getRate();
    }
    setRate(r) { this.p && this.p.setPlaybackRate(r); }
    getRate() { return (this.p && this.p.getPlaybackRate && this.p.getPlaybackRate()) || 1; }
    title() { try { return this.p.getVideoData().title || ''; } catch (e) { return ''; } }
  }

  class VideoPlayer {
    constructor(el, src, { onReady, onState }) {
      const v = document.createElement('video');
      v.src = src; v.muted = true; v.playsInline = true; v.controls = true;
      v.style.width = '100%'; v.style.height = '100%';
      el.replaceWith(v);
      this.v = v;
      const st = s => () => onState && onState(s);
      v.addEventListener('playing', st('playing'));
      v.addEventListener('pause', st('paused'));
      v.addEventListener('waiting', st('buffering'));
      v.addEventListener('ended', st('ended'));
      v.addEventListener('loadedmetadata', () => onReady && onReady(), { once: true });
    }
    play() { this.v.play().catch(() => {}); }
    pause() { this.v.pause(); }
    seek(t) { this.v.currentTime = t; }
    isPlaying() { return !this.v.paused && !this.v.ended; }
    time() { return this.v.currentTime; }
    setRate(r) { this.v.playbackRate = r; }
    getRate() { return this.v.playbackRate; }
    title() { return 'Test video'; }
  }

  root.YTD_PLAYER = { YTPlayer, VideoPlayer };
})(window);
