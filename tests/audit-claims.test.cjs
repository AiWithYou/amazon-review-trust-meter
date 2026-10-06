'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const sourceRoot = process.env.AMAZON_AUDIT_SOURCE || path.resolve(__dirname, '..');
const scoring = require(path.join(sourceRoot, 'scoring.js'));
const extension = require(path.join(sourceRoot, 'content.js'));

test('equivalent integer and decimal runtimes do not add listing risk', () => {
  for (const [titleValue, detailsValue] of [['10', '10.0'], ['10.00', '10'], ['10.0', '10.00']]) {
    const title = `スピーカー ${titleValue}時間連続再生`;
    const details = `最大${detailsValue}時間連続再生`;
    assert.deepEqual(scoring.collectClaimConflicts(title, details), []);
    const result = scoring.analyzeProduct({ title, details });
    assert.equal(result.listingRiskScore, 0);
    assert.equal(result.signals.some((signal) => signal.id === 'claim_conflicts'), false);
  }
});

test('different integer runtimes retain the conflict and its weight', () => {
  assert.deepEqual(scoring.collectClaimConflicts('10時間連続再生', '12時間連続再生'), [
    { label: '連続時間', weight: 18, title: ['10'], details: ['12'] },
  ]);
});

test('different decimal runtimes preserve their original display values', () => {
  const title = 'スピーカー 10.0時間連続再生';
  const details = '最大12.0時間連続再生';
  assert.deepEqual(scoring.collectClaimConflicts(title, details), [
    { label: '連続時間', weight: 18, title: ['10.0'], details: ['12.0'] },
  ]);
  const result = scoring.analyzeProduct({ title, details });
  assert.equal(result.listingRiskScore, 18);
  assert.equal(result.signals.find((signal) => signal.id === 'claim_conflicts').evidence,
    '連続時間: 商品名 10.0 ↔ 説明 12.0');
});

test('very large numeric claims retain their distinct display strings', () => {
  const titleValue = '9'.repeat(350);
  const detailsValue = '8'.repeat(350);
  assert.deepEqual(scoring.collectClaimConflicts(`${titleValue}時間連続再生`, `${detailsValue}時間連続再生`), [
    { label: '連続時間', weight: 18, title: [titleValue], details: [detailsValue] },
  ]);
});

test('comma-separated capacities remain equal and real capacity differences remain visible', () => {
  assert.deepEqual(scoring.collectClaimConflicts('5,000mAh', '5000mAh'), []);
  assert.deepEqual(scoring.collectClaimConflicts('5,000mAh', '3000mAh'), [
    { label: '電池容量', weight: 18, title: ['5000'], details: ['3000'] },
  ]);
  assert.deepEqual(scoring.collectClaimConflicts('05000mAh', '5000mAh'), []);
});

test('light pattern counts compare numerically without changing conflict display', () => {
  assert.deepEqual(scoring.collectClaimConflicts('03種類の発光パターン', '3種類の発光パターン'), []);
  assert.deepEqual(scoring.collectClaimConflicts('03種類の発光パターン', '5種類の発光パターン'), [
    { label: '発光パターン数', weight: 12, title: ['03'], details: ['5'] },
  ]);
});

test('IP ratings retain string comparison and existing case normalization', () => {
  assert.deepEqual(scoring.collectClaimConflicts('IPX6', 'ipx6'), []);
  assert.deepEqual(scoring.collectClaimConflicts('IPX6', 'IPX7'), [
    { label: '防水・防塵等級', weight: 28, title: ['IPX6'], details: ['IPX7'] },
  ]);
  assert.deepEqual(scoring.collectClaimConflicts('IP56', 'IPX6'), [
    { label: '防水・防塵等級', weight: 28, title: ['IP56'], details: ['IPX6'] },
  ]);
});

test('direct engine retains its existing fullwidth matching boundary', () => {
  assert.deepEqual(scoring.collectClaimConflicts('１０時間連続再生', '１２時間連続再生'), []);
  assert.deepEqual(scoring.collectClaimConflicts('10時間連続再生', '１２時間連続再生'), []);
});

test('DOM NFKC normalization allows equivalent fullwidth runtimes without added risk', (t) => {
  const dom = new JSDOM('<h1 id="productTitle">スピーカー １０時間連続再生</h1><div id="feature-bullets">最大１０．０時間連続再生</div>');
  t.after(() => dom.window.close());
  const data = extension.collectPageData(dom.window.document);
  assert.equal(data.title, 'スピーカー 10時間連続再生');
  assert.equal(data.details, '最大10.0時間連続再生');
  assert.equal(scoring.analyzeProduct(data).listingRiskScore, 0);
});

test('DOM NFKC normalization still exposes different fullwidth runtimes', (t) => {
  const dom = new JSDOM('<h1 id="productTitle">スピーカー １０．０時間連続再生</h1><div id="feature-bullets">最大１２．０時間連続再生</div>');
  t.after(() => dom.window.close());
  const data = extension.collectPageData(dom.window.document);
  assert.equal(data.title, 'スピーカー 10.0時間連続再生');
  assert.equal(data.details, '最大12.0時間連続再生');
  const result = scoring.analyzeProduct(data);
  assert.equal(result.listingRiskScore, 18);
  assert.equal(result.signals.find((signal) => signal.id === 'claim_conflicts').evidence,
    '連続時間: 商品名 10.0 ↔ 説明 12.0');
});
