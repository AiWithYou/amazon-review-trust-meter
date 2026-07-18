(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  root.ReviewTrustScoring = api;
  api.start();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CARD_ID = 'review-trust-meter-card';
  const SAKURA_CHECKER_URL = 'https://sakura-checker.jp/search/';
  const PRODUCT_PATH = /\/(?:[^/]+\/dp|dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i;
  let renderTimer;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeSpaces(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function parseInteger(value) {
    const digits = String(value || '').replace(/[^0-9]/g, '');
    return digits ? Number.parseInt(digits, 10) : null;
  }

  function parseAverageRatingText(value) {
    const text = normalizeSpaces(value).replace(',', '.');
    const patterns = [
      /5つ星のうち\s*([0-5](?:\.[0-9])?)/,
      /5つのうち\s*([0-5](?:\.[0-9])?)/,
      /([0-5](?:\.[0-9])?)\s*out of 5/i,
      /^\s*([0-5](?:\.[0-9])?)\s*(?:\/\s*5)?\s*$/
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return Number.parseFloat(match[1]);
    }
    return null;
  }

  function parseHistogramLabel(value) {
    const text = normalizeSpaces(value);
    const japanese = text.match(/レビューの\s*(\d{1,3})%\s*に星\s*([1-5])つ/);
    if (japanese) {
      return { star: Number(japanese[2]), percentage: clamp(Number(japanese[1]), 0, 100) };
    }

    const english = text.match(/(\d{1,3})%.*?([1-5])\s*star/i);
    if (english) {
      return { star: Number(english[2]), percentage: clamp(Number(english[1]), 0, 100) };
    }
    return null;
  }

  function parseReviewStarText(value) {
    const text = normalizeSpaces(value).replace(',', '.');
    const japanese = text.match(/星5つ中\s*([1-5](?:\.[0-9])?)つ/);
    if (japanese) return Number.parseFloat(japanese[1]);
    return parseAverageRatingText(text);
  }

  function isCompleteDistribution(distribution) {
    return [1, 2, 3, 4, 5].every((star) => Number.isFinite(distribution?.[star]));
  }

  function getWeightedRating(distribution) {
    if (!isCompleteDistribution(distribution)) return null;
    return [1, 2, 3, 4, 5].reduce((sum, star) => sum + star * distribution[star], 0) / 100;
  }

  function findRepeatedTitleWord(title) {
    const ignored = new Set(['amazon', '対応', '可能', 'セット', 'タイプ', '付き', '種類', 'ワイヤレス']);
    const words = normalizeSpaces(title)
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9.+-]{2,}|[ぁ-んァ-ヶ一-龠々ー]{3,}/g) || [];
    const counts = new Map();

    for (const word of words) {
      if (ignored.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }

    let repeated = null;
    for (const [word, count] of counts) {
      if (count >= 2 && (!repeated || count > repeated.count)) repeated = { word, count };
    }
    return repeated;
  }

  function collectMatches(text, pattern, valueIndex = 1) {
    const values = new Set();
    for (const match of String(text || '').matchAll(pattern)) values.add(String(match[valueIndex]).toUpperCase());
    return [...values];
  }

  function collectClaimConflicts(title, details) {
    const definitions = [
      { label: '連続時間', pattern: /(\d+(?:\.\d+)?)\s*時間/gi },
      { label: '発光などの種類数', pattern: /(\d+)\s*種類/gi },
      { label: '防水・防塵等級', pattern: /\b(IP(?:X\d|\d{2}))\b/gi }
    ];
    const conflicts = [];

    for (const definition of definitions) {
      const inTitle = collectMatches(title, definition.pattern);
      const inDetails = collectMatches(details, definition.pattern);
      if (!inTitle.length || !inDetails.length) continue;
      if (inTitle.some((value) => inDetails.includes(value))) continue;
      conflicts.push({ label: definition.label, title: inTitle, details: inDetails });
    }
    return conflicts;
  }

  function findDateCluster(reviews, windowDays = 120) {
    const timestamps = reviews
      .map((review) => Date.parse(review.date))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    if (timestamps.length < 6) return null;

    let maxCount = 1;
    let right = 0;
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    for (let left = 0; left < timestamps.length; left += 1) {
      if (right < left) right = left;
      while (right + 1 < timestamps.length && timestamps[right + 1] - timestamps[left] <= windowMs) right += 1;
      maxCount = Math.max(maxCount, right - left + 1);
    }

    return { count: maxCount, total: timestamps.length, ratio: maxCount / timestamps.length, windowDays };
  }

  function normalizeReviewBody(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  function isGenericReviewBody(value) {
    const body = normalizeReviewBody(value);
    if (!body) return true;
    if (body.length <= 28) return true;
    return /^(とても)?(良い|いい|満足|おすすめ|使えます|問題ない|最高)(商品|です|でした|と思います)*$/.test(body);
  }

  function getShingles(value, size = 3) {
    const normalized = normalizeReviewBody(value);
    const shingles = new Set();
    for (let index = 0; index <= normalized.length - size; index += 1) {
      shingles.add(normalized.slice(index, index + size));
    }
    return shingles;
  }

  function getMaximumReviewSimilarity(reviews) {
    const bodies = reviews
      .map((review) => review.body)
      .filter((body) => normalizeReviewBody(body).length >= 45)
      .slice(0, 12);
    let maximum = 0;

    for (let left = 0; left < bodies.length; left += 1) {
      const leftSet = getShingles(bodies[left]);
      for (let right = left + 1; right < bodies.length; right += 1) {
        const rightSet = getShingles(bodies[right]);
        const intersection = [...leftSet].filter((item) => rightSet.has(item)).length;
        const union = new Set([...leftSet, ...rightSet]).size;
        if (union) maximum = Math.max(maximum, intersection / union);
      }
    }
    return maximum;
  }

  function addSignal(signals, id, group, points, text, evidence) {
    signals.push({ id, group, points, text, evidence: evidence || '' });
  }

  function analyzeProduct(input) {
    const averageRating = Number.isFinite(input.averageRating) ? input.averageRating : null;
    const reviewCount = Number.isFinite(input.reviewCount) ? input.reviewCount : null;
    const distribution = input.distribution || {};
    const title = normalizeSpaces(input.title);
    const brand = normalizeSpaces(input.brand);
    const details = normalizeSpaces(input.details);
    const reviews = Array.isArray(input.reviews) ? input.reviews : [];
    const signals = [];

    if (title.length > 110) {
      addSignal(signals, 'long_title', '商品情報', title.length > 170 ? 10 : 8, '商品名が長く、検索語を詰め込んだ可能性', `${title.length}文字`);
    }

    if (title && brand) {
      const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9ぁ-んァ-ヶ一-龠々ー]/g, '');
      const normalizedBrand = brand.toLowerCase().replace(/[^a-z0-9ぁ-んァ-ヶ一-龠々ー]/g, '');
      if (normalizedBrand && !normalizedTitle.includes(normalizedBrand)) {
        addSignal(signals, 'brand_missing', '商品情報', 14, 'ブランド名が商品名に見当たらない', brand);
      }
    }

    const repeated = findRepeatedTitleWord(title);
    if (repeated) {
      addSignal(signals, 'repeated_keyword', '商品情報', 6, '同じキーワードが商品名で繰り返されている', `「${repeated.word}」${repeated.count}回`);
    }

    const promotionalTerms = ['最高', '最強', '超', '驚き', '大音量', '重低音', '高音質', '先端', '究極', '圧倒的']
      .filter((term) => title.includes(term));
    if (promotionalTerms.length >= 4) {
      addSignal(signals, 'promotional_title', '商品情報', 7, '強い宣伝表現が商品名に集中', promotionalTerms.join('・'));
    }

    const claimConflicts = collectClaimConflicts(title, details);
    if (claimConflicts.length) {
      const evidence = claimConflicts
        .map((conflict) => `${conflict.label}: 商品名 ${conflict.title.join('/')} ↔ 説明 ${conflict.details.join('/')}`)
        .join('、');
      addSignal(signals, 'claim_conflicts', '商品情報', Math.min(18, claimConflicts.length * 7), '商品名と説明で仕様の数値が食い違う', evidence);
    }

    if (isCompleteDistribution(distribution)) {
      const five = distribution[5];
      const one = distribution[1];
      const positive = distribution[4] + five;
      if (five >= 85) {
        addSignal(signals, 'five_star_skew', '評価分布', 12, '★5へ強く偏っている', `★5 ${five}%`);
      }
      if (five >= 70 && one >= 12) {
        addSignal(signals, 'polarized_distribution', '評価分布', 14, '★5と★1へ二極化している', `★5 ${five}% / ★1 ${one}%`);
      }
      if (positive >= 95 && one <= 1) {
        addSignal(signals, 'near_perfect_distribution', '評価分布', 10, '高評価が極端に集中している', `★4〜5 ${positive}% / ★1 ${one}%`);
      }

      const weightedRating = getWeightedRating(distribution);
      if (Number.isFinite(averageRating) && Math.abs(weightedRating - averageRating) >= 0.35) {
        addSignal(signals, 'rating_mismatch', '評価分布', 10, '平均評価と星別分布の整合性が低い', `表示 ${averageRating.toFixed(1)} / 分布換算 ${weightedRating.toFixed(1)}`);
      }
    }

    const dateCluster = findDateCluster(reviews);
    if (dateCluster && dateCluster.ratio >= 0.5) {
      addSignal(
        signals,
        'review_date_cluster',
        '表示レビュー',
        dateCluster.ratio >= 0.7 ? 18 : 14,
        'レビュー投稿日が短期間に集中',
        `${dateCluster.windowDays}日以内に${dateCluster.count}/${dateCluster.total}件`
      );
    }

    const highRatedReviews = reviews.filter((review) => Number.isFinite(review.stars) && review.stars >= 4);
    const genericHighRated = highRatedReviews.filter((review) => isGenericReviewBody(review.body));
    if (highRatedReviews.length >= 4 && genericHighRated.length / highRatedReviews.length >= 0.35) {
      const percentage = Math.round((genericHighRated.length / highRatedReviews.length) * 100);
      addSignal(signals, 'generic_high_rating', '表示レビュー', 12, '高評価に短文・汎用的な本文が多い', `${genericHighRated.length}/${highRatedReviews.length}件（${percentage}%）`);
    }

    const verifiedKnown = reviews.filter((review) => typeof review.verified === 'boolean');
    if (verifiedKnown.length >= 6) {
      const verifiedCount = verifiedKnown.filter((review) => review.verified).length;
      const verifiedRatio = verifiedCount / verifiedKnown.length;
      if (verifiedRatio < 0.5) {
        addSignal(signals, 'low_verified_ratio', '表示レビュー', 10, '確認済み購入の割合が低い', `${verifiedCount}/${verifiedKnown.length}件`);
      }
    }

    const maximumSimilarity = getMaximumReviewSimilarity(reviews);
    if (maximumSimilarity >= 0.62) {
      addSignal(signals, 'similar_review_text', '表示レビュー', 14, 'よく似たレビュー本文がある', `類似度 ${Math.round(maximumSimilarity * 100)}%`);
    }

    const coverage = {
      rating: Number.isFinite(averageRating) && Number.isFinite(reviewCount),
      distribution: isCompleteDistribution(distribution),
      listing: Boolean(title && brand && details),
      reviews: reviews.length >= 6
    };
    const coverageCount = Object.values(coverage).filter(Boolean).length;
    const sufficient = coverageCount >= 3 && coverage.rating;
    const score = clamp(signals.reduce((sum, signal) => sum + signal.points, 0), 0, 100);
    const trustStars = sufficient ? Number(clamp(5 - score * 0.04, 1, 5).toFixed(1)) : null;

    let label = '判定材料不足';
    let tone = 'unknown';
    if (sufficient && score >= 65) {
      label = '要注意';
      tone = 'high';
    } else if (sufficient && score >= 40) {
      label = '注意';
      tone = 'medium';
    } else if (sufficient) {
      label = '強い兆候は少ない';
      tone = 'low';
    }

    return {
      score,
      trustStars,
      sufficient,
      label,
      tone,
      signals: signals.sort((left, right) => right.points - left.points),
      coverage,
      coverageCount,
      coverageTotal: Object.keys(coverage).length,
      weightedRating: getWeightedRating(distribution),
      sampleSize: reviews.length
    };
  }

  function getAsin() {
    const match = location.pathname.match(PRODUCT_PATH);
    return match ? match[1].toUpperCase() : null;
  }

  function getAverageRating() {
    const candidates = [
      document.querySelector('#acrPopover')?.getAttribute('title'),
      document.querySelector('#averageCustomerReviews #acrPopover')?.textContent,
      document.querySelector('#averageCustomerReviews .a-icon-alt')?.textContent,
      document.querySelector('[data-hook="rating-out-of-text"]')?.textContent
    ];
    for (const candidate of candidates) {
      const rating = parseAverageRatingText(candidate);
      if (Number.isFinite(rating)) return rating;
    }
    return null;
  }

  function getReviewCount() {
    const element = document.querySelector('#acrCustomerReviewText, [data-hook="total-review-count"]');
    return parseInteger(element?.getAttribute('aria-label') || element?.textContent);
  }

  function getHistogram() {
    const distribution = { 1: null, 2: null, 3: null, 4: null, 5: null };
    const rows = document.querySelectorAll('#histogramTable a[aria-label], [data-hook="review-star-filter"][aria-label], tr.a-histogram-row');

    for (const row of rows) {
      const parsed = parseHistogramLabel(row.getAttribute('aria-label'));
      if (parsed) {
        distribution[parsed.star] = parsed.percentage;
        continue;
      }

      const href = row.getAttribute('href') || row.querySelector('a')?.getAttribute('href') || '';
      const starNames = { five_star: 5, four_star: 4, three_star: 3, two_star: 2, one_star: 1 };
      const starName = href.match(/filterByStar=([a-z_]+)/i)?.[1];
      const percentage = Number(row.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'));
      if (starNames[starName] && Number.isFinite(percentage)) distribution[starNames[starName]] = clamp(percentage, 0, 100);
    }
    return distribution;
  }

  function getTitle() {
    return normalizeSpaces(document.querySelector('#productTitle')?.textContent);
  }

  function getBrand() {
    const byline = normalizeSpaces(document.querySelector('#bylineInfo')?.textContent);
    if (byline) {
      return byline
        .replace(/のストアを表示.*$/, '')
        .replace(/^ブランド[:：]\s*/, '')
        .trim();
    }

    for (const row of document.querySelectorAll('#productOverview_feature_div tr, #productDetails_techSpec_section_1 tr')) {
      const label = normalizeSpaces(row.querySelector('th, td:first-child')?.textContent);
      if (!/ブランド|Brand/i.test(label)) continue;
      return normalizeSpaces(row.querySelector('td:last-child')?.textContent);
    }
    return '';
  }

  function getListingDetails() {
    return [
      document.querySelector('#feature-bullets')?.textContent,
      document.querySelector('#productDescription')?.textContent,
      document.querySelector('#aplus')?.textContent
    ].filter(Boolean).map(normalizeSpaces).join(' ');
  }

  function parseReviewDate(value) {
    const text = normalizeSpaces(value);
    const japanese = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (japanese) {
      return `${japanese[1]}-${japanese[2].padStart(2, '0')}-${japanese[3].padStart(2, '0')}`;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
  }

  function getReviewSample() {
    return [...document.querySelectorAll('[data-hook="review"]')].slice(0, 12).map((review) => {
      const starText = review.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]')?.textContent;
      const verified = Boolean(review.querySelector('[data-hook="avp-badge"]'));
      return {
        stars: parseReviewStarText(starText),
        body: normalizeSpaces(review.querySelector('[data-hook="review-body"]')?.textContent),
        date: parseReviewDate(review.querySelector('[data-hook="review-date"]')?.textContent),
        verified,
        imageCount: review.querySelectorAll('[data-hook="review-image-tile"], .review-image-tile').length
      };
    });
  }

  function findInsertionPoint(doc = document) {
    const afterSelectors = ['#ask_feature_div', '#averageCustomerReviews_feature_div', '#title_feature_div'];
    for (const selector of afterSelectors) {
      const element = doc.querySelector(selector);
      if (element) return { element, position: 'afterend' };
    }

    const centerColumn = doc.querySelector('#centerCol');
    return centerColumn ? { element: centerColumn, position: 'afterbegin' } : null;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function createCard({ asin, averageRating, reviewCount, distribution, analysis }) {
    const card = document.createElement('section');
    card.id = CARD_ID;
    card.className = `review-trust-meter review-trust-meter--${analysis.tone}`;
    card.dataset.riskScore = String(analysis.score);
    card.dataset.analysisSufficient = String(analysis.sufficient);
    card.setAttribute('aria-label', 'レビュー信頼度メーター');

    const scoreHtml = analysis.sufficient
      ? `<span class="review-trust-meter__score"><span aria-hidden="true">★</span> ${analysis.trustStars.toFixed(1)}<span class="review-trust-meter__out-of"> / 5</span></span>`
      : '<span class="review-trust-meter__score review-trust-meter__score--unknown">判定不能</span>';
    const signalHtml = analysis.signals.length
      ? `<ul class="review-trust-meter__reasons">${analysis.signals.slice(0, 6).map((signal) => `
          <li>
            <span class="review-trust-meter__points">+${signal.points}</span>
            <span><strong>${escapeHtml(signal.text)}</strong>${signal.evidence ? `<small>${escapeHtml(signal.evidence)}</small>` : ''}</span>
          </li>`).join('')}</ul>`
      : '<p class="review-trust-meter__none">取得できた範囲では、設定した注意兆候を検出しませんでした。</p>';
    const histogramText = isCompleteDistribution(distribution)
      ? [5, 4, 3, 2, 1].map((star) => `★${star} ${distribution[star]}%`).join(' / ')
      : '星別分布は取得できませんでした';

    card.innerHTML = `
      <details class="review-trust-meter__panel">
        <summary class="review-trust-meter__summary">
          ${scoreHtml}
          <span class="review-trust-meter__label">${escapeHtml(analysis.label)}</span>
          <span class="review-trust-meter__risk">注意度 <strong>${analysis.score} / 100</strong></span>
          <span class="review-trust-meter__toggle">
            <span class="review-trust-meter__toggle-open">詳細を見る</span>
            <span class="review-trust-meter__toggle-close">閉じる</span>
          </span>
        </summary>
        <div class="review-trust-meter__details">
          <div class="review-trust-meter__details-heading">
            <p class="review-trust-meter__eyebrow">レビュー信頼度（独自分析）</p>
            <p class="review-trust-meter__coverage">星が低いほど注意・取得項目 ${analysis.coverageCount}/${analysis.coverageTotal}</p>
          </div>
          <div class="review-trust-meter__bar" aria-label="独自注意度 ${analysis.score}%"><span style="width:${analysis.score}%"></span></div>
          <dl class="review-trust-meter__facts">
            <div><dt>Amazon平均</dt><dd>${Number.isFinite(averageRating) ? `★ ${averageRating.toFixed(1)}` : '取得不可'}</dd></div>
            <div><dt>レビュー数</dt><dd>${Number.isFinite(reviewCount) ? `${reviewCount.toLocaleString('ja-JP')}件` : '取得不可'}</dd></div>
            <div><dt>本文分析</dt><dd>${analysis.sampleSize}件</dd></div>
          </dl>
          <p class="review-trust-meter__histogram">${escapeHtml(histogramText)}</p>
          <p class="review-trust-meter__section-title">判定根拠</p>
          ${signalHtml}
          <div class="review-trust-meter__method">
            <p class="review-trust-meter__method-title">この点数の見方</p>
            <p>商品名・記載値の整合性、星分布、表示中レビューの日付・本文・確認済み購入をローカル分析しています。ブランド履歴、ショップ履歴、削除済みレビュー、カテゴリ平均との差は含みません。</p>
          </div>
          <p class="review-trust-meter__note">本家サクラチェッカーの点数ではなく、購入前に詳しく確認する必要度の目安です。</p>
          <a class="review-trust-meter__link" href="${SAKURA_CHECKER_URL}${escapeHtml(asin)}/" target="_blank" rel="noopener noreferrer">本家サクラチェッカーで確認 ↗</a>
        </div>
      </details>
    `;
    return card;
  }

  function render() {
    const asin = getAsin();
    const currentCard = document.getElementById(CARD_ID);
    if (!asin) {
      currentCard?.remove();
      return;
    }

    const insertionPoint = findInsertionPoint();
    if (!insertionPoint) {
      currentCard?.remove();
      return;
    }
    const averageRating = getAverageRating();
    const reviewCount = getReviewCount();
    const distribution = getHistogram();
    const analysis = analyzeProduct({
      averageRating,
      reviewCount,
      distribution,
      title: getTitle(),
      brand: getBrand(),
      details: getListingDetails(),
      reviews: getReviewSample()
    });
    const nextCard = createCard({ asin, averageRating, reviewCount, distribution, analysis });
    currentCard?.remove();
    insertionPoint.element.insertAdjacentElement(insertionPoint.position, nextCard);
  }

  function scheduleRender() {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(render, 500);
  }

  function start() {
    scheduleRender();
    new MutationObserver((mutations) => {
      const changedByPage = mutations.some((mutation) =>
        [...mutation.addedNodes].some((node) =>
          node.nodeType === Node.ELEMENT_NODE &&
          node.id !== CARD_ID &&
          !node.querySelector?.(`#${CARD_ID}`)
        )
      );
      if (changedByPage) scheduleRender();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  return {
    analyzeProduct,
    collectClaimConflicts,
    findInsertionPoint,
    findDateCluster,
    isGenericReviewBody,
    parseAverageRatingText,
    parseHistogramLabel,
    parseReviewStarText,
    start
  };
});
