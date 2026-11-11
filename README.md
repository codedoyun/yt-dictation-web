# 유튜브 받아쓰기 (웹)

휴대폰/PC 브라우저에서 유튜브 영상의 영어 대사를 듣고 한 글자씩 받아쓰는 듣기 연습 웹앱.

## 사용법
1. 유튜브 링크 붙여넣기
2. 영어 자막 넣기 — SRT/VTT 파일 선택, 또는 유튜브 '스크립트 표시' 복사본 붙여넣기
3. 시작하기 → 대사가 끝나면 영상이 멈춤 → 문장을 눌러 입력

- 틀린 글자는 빨간색, 지우고 다시 입력. 다 맞으면 다음 대사 자동 재생
- 버튼: 다시 듣기 / 느리게(0.75배) / 한 글자 힌트 / 정답 보기 / 이전 / 다음
- PC 키보드: Enter 다시 듣기, Shift+Enter 느리게, ↑ 힌트, ↓ 정답, → 다음
- 한 번 넣은 자막과 진행 위치는 브라우저에 저장됨 (최근 목록에서 이어하기)
- 안드로이드: 홈 화면에 추가하면 유튜브 앱의 '공유'로 링크를 바로 보낼 수 있음

## 한계
- 자막은 직접 넣어야 함 (웹사이트는 유튜브 자막을 직접 가져올 수 없음)
- 일부 영상은 유튜브가 외부 사이트 재생을 막아둠
- 아이폰은 처음 한 번 영상의 ▶를 직접 눌러야 할 수 있음

## 파일
- `core.js` 문장 나누기·채점 (크롬 확장 프로그램 yt-dictation과 같은 코드)
- `subs.js` 자막 파일 읽기, `player.js` 유튜브 플레이어 제어, `app.js` 화면·입력

## 테스트 (개발용)
- `node tests/subs.test.js`
- 브라우저 테스트: `ffmpeg -f lavfi -i testsrc=size=1280x720:rate=25 -t 30 -c:v libvpx-vp9 -g 25 tests/video.webm` 로 테스트 영상을 만든 뒤 `python3 tests/test_web.py`

## 아이폰 사파리용 스크립트 (자막 자동 + 프리미엄 광고 없음)
`yt-dictation.user.js` — 사파리의 유튜브 사이트(m.youtube.com) 위에서 바로 돌아가는 버전. 자막을 유튜브 페이지 안에서 직접 가져옴.
1. 앱스토어에서 **Userscripts** 설치 → 설정 > 사파리 > 확장 프로그램에서 켜고 youtube.com 권한 허용
2. 사파리로 https://codedoyun.github.io/yt-dictation-web/yt-dictation.user.js 열기 → 주소창의 확장 프로그램 메뉴에서 Userscripts → 설치
3. 사파리에서 유튜브 영상 열기 → 오른쪽 아래 **받아쓰기** 버튼

- 소스: `userscript/main.js` (+ 공용 `core.js`). 수정 후 `node tools/build-userscript.js` 로 다시 만들기
- 테스트: `python3 tests/test_userscript.py` (가짜 모바일 유튜브 페이지)
