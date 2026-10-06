'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = process.env.AMAZON_AUDIT_SOURCE || path.resolve(__dirname, '..');
const scoring = require(path.join(source, 'scoring.js'));
const extension = require(path.join(source, 'content.js'));

function conflict(title, details, label, weight, a, b) {
  assert.deepEqual(scoring.collectClaimConflicts(title, details), [{ label, weight, title: [a], details: [b] }]);
  const signal = scoring.analyzeProduct({ title, details }).signals.find(item => item.id === 'claim_conflicts');
  assert.equal(signal.rawPoints, weight);
  assert.equal(signal.points, weight);
  assert.equal(signal.evidence, `${label}: 商品名 ${a} ↔ 説明 ${b}`);
}
function collect(t, rows, title) {
  const dom = new JSDOM(`<h1 id="productTitle">${title}</h1><table id="productDetails_detailBullets_sections1">${rows}</table>`);
  t.after(() => dom.window.close());
  return extension.collectPageData(dom.window.document);
}

test('finite integers beyond binary64 precision keep distinct runtime values', () => {
  conflict('9007199254740992時間連続再生', '9007199254740993時間連続再生', '連続時間', 18, '9007199254740992', '9007199254740993');
});
test('finite integers beyond binary64 precision keep distinct pattern counts', () => {
  conflict('9007199254740992種類の発光', '9007199254740993種類の発光', '発光パターン数', 12, '9007199254740992', '9007199254740993');
});
test('comma capacity values beyond binary64 precision remain distinct', () => {
  conflict('9,007,199,254,740,992mAh', '9,007,199,254,740,993mAh', '電池容量', 18, '9007199254740992', '9007199254740993');
});
test('decimal differences below binary64 precision remain distinct', () => {
  conflict('10時間連続再生', '10.0000000000000001時間連続再生', '連続時間', 18, '10', '10.0000000000000001');
});
test('a nonzero decimal never underflows to the same value as zero', () => {
  const tiny = `0.${'0'.repeat(350)}1`;
  conflict('0時間連続再生', `${tiny}時間連続再生`, '連続時間', 18, '0', tiny);
});
test('format-only decimal zeros remain equivalent even beyond binary64 precision', () => {
  const huge = '9'.repeat(350);
  assert.deepEqual(scoring.collectClaimConflicts(`${huge}時間連続再生`, `00${huge}.00時間連続再生`), []);
});
test('different properties or units do not satisfy another property conflict', () => {
  conflict('10時間連続再生 5000mAh IPX6', '12時間連続再生 5000mAh 10種類の発光 IPX6', '連続時間', 18, '10', '12');
});
test('unsupported units do not become known claims', () => {
  assert.deepEqual(scoring.collectClaimConflicts('10時間連続再生 5000mAh', '10分連続再生 5000mWh'), []);
});
test('a count and a runtime phrase in separate cells do not invent a claim', (t) => {
  const data = collect(t, '<tr><th>付属品数</th><td>3</td><td>時間連続再生テスト対応</td></tr>', '10時間連続再生');
  assert.deepEqual(scoring.collectClaimConflicts(data.title, data.details), []);
});
test('a count and a runtime phrase in separate rows do not invent a claim', (t) => {
  const data = collect(t, '<tr><th>付属品数</th><td>3</td></tr><tr><th>時間連続再生テスト</th><td>対応</td></tr>', '10時間連続再生');
  assert.deepEqual(scoring.collectClaimConflicts(data.title, data.details), []);
});
test('a cross-row phantom equality cannot erase the real runtime contradiction', (t) => {
  const data = collect(t, '<tr><th>付属品数</th><td>10</td></tr><tr><th>時間連続再生テスト</th><td>対応</td></tr><tr><th>再生時間</th><td>12時間連続再生</td></tr>', '10時間連続再生');
  conflict(data.title, data.details, '連続時間', 18, '10', '12');
});
test('a count and capacity unit from separate cells cannot erase the real capacity contradiction', (t) => {
  const data = collect(t, '<tr><th>件数</th><td>5000</td><td>mAhは容量単位</td></tr><tr><th>電池容量</th><td>3000mAh</td></tr>', '5000mAh');
  conflict(data.title, data.details, '電池容量', 18, '5000', '3000');
});
test('a count and light-pattern unit from separate cells cannot erase the real count contradiction', (t) => {
  const data = collect(t, '<tr><th>付属品数</th><td>3</td><td>種類の発光テスト対応</td></tr><tr><th>ライト</th><td>5種類の発光</td></tr>', '3種類の発光');
  conflict(data.title, data.details, '発光パターン数', 12, '3', '5');
});
test('claim text inside one cell still joins inline spans', (t) => {
  const data = collect(t, '<tr><th>連続再生時間</th><td><span>12</span><span>時間</span>連続<span>再生</span></td></tr>', '10時間連続再生');
  conflict(data.title, data.details, '連続時間', 18, '10', '12');
});
test('independent selected description sections cannot invent a claim across their boundary', (t) => {
  const dom = new JSDOM('<h1 id="productTitle">10時間連続再生</h1><div id="feature-bullets">付属品数3</div><div id="productDescription">時間連続再生テスト対応</div>');
  t.after(() => dom.window.close());
  const data = extension.collectPageData(dom.window.document);
  assert.deepEqual(scoring.collectClaimConflicts(data.title, data.details), []);
});
