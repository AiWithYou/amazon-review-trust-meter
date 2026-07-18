'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const scoring = require('../content.js');

const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const cardRule = styles.match(/#review-trust-meter-card\.review-trust-meter\s*\{([^}]*)\}/)?.[1] || '';
assert.match(cardRule, /clear:\s*none\s*;/, '商品画像のfloatをclearして大きな空白を作ってはいけない');
assert.doesNotMatch(cardRule, /clear:\s*both\s*;/);

assert.equal(scoring.parseAverageRatingText('5つ星のうち4.0'), 4.0, 'Amazon表記の先頭の5を平均値としてはいけない');
assert.equal(scoring.parseAverageRatingText('4.0 out of 5'), 4.0);
assert.deepEqual(
  scoring.parseHistogramLabel('レビューの42%に星5つがついています'),
  { star: 5, percentage: 42 }
);

const askFeature = { id: 'ask_feature_div' };
const averageReviewsFeature = { id: 'averageCustomerReviews_feature_div' };
const insertionQueries = [];
const insertionPoint = scoring.findInsertionPoint({
  querySelector(selector) {
    insertionQueries.push(selector);
    if (selector === '#ask_feature_div') return askFeature;
    if (selector === '#averageCustomerReviews_feature_div') return averageReviewsFeature;
    return null;
  }
});
assert.equal(insertionPoint.element, askFeature, '評価行では質問リンクの直後を優先する');
assert.equal(insertionPoint.position, 'afterend');
assert.deepEqual(insertionQueries, ['#ask_feature_div'], '購入ボックスを探索してはいけない');

const centerColumn = { id: 'centerCol' };
const fallbackPoint = scoring.findInsertionPoint({
  querySelector(selector) {
    return selector === '#centerCol' ? centerColumn : null;
  }
});
assert.equal(fallbackPoint.element, centerColumn);
assert.equal(fallbackPoint.position, 'afterbegin');

const axloie = scoring.analyzeProduct({
  averageRating: 4.0,
  reviewCount: 134,
  distribution: { 5: 42, 4: 29, 3: 21, 2: 5, 1: 3 },
  title: 'Bluetooth スピーカー ワイヤレス スピーカー【2020 2種類の発光パターン】大音量 重低音 ポータブル 45mmラッパ TWS二台接続可能 12時間連続再生 内蔵マイク ハンズフリー通話 LEDライト 発光 スマホスピーカー IPX6生活防水 Auxポート&TFカード(microSD)スロット対応 アウトドア お風呂 iP',
  brand: 'Axloie',
  details: '最大10時間連続再生。4種類の発光モード。IP56防塵防水対応。',
  reviews: [
    { stars: 5, date: '2020-09-25', body: '音質と低音がとても良く、バッテリーも長く持ちます。毎日使っています。', verified: true },
    { stars: 4, date: '2020-12-05', body: '防水性能には少し不安がありますが、音量と音質は悪くありません。', verified: true },
    { stars: 3, date: '2020-09-15', body: '音楽には使えますが動画では音声が遅れます。', verified: true },
    { stars: 5, date: '2021-03-12', body: 'いいです！', verified: true },
    { stars: 4, date: '2021-12-10', body: '音も見栄えも良い', verified: true },
    { stars: 3, date: '2020-11-16', body: 'Bluetooth接続とTWS接続に難があります。音は良いです。', verified: true },
    { stars: 5, date: '2023-05-08', body: '普通に良い。', verified: true },
    { stars: 2, date: '2022-10-11', body: '希望する音量に対して小さかったです。', verified: true }
  ]
});

assert.equal(axloie.sufficient, true);
assert.equal(axloie.label, '要注意');
assert.ok(axloie.score >= 65, `対象商品は要注意域を期待したが ${axloie.score} 点`);
assert.ok(axloie.trustStars <= 2.4, `対象商品の信頼目安が高すぎる: ${axloie.trustStars}`);
for (const id of ['brand_missing', 'claim_conflicts', 'review_date_cluster', 'generic_high_rating']) {
  assert.ok(axloie.signals.some((signal) => signal.id === id), `${id} が検出されていない`);
}

const missingData = scoring.analyzeProduct({
  averageRating: 4.2,
  reviewCount: 500,
  distribution: { 5: null, 4: null, 3: null, 2: null, 1: null },
  title: '',
  brand: '',
  details: '',
  reviews: []
});
assert.equal(missingData.sufficient, false);
assert.equal(missingData.trustStars, null, '欠損時に安全そうな★を表示してはいけない');

const manyReviews = scoring.analyzeProduct({
  averageRating: 4.2,
  reviewCount: 10000,
  distribution: { 5: 65, 4: 20, 3: 8, 2: 4, 1: 3 },
  title: 'Example Bluetooth Speaker Model X1',
  brand: 'Example',
  details: 'Bluetooth speaker with USB-C charging.',
  reviews: Array.from({ length: 8 }, (_, index) => ({
    stars: 3 + (index % 3),
    date: `${2020 + index}-01-01`,
    body: `This is a specific review body number ${index} describing a different experience with the product.`,
    verified: true
  }))
});
assert.ok(manyReviews.score >= 0, 'レビュー件数の多さで注意度をマイナスにしてはいけない');

console.log(`scoring tests: passed (Axloie ${axloie.score}/100, ★${axloie.trustStars})`);
