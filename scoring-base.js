(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.ReviewTrustBase = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const STARS = [1, 2, 3, 4, 5];
  const GROUP_CAPS = Object.freeze({
    listing: 65,
    distribution: 16,
    text: 28,
    temporal: 14,
    provenance: 10,
    coordination: 22,
    applicability: 6
  });

  const GROUP_LABELS = Object.freeze({
    listing: '商品情報',
    distribution: '評価分布',
    text: 'レビュー本文',
    temporal: '投稿時系列',
    provenance: '投稿属性',
    coordination: '複合兆候',
    applicability: 'レビュー適用範囲'
  });

  const TITLE_IGNORED_WORDS = new Set([
    'amazon', '対応', '可能', 'セット', 'タイプ', '付き', '種類', 'ワイヤレス',
    'モデル', '商品', '専用', '用', '日本', '正規', '最新版', '新型'
  ]);

  const GENERIC_EXACT_PATTERNS = [
    /^(とても)?(良い|いい|よい|最高|満足|おすすめ|オススメ|問題ない|普通|期待通り|使いやすい|気に入りました|買ってよかった)(商品)?(です|でした|と思います|です。|でした。|！|!)*$/,
    /^(good|great|excellent|perfect|nice|love it|works well|as expected)( product| item)?[.!]*$/i
  ];

  const SPECIFIC_MARKER_PATTERN = /(?:\d|cm|mm|km|kg|mg|mah|wh|hz|db|時間|分|秒|日|週間|週|か月|ヶ月|月間|年間|回|台|個|枚|本|サイズ|重量|重さ|容量|温度|速度|接続|充電|電池|バッテリー|音質|画質|耐久|素材|色|設定|取付|取り付け|交換|返品|故障|不良|破損|遅延|発熱|防水|防塵|使用|装着|保存|洗濯|配送後|届いて|購入して)/i;
  const CONTRAST_PATTERN = /(?:ただ|しかし|一方|けれど|けど|ものの|残念|惜しい|改善|欠点|難点|良いが|いいが|反面|except|however|but|although)/i;
  const PROMOTIONAL_REVIEW_PATTERN = /(?:絶対(?:に)?おすすめ|買って損なし|コスパ最強|コスパ最高|神商品|必需品|万人におすすめ|迷っているなら|今すぐ買う|五つ星に値する|highly recommend|must buy|best ever)/i;
  const NEGATIVE_PATTERN = /(?:壊れ|故障|不良|返品|返金|使えない|動かない|最悪|粗悪|危険|発火|破損|偽物|遅い|臭い|痛い|失敗|残念|bad|broken|defective|refund|terrible|worst)/i;
  const POSITIVE_PATTERN = /(?:満足|最高|良い|いい|快適|便利|おすすめ|気に入|使いやす|高品質|完璧|excellent|great|perfect|love|recommend)/i;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function safeDivide(numerator, denominator, fallback = 0) {
    return denominator ? numerator / denominator : fallback;
  }

  function normalizeSpaces(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeReviewBody(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
      .replace(/\b(?:注文|order)?\s*[#:]?\s*[0-9-]{8,}\b/gi, ' ')
      .replace(/\d+(?:[.,]\d+)?/g, '#')
      .replace(/[\s\p{P}\p{S}]+/gu, '')
      .trim();
  }

  function charLength(value) {
    return Array.from(String(value || '')).length;
  }

  function roundTo(value, digits = 1) {
    const multiplier = 10 ** digits;
    return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
  }

  function distributionInfo(distribution) {
    const values = {};
    for (const star of STARS) {
      const value = Number(distribution?.[star]);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return { valid: false, usable: false, sum: null, values: null, normalized: null };
      }
      values[star] = value;
    }

    const sum = STARS.reduce((total, star) => total + values[star], 0);
    const usable = sum >= 90 && sum <= 110;
    const valid = sum >= 97 && sum <= 103;
    if (!usable || sum <= 0) return { valid: false, usable: false, sum, values, normalized: null };

    const normalized = {};
    for (const star of STARS) normalized[star] = values[star] / sum;
    return { valid, usable, sum, values, normalized };
  }

  function isCompleteDistribution(distribution) {
    return distributionInfo(distribution).usable;
  }

  function getWeightedRating(distribution) {
    const info = distributionInfo(distribution);
    if (!info.usable) return null;
    return STARS.reduce((sum, star) => sum + star * info.normalized[star], 0);
  }

  function getDistributionEntropy(normalized) {
    if (!normalized) return null;
    const entropy = STARS.reduce((sum, star) => {
      const probability = normalized[star];
      return probability > 0 ? sum - probability * Math.log(probability) : sum;
    }, 0);
    return entropy / Math.log(STARS.length);
  }

  function getCountReliability(reviewCount) {
    if (!Number.isFinite(reviewCount) || reviewCount <= 0) return 0.35;
    return clamp(0.35 + 0.65 * (Math.log10(reviewCount + 1) / 3), 0.35, 1);
  }

  function findRepeatedTitleWord(title) {
    const words = normalizeSpaces(title)
      .normalize('NFKC')
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9.+-]{2,}|[ぁ-んァ-ヶ一-龠々ー]{3,}/g) || [];
    const counts = new Map();

    for (const word of words) {
      if (TITLE_IGNORED_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }

    let repeated = null;
    for (const [word, count] of counts) {
      if (count >= 2 && (!repeated || count > repeated.count || (count === repeated.count && word.length > repeated.word.length))) {
        repeated = { word, count };
      }
    }
    return repeated;
  }

  function collectMatches(text, pattern, valueIndex = 1) {
    const values = new Set();
    for (const match of String(text || '').matchAll(pattern)) {
      values.add(String(match[valueIndex]).normalize('NFKC').replace(/,/g, '').toUpperCase());
    }
    return [...values];
  }

  function collectClaimConflicts(title, details) {
    const definitions = [
      { label: '連続時間', weight: 18, pattern: /(\d+(?:\.\d+)?)\s*時間/gi },
      { label: '防水・防塵等級', weight: 28, pattern: /\b(IP(?:X\d|\d{2}))\b/gi },
      { label: '電池容量', weight: 18, pattern: /(\d{3,6}(?:,\d{3})?)\s*mAh/gi },
      { label: '発光パターン数', weight: 12, pattern: /(\d+)\s*種類(?:の)?(?:発光|ライト|点灯)(?:パターン|モード|色)?/gi }
    ];
    const conflicts = [];

    for (const definition of definitions) {
      const inTitle = collectMatches(title, definition.pattern);
      const inDetails = collectMatches(details, definition.pattern);
      if (!inTitle.length || !inDetails.length) continue;
      if (inTitle.some((value) => inDetails.includes(value))) continue;
      conflicts.push({ label: definition.label, weight: definition.weight, title: inTitle, details: inDetails });
    }
    return conflicts;
  }

  function getBrandAliases(brand) {
    return normalizeSpaces(brand)
      .normalize('NFKC')
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9.+-]{1,}|[ぁ-んァ-ヶ一-龠々ー]{2,}/g) || [];
  }

  function brandMatchesTitle(brand, title) {
    const normalizedTitle = normalizeSpaces(title)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9ぁ-んァ-ヶ一-龠々ー]/g, '');
    return getBrandAliases(brand).some((alias) => {
      const normalizedAlias = alias.replace(/[^a-z0-9ぁ-んァ-ヶ一-龠々ー]/g, '');
      return normalizedAlias.length >= 2 && normalizedTitle.includes(normalizedAlias);
    });
  }

  function getGenericness(value) {
    const original = normalizeSpaces(value).normalize('NFKC');
    const body = normalizeReviewBody(original);
    const length = charLength(body);
    if (!length) return 1;

    let score = 0;
    if (length <= 8) score = 1;
    else if (length <= 16) score = 0.86;
    else if (length <= 28) score = 0.68;
    else if (length <= 45) score = 0.42;
    else if (length <= 70) score = 0.22;
    else score = 0.08;

    if (GENERIC_EXACT_PATTERNS.some((pattern) => pattern.test(original.trim()))) score = Math.max(score, 0.96);
    if (SPECIFIC_MARKER_PATTERN.test(original)) score -= 0.23;
    if (CONTRAST_PATTERN.test(original)) score -= 0.17;
    if (/[。.!！?？].+[。.!！?？]/u.test(original)) score -= 0.08;

    const uniqueCharacters = new Set(Array.from(body)).size;
    const diversity = safeDivide(uniqueCharacters, Math.min(length, 40), 0);
    if (length >= 30 && diversity >= 0.55) score -= 0.08;

    return clamp(score, 0, 1);
  }

  function isGenericReviewBody(value) {
    return getGenericness(value) >= 0.68;
  }

  function getShingles(value, size = 3) {
    const normalized = normalizeReviewBody(value);
    const characters = Array.from(normalized);
    const shingles = new Set();
    if (characters.length < size) {
      if (normalized) shingles.add(normalized);
      return shingles;
    }
    for (let index = 0; index <= characters.length - size; index += 1) {
      shingles.add(characters.slice(index, index + size).join(''));
    }
    return shingles;
  }

  function getReviewTextSimilarity(leftValue, rightValue) {
    const left = normalizeReviewBody(leftValue);
    const right = normalizeReviewBody(rightValue);
    const leftLength = charLength(left);
    const rightLength = charLength(right);
    const minimumLength = Math.min(leftLength, rightLength);
    const maximumLength = Math.max(leftLength, rightLength);
    if (minimumLength < 18 || maximumLength === 0) return 0;
    if (left === right) return 1;

    const containmentByText = left.includes(right) || right.includes(left)
      ? minimumLength / maximumLength
      : 0;
    const shingleSize = minimumLength < 42 ? 2 : 3;
    const leftSet = getShingles(left, shingleSize);
    const rightSet = getShingles(right, shingleSize);
    let intersection = 0;
    for (const item of leftSet) if (rightSet.has(item)) intersection += 1;
    const union = leftSet.size + rightSet.size - intersection;
    const jaccard = safeDivide(intersection, union, 0);
    const containment = safeDivide(intersection, Math.min(leftSet.size, rightSet.size), 0);
    const lengthRatio = minimumLength / maximumLength;
    const similarity = (0.58 * jaccard + 0.42 * containment) * Math.sqrt(lengthRatio);
    return clamp(Math.max(similarity, containmentByText * 0.92), 0, 1);
  }

  class UnionFind {
    constructor(size) {
      this.parent = Array.from({ length: size }, (_, index) => index);
      this.rank = Array(size).fill(0);
    }

    find(index) {
      if (this.parent[index] !== index) this.parent[index] = this.find(this.parent[index]);
      return this.parent[index];
    }

    union(left, right) {
      let leftRoot = this.find(left);
      let rightRoot = this.find(right);
      if (leftRoot === rightRoot) return;
      if (this.rank[leftRoot] < this.rank[rightRoot]) [leftRoot, rightRoot] = [rightRoot, leftRoot];
      this.parent[rightRoot] = leftRoot;
      if (this.rank[leftRoot] === this.rank[rightRoot]) this.rank[leftRoot] += 1;
    }
  }

  function getSimilarityThreshold(minimumLength) {
    // 単語分割に依存しない日本語の文字n-gram比較。単独一致ではなく、
    // 後段のクラスタ密度・時系列・評価方向との重なりで誤検知を抑える。
    if (minimumLength < 30) return 0.62;
    if (minimumLength < 60) return 0.39;
    if (minimumLength < 120) return 0.4;
    return 0.38;
  }

  function findTextClusters(reviews) {
    const eligible = reviews
      .map((review, index) => ({ index, body: review.body || '', length: charLength(normalizeReviewBody(review.body)) }))
      .filter((item) => item.length >= 18);
    const unionFind = new UnionFind(reviews.length);
    const matchingPairs = [];

    for (let left = 0; left < eligible.length; left += 1) {
      for (let right = left + 1; right < eligible.length; right += 1) {
        const leftItem = eligible[left];
        const rightItem = eligible[right];
        const similarity = getReviewTextSimilarity(leftItem.body, rightItem.body);
        const threshold = getSimilarityThreshold(Math.min(leftItem.length, rightItem.length));
        if (similarity >= threshold) {
          unionFind.union(leftItem.index, rightItem.index);
          matchingPairs.push({ left: leftItem.index, right: rightItem.index, similarity });
        }
      }
    }

    const groups = new Map();
    for (const item of eligible) {
      const root = unionFind.find(item.index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(item.index);
    }

    const clusters = [...groups.values()]
      .filter((indices) => indices.length >= 2)
      .map((indices) => {
        const indexSet = new Set(indices);
        const similarities = matchingPairs
          .filter((pair) => indexSet.has(pair.left) && indexSet.has(pair.right))
          .map((pair) => pair.similarity);
        const possiblePairs = indices.length * (indices.length - 1) / 2;
        return {
          indices,
          size: indices.length,
          averageSimilarity: safeDivide(similarities.reduce((sum, value) => sum + value, 0), similarities.length, 0),
          maximumSimilarity: similarities.length ? Math.max(...similarities) : 0,
          edgeDensity: safeDivide(similarities.length, possiblePairs, 0)
        };
      })
      .sort((left, right) => right.size - left.size || right.averageSimilarity - left.averageSimilarity);

    const membership = Array(reviews.length).fill(null);
    clusters.forEach((cluster, clusterIndex) => {
      for (const reviewIndex of cluster.indices) membership[reviewIndex] = clusterIndex;
    });

    const largest = clusters[0] || null;
    const eligibleCount = eligible.length;
    let strength = 0;
    if (largest) {
      const ratio = largest.size / Math.max(eligibleCount, 1);
      if (largest.size >= 3) {
        strength = clamp(
          0.25 +
          (largest.size - 3) * 0.1 +
          ratio * 0.5 +
          largest.averageSimilarity * 0.4 +
          largest.edgeDensity * 0.25 -
          0.45,
          0,
          1
        );
      } else if (largest.maximumSimilarity >= 0.9) {
        strength = 0.25;
      }
    }

    return {
      eligibleCount,
      matchingPairs,
      clusters,
      membership,
      largestSize: largest?.size || 0,
      largestRatio: largest ? largest.size / Math.max(eligibleCount, 1) : 0,
      averageSimilarity: largest?.averageSimilarity || 0,
      maximumSimilarity: matchingPairs.length ? Math.max(...matchingPairs.map((pair) => pair.similarity)) : 0,
      strength
    };
  }

  function findDateCluster(reviews, windowDays = 30) {
    const dated = reviews
      .map((review, index) => ({ index, timestamp: Date.parse(review.date) }))
      .filter((item) => Number.isFinite(item.timestamp))
      .sort((left, right) => left.timestamp - right.timestamp);
    if (dated.length < 2) return null;

    const windowMs = windowDays * DAY_MS;
    let bestLeft = 0;
    let bestRight = 0;
    let right = 0;
    for (let left = 0; left < dated.length; left += 1) {
      if (right < left) right = left;
      while (right + 1 < dated.length && dated[right + 1].timestamp - dated[left].timestamp <= windowMs) right += 1;
      if (right - left > bestRight - bestLeft) {
        bestLeft = left;
        bestRight = right;
      }
    }

    const members = dated.slice(bestLeft, bestRight + 1);
    return {
      count: members.length,
      total: dated.length,
      ratio: members.length / dated.length,
      windowDays,
      indices: members.map((item) => item.index),
      start: new Date(members[0].timestamp).toISOString().slice(0, 10),
      end: new Date(members[members.length - 1].timestamp).toISOString().slice(0, 10)
    };
  }

  return {
    DAY_MS,
    STARS,
    GROUP_CAPS,
    GROUP_LABELS,
    PROMOTIONAL_REVIEW_PATTERN,
    NEGATIVE_PATTERN,
    POSITIVE_PATTERN,
    clamp,
    safeDivide,
    normalizeSpaces,
    normalizeReviewBody,
    charLength,
    roundTo,
    distributionInfo,
    isCompleteDistribution,
    getWeightedRating,
    getDistributionEntropy,
    getCountReliability,
    findRepeatedTitleWord,
    collectClaimConflicts,
    brandMatchesTitle,
    getGenericness,
    isGenericReviewBody,
    getReviewTextSimilarity,
    findTextClusters,
    findDateCluster
  };
});
