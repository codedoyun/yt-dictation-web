// 사용법: node tools/build-userscript.js
// core.js + userscript/main.js 를 합쳐서 yt-dictation.user.js 를 만듦 (Userscripts 앱용)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const version = require(path.join(root, 'userscript', 'version.json')).version;
const URL = 'https://codedoyun.github.io/yt-dictation-web/yt-dictation.user.js';
const header = `// ==UserScript==
// @name         YouTube 받아쓰기
// @namespace    https://github.com/codedoyun
// @version      ${version}
// @description  유튜브 영어 대사를 듣고 한 글자씩 받아쓰는 듣기 연습
// @match        https://m.youtube.com/*
// @match        https://www.youtube.com/*
// @run-at       document-start
// @inject-into  content
// @noframes
// @grant        none
// @updateURL    ${URL}
// @downloadURL  ${URL}
// ==/UserScript==
`;
const core = fs.readFileSync(path.join(root, 'core.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'userscript', 'main.js'), 'utf8');
fs.writeFileSync(path.join(root, 'yt-dictation.user.js'), header + '\n' + core + '\n' + main);
console.log('built yt-dictation.user.js v' + version);
