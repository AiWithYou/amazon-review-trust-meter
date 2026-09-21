'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const extension = require('../content.js');
const scoring = require('../scoring.js');
const features = require('../scoring-features.js');

function fixture() {
  return new JSDOM(`<!doctype html><div id="centerCol">
    <div id="title_feature_div"><h1 id="productTitle">テスト用スピーカー 12時間連続再生</h1></div>
    <div id="averageCustomerReviews_feature_div"><div id="averageCustomerReviews">
      <span id="acrPopover" title="5つ星のうち4.5"></span><span id="acrCustomerReviewText">100個の評価</span>
    </div></div><div id="feature-bullets">最大12時間連続再生</div>
    <div id="histogramTable">${[5,4,3,2,1].map((star,i) => `<a aria-label="星${star}つ ${[70,20,5,3,2][i]}%"></a>`).join('')}</div>
    <div data-hook="review" data-review-id="R1"><a class="a-profile" href="/gp/profile/A1">投稿者</a>
      <span data-hook="review-star-rating">5つ星のうち5.0</span>
      <span data-hook="review-title">使用感</span><span data-hook="review-body">机で半年使用しています。充電は安定し、音量も十分でした。</span>
      <span data-hook="review-date">2026年9月1日</span><span data-hook="avp-badge">Amazonで購入</span>
      <span data-hook="helpful-vote-statement">11人のお客様がこれが役に立ったと考えています</span>
    </div><div id="unrelated"></div></div>`, { url: 'https://www.amazon.co.jp/dp/B012345678', runScripts: 'outside-only' });
}

function runningFixture(t) {
  const dom = fixture();
  t.after(() => dom.window.close());
  const timers = new Map(); let serial = 0;
  dom.window.setTimeout = (fn) => { timers.set(++serial, fn); return serial; };
  dom.window.clearTimeout = (id) => timers.delete(id);
  for (const file of ['scoring-base.js','scoring-features.js','scoring.js','content.js']) dom.window.eval(fs.readFileSync(path.join(__dirname,'..',file),'utf8'));
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const tick = async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); await flush(); };
  return { dom, doc: dom.window.document, timers, flush, tick };
}

test('実DOMから星・本文・参考票を取得し同一review-idを一度だけ数える', (t) => {
  const dom = fixture(); t.after(() => dom.window.close());
  const doc = dom.window.document;
  doc.body.append(doc.querySelector('[data-hook="review"]').cloneNode(true));
  const data = extension.collectPageData(doc);
  assert.equal(data.averageRating, 4.5); assert.equal(data.reviewCount, 100);
  assert.equal(data.reviews.length, 1); assert.equal(data.reviews[0].helpfulVotes, 11);
  assert.equal(data.reviews[0].reviewerId, 'A1'); assert.equal(data.reviews[0].verified, true);
});

test('ヒストグラムの属性欠損を0%にしない', (t) => {
  const dom = fixture(); t.after(() => dom.window.close());
  const doc = dom.window.document;
  doc.querySelector('#histogramTable').innerHTML = '<a href="?filterByStar=five_star"><span role="progressbar"></span></a>';
  assert.equal(extension.collectPageData(doc).distribution[5], null);
  doc.querySelector('[role="progressbar"]').setAttribute('aria-valuenow','0');
  assert.equal(extension.collectPageData(doc).distribution[5], 0);
});

test('同文字数の仕様変更とレビュータイトル変更も再判定する', (t) => {
  const dom = fixture(); t.after(() => dom.window.close());
  const data = extension.collectPageData(dom.window.document);
  const before = extension.createFingerprint('B012345678', data);
  data.details = data.details.replace('12','10');
  assert.notEqual(extension.createFingerprint('B012345678',data),before);
  const second = extension.createFingerprint('B012345678',data);
  data.reviews[0].title = '変更';
  assert.notEqual(extension.createFingerprint('B012345678',data),second);
});

test('不足した割合は不明のまま、明示的な0%は有効', () => {
  for (const value of [null, undefined, '', ' ', false]) assert.equal(scoring.distributionInfo({1:value,2:0,3:0,4:10,5:90}).usable,false);
  assert.equal(scoring.distributionInfo({1:0,2:0,3:0,4:10,5:90}).usable,true);
});

test('星欠損や範囲外を低評価や補正評価に流用しない', () => {
  for (const stars of [null, undefined, '', 0, -1, 6, false]) {
    assert.equal(features.getReviewDirection({stars:null}), 'neutral');
    const result = scoring.analyzeProduct({reviews:Array.from({length:8},(_,i)=>({id:String(i),stars,body:'最高です。',reviewerId:'same',date:`2026-09-0${i+1}`}))});
    assert.ok(!result.signals.some(s=>['duplicate_reviewer_direction','rating_body_mismatch','unverified_negative_cluster'].includes(s.id)));
    assert.equal(result.adjustedRating,null);
  }
});

test('同じレビューのDOM複製を投稿者の連続投稿と誤認しない', () => {
  const review = {id:'R1',reviewerId:'A1',stars:5,body:'机で使用。音質は満足しています。'};
  const result = scoring.analyzeProduct({reviews:Array(10).fill(review)});
  assert.equal(result.sampleSize,1);
  assert.ok(!result.signals.some(s=>s.id==='duplicate_reviewer_direction'));
  assert.equal(scoring.analyzeProduct({reviews:[null,undefined,review]}).sampleSize,1);
});

test('件数が多くてもAmazon重み付き平均との差だけで加点しない', () => {
  const result = scoring.analyzeProduct({averageRating:4,reviewCount:10000,distribution:{1:2,2:3,3:5,4:20,5:70}});
  assert.ok(!result.signals.some(s=>s.id==='rating_mismatch'));
  assert.ok(result.observations.some(s=>s.id==='rating_mismatch_observation'));
});

test('充電時間と再生時間を区別し桁区切り容量を正しく比較する', () => {
  assert.equal(scoring.collectClaimConflicts('12時間連続再生 5,000mAh','充電時間は2時間。5000mAh。').length,0);
  assert.equal(scoring.collectClaimConflicts('12時間連続再生','10時間連続再生').length,1);
  assert.equal(scoring.collectClaimConflicts('5,000mAh','3000mAh').length,1);
});

test('参考票の11人・21人と存在しない日本語日付を正しく扱う', () => {
  assert.equal(extension.parseHelpfulVotes('21人のお客様'),21);
  assert.equal(extension.parseHelpfulVotes('一人のお客様'),1);
  assert.equal(extension.parseReviewDate('2026年2月30日'), '');
  assert.equal(extension.parseReviewDate('2024年2月29日'), '2024-02-29');
});

test('完全な星分布でも本文1件では安全そうな判定を出さない', (t) => {
  const dom = fixture(); t.after(() => dom.window.close());
  const result = scoring.analyzeProduct(extension.collectPageData(dom.window.document));
  assert.equal(result.sufficient,false);
  assert.equal(result.label,'判定材料不足');
  const unknownStars = features.computeAdjustedRating({averageRating:4.5,distribution:{1:2,2:3,3:5,4:20,5:70},reviews:Array(8).fill({stars:null}),reviewAnalysis:[],confidence:80});
  assert.equal(unknownStars,null);
});

test('実MutationObserverで本文変更・属性変更を検出し詳細の開閉を維持する', async (t) => {
  const {doc,tick,flush,timers} = runningFixture(t);
  await tick(); assert.equal(doc.querySelectorAll('#review-trust-meter-card').length,1);
  assert.equal(timers.size,0);
  doc.querySelector('details').open = true;
  doc.querySelector('#feature-bullets').firstChild.data = '最大10時間連続再生';
  await flush(); assert.equal(timers.size,1); await tick();
  assert.equal(doc.querySelector('details').open,true);
  assert.match(doc.querySelector('#review-trust-meter-card').textContent,/仕様値が一致しない/);
  doc.querySelector('#acrPopover').setAttribute('title','5つ星のうち4.0');
  await flush(); await tick();
  assert.match(doc.querySelector('#review-trust-meter-card').textContent,/★ 4.0/);
  assert.equal(timers.size,0);
});

test('無関係な変更100件は再解析を予約せず、連続する関連変更は同じ予約を使う', async (t) => {
  const {doc,tick,flush,timers,dom} = runningFixture(t); await tick();
  for (let i=0;i<100;i++) doc.querySelector('#unrelated').append(doc.createElement('span'));
  await flush(); assert.equal(timers.size,0);
  doc.querySelector('#feature-bullets').textContent='変更1'; await flush();
  const timer = [...timers.keys()][0];
  for(let i=0;i<20;i++) {doc.querySelector('#feature-bullets').textContent=`変更${i}`; await flush();}
  assert.deepEqual([...timers.keys()],[timer]);
  dom.window.ReviewTrustExtension.start(); assert.equal(timers.size,1);
  await tick(); assert.equal(doc.querySelectorAll('#review-trust-meter-card').length,1);
});

test('カードを含む親要素の差し替えとカード単独削除から復帰する', async (t) => {
  const {doc,tick,flush} = runningFixture(t); await tick();
  const column=doc.querySelector('#centerCol'); column.replaceWith(column.cloneNode(true));
  doc.querySelector('#review-trust-meter-card').remove();
  await flush(); await tick();
  assert.equal(doc.querySelectorAll('#review-trust-meter-card').length,1);
  doc.querySelector('#review-trust-meter-card').remove(); await flush(); await tick();
  assert.equal(doc.querySelectorAll('#review-trust-meter-card').length,1);
});

test('ブラウザ戻る操作のASIN変更を反映し商品外では表示を消す', async (t) => {
  const {doc,dom,tick,flush} = runningFixture(t); await tick();
  dom.window.history.pushState({},'', '/dp/B087654321');
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate')); await tick();
  assert.match(doc.querySelector('.review-trust-meter__link').href,/B087654321/);
  dom.window.history.pushState({},'', '/');
  dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate')); await tick();
  assert.equal(doc.querySelector('#review-trust-meter-card'),null);
  await flush();
});
