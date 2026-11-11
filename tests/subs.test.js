const assert = require('assert');
const { parseSubtitles, parseVideoId } = require('../subs.js');
const texts = r => r.segments.map(s => s.text);

// SRT
let r = parseSubtitles(`1
00:00:01,000 --> 00:00:03,000
Hello, everyone.

2
00:00:03,500 --> 00:00:05,000
<i>Today we're going</i>

3
00:00:05,000 --> 00:00:07,000
to learn English!
`);
assert.strictEqual(r.format, 'srt');
assert.deepStrictEqual(texts(r), ['Hello, everyone.', "Today we're going to learn English!"]);
assert.strictEqual(r.segments[1].start, 3.5);

// YouTube auto VTT (중복 줄 + 단어 타이밍 태그)
r = parseSubtitles(`WEBVTT
Kind: captions
Language: en

00:00:00.320 --> 00:00:02.150 align:start position:0%

hey<00:00:00.640><c> guys</c><00:00:00.960><c> welcome</c>

00:00:02.150 --> 00:00:02.160 align:start position:0%
hey guys welcome


00:00:02.160 --> 00:00:04.000 align:start position:0%
hey guys welcome
back<00:00:02.500><c> to</c><00:00:02.800><c> my</c><00:00:03.000><c> channel</c>
`);
assert.strictEqual(r.format, 'vtt');
assert.strictEqual(texts(r).join(' '), 'hey guys welcome back to my channel');

// 유튜브 스크립트 복사 (줄바꿈 형식)
r = parseSubtitles(`0:01
So I was walking down the street.
0:04
And I saw a dog.
1:02:03
It was huge!`);
assert.strictEqual(r.format, 'transcript');
assert.deepStrictEqual(texts(r), ['So I was walking down the street.', 'And I saw a dog.', 'It was huge!']);
assert.strictEqual(r.segments[2].start, 3723);
// 같은 줄 형식
r = parseSubtitles('0:01 hello there.\n0:03 how are you?');
assert.deepStrictEqual(texts(r), ['hello there.', 'how are you?']);

// json3
r = parseSubtitles(JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Hi.' }] }] }));
assert.deepStrictEqual(texts(r), ['Hi.']);

// 빈 입력
assert.strictEqual(parseSubtitles('').segments.length, 0);
assert.strictEqual(parseSubtitles('just some random text').segments.length, 0);

// video id
const id = 'dQw4w9WgXcQ';
for (const u of [`https://www.youtube.com/watch?v=${id}&t=10s`, `https://youtu.be/${id}?si=abc`, `youtube.com/shorts/${id}`,
  `https://m.youtube.com/watch?v=${id}`, `https://www.youtube.com/embed/${id}`, id, `https://www.youtube.com/live/${id}?feature=share`]) {
  assert.strictEqual(parseVideoId(u), id, u);
}
assert.strictEqual(parseVideoId('https://example.com/watch?v=x'), null);
console.log('subs tests passed');
