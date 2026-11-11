# 휴대폰 화면 흉내 + 테스트용 영상(<video>)으로 받아쓰기 흐름 검사
# 실행: python3 tests/test_web.py   (playwright, google-chrome 필요)
import subprocess, sys, os, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8790
SRT = """1
00:00:01,000 --> 00:00:03,000
Hello, world!

2
00:00:04,000 --> 00:00:06,000
I don't know.

3
00:00:08,000 --> 00:00:10,000
[Music] It's a well-known fact.
"""
srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py'), str(PORT)])
time.sleep(0.8)

def E(page, js): return page.evaluate('() => {' + js + '}')
def wait(page, cond, timeout=8):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.evaluate(f'() => !!({cond})'): return
        time.sleep(0.05)
    raise AssertionError('timeout: ' + cond + ' ' + str(E(page, 'const S=__app.S; return {t:S.player&&S.player.time(), tg:S.target, aw:S.awaiting, msg:document.getElementById("msg").textContent}')))

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True,
                              args=['--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(**p.devices['Pixel 7'])
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto(f'http://127.0.0.1:{PORT}/index.html?test=1')

        # 자막 없이 시작 → 에러 메시지
        page.click('#start')
        assert '자막' in page.text_content('#homeMsg')
        page.fill('#subs', SRT)
        page.screenshot(path=os.path.join(HERE, 'm_home.png'))
        page.click('#start')
        wait(page, '!document.getElementById("practice").hidden')
        wait(page, '__app.S.awaiting')
        t = E(page, 'return __app.S.player.time()')
        print('paused at', round(t, 3)); assert 3.05 <= t <= 3.3

        page.tap('#lineWrap')  # 문장을 눌러 입력 시작
        assert E(page, 'return document.activeElement.id') == 'typer'
        page.keyboard.type('Hello')
        page.keyboard.type('x')
        assert E(page, 'return document.querySelectorAll("#line .bad").length') == 1
        page.keyboard.type('yz')  # 틀린 뒤에 더 쳐도 잘려야 함
        assert E(page, 'return document.getElementById("typer").value') == 'Hellox', E(page, 'return document.getElementById("typer").value')
        page.screenshot(path=os.path.join(HERE, 'm_error.png'))
        page.keyboard.press('Backspace')
        assert E(page, 'return document.querySelectorAll("#line .bad").length') == 0
        # 버튼을 눌러도 입력칸 포커스 유지되는지 (힌트 버튼)
        page.click('#tools button[data-act=hint]')
        assert E(page, 'return document.activeElement.id') == 'typer'
        assert E(page, 'return __app.S.typing.typed.length') == 7  # ' ' + 'w'
        page.keyboard.insert_text('orld')  # 모바일 키보드처럼 텍스트 삽입
        wait(page, '__app.S.completing')
        page.screenshot(path=os.path.join(HERE, 'm_done.png'))
        wait(page, '__app.S.target === 1')
        wait(page, '__app.S.awaiting')
        t = E(page, 'return __app.S.player.time()')
        print('paused at', round(t, 3)); assert 6.05 <= t <= 6.3

        # 아이폰 둥근 따옴표(’) + 띄어쓰기 생략
        page.keyboard.insert_text('I don’tknow')
        wait(page, '__app.S.completing')
        wait(page, '__app.S.target === 2')

        # 한글 입력 경고
        page.keyboard.insert_text('ㅑ')
        assert '영어' in page.text_content('#msg')
        assert E(page, 'return document.getElementById("typer").value') == ''
        # 정답 보기 + 느리게
        page.click('#tools button[data-act=reveal]')
        assert E(page, 'return document.querySelectorAll("#line .ghost").length') > 0
        wait(page, '__app.S.awaiting')
        page.click('#tools button[data-act=slow]')
        time.sleep(0.2)
        assert E(page, 'return __app.S.player.getRate()') == 0.75
        wait(page, '__app.S.awaiting')
        assert E(page, 'return __app.S.player.getRate()') == 1
        page.screenshot(path=os.path.join(HERE, 'm_reveal.png'))
        # 이전 버튼
        page.click('#tools button[data-act=prev]')
        wait(page, '__app.S.target === 1')
        # 재생바 이동 감지
        E(page, 'const v=document.querySelector("video"); v.pause(); v.currentTime=8.5;')
        wait(page, '__app.S.target === 2')
        page.click('#tools button[data-act=next]')
        wait(page, '__app.S.typing === null')
        assert '끝' in page.text_content('#msg')

        # 뒤로가기 → 최근 목록 + 진행 위치 저장
        page.go_back()
        wait(page, '!document.getElementById("home").hidden')
        assert E(page, 'return document.querySelectorAll(".recent").length') == 1
        page.click('.recent')
        wait(page, '!document.getElementById("practice").hidden')
        print('resumed at target', E(page, 'return __app.S.target'))
        assert not errs, errs
        b.close()
    print('WEB TESTS PASSED')
finally:
    srv.terminate()
