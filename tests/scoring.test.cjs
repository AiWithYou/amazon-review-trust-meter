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

function polarizedFanReviews() {
  return [
    { stars: 5, date: '2026-07-16', body: 'コンパクトで高級感があり、風量も十分で音も静かです。', verified: true },
    { stars: 5, date: '2026-07-13', body: 'デスクでは風量1でも涼しく、台を回すクリック感と充電の速さも気に入りました。', verified: true, helpfulVotes: 1 },
    { stars: 5, date: '2026-07-16', body: '机で場所を取らず、風量調節も簡単です。仕事中も比較的静かでした。', verified: true },
    { stars: 5, date: '2026-07-10', body: '上下左右の首振りとリモコンが便利で、サイズとデザインにも満足です。', verified: true, helpfulVotes: 4 },
    { stars: 1, date: '2026-06-17', body: '風力が思ったより弱く、重くて価格も高いため購入に失敗したと感じました。', verified: true, helpfulVotes: 10 },
    { stars: 5, date: '2026-05-21', body: '金属の質感とディスプレイが良く、向きを変えるときのクリック感も独特です。', verified: true, helpfulVotes: 3, imageCount: 1 },
    { stars: 4, date: '2026-07-04', body: '風量は強いですが、最弱でも強めなので優しい風が好みなら注意が必要です。', verified: true },
    { stars: 5, date: '2026-06-28', body: '小さいので期待していませんでしたが、最弱でもしっかり風が届きました。', verified: true, helpfulVotes: 3 },
    { stars: 5, date: '2026-06-15', body: 'The metal finish feels solid, the battery lasted well, and the airflow was quiet and strong.', verified: true, imageCount: 6 },
    { stars: 5, date: '2026-07-13', body: 'It fits on my desk, stays quiet, and provides strong airflow without taking much space.', verified: true },
    { stars: 5, date: '2026-06-14', body: 'The fan worked as described and the compact body was not noisy during use.', verified: true },
    { stars: 5, date: '2026-05-26', body: 'The sturdy metal build looks sleek, runs quietly, and produces enough airflow.', verified: true },
    { stars: 5, date: '2026-05-02', body: 'The fan is well made, performs reliably, and the battery life has been good.', verified: true }
  ];
}

test('manifest・package・構文がv2で整合する', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '2.0.3');
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

test('Amazon現行DOMのreviewTextとreviewTitleから本文・タイトルを取得する', () => {
  const titleElement = {
    cloneNode() {
      return {
        textContent: ' 安定の品質。5か月使用でも不具合なし。 ',
        querySelectorAll() { return []; }
      };
    }
  };
  const bodyElement = {
    innerText: 'AnkerのUSB-Cケーブルを約5か月使用。\n充電・データ転送とも安定しています。'
  };
  const reviewElement = {
    querySelector(selector) {
      if (selector.startsWith('[data-hook="reviewTitle"]')) return titleElement;
      if (selector.startsWith('[data-hook="reviewText"]')) return bodyElement;
      return null;
    }
  };

  assert.equal(extension.getReviewTitle(reviewElement), '安定の品質。5か月使用でも不具合なし。');
  assert.equal(extension.getReviewBody(reviewElement), 'AnkerのUSB-Cケーブルを約5か月使用。 充電・データ転送とも安定しています。');
});

test('商品画像のfloatをclearして大きな空白を作らない', () => {
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const cardRule = styles.match(/#review-trust-meter-card\.review-trust-meter\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(cardRule, /clear:\s*none\s*;/);
  assert.doesNotMatch(cardRule, /clear:\s*both\s*;/);
});

test('折りたたみ表示は補正★・判定・注意度・詳細だけを並べる', () => {
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const summary = source.match(/<summary class="review-trust-meter__summary">([\s\S]*?)<\/summary>/)?.[1] || '';
  assert.match(summary, /\$\{scoreHtml\}/);
  assert.match(summary, /review-trust-meter__label/);
  assert.match(summary, /review-trust-meter__risk">注意度/);
  assert.match(summary, /詳細を見る/);
  assert.doesNotMatch(summary, /分析材料|判定確度|レビュー兆候|商品記載/);
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

test('Anker USBケーブルの選択表示レビューを集中投稿と誤判定しない', () => {
  const bodies = [
    '高速充電も出来て、問題なく使用しています。',
    '【良かった点・気に入ったこと】超速充電で、忙しい朝でもあっという間に充電完了。猫が噛んでも壊れない丈夫さ。コスパも良いです。【注意点】ケーブルの太さが少し太めで、好みによっては気になるかもしれません。',
    '良い商品。手頃感があって良い',
    '特に使用に関しては問題なし',
    '今や機材の多くがタイプC規格となり、一本で充電するより複数本で各機材に配電したほうが効率がよいため、とりあえず購入して損はない。',
    '非常に丈夫なので、最高',
    'AnkerのUSB-Cケーブルとして購入し、iPhone16eの充電用に約5か月間日常的に使用しています。充電・データ転送ともに安定し、接続の緩さや断線もありません。長さ1.8mで取り回しに余裕があります。',
    '寝室にちょうど良い長さで満足です。',
    'sredni. odeslany',
    'Se estropean mucho',
    'De zeer vriendelijke prijs ten opzichte van de officiële kabel deed mij besluiten deze kabel te proberen. Werkt gewoon prima voor vr sim racing.',
    'Il cavo è perfetto e resistentissimo. Dopo più di un anno è ancora immacolato e supporta la carica veloce.',
    'Works just as good as original cable'
  ];
  const dates = ['2026-07-15', '2026-03-31', '2026-07-14', '2026-06-16', '2026-07-14', '2026-06-29', '2026-04-14', '2026-07-11', '2025-10-23', '2024-12-26', '2021-07-17', '2024-04-26', '2023-11-27'];
  const stars = [5, 4, 5, 3, 5, 5, 4, 5, 3, 3, 5, 5, 5];
  const result = scoring.analyzeProduct({
    averageRating: 4.3,
    reviewCount: 57722,
    distribution: { 5: 60, 4: 24, 3: 12, 2: 2, 1: 2 },
    title: 'Anker USB Type C ケーブル PowerLine USB-C & USB-A 3.0 ケーブル iPhone 17 / 16 / 15 /Xperia/Galaxy/LG/iPad Pro/MacBook その他 Android 等 USB-C機器対応 テレワーク リモート 在宅勤務 0.9m ホワイト | iPhone 17 / 16 / 15 /Xperia/Galaxy/LG/iPad Pro/MacBook その他 Android 等 USB-C機器対応 テレワーク リモート 在宅勤務',
    brand: 'Anker',
    details: 'USB-A 3.0とUSB-Cに対応。0.9m、ホワイト。',
    reviews: bodies.map((body, index) => ({ stars: stars[index], date: dates[index], body, verified: true }))
  });

  assert.ok(result.score < 25, `Anker正常例の注意度が高すぎる: ${result.score}`);
  assert.equal(result.reviewRiskScore, 0);
  assert.equal(result.tone, 'low');
  assert.ok(result.observations.some((item) => item.id === 'uncorroborated_time_cluster'));
  assert.ok(!result.signals.some((signal) => signal.id === 'directional_time_burst'));
  assert.ok(!result.signals.some((signal) => signal.id === 'co_burst_generic_campaign'));
});

test('Yibestサーキュレーターは二極化・短期高評価・参考票・強い訴求の重なりを確認推奨にする', () => {
  const result = scoring.analyzeProduct({
    averageRating: 4.4,
    reviewCount: 71,
    distribution: { 5: 78, 4: 8, 3: 1, 2: 3, 1: 10 },
    title: '【世界初！チタン金属製サーキュレーター DCモーター】卓上扇風機 静音 超小型せんぷうき パワフル送風 省エネ USB充電式 10段階風量調節 デスクトップファン 360°x180°立体送風 5000mAhバッテリー 9時間の持続使用 LEDディスプレイ付き一台多役 換気/空気循環/部屋干し/冷房/梅雨対策 室内や屋外兼用',
    brand: 'Yibest',
    details: '世界初のチタン金属製。特許出願中の独自開発構造と業界最先端の革新的技術を採用。従来品より風量300%向上、究極の静音性を実現。',
    reviews: polarizedFanReviews()
  });

  assert.ok(result.score >= 25 && result.score < 50, `確認推奨の範囲外: ${result.score}`);
  assert.equal(result.label, '確認推奨');
  assert.ok(result.reviewRiskScore >= 15, `レビュー兆候が低すぎる: ${result.reviewRiskScore}`);
  assert.ok(result.listingRiskScore >= 10, `商品記載が低すぎる: ${result.listingRiskScore}`);
  for (const id of [
    'moderate_polarized_distribution',
    'polarized_time_overlap',
    'helpful_negative_contrast',
    'promotional_title',
    'extraordinary_claim_density'
  ]) {
    assert.ok(result.signals.some((signal) => signal.id === id), `${id} が検出されていない`);
  }
  assert.ok(result.observations.some((item) => item.id === 'positive_review_images'));
});

test('中程度の二極化だけでは正常商品を確認推奨にしない', () => {
  const result = scoring.analyzeProduct({
    averageRating: 4.4,
    reviewCount: 600,
    distribution: { 5: 78, 4: 8, 3: 4, 2: 2, 1: 8 },
    title: 'Example 卓上扇風機 USB-C充電式',
    brand: 'Example',
    details: '3段階風量、首振り機能、USB-C充電。',
    reviews: cleanReviews()
  });

  assert.ok(result.score < 25, `二極化単独で加点しすぎている: ${result.score}`);
  assert.equal(result.label, '目立つ異常は少ない');
  assert.ok(result.signals.some((signal) => signal.id === 'moderate_polarized_distribution'));
  assert.ok(!result.signals.some((signal) => signal.id === 'polarized_time_overlap'));
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

test('エレコムの新製品は発売直後の日付集中やブランド別名で誤警告しない', () => {
  const bodies = [
    '箱を開けた第一印象は大きい。ベアリング支持は滑らかだが汚れで抵抗が出るため掃除が必要。細かな操作は二本指で快適です。',
    '初日は難しかったが3日目には普通に使え、一週間で慣れました。不満は設定アプリの対応が遅れていることです。',
    '前モデルからアップグレードしました。ボールを弾く移動は快適ですが微調整は少し独特です。',
    '二か月メインで使用。操作は滑らかですが手を広げるので疲れ、親指のボタン操作に負担を感じます。',
    'ExpertMouseから乗り換え。ベアリング式で摩擦が少なく、低床で手首が疲れません。',
    'Excellent feel and smooth movement, but the buttons require setup for my workflow.',
    '前モデルから乗り換え。クリック音と接続方式は改善しましたが、価格とボール操作音には不満があります。',
    '説明不要なほど大きいですが機能が多く、設置スペースがあれば所有感が満たされます。'
  ];
  const dates = ['2026-01-20', '2026-04-16', '2026-05-01', '2026-04-21', '2026-06-01', '2026-06-11', '2026-02-24', '2026-01-11'];
  const stars = [5, 4, 5, 3, 5, 5, 4, 5];
  const result = scoring.analyzeProduct({
    averageRating: 4.2,
    reviewCount: 132,
    distribution: { 5: 56, 4: 20, 3: 14, 2: 6, 1: 4 },
    title: 'エレコム トラックボールマウス HUGE PLUS 静音 ベアリング支持 充電式 Bluetooth 無線2.4GHz 有線 3台マルチペアリング 10ボタン チルトホイール 2年保証 ブラック M-HT1MRBK-G',
    brand: 'エレコム(ELECOM)',
    details: '直径52mm。Bluetoothと無線2.4GHzと有線の3種接続。3台まで同時接続。ベアリング支持。チルトホイール。',
    reviews: bodies.map((body, index) => ({ stars: stars[index], date: dates[index], body, verified: true }))
  });

  assert.ok(result.score < 25, `正常な新製品の注意度が高すぎる: ${result.score}`);
  assert.equal(result.reviewRiskScore, 0);
  assert.equal(result.listingRiskScore, 0);
  assert.equal(result.label, '目立つ異常は少ない');
  assert.ok(!result.observations.some((item) => item.id === 'brand_not_in_title'));
  assert.ok(!result.signals.some((signal) => signal.id === 'directional_time_burst'));
});

test('Axloieはレビュー兆候と分けて複数の商品記載矛盾を要注意にする', () => {
  const result = scoring.analyzeProduct({
    averageRating: 4.0,
    reviewCount: 134,
    distribution: { 5: 42, 4: 29, 3: 21, 2: 5, 1: 3 },
    title: 'Bluetooth スピーカー ワイヤレス スピーカー【2020 2種類の発光パターン】大音量 重低音 ポータブル 45mmラッパ TWS二台接続可能 12時間連続再生 内蔵マイク ハンズフリー通話 LEDライト 発光 スマホスピーカー IPX6生活防水 Auxポート&TFカード(microSD)スロット対応 アウトドア お風呂 iP',
    brand: 'Axloie',
    details: '最大10時間連続再生。4種類の発光モード。IP56防塵防水対応。',
    reviews: [
      { stars: 5, date: '2020-09-25', body: '音質と低音が良く、バッテリーも長く持ちます。毎日シャワー中にも使っています。', verified: true },
      { stars: 4, date: '2020-12-05', body: '音は大きいですが端子がむき出しで、防水性能には不安があります。', verified: true },
      { stars: 3, date: '2020-09-15', body: '音楽には使えますが動画では音声がかなり遅れます。', verified: true },
      { stars: 5, date: '2021-03-12', body: '白い本体でサイズもちょうど良く、イルミネーションを消せる点が便利です。', verified: true },
      { stars: 4, date: '2021-12-10', body: '音も見栄えも良いです。', verified: true },
      { stars: 3, date: '2020-11-16', body: 'Bluetooth接続とTWS接続に難がありますが、音質は良いです。', verified: true },
      { stars: 5, date: '2023-05-08', body: '普通に良い。', verified: true },
      { stars: 2, date: '2022-10-11', body: '希望する音量に対して小さかったです。', verified: true }
    ]
  });

  assert.equal(result.reviewRiskScore, 0);
  assert.ok(result.listingRiskScore >= 58, `商品記載の注意度が低すぎる: ${result.listingRiskScore}`);
  assert.ok(result.score >= 65, `総合注意度が低すぎる: ${result.score}`);
  assert.equal(result.label, '要注意');
  const conflictSignal = result.signals.find((signal) => signal.id === 'claim_conflicts');
  assert.match(conflictSignal?.evidence || '', /連続時間/);
  assert.match(conflictSignal?.evidence || '', /防水・防塵等級/);
  assert.match(conflictSignal?.evidence || '', /発光パターン数/);
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
  assert.equal(scoring.getGenericness(''), 0, '取得できない本文を汎用レビューと推定しない');
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
