# 키보드가 올라온 휴대폰 화면(세로 높이가 작은 화면)에서 긴 문장을 입력할 때 커서가 계속 보이는지 검사
import subprocess, sys, os, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8791
LONG = "So I want you to imagine that you are standing on the deck of a very small boat in the middle of the ocean and the water is calm."
SRT = f"1\n00:00:01,000 --> 00:00:09,000\n{LONG}\n"
srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py'), str(PORT)])
time.sleep(0.8)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True,
                              args=['--autoplay-policy=no-user-gesture-required'])
        dev = dict(p.devices['iPhone 13'])
        dev['viewport'] = {'width': 390, 'height': 330}  # 키보드가 화면 절반을 가린 상태 흉내
        page = b.new_context(**dev).new_page()
        page.goto(f'http://127.0.0.1:{PORT}/index.html?test=1')
        page.fill('#subs', SRT)
        page.click('#start')
        page.wait_for_function('() => window.__app && __app.S.ready')
        page.tap('#lineWrap')
        assert page.evaluate('() => document.documentElement.classList.contains("kb")'), 'kb class missing'
        # 정답 텍스트에서 입력할 글자만 뽑아서 거의 끝까지 입력
        typed = LONG.replace('.', '').lower()[:-6]
        page.keyboard.insert_text(typed)
        vis = page.evaluate('''() => {
            const c = document.querySelector('#line .at').getBoundingClientRect();
            const s = document.getElementById('lineScroll').getBoundingClientRect();
            return {c: [c.top, c.bottom], s: [s.top, s.bottom], scrolled: document.getElementById('lineScroll').scrollTop};
        }''')
        print(vis)
        assert vis['s'][0] <= vis['c'][0] and vis['c'][1] <= vis['s'][1], 'cursor not visible'
        assert vis['scrolled'] > 0
        tools = page.evaluate('() => document.getElementById("tools").getBoundingClientRect().bottom')
        assert tools <= 330, tools  # 버튼이 화면 안에 있음
        page.screenshot(path=os.path.join(HERE, 'kb.png'))
        b.close()
    print('KB TEST PASSED')
finally:
    srv.terminate()
