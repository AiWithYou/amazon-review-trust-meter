(function (root, factory) {
  'use strict';

  const scoring = typeof module === 'object' && module.exports
    ? require('./scoring.js')
    : root.ReviewTrustScoring;
  const api = factory(scoring);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  root.ReviewTrustExtension = api;
  api.start();
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scoring) {
  'use strict';

  const CARD_ID = 'review-trust-meter-card';
  const SAKURA_CHECKER_URL = 'https://sakura-checker.jp/search/';
  const PRODUCT_PATH = /\/(?:[^/]+\/dp|dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i;
  let renderTimer;
  let lastFingerprint = '';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeSpaces(value) {
    return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  function parseInteger(value) {
    const normalized = String(value || '').normalize('NFKC');
    const digits = normalized.replace(/[^0-9]/g, '');
    return digits ? Number.parseInt(digits, 10) : null;
  }

  function parseAverageRatingText(value) {
    const text = normalizeSpaces(value).replace(',', '.');
    const patterns = [
      /5つ星のうち\s*([0-5](?:\.[0-9])?)/,
      /5つのうち\s*([0-5](?:\.[0-9])?)/,
      /星5つ中\s*([0-5](?:\.[0-9])?)つ/,
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
    const japanesePatterns = [
      /レビューの\s*(\d{1,3})%\s*に星\s*([1-5])つ/,
      /星\s*([1-5])つ[^0-9]*(\d{1,3})%/,
      /([1-5])つ星[^0-9]*(\d{1,3})%/
    ];

    for (let index = 0; index < japanesePatterns.length; index += 1) {
      const match = text.match(japanesePatterns[index]);
      if (!match) continue;
      if (index === 0) return { star: Number(match[2]), percentage: clamp(Number(match[1]), 0, 100) };
      return { star: Number(match[1]), percentage: clamp(Number(match[2]), 0, 100) };
    }

    const english = text.match(/(?:([1-5])\s*star[^0-9]*(\d{1,3})%|(\d{1,3})%.*?([1-5])\s*star)/i);
    if (english) {
      const star = Number(english[1] || english[4]);
      const percentage = Number(english[2] || english[3]);
      return { star, percentage: clamp(percentage, 0, 100) };
    }
    return null;
  }

  function parseReviewStarText(value) {
    return parseAverageRatingText(value);
  }

  function parseReviewDate(value) {
    const text = normalizeSpaces(value);
    const japanese = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (japanese) {
      return `${japanese[1]}-${japanese[2].padStart(2, '0')}-${japanese[3].padStart(2, '0')}`;
    }

    const englishText = text
      .replace(/^.*?reviewed in .*? on\s+/i, '')
      .replace(/^.*?on\s+/i, '');
    const parsed = Date.parse(englishText);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
  }

  function parseHelpfulVotes(value) {
    const text = normalizeSpaces(value);
    if (!text) return null;
    if (/一人|1人|one person/i.test(text)) return 1;
    return parseInteger(text);
  }

  function getAsin(locationObject = location) {
    const match = locationObject.pathname.match(PRODUCT_PATH);
    return match ? match[1].toUpperCase() : null;
  }

  function getAverageRating(doc = document) {
    const candidates = [
      doc.querySelector('#acrPopover')?.getAttribute('title'),
      doc.querySelector('#averageCustomerReviews #acrPopover')?.textContent,
      doc.querySelector('#averageCustomerReviews .a-icon-alt')?.textContent,
      doc.querySelector('[data-hook="rating-out-of-text"]')?.textContent,
      doc.querySelector('[data-csa-c-type="widget"] [aria-label*="5つ星のうち"]')?.getAttribute('aria-label')
    ];
    for (const candidate of candidates) {
      const rating = parseAverageRatingText(candidate);
      if (Number.isFinite(rating)) return rating;
    }
    return null;
  }

  function getReviewCount(doc = document) {
    const candidates = [
      doc.querySelector('#acrCustomerReviewText'),
      doc.querySelector('[data-hook="total-review-count"]'),
      doc.querySelector('#averageCustomerReviews [href*="#customerReviews"]')
    ];
    for (const element of candidates) {
      const count = parseInteger(element?.getAttribute('aria-label') || element?.textContent);
      if (Number.isFinite(count)) return count;
    }
    return null;
  }

  function getHistogram(doc = document) {
    const distribution = { 1: null, 2: null, 3: null, 4: null, 5: null };
    const rows = doc.querySelectorAll('#histogramTable tr, #histogramTable a[aria-label], [data-hook="review-star-filter"]');

    for (const row of rows) {
      const labels = [
        row.getAttribute?.('aria-label'),
        row.querySelector?.('[aria-label]')?.getAttribute('aria-label'),
        row.textContent
      ];
      let parsed = null;
      for (const label of labels) {
        parsed = parseHistogramLabel(label);
        if (parsed) break;
      }
      if (parsed) {
        distribution[parsed.star] = parsed.percentage;
        continue;
      }

      const href = row.getAttribute?.('href') || row.querySelector?.('a')?.getAttribute('href') || '';
      const starNames = { five_star: 5, four_star: 4, three_star: 3, two_star: 2, one_star: 1 };
      const starName = href.match(/filterByStar=([a-z_]+)/i)?.[1];
      const progress = row.querySelector?.('[role="progressbar"]');
      const percentage = Number(progress?.getAttribute('aria-valuenow'));
      if (starNames[starName] && Number.isFinite(percentage)) {
        distribution[starNames[starName]] = clamp(percentage, 0, 100);
      }
    }
    return distribution;
  }

  function getTitle(doc = document) {
    return normalizeSpaces(doc.querySelector('#productTitle')?.textContent);
  }

  function getBrand(doc = document) {
    const byline = normalizeSpaces(doc.querySelector('#bylineInfo')?.textContent);
    if (byline) {
      return byline
        .replace(/のストアを表示.*$/, '')
        .replace(/^ブランド[:：]\s*/, '')
        .replace(/^Visit the\s+/i, '')
        .replace(/\s+Store$/i, '')
        .trim();
    }

    for (const row of doc.querySelectorAll('#productOverview_feature_div tr, #productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr')) {
      const label = normalizeSpaces(row.querySelector('th, td:first-child')?.textContent);
      if (!/ブランド|Brand/i.test(label)) continue;
      return normalizeSpaces(row.querySelector('td:last-child')?.textContent);
    }
    return '';
  }

  function getListingDetails(doc = document) {
    return [
      doc.querySelector('#feature-bullets')?.textContent,
      doc.querySelector('#productOverview_feature_div')?.textContent,
      doc.querySelector('#productDescription')?.textContent,
      doc.querySelector('#aplus')?.textContent,
      doc.querySelector('#productDetails_techSpec_section_1')?.textContent
    ].filter(Boolean).map(normalizeSpaces).join(' ');
  }

  function getReviewTitle(reviewElement) {
    const titleElement = reviewElement.querySelector('[data-hook="review-title"]');
    if (!titleElement) return '';
    const clone = titleElement.cloneNode(true);
    clone.querySelectorAll('.a-icon-alt, [data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]').forEach((element) => element.remove());
    return normalizeSpaces(clone.textContent);
  }

  function getReviewerId(reviewElement) {
    const profileLink = reviewElement.querySelector('[data-hook="review-author"] a, .a-profile');
    const href = profileLink?.getAttribute('href') || '';
    return href.match(/\/gp\/profile\/([^/?]+)/i)?.[1] || '';
  }

  function getReviewSample(doc = document) {
    return [...doc.querySelectorAll('[data-hook="review"]')].slice(0, 20).map((reviewElement) => {
      const starText = reviewElement.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"], .review-rating')?.textContent;
      const fullText = normalizeSpaces(reviewElement.textContent);
      const verifiedBadge = reviewElement.querySelector('[data-hook="avp-badge"]');
      const vineBadge = reviewElement.querySelector('[data-hook="vine-review-badge"], .vine-review-badge');
      const vine = Boolean(vineBadge) || /Vine(?:先取りプログラム|カスタマーレビュー| Customer Review)/i.test(fullText);
      const helpfulElement = reviewElement.querySelector('[data-hook="helpful-vote-statement"]');
      return {
        id: reviewElement.id || reviewElement.getAttribute('data-review-id') || '',
        reviewerId: getReviewerId(reviewElement),
        stars: parseReviewStarText(starText),
        title: getReviewTitle(reviewElement),
        body: normalizeSpaces(reviewElement.querySelector('[data-hook="review-body"]')?.textContent),
        date: parseReviewDate(reviewElement.querySelector('[data-hook="review-date"]')?.textContent),
        verified: vine ? false : Boolean(verifiedBadge),
        vine,
        variation: normalizeSpaces(reviewElement.querySelector('[data-hook="format-strip"]')?.textContent),
        helpfulVotes: parseHelpfulVotes(helpfulElement?.textContent),
        imageCount: reviewElement.querySelectorAll('[data-hook="review-image-tile"], .review-image-tile').length
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

  function formatSigned(value, digits = 1) {
    if (!Number.isFinite(value)) return '';
    const rounded = value.toFixed(digits);
    return value > 0 ? `+${rounded}` : rounded;
  }

  function createSignalHtml(analysis) {
    if (!analysis.signals.length) {
      return '<p class="review-trust-meter__none">取得できた範囲では、設定した複合兆候を検出しませんでした。</p>';
    }
    return `<ul class="review-trust-meter__reasons">${analysis.signals.slice(0, 8).map((signal) => `
      <li>
        <span class="review-trust-meter__points">+${signal.points}</span>
        <span>
          <strong>${escapeHtml(signal.text)}</strong>
          <small>${escapeHtml(signal.group)}${signal.evidence ? ` · ${escapeHtml(signal.evidence)}` : ''}</small>
        </span>
      </li>`).join('')}</ul>`;
  }

  function createObservationHtml(analysis) {
    if (!analysis.observations?.length) return '';
    return `
      <p class="review-trust-meter__section-title">補足</p>
      <ul class="review-trust-meter__observations">${analysis.observations.slice(0, 5).map((item) => `
        <li><strong>${escapeHtml(item.text)}</strong>${item.evidence ? `<small>${escapeHtml(item.evidence)}</small>` : ''}</li>`).join('')}</ul>`;
  }

  function createCard({ asin, averageRating, reviewCount, distribution, analysis }) {
    const card = document.createElement('section');
    card.id = CARD_ID;
    card.className = `review-trust-meter review-trust-meter--${analysis.tone}`;
    card.dataset.riskScore = String(analysis.score);
    card.dataset.analysisSufficient = String(analysis.sufficient);
    card.setAttribute('aria-label', 'Amazonレビュー注意度メーター');

    const scoreHtml = analysis.sufficient
      ? `<span class="review-trust-meter__score"><span class="review-trust-meter__score-label">注意度</span><strong>${analysis.score}</strong><span class="review-trust-meter__out-of"> / 100</span></span>`
      : '<span class="review-trust-meter__score review-trust-meter__score--unknown">判定不能</span>';
    const adjustedText = Number.isFinite(analysis.adjustedRating)
      ? `★ ${analysis.adjustedRating.toFixed(1)}${Math.abs(analysis.adjustmentDelta || 0) >= 0.05 ? `<small>${formatSigned(analysis.adjustmentDelta, 1)}</small>` : ''}`
      : '算出不可';
    const histogramInfo = scoring.distributionInfo(distribution);
    const histogramText = histogramInfo.usable
      ? [5, 4, 3, 2, 1].map((star) => `★${star} ${distribution[star]}%`).join(' / ')
      : '星別分布は取得できませんでした';

    card.innerHTML = `
      <details class="review-trust-meter__panel">
        <summary class="review-trust-meter__summary">
          ${scoreHtml}
          <span class="review-trust-meter__label">${escapeHtml(analysis.label)}</span>
          <span class="review-trust-meter__confidence">判定確度 <strong>${analysis.confidence}%</strong></span>
          <span class="review-trust-meter__toggle">
            <span class="review-trust-meter__toggle-open">詳細を見る</span>
            <span class="review-trust-meter__toggle-close">閉じる</span>
          </span>
        </summary>
        <div class="review-trust-meter__details">
          <div class="review-trust-meter__details-heading">
            <p class="review-trust-meter__eyebrow">レビュー信頼度・複合分析 v2</p>
            <p class="review-trust-meter__coverage">取得項目 ${analysis.coverageCount}/${analysis.coverageTotal} · 表示レビューのみ</p>
          </div>
          <div class="review-trust-meter__bar" aria-label="独自注意度 ${analysis.score}%"><span style="width:${analysis.score}%"></span></div>
          <dl class="review-trust-meter__facts">
            <div><dt>Amazon平均</dt><dd>${Number.isFinite(averageRating) ? `★ ${averageRating.toFixed(1)}` : '取得不可'}</dd></div>
            <div><dt>補正評価（参考）</dt><dd>${adjustedText}</dd></div>
            <div><dt>判定確度</dt><dd>${analysis.confidence}%（${escapeHtml(analysis.confidenceLabel)}）</dd></div>
            <div><dt>評価・レビュー数</dt><dd>${Number.isFinite(reviewCount) ? `${reviewCount.toLocaleString('ja-JP')}件` : '取得不可'}</dd></div>
            <div><dt>本文分析</dt><dd>${analysis.sampleSize}件</dd></div>
          </dl>
          <p class="review-trust-meter__histogram">${escapeHtml(histogramText)}</p>
          <p class="review-trust-meter__section-title">主な判定根拠</p>
          ${createSignalHtml(analysis)}
          ${createObservationHtml(analysis)}
          <div class="review-trust-meter__method">
            <p class="review-trust-meter__method-title">判定方法</p>
            <p>星分布、本文の重複群、短文率、投稿日バースト、評価方向、購入確認、Vine、商品記載の整合性を別々に評価し、独立した兆候が重なった場合だけ強く加点します。投稿日集中や無名ブランドだけでは要注意判定にしません。</p>
            <p>補正評価は、表示中レビューの疑わしさで星別分布を小さく再重み付けした参考値です。全レビューを取得していないため、Amazon平均より優先する値ではありません。</p>
          </div>
          <p class="review-trust-meter__note">注意度は「不正レビューである確率」ではありません。Amazon内部の購入・返金・アカウント情報、削除済みレビュー、全投稿履歴は取得していません。</p>
          <a class="review-trust-meter__link" href="${SAKURA_CHECKER_URL}${escapeHtml(asin)}/" target="_blank" rel="noopener noreferrer">本家サクラチェッカーで確認 ↗</a>
        </div>
      </details>
    `;
    return card;
  }

  function collectPageData(doc = document) {
    return {
      averageRating: getAverageRating(doc),
      reviewCount: getReviewCount(doc),
      distribution: getHistogram(doc),
      title: getTitle(doc),
      brand: getBrand(doc),
      details: getListingDetails(doc),
      reviews: getReviewSample(doc)
    };
  }

  function createFingerprint(asin, data) {
    return JSON.stringify({
      asin,
      averageRating: data.averageRating,
      reviewCount: data.reviewCount,
      distribution: data.distribution,
      title: data.title,
      brand: data.brand,
      detailsLength: data.details.length,
      reviews: data.reviews.map((review) => [review.id, review.stars, review.date, review.verified, review.vine, review.variation, review.body])
    });
  }

  function render() {
    if (!scoring) return;
    const asin = getAsin();
    const currentCard = document.getElementById(CARD_ID);
    if (!asin) {
      currentCard?.remove();
      lastFingerprint = '';
      return;
    }

    const insertionPoint = findInsertionPoint();
    if (!insertionPoint) {
      currentCard?.remove();
      return;
    }

    const pageData = collectPageData();
    const fingerprint = createFingerprint(asin, pageData);
    if (fingerprint === lastFingerprint && currentCard) return;

    const analysis = scoring.analyzeProduct(pageData);
    const nextCard = createCard({
      asin,
      averageRating: pageData.averageRating,
      reviewCount: pageData.reviewCount,
      distribution: pageData.distribution,
      analysis
    });
    const wasOpen = Boolean(currentCard?.querySelector('details')?.open);
    if (wasOpen) nextCard.querySelector('details').open = true;
    currentCard?.remove();
    insertionPoint.element.insertAdjacentElement(insertionPoint.position, nextCard);
    lastFingerprint = fingerprint;
  }

  function scheduleRender() {
    window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(render, 650);
  }

  function start() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    scheduleRender();
    new MutationObserver((mutations) => {
      const changedByPage = mutations.some((mutation) => {
        if (mutation.target?.closest?.(`#${CARD_ID}`)) return false;
        return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return false;
          if (node.id === CARD_ID || node.closest?.(`#${CARD_ID}`) || node.querySelector?.(`#${CARD_ID}`)) return false;
          return true;
        });
      });
      if (changedByPage) scheduleRender();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  return {
    collectPageData,
    createFingerprint,
    findInsertionPoint,
    getAsin,
    parseAverageRatingText,
    parseHistogramLabel,
    parseHelpfulVotes,
    parseReviewDate,
    parseReviewStarText,
    start
  };
});
