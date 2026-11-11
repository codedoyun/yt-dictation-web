# yt-dictation.user.js 를 가짜 모바일 유튜브(아이폰 화면)에서 검사
import subprocess, sys, os, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8792
BASE = f'http://127.0.0.1:{PORT}'
SCRIPT = open(os.path.join(HERE, '..', 'yt-dictation.user.js'), encoding='utf-8').read()
srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'us_server.py'), str(PORT)])
time.sleep(0.8)

def E(page, js): return page.evaluate('() => {' + js + '}')
def wait(page, cond, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.evaluate(f'() => !!({cond})'): return
        time.sleep(0.05)
    raise AssertionError('timeout: ' + cond + ' ' + str(E(page, 'const S=__ytdUS.S; return {st:S.status, msg:S.msg, log:S.log, tg:S.target, aw:S.awaiting, t:document.querySelector("video").currentTime}')))

def run(b, p, mode, force_content=False, full=False):
    urllib.request.urlopen(f'{BASE}/setmode?m={mode}').read()
    ctx = b.new_context(**p.devices['iPhone 13'])
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append(m.text) if 'TrustedHTML' in m.text or 'Trusted Type' in m.text else None)
    if force_content: page.add_init_script('window.__ytdForceContent = true;')
    page.add_init_script(SCRIPT)
    page.goto(f'{BASE}/watch?v=TESTVIDEO01')
    page.wait_for_selector('#ytd-fab')
    page.tap('#ytd-fab')
    wait(page, '__ytdUS.S.status === "ready"')
    src = E(page, 'return __ytdUS.S.log.join(" ")')
    print(f'[{mode}{" content" if force_content else ""}] {src}')
    assert E(page, 'return __ytdUS.S.segs.length') == 3
    assert E(page, 'return getComputedStyle(document.querySelector(".ytp-caption-window-container")).display') == 'none'
    wait(page, '__ytdUS.S.awaiting')
    t = E(page, 'return document.querySelector("video").currentTime'); assert 3.05 <= t <= 3.3, t
    # 패널이 영상 아래에 있는지
    pr = E(page, 'const a=document.getElementById("player-container-id").getBoundingClientRect(), b=document.getElementById("ytd-panel").getBoundingClientRect(); return [a.bottom, b.top, b.bottom, innerHeight]')
    assert abs(pr[0] - pr[1]) < 2 and abs(pr[2] - pr[3]) < 2, pr
    if full:
        page.tap('#ytd-panel .ytd-wrap')
        assert E(page, 'return document.activeElement.className') == 'ytd-in'
        page.keyboard.insert_text('hellox')
        assert E(page, 'return document.querySelectorAll("#ytd-panel .bad").length') == 1
        page.screenshot(path=os.path.join(HERE, 'us_error.png'))
        page.keyboard.press('Backspace')
        page.click('#ytd-panel button[data-act=hint]')
        assert E(page, 'return document.activeElement.className') == 'ytd-in'
        page.keyboard.insert_text('orld')
        wait(page, '__ytdUS.S.target === 1')
        wait(page, '__ytdUS.S.awaiting')
        page.keyboard.insert_text('I don’tknow')
        wait(page, '__ytdUS.S.target === 2')
        page.click('#ytd-panel button[data-act=reveal]')
        assert E(page, 'return document.querySelectorAll("#ytd-panel .ghost").length') > 0
        # 재생바로 직접 이동
        wait(page, '__ytdUS.S.awaiting')
        E(page, 'document.querySelector("video").currentTime = 4.5;')
        wait(page, '__ytdUS.S.target === 1')
        page.click('#ytd-panel .ytd-x')
        assert E(page, 'return document.getElementById("ytd-panel").style.display') == 'none'
        assert E(page, 'return getComputedStyle(document.getElementById("ytd-fab")).display') != 'none'
    assert not errs, errs
    ctx.close()

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--autoplay-policy=no-user-gesture-required'])
        run(b, p, 'ok', full=True, force_content=True)
        run(b, p, 'pot')
        run(b, p, 'none')
        run(b, p, 'pot', force_content=True)
        b.close()
    print('USERSCRIPT TESTS PASSED')
finally:
    srv.terminate()
