'use strict';

// Reproducible store screenshots: sample product data with the actual extension
// scripts and styles. This development fixture is excluded from both ZIPs.
const version = require('../manifest.json').version;
const reviews = [
  [5, '2026-02-08', '音量について', '在宅勤務の机に置き、会議の音声を聞くために使用しています。人の声が明瞭で、小さい音量でも聞き取りやすいです。'],
  [4, '2026-03-17', '持ち運び', 'キャンプに持参しました。収納袋に収まり、荷物の中でも場所を取りません。ただし持ち手があるとさらに運びやすいと思います。'],
  [5, '2026-04-22', '接続の安定性', 'Androidスマートフォンと接続しています。最初の設定は説明書どおりに進めれば完了し、別の部屋に移動しても途切れませんでした。'],
  [4, '2026-06-09', '操作ボタン', '手袋をしたままでも音量ボタンを押せました。電源と再生ボタンの形が違うので、暗い場所でも触った感覚で区別できます。'],
  [5, '2026-07-14', '素材と掃除', '外装に指紋が目立たず、乾いた布で拭くだけで掃除できます。半年ほど使いましたが、表面の塗装もはがれていません。'],
  [3, '2026-08-21', '低音の響き', '集合住宅では低音が床に響くことがあり、下に防振マットを敷いて使っています。夜間は音量を控えめにする方がよさそうです。'],
  [5, '2026-09-04', '給電の使い方', '手持ちのUSB-C充電器から問題なく給電できました。端子の位置が背面にまとまっているため、机の配線を整理しやすかったです。'],
  [4, '2026-09-29', '動画の視聴', 'ノートPCにつなぎ、映画や配信を視聴しています。映像と音のずれは気になりませんが、通知音が少し大きく感じました。']
];

module.exports = function storePreview(conflicts = false) {
  const details = conflicts ? '最大10時間連続再生・電池容量3000mAh' : '最大12.0時間連続再生・電池容量5,000mAh';
  const reviewHtml = reviews.map(([stars, date, title, body], index) => `<article data-hook="review" data-review-id="SAMPLE-${index}">
    <a class="a-profile" href="/gp/profile/SAMPLE-${index}">サンプル投稿者${index + 1}</a>
    <span data-hook="review-star-rating">5つ星のうち${stars}.0</span>
    <strong data-hook="review-title">${title}</strong><p data-hook="review-body">${body}</p>
    <span data-hook="review-date">${date.replace(/(\d+)-(\d+)-(\d+)/, '$1年$2月$3日')}</span>
    <span data-hook="avp-badge">Amazonで購入</span>
  </article>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>レビュー注意度メーター v${version} · 表示例</title><link rel="stylesheet" href="/styles.css"><link rel="icon" href="data:,">
    <style>
      * { box-sizing:border-box } body { margin:0;color:#0f1111;background:#fff;font-family:Arial,'Yu Gothic',sans-serif }
      header { background:#f2f6fa;border-bottom:1px solid #d5d9d9;padding:28px 40px 24px }
      header p { margin:0 0 8px;color:#007185;font-size:13px;font-weight:bold }
      header h1 { margin:0;font-size:29px;line-height:1.4 }
      .demo-note { margin-top:10px;color:#565959;font-size:12px;font-weight:normal }
      main { max-width:1120px;margin:24px auto;display:grid;grid-template-columns:240px minmax(0,1fr);gap:36px;padding:0 16px }
      aside { color:#37475a;font-size:14px } aside h2 { margin:0 0 14px;font-size:17px }
      aside p { margin:0 0 18px;line-height:1.8 } aside a { display:block;color:#007185;margin-top:18px;font-size:13px }
      #productTitle { margin:0 0 8px;font-size:23px;line-height:1.5;font-weight:normal }
      #bylineInfo { color:#007185;font-size:13px;margin:6px 0 }
      #averageCustomerReviews { padding:6px 0;font-size:14px } #acrPopover { color:#b05c00;font-weight:bold;margin-right:16px }
      #feature-bullets { font-size:14px;line-height:1.6;padding:10px 0;border-top:1px solid #eaeded }
      #histogramTable { display:flex;gap:16px;font-size:12px;color:#565959;margin:4px 0 24px }
      .reviews-title { margin:18px 0 8px;font-size:17px } article { padding:12px 0;border-top:1px solid #eaeded;font-size:13px }
      article a { color:#565959;text-decoration:none;margin-right:14px } article strong { display:block;margin-top:7px }
      article p { margin:6px 0;line-height:1.7 } article span:last-child { margin-left:12px;color:#b05c00 }
      @media(max-width:650px) { header { padding:20px } header h1 { font-size:23px } main { display:block;margin-top:20px } aside { display:none } }
    </style></head><body>
    <header><p>Amazon レビュー注意度メーター</p><h1>商品ページで、購入前の確認材料をひと目で。</h1>
    <div class="demo-note">動作例（サンプルデータ） · v${version} · 実際の拡張コードで表示しています</div></header>
    <main><aside><h2>ブラウザ内で分析</h2><p>ページに表示されるレビューと商品記載を使い、注意度と確認材料を表示します。</p>
    <h2>理由を確かめる</h2><p>「詳細を見る」で主な判定根拠を開けます。注意度は不正レビューの確率ではありません。</p>
    <p>外部送信・保存・外部AI APIなし</p><a href="/store/dp/B012345678">記載が一致する例</a><a href="/store/dp/B012345678?conflicts">記載が異なる例</a></aside>
    <div id="centerCol"><div id="title_feature_div"><h2 id="productTitle">サンプル スピーカー 12時間連続再生 5000mAh</h2></div>
    <div id="bylineInfo">ブランド: サンプル</div><div id="averageCustomerReviews_feature_div"><div id="averageCustomerReviews">
    <span id="acrPopover" title="5つ星のうち4.5">4.5 ★★★★★</span><span id="acrCustomerReviewText">100個の評価</span></div></div>
    <div id="feature-bullets">${details}</div><div id="histogramTable">${[[5,70],[4,20],[3,5],[2,3],[1,2]].map(([star, percentage]) => `<a aria-label="星${star}つ ${percentage}%">★${star} ${percentage}%</a>`).join('')}</div>
    <h3 class="reviews-title">表示レビューの例</h3>${reviewHtml}</div></main>
    <script src="/scoring-base.js"></script><script src="/scoring-features.js"></script><script src="/scoring.js"></script><script src="/content.js"></script>
  </body></html>`;
};
