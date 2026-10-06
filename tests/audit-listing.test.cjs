'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = process.env.AMAZON_AUDIT_SOURCE || path.resolve(__dirname, '..');
const extension = require(path.join(source, 'content.js'));
const scoring = require(path.join(source, 'scoring.js'));

function collect(t, html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  t.after(() => dom.window.close());
  return extension.collectPageData(dom.window.document);
}

test('詳細表だけにある容量差を商品記載の根拠として取得する', (t) => {
  const data = collect(t, `
    <h1 id="productTitle">スピーカー 5000mAh</h1>
    <div id="feature-bullets">標準モデル</div>
    <table id="productDetails_detailBullets_sections1"><tbody>
      <tr><th>ブランド</th><td>Example</td></tr>
      <tr><th>電池容量</th><td>3000mAh</td></tr>
    </tbody></table>`);
  assert.equal(data.brand, 'Example');
  assert.match(data.details, /電池容量 \| 3000mAh/);
  const result = scoring.analyzeProduct(data);
  assert.equal(result.listingRiskScore, 18);
  assert.match(result.signals.find(signal => signal.id === 'claim_conflicts').evidence, /商品名 5000 ↔ 説明 3000/);
});

test('表のセルと行を区切り、隣接する数値を結合しない', (t) => {
  const data = collect(t, '<table id="productDetails_techSpec_section_1"><tr><th>区分1</th><td>12時間連続再生</td></tr><tr><td>3</td><td>000mAh</td></tr></table>');
  assert.equal(data.details, '区分1 | 12時間連続再生 | 3 | 000mAh');
  assert.equal(data.details.includes('112時間'), false);
  assert.equal(data.details.includes('3000mAh'), false);
});

test('選択領域に内包された同じ詳細表は一度だけ取得する', (t) => {
  const data = collect(t, `
    <div id="feature-bullets">容量5000mAh</div>
    <div id="productOverview_feature_div">概要
      <table id="productDetails_detailBullets_sections1"><tr><th>電池容量</th><td>5000mAh</td></tr></table>
      <div id="productDescription">補足説明</div>
    </div>`);
  assert.equal(data.details, '容量5000mAh | 概要 | 電池容量 | 5000mAh | 補足説明');
  assert.equal(data.details.match(/電池容量/g).length, 1);
  assert.equal(data.details.match(/補足説明/g).length, 1);
  assert.equal(data.details.match(/5000mAh/g).length, 2); // distinct sections retain their own content
});

test('既存の説明領域は保持し、無関係な表を混ぜない', (t) => {
  const data = collect(t, `
    <div id="feature-bullets">箇条書き</div>
    <table id="productOverview_feature_div"><tr><th>概要</th><td>値A</td></tr></table>
    <div id="productDescription">商品説明</div>
    <div id="aplus">追加説明</div>
    <table id="productDetails_techSpec_section_1"><tr><th>技術仕様</th><td>値B</td></tr></table>
    <table id="productDetails_detailBullets_sections1"><tr><th>詳細仕様</th><td>値C</td></tr></table>
    <table id="unrelated"><tr><td>混入禁止</td></tr></table>`);
  assert.equal(data.details, '箇条書き | 概要 | 値A | 商品説明 | 追加説明 | 技術仕様 | 値B | 詳細仕様 | 値C');
});

test('セル内のインライン要素と従来の箇条書き判定を保持する', (t) => {
  const data = collect(t, `
    <h1 id="productTitle">スピーカー 5000mAh</h1>
    <div id="feature-bullets">容量5<span>,000</span>mAh</div>
    <table id="productDetails_detailBullets_sections1"><tr><th>電池容量</th><td>5<span>,000</span>mAh</td></tr></table>`);
  assert.equal(data.details, '容量5,000mAh | 電池容量 | 5,000mAh');
  assert.equal(scoring.analyzeProduct(data).listingRiskScore, 0);
  const bulletsOnly = collect(t, '<h1 id="productTitle">スピーカー 5000mAh</h1><div id="feature-bullets">容量3000mAh</div>');
  assert.equal(scoring.analyzeProduct(bulletsOnly).listingRiskScore, 18);
});

test('箇条書き・段落・改行の境界で架空の仕様値を作らない', (t) => {
  for (const description of [
    '<ul><li>付属品数3</li><li>時間連続再生テスト対応</li></ul>',
    '<p>付属品数3</p><p>時間連続再生テスト対応</p>',
    '<div>付属品数3</div><div>時間連続再生テスト対応</div>',
    '付属品数3<br>時間連続再生テスト対応'
  ]) {
    const data = collect(t, `<h1 id="productTitle">10時間連続再生</h1><div id="feature-bullets">${description}</div>`);
    assert.deepEqual(scoring.collectClaimConflicts(data.title, data.details), []);
  }
});

test('別の箇条書き項目の数値が実際の容量矛盾を打ち消さない', (t) => {
  const data = collect(t, '<h1 id="productTitle">5000mAh</h1><div id="feature-bullets"><ul><li>検証件数5000</li><li>mAhは容量単位</li><li>電池容量3000mAh</li></ul></div>');
  assert.equal(scoring.analyzeProduct(data).listingRiskScore, 18);
});

test('表がない説明のインライン要素は結合し、コードやスタイルは分析しない', (t) => {
  const data = collect(t, '<h1 id="productTitle">10時間連続再生</h1><div id="feature-bullets">最大<span>12</span><span>時間</span>連続再生<script>"10時間連続再生"</script><style>/*10時間連続再生*/</style></div>');
  assert.equal(data.details, '最大12時間連続再生');
  assert.equal(scoring.analyzeProduct(data).listingRiskScore, 18);
});
