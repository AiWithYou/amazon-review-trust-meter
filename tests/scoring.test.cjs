'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const scoring = require('../scoring.js');
const extension = require('../content.js');

const root = path.join(__dirname, '..');

function campaignReviews() {
  const bodies = [
    'コンパクトなのに高性能で音質も最高です。接続も簡単で毎日愛用しています。絶対におすすめです。',
    '小型なのに高性能で音も最高です。接続が簡単なので毎日使っています。絶対おすすめの商品です。',
    'コンパクトで高性能、音質も最高でした。接続も簡単で毎日使えるため絶対おすすめです。',
    '小さいのに高性能で音質が最高です。接続も簡単、毎日愛用しています。絶対におすすめします。',
    'コンパクトなのに高性能で音質も最高。接続は簡単で毎日使っています。迷っているならおすすめです。',
    '小型で高性能、音質も最高です。接続も簡単なので毎日愛用中です。絶対におすすめです。',
    'コンパクトなのに高性能、音質が最高です。接続も簡単で毎日使っています。買って損なしです。',
    '小型なのに高性能で音質も最高。接続が簡単で毎日愛用しています。絶対おすすめです。'
  ];
  return bodies.map((body, index) => ({
    stars: 5,
    date: `2026-06-${String(index + 1).padStart(2, '0')}`,
    body,
    verified: index === 7
  })).concat([
    { stars: 4, date: '2025-01-03', body: '音量は十分ですが、充電端子のカバーが少し開けにくいです。', verified: true },
    { stars: 1, date: '2024-08-02', body: '三日で電源が入らなくなり返品しました。', verified: true }
  ]);
}

function cleanReviews() {
  return [
    { stars: 5, date: '2019-02-02', body: '小さな部屋で半年使っています。低音は強すぎず、USB-C充電も安定しています。', verified: true },
    { stars: 5, date: '2020-07-11', body: '旅行用に購入。実測で二日ほど充電せず使え、音量も屋外で十分でした。', verified: true },
    { stars: 4, date: '2021-04-03', body: '音質は価格相応で満足です。ただし起動音が少し大きい点は気になります。', verified: true },
    { stars: 5, date: '2022-09-20', body: '浴室で使って3か月。水がかかっても問題なく、接続もすぐ終わります。', verified: true },
    { stars: 5, date: '2023-01-15', body: '良い商品です。', verified: true },
    { stars: 3, date: '2023-08-12', body: '動画ではわずかに遅延を感じます。音楽用途なら特に問題ありません。', verified: true },
    { stars: 5, date: '2024-05-04', body: '家事中に毎日使用。バッテリーは一週間に一度の充電で足りています。', verified: true },
    { stars: 4, date: '2025-02-14', body: 'サイズと重さは想定通り。ボタンが少し硬いですが、音は聞き取りやすいです。', verified: true },
    { stars: 5, date: '2025-11-01', body: '接続先の切替が簡単で、PCとスマホの両方で使えました。', verified: true },
    { stars: 5, date: '2026-06-20', body: '満足しています。', verified: true }
  ];
}

test('manifest・package・構文がv2で整合する', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '2.0.0');
  assert.equal(packageJson.version, manifest.version);
  assert.deepEqual(manifest.content_scripts[0].js, ['scoring-base.js', 'scoring-features.js', 'scoring.js', 'content.js']);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.host_permissions, undefined);
});

test('Amazon表記のパーサーが先頭の5を平均値と誤認しない', () => {
  assert.equal(extension.parseAverageRatingText('5つ星のうち4.0'), 4.0);
  assert.equal(extension.parseAverageRatingText('星5つ中 4.5つ'), 4.5);
  assert.equal(extension.parseAverageRatingText('4.0 out of 5'), 4.0);
  assert.deepEqual(extension.parseHistogramLabel('レビューの42%に星5つがついています'), { star: 5, percentage: 42 });
  assert.deepEqual(extension.parseHistogramLabel('5 star 81%'), { star: 5, percentage: 81 });
  assert.equal(extension.parseReviewDate('2026年7月18日に日本でレビュー済み'), '2026-07-18');
  assert.equal(extension.parseHelpfulVotes('12人のお客様がこれが役に立ったと考えています'), 12);
});

test('商品画像のfloatをclearして大きな空白を作らない', () => {
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const cardRule = styles.match(/#review-trust-meter-card\.review-trust-meter\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(cardRule, /clear:\s*none\s*;/);
  assert.doesNotMatch(cardRule, /clear:\s*both\s*;/);
});

test('挿入位置は質問・評価行の直後を優先し、購入ボックスを探索しない', () => {
  const askFeature = { id: 'ask_feature_div' };
  const queries = [];
  const insertionPoint = extension.findInsertionPoint({
    querySelector(selector) {
      queries.push(selector);
      return selector === '#ask_feature_div' ? askFeature : null;
    }
  });
  assert.equal(insertionPoint.element, askFeature);
  assert.equal(insertionPoint.position, 'afterend');
  assert.deepEqual(queries, ['#ask_feature_div']);
});

test('高評価比率が高いだけの実用品を危険判定しない', () => {
  const result = scoring.analyzeProduct({
    averageRating: 4.7,
    reviewCount: 2400,
    distribution: { 5: 88, 4: 8, 3: 2, 2: 1, 1: 1 },
    title: 'Anker Soundcore Bluetoothスピーカー 防水モデル',
    brand: 'Anker',
    details: 'IPX7防水、USB-C充電、最大24時間再生。',
    reviews: cleanReviews()
  });

  assert.ok(result.score <= 20, `正常例の注意度が高すぎる: ${result.score}`);
  assert.equal(result.tone, 'low');
  assert.ok(result.confidence >= 70);
  assert.ok(!result.signals.some((signal) => signal.id === 'duplicate_text_cluster'));
  assert.ok(result.adjustedRating >= 4.6 && result.adjustedRating <= 4.8);
});

test('本文重複・短期集中・未確認高評価・星分布が重なるキャンペーンを強く検出する', () => {
  const result = scoring.analyzeProduct({
    averageRating: 4.8,
    reviewCount: 326,
    distribution: { 5: 92, 4: 5, 3: 1, 2: 0, 1: 2 },
    title: 'Bluetooth スピーカー 高音質 大音量 重低音 最強 究極 圧倒的 超強力 ワイヤレススピーカー 防水',
    brand: 'XQZZ',
    details: '最大12時間再生。IPX6防水。',
    reviews: campaignReviews()
  });

  assert.ok(result.score >= 65, `キャンペーン例の注意度が低すぎる: ${result.score}`);
  assert.equal(result.tone, 'high');
  for (const id of ['duplicate_text_cluster', 'co_burst_duplicate_campaign', 'unverified_positive_cluster']) {
    assert.ok(result.signals.some((signal) => signal.id === id), `${id} が検出されていない`);
  }
  assert.ok(result.diagnostics.textClusters.largestSize >= 7);
  assert.ok(result.adjustedRating <= 4.8);
});

test('Vineレビューの発売時集中を不正キャンペーン扱いしない', () => {
  const bodies = [
    '浅煎り豆を20g挽くのに約35秒でした。粒度調整は二段目がドリップに合いました。',
    '毎朝一週間使いました。容器を外して洗えるので粉が残りにくいです。',
    '充電後に12回ほど使えました。音は大きめですが短時間なので許容範囲です。',
    '細挽きでは少し粒が不揃いですが、中挽きなら十分均一でした。',
    '本体は実測で軽く、旅行用バッグにも収まりました。ロック機構も分かりやすいです。',
    '豆の量を入れすぎると停止しました。説明書どおり20g以下なら安定しています。',
    '刃の周囲に粉が少し残ります。ただし付属ブラシで一分ほどで清掃できます。',
    'USB-Cで充電できる点が便利です。満充電まで約二時間かかりました。',
    'エスプレッソ用には粗さが足りませんでした。ドリップ用途向けだと思います。',
    '価格を考えると作りは良いです。ただし蓋のクリック感は弱めです。'
  ];
  const result = scoring.analyzeProduct({
    averageRating: 4.6,
    reviewCount: 30,
    distribution: { 5: 80, 4: 13, 3: 4, 2: 0, 1: 3 },
    title: '新型コーヒーミル USB-C充電式',
    brand: 'Millo',
    details: 'ステンレス刃、5段階調整、USB-C充電。',
    reviews: bodies.map((body, index) => ({
      stars: index === 8 ? 3 : index === 9 ? 4 : 5,
      date: `2026-07-${String(index + 1).padStart(2, '0')}`,
      body,
      verified: false,
      vine: true
    }))
  });

  assert.ok(result.score < 25, `Vine正常例の注意度が高すぎる: ${result.score}`);
  assert.ok(result.observations.some((item) => item.id === 'vine_reviews'));
  assert.ok(!result.signals.some((signal) => signal.id === 'unverified_positive_cluster'));
});

test('短期の類似低評価群をレビュー攻撃候補として検出する', () => {
  const bodies = [
    '発熱がひどくて危険です。すぐ返品しました。絶対に買わない方がいいです。',
    '発熱がひどく危険でした。すぐに返品しました。絶対買わない方がいいです。',
    '熱くなり危険なので返品しました。絶対に購入しない方がいい商品です。',
    '発熱がひどくて危険。すぐ返品しました。絶対に買わないことをおすすめします。',
    '危険なほど発熱したので即返品。絶対買わない方がいいと思います。',
    '発熱が酷く危険です。すぐ返品しました。絶対に購入しないでください。',
    'すぐ熱くなり危険でした。返品済みです。絶対買わない方がいいです。'
  ];
  const result = scoring.analyzeProduct({
    averageRating: 3.9,
    reviewCount: 850,
    distribution: { 5: 66, 4: 9, 3: 3, 2: 2, 1: 20 },
    title: 'Example USB-C Charger 65W',
    brand: 'Example',
    details: 'USB-C PD 65W、PSE適合。',
    reviews: bodies.map((body, index) => ({
      stars: 1,
      date: `2026-05-${String(index + 10).padStart(2, '0')}`,
      body,
      verified: false
    })).concat([
      { stars: 5, date: '2023-01-01', body: 'ノートPCで一年使用。65Wで安定して充電でき、発熱も純正品と同程度です。', verified: true },
      { stars: 4, date: '2024-02-01', body: '二ポート同時利用では出力が分配されますが、仕様どおり動作しました。', verified: true },
      { stars: 5, date: '2025-02-01', body: '出張用に軽く、ケーブルを変えても接続が安定しています。', verified: true }
    ])
  });

  assert.ok(result.score >= 45, `低評価攻撃例の注意度が低すぎる: ${result.score}`);
  assert.ok(result.signals.some((signal) => signal.id === 'unverified_negative_cluster'));
  assert.ok(result.signals.some((signal) => signal.id === 'co_burst_duplicate_campaign'));
  assert.ok(result.adjustmentDelta >= 0, '疑わしい低評価を弱める補正は上方向であるべき');
});

test('投稿日集中だけでは強い判定にしない', () => {
  const result = scoring.analyzeProduct({
    averageRating: 4.3,
    reviewCount: 90,
    distribution: { 5: 68, 4: 20, 3: 7, 2: 3, 1: 2 },
    title: 'Seasonal Heater Model H2',
    brand: 'Seasonal',
    details: '温度3段階、タイマー付き。',
    reviews: [
      '寝室の弱運転で三時間使いました。室温は十分上がり、運転音も小さめです。',
      '脱衣所で使用。強運転は暖かい一方、消費電力が高いので短時間向きです。',
      '六畳の仕事部屋では中設定がちょうどよく、タイマーも正確に動きました。',
      '足元用として使っています。本体が軽く、持ち手も熱くなりません。',
      '朝だけ台所で使用。立ち上がりは速いですが、広い部屋全体には不足します。',
      '転倒時停止を試したところすぐ切れました。安全機能は仕様どおりです。',
      'フィルター掃除は簡単でした。ただし電源コードはもう少し長い方が便利です。',
      '弱運転を一週間使い、乾燥は少なめでした。表示ランプが夜は少し明るいです。'
    ].map((body, index) => ({
      stars: 3 + (index % 3),
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      body,
      verified: true
    })).concat([
      { stars: 4, date: '2024-01-01', body: '寝室で一冬使いました。弱運転なら音は気になりません。', verified: true }
    ])
  });

  assert.ok(result.score < 25, `時系列だけで加点しすぎている: ${result.score}`);
});

test('ブランド名が商品名にないことだけでは加点しない', () => {
  const result = scoring.analyzeProduct({
    averageRating: 4.2,
    reviewCount: 120,
    distribution: { 5: 62, 4: 24, 3: 8, 2: 4, 1: 2 },
    title: 'USB-C 充電器 45W 2ポート',
    brand: 'ExampleBrand',
    details: 'PD対応、PSE適合。',
    reviews: cleanReviews().slice(0, 8)
  });
  assert.ok(!result.signals.some((signal) => signal.id === 'brand_missing'));
  assert.ok(result.observations.some((item) => item.id === 'brand_not_in_title'));
});

test('欠損データでは安全そうな数値を捏造しない', () => {
  const result = scoring.analyzeProduct({
    averageRating: 4.2,
    reviewCount: 500,
    distribution: { 5: null, 4: null, 3: null, 2: null, 1: null },
    title: '',
    brand: '',
    details: '',
    reviews: []
  });
  assert.equal(result.sufficient, false);
  assert.equal(result.adjustedRating, null);
  assert.equal(result.label, '判定材料不足');
});

test('日本語の言い換えテンプレートを文字n-gramで検出できる', () => {
  const similarity = scoring.getReviewTextSimilarity(
    '発熱がひどくて危険です。すぐ返品しました。絶対に買わない方がいいです。',
    '熱くなり危険なので返品しました。絶対に購入しない方がいい商品です。'
  );
  assert.ok(similarity >= 0.39, `類似度が低すぎる: ${similarity}`);
  assert.ok(
    scoring.getGenericness('良い商品です。') > scoring.getGenericness('三か月毎日使い、充電は一週間に一度で足りました。'),
    '具体的レビューの汎用度は低くなるべき'
  );
});

test('異なる仕様項目の「種類数」を数値矛盾と誤認しない', () => {
  const conflicts = scoring.collectClaimConflicts(
    'LEDライト 3種類の発光色 500g',
    'サイズは5種類から選択できます。重量は0.5kgです。'
  );
  assert.equal(conflicts.length, 0);
});

test('星別割合は丸め誤差を正規化して平均を計算する', () => {
  const info = scoring.distributionInfo({ 5: 70, 4: 20, 3: 7, 2: 2, 1: 2 });
  assert.equal(info.usable, true);
  assert.equal(info.valid, true);
  const rating = scoring.getWeightedRating({ 5: 70, 4: 20, 3: 7, 2: 2, 1: 2 });
  assert.ok(rating > 4.5 && rating < 4.6);
});
