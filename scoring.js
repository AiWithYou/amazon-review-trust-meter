(function (root, factory) {
  'use strict';

  const isNode = typeof module === 'object' && module.exports;
  const base = isNode ? require('./scoring-base.js') : root.ReviewTrustBase;
  const features = isNode ? require('./scoring-features.js') : root.ReviewTrustFeatures;
  const api = factory(base, features);
  if (isNode) {
    module.exports = api;
    return;
  }
  root.ReviewTrustScoring = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (base, features) {
  'use strict';

  if (!base || !features) throw new Error('Review trust scoring dependencies are required');
  const {
    GROUP_CAPS,
    NEGATIVE_PATTERN,
    POSITIVE_PATTERN,
    clamp,
    safeDivide,
    wilsonLowerBound,
    smoothstep,
    normalizeSpaces,
    normalizeReviewBody,
    charLength,
    roundTo,
    distributionInfo,
    getWeightedRating,
    getDistributionEntropy,
    getCountReliability,
    findRepeatedTitleWord,
    collectClaimConflicts,
    brandMatchesTitle,
    getGenericness,
    findTextClusters,
    findDateCluster,
    getReviewTextSimilarity,
    isCompleteDistribution,
    isGenericReviewBody
  } = base;
  const {
    findTemporalBurst,
    addSignal,
    addObservation,
    getReviewDirection,
    analyzeIndividualReviews,
    computeAdjustedRating,
    capSignalsByGroup,
    calculateConfidence,
    getLabel
  } = features;

  const WILSON_THRESHOLDS = Object.freeze({
    // 7/9 and 6/8 both retain support, while 4/6 remains below the gate.
    // This keeps the small-sample guard without a one-review score cliff.
    unverifiedPositive: 0.4,
    unverifiedNegative: 0.5,
    genericDirection: 0.45,
    burstGeneric: 0.35,
    burstDuplicate: 0.15,
    directionModerate: 0.43
  });

  function getDirectionCount(reviews, direction) {
    return reviews.filter((review) => getReviewDirection(review) === direction).length;
  }

  function collectExtraordinaryClaims(title, details) {
    const text = `${title} ${details}`;
    const definitions = [
      { label: '初・唯一をうたう表現', pattern: /(?:世界初|業界初|日本初|初めて搭載|唯一)/i },
      { label: '最上級・革新表現', pattern: /(?:業界最高|業界最先端|最先端|究極|革新的|新世代の[^。]{0,20}傑作)/i },
      { label: '大幅な性能向上値', pattern: /(?:\d{2,4}(?:\.\d+)?\s*[%％]\s*(?:向上|UP|アップ)|\d+(?:\.\d+)?\s*倍以上)/i },
      { label: '独自・特許の訴求', pattern: /(?:特許(?:出願中|取得)|独自(?:開発|技術|構造|設計))/i }
    ];
    return definitions.filter((definition) => definition.pattern.test(text)).map((definition) => definition.label);
  }

  function analyzeProduct(input = {}) {
    const averageRating = Number.isFinite(input.averageRating) ? input.averageRating : null;
    const reviewCount = Number.isFinite(input.reviewCount) ? input.reviewCount : null;
    const distribution = input.distribution || {};
    const title = normalizeSpaces(input.title);
    const brand = normalizeSpaces(input.brand);
    const details = normalizeSpaces(input.details);
    const reviews = (Array.isArray(input.reviews) ? input.reviews : [])
      .slice(0, 24)
      .map((review) => ({
        ...review,
        stars: Number.isFinite(Number(review.stars)) ? Number(review.stars) : null,
        body: normalizeSpaces(review.body),
        title: normalizeSpaces(review.title),
        date: normalizeSpaces(review.date),
        variation: normalizeSpaces(review.variation),
        vine: review.vine === true,
        verified: typeof review.verified === 'boolean' ? review.verified : null,
        reviewerId: normalizeSpaces(review.reviewerId),
        helpfulVotes: review.helpfulVotes === null || review.helpfulVotes === undefined || !Number.isFinite(Number(review.helpfulVotes))
          ? null
          : Math.max(0, Number(review.helpfulVotes)),
        imageCount: Number.isFinite(Number(review.imageCount)) ? Math.max(0, Math.floor(Number(review.imageCount))) : 0
      }));

    const signals = [];
    const observations = [];
    const confidenceInfo = calculateConfidence({ averageRating, reviewCount, distribution, title, details, reviews });
    const distributionData = confidenceInfo.distributionInfo;
    const countReliability = getCountReliability(reviewCount);
    const reviewQuantityReliability = clamp((reviews.length - 3) / 9, 0.25, 1);

    // 商品情報は補助根拠に限定する。ブランド名のタイトル不記載は判定材料にしない。
    if (title.length > 150) {
      addSignal(signals, 'long_title', 'listing', title.length > 220 ? 6 : 4, 1, '商品名が非常に長い', `${title.length}文字`);
    }
    const repeated = findRepeatedTitleWord(title);
    if (repeated && repeated.count >= 2) {
      addSignal(signals, 'repeated_keyword', 'listing', repeated.count >= 3 ? 4 : 3, 1, '商品名で同じ語が繰り返されている', `「${repeated.word}」${repeated.count}回`);
    }
    const promotionalTerms = [
      '最高', '最強', '驚き', '大音量', '重低音', '高音質', '先端', '究極', '圧倒的', '革命', '超強力',
      '世界初', '業界初', '超小型', 'パワフル', '省エネ', '一台多役'
    ]
      .filter((term) => title.includes(term));
    if (promotionalTerms.length >= 5) {
      addSignal(signals, 'promotional_title', 'listing', 4, 1, '強い宣伝表現が商品名に集中', promotionalTerms.join('・'));
    }
    const extraordinaryClaims = collectExtraordinaryClaims(title, details);
    if (extraordinaryClaims.length >= 4) {
      addSignal(
        signals,
        'extraordinary_claim_density',
        'listing',
        6,
        1,
        '検証しにくい強い商品訴求が重なる',
        extraordinaryClaims.join('・')
      );
    }
    const claimConflicts = collectClaimConflicts(title, details);
    if (claimConflicts.length) {
      const evidence = claimConflicts
        .slice(0, 3)
        .map((conflict) => `${conflict.label}: 商品名 ${conflict.title.join('/')} ↔ 説明 ${conflict.details.join('/')}`)
        .join('、');
      const conflictPoints = claimConflicts.reduce((sum, conflict) => sum + conflict.weight, 0);
      addSignal(
        signals,
        'claim_conflicts',
        'listing',
        Math.min(GROUP_CAPS.listing, conflictPoints),
        1,
        claimConflicts.length >= 2 ? '商品名と説明で複数の仕様値が一致しない' : '商品名と説明の仕様値が一致しない',
        evidence
      );
    }

    // 評価分布は単独では弱い根拠として扱う。
    let polarizedDistribution = false;
    if (distributionData.usable) {
      const p = distributionData.normalized;
      const five = p[5];
      const one = p[1];
      const middle = p[2] + p[3] + p[4];
      const positive = p[4] + p[5];
      const entropy = getDistributionEntropy(p);

      if (Number(reviewCount) >= 20) {
        const fiveStarRamp = smoothstep(five, 0.828, 0.99);
        const fiveStarPoints = fiveStarRamp * (7 + 3 * smoothstep(five, 0.93, 0.99));
        addSignal(signals, 'extreme_five_star_skew', 'distribution', fiveStarPoints, countReliability, '★5への集中が極端', `★5 ${Math.round(five * 100)}% / ${reviewCount.toLocaleString('ja-JP')}件`);
      }
      if (positive >= 0.98 && p[1] + p[2] <= 0.01 && Number(reviewCount) >= 30) {
        addSignal(signals, 'near_perfect_distribution', 'distribution', 6, countReliability, '高評価だけにほぼ集中', `★4〜5 ${Math.round(positive * 100)}%`);
      }

      if (five >= 0.7 && one >= 0.14 && middle <= 0.18) {
        polarizedDistribution = true;
        addSignal(signals, 'polarized_distribution', 'distribution', 8, countReliability, '★5と★1への二極化が強い', `★5 ${Math.round(five * 100)}% / ★1 ${Math.round(one * 100)}%`);
      } else if (five >= 0.75 && one >= 0.08 && middle <= 0.18 && Number(reviewCount) >= 30) {
        polarizedDistribution = true;
        addSignal(signals, 'moderate_polarized_distribution', 'distribution', 6, countReliability, '高評価中心だが低評価側にも山がある', `★5 ${Math.round(five * 100)}% / ★1 ${Math.round(one * 100)}%`);
      }

      if (entropy !== null && entropy < 0.28 && five >= 0.85 && Number(reviewCount) >= 15) {
        addSignal(signals, 'low_entropy_distribution', 'distribution', 5, countReliability, '評価分布の偏りが非常に大きい', `分布エントロピー ${entropy.toFixed(2)}`);
      }

      const weightedRating = getWeightedRating(distribution);
      const mismatch = Number.isFinite(averageRating) ? Math.abs(weightedRating - averageRating) : 0;
      if (mismatch >= 0.24) {
        const mismatchRamp = smoothstep(mismatch, 0.315, 0.385);
        const reliabilityRamp = smoothstep(countReliability, 0.65, 0.8);
        const mismatchPoints = mismatchRamp * (7 + 3 * smoothstep(mismatch, 0.405, 0.495));
        const added = addSignal(
          signals,
          'rating_mismatch',
          'distribution',
          mismatchPoints,
          countReliability * reliabilityRamp,
          '平均評価と星別分布が整合しにくい',
          `表示 ${averageRating.toFixed(1)} / 分布換算 ${weightedRating.toFixed(1)}`
        );
        if (!added) {
          addObservation(
            observations,
            'rating_mismatch_observation',
            '表示平均と星別分布の単純平均に差がある',
            `表示 ${averageRating.toFixed(1)} / 分布換算 ${weightedRating.toFixed(1)}（Amazonの重み付け平均を考慮し単独では加点しません）`
          );
        }
      }

      if (!distributionData.valid) {
        addObservation(observations, 'distribution_rounding', '星別割合の合計が100%からやや外れている', `合計 ${roundTo(distributionData.sum, 1)}%`);
      }
    } else {
      addObservation(observations, 'distribution_missing', '星別評価分布を十分に取得できなかった');
    }

    const textClusters = findTextClusters(reviews);
    const temporalBurst = findTemporalBurst(reviews);
    const rawPositiveReviews = reviews.filter((review) => Number(review.stars) >= 4);
    const rawNegativeReviews = reviews.filter((review) => Number(review.stars) <= 2);
    const rawNonVinePositive = rawPositiveReviews.filter((review) => review.vine !== true);
    const rawNonVineNegative = rawNegativeReviews.filter((review) => review.vine !== true);
    const positiveUnverifiedCount = rawNonVinePositive.filter((review) => review.verified === false).length;
    const negativeUnverifiedCount = rawNonVineNegative.filter((review) => review.verified === false).length;
    const positiveUnverifiedLowerBound = wilsonLowerBound(positiveUnverifiedCount, rawNonVinePositive.length);
    const negativeUnverifiedLowerBound = wilsonLowerBound(negativeUnverifiedCount, rawNonVineNegative.length);
    const temporalSupport = {
      burstDuplicateCount: 0,
      burstDuplicateRatio: 0,
      burstDuplicateLowerBound: 0,
      direction: null,
      directionalUnverifiedSupport: false,
      unverifiedSupportStrength: 0,
      directionalDistributionSupport: false,
      distributionSupportStrength: 0,
      ratingShiftSupport: false,
      corroborationStrength: 0,
      corroborated: false
    };

    if (temporalBurst) {
      temporalSupport.burstDuplicateCount = temporalBurst.indices.filter((index) => Number.isInteger(textClusters.membership[index])).length;
      temporalSupport.burstDuplicateRatio = safeDivide(temporalSupport.burstDuplicateCount, temporalBurst.count, 0);
      temporalSupport.burstDuplicateLowerBound = wilsonLowerBound(temporalSupport.burstDuplicateCount, temporalBurst.count);
      temporalSupport.direction = temporalBurst.highRatio >= temporalBurst.lowRatio ? 'positive' : 'negative';
      const unverifiedThreshold = temporalSupport.direction === 'positive'
        ? WILSON_THRESHOLDS.unverifiedPositive
        : WILSON_THRESHOLDS.unverifiedNegative;
      const unverifiedLowerBound = temporalSupport.direction === 'positive'
        ? positiveUnverifiedLowerBound
        : negativeUnverifiedLowerBound;
      const enoughDirectionalReviews = temporalSupport.direction === 'positive'
        ? rawNonVinePositive.length >= 6
        : rawNonVineNegative.length >= 5;
      const unverifiedSupportStrength = enoughDirectionalReviews
        ? smoothstep(unverifiedLowerBound, unverifiedThreshold * 0.9, unverifiedThreshold * 1.1)
        : 0;
      temporalSupport.unverifiedSupportStrength = unverifiedSupportStrength;
      temporalSupport.directionalUnverifiedSupport = unverifiedSupportStrength > 0;
      const distributionSupportStrength = distributionData.usable
        ? temporalSupport.direction === 'positive'
          ? smoothstep(distributionData.normalized[5], 0.828, 0.99)
          : smoothstep(distributionData.normalized[1], 0.144, 0.176)
        : 0;
      temporalSupport.distributionSupportStrength = distributionSupportStrength;
      temporalSupport.directionalDistributionSupport = distributionSupportStrength > 0;
      temporalSupport.ratingShiftSupport = Number.isFinite(temporalBurst.ratingShift) &&
        temporalBurst.ratingShift >= 0.8 &&
        Number.isFinite(temporalBurst.burstMean) &&
        Number.isFinite(temporalBurst.outsideMean) &&
        (
          (temporalSupport.direction === 'positive' && temporalBurst.burstMean > temporalBurst.outsideMean) ||
          (temporalSupport.direction === 'negative' && temporalBurst.burstMean < temporalBurst.outsideMean)
        );
      const duplicateSupportStrength =
        smoothstep(textClusters.strength, 0.315, 0.385) *
        smoothstep(temporalSupport.burstDuplicateLowerBound, 0.135, 0.165);
      const aggregateSupportStrength =
        distributionSupportStrength *
        smoothstep(temporalBurst.genericLowerBound, 0.315, 0.385);
      temporalSupport.corroborationStrength = Math.max(
        duplicateSupportStrength,
        unverifiedSupportStrength,
        aggregateSupportStrength,
        Number(temporalSupport.ratingShiftSupport)
      );
      temporalSupport.corroborated = temporalSupport.corroborationStrength > 0;
    }

    const reviewerGroups = new Map();
    for (const review of reviews) {
      if (!review.reviewerId) continue;
      if (!reviewerGroups.has(review.reviewerId)) reviewerGroups.set(review.reviewerId, []);
      reviewerGroups.get(review.reviewerId).push(review);
    }
    const alignedReviewerGroups = [...reviewerGroups.values()]
      .map((group) => ({ group, directions: new Set(group.map((review) => getReviewDirection(review))) }))
      .filter(({ group, directions }) => group.length >= 2 && directions.size === 1 && !directions.has('neutral'))
      .sort((left, right) => right.group.length - left.group.length);
    if (alignedReviewerGroups.length) {
      const largestReviewerGroup = alignedReviewerGroups[0];
      const direction = getReviewDirection(largestReviewerGroup.group[0]);
      addSignal(
        signals,
        'duplicate_reviewer_direction',
        'provenance',
        largestReviewerGroup.group.length >= 3 ? 10 : 8,
        1,
        '同じ投稿者による同方向のレビューがページ内で重複',
        `${largestReviewerGroup.group.length}件・${direction === 'positive' ? '高評価方向' : '低評価方向'}（同方向の重複投稿者群 ${alignedReviewerGroups.length}組）`
      );
    }

    const individualReviews = analyzeIndividualReviews(reviews, textClusters, temporalBurst, temporalSupport.corroborationStrength);

    const positiveReviews = reviews.map((review, index) => ({ review, analysis: individualReviews[index] })).filter((item) => item.analysis.direction === 'positive');
    const negativeReviews = reviews.map((review, index) => ({ review, analysis: individualReviews[index] })).filter((item) => item.analysis.direction === 'negative');
    const genericPositive = positiveReviews.filter((item) => item.analysis.genericness >= 0.68);
    const genericNegative = negativeReviews.filter((item) => item.analysis.genericness >= 0.68);
    const genericPositiveLowerBound = wilsonLowerBound(genericPositive.length, positiveReviews.length);
    const genericNegativeLowerBound = wilsonLowerBound(genericNegative.length, negativeReviews.length);

    const mostHelpfulPositive = positiveReviews.reduce((maximum, item) => Math.max(maximum, item.review.helpfulVotes || 0), 0);
    const mostHelpfulNegative = negativeReviews.reduce((maximum, item) => Math.max(maximum, item.review.helpfulVotes || 0), 0);
    if (
      polarizedDistribution &&
      negativeReviews.length >= 1 &&
      mostHelpfulNegative >= 5 &&
      mostHelpfulNegative >= Math.max(5, mostHelpfulPositive * 1.8)
    ) {
      addSignal(
        signals,
        'helpful_negative_contrast',
        'coordination',
        6,
        Math.min(reviewQuantityReliability, countReliability),
        '高評価中心の分布に対し低評価レビューへの参考票が突出',
        `低評価 最大${mostHelpfulNegative}票 / 高評価 最大${mostHelpfulPositive}票`
      );
    }

    const positiveImageReviews = positiveReviews.filter((item) => item.review.imageCount > 0);
    const positiveImageCount = positiveImageReviews.reduce((sum, item) => sum + item.review.imageCount, 0);
    if (polarizedDistribution && positiveImageReviews.length >= 2 && positiveImageCount >= 5) {
      addObservation(
        observations,
        'positive_review_images',
        '高評価側の表示レビューに画像添付がある',
        `${positiveImageReviews.length}/${positiveReviews.length}件・計${positiveImageCount}枚（単独では加点しません）`
      );
    }

    if (textClusters.largestSize >= 3) {
      const duplicateRamp = smoothstep(textClusters.strength, 0.315, 0.385);
      addSignal(
        signals,
        'duplicate_text_cluster',
        'text',
        duplicateRamp * (14 + Math.min(10, (textClusters.largestSize - 3) * 3)),
        reviewQuantityReliability,
        '似た本文のレビュー群がある',
        `${textClusters.largestSize}/${textClusters.eligibleCount}件、平均類似度 ${Math.round(textClusters.averageSimilarity * 100)}%`
      );
    } else if (textClusters.largestSize === 2 && textClusters.maximumSimilarity >= 0.92) {
      addSignal(signals, 'near_duplicate_pair', 'text', 6, reviewQuantityReliability * 0.7, 'ほぼ同一のレビュー本文がある', `最大類似度 ${Math.round(textClusters.maximumSimilarity * 100)}%`);
    }

    if (positiveReviews.length >= 5) {
      const ratio = genericPositive.length / positiveReviews.length;
      if (genericPositiveLowerBound >= WILSON_THRESHOLDS.genericDirection) {
        addObservation(observations, 'generic_positive_concentration', '高評価レビューに短文・汎用表現が多い', `${genericPositive.length}/${positiveReviews.length}件（${Math.round(ratio * 100)}%、単独では加点しません）`);
      }
    }
    if (negativeReviews.length >= 4) {
      const ratio = genericNegative.length / negativeReviews.length;
      if (genericNegativeLowerBound >= WILSON_THRESHOLDS.genericDirection) {
        addObservation(observations, 'generic_negative_concentration', '低評価レビューに短文・汎用表現が多い', `${genericNegative.length}/${negativeReviews.length}件（${Math.round(ratio * 100)}%、単独では加点しません）`);
      }
    }

    const ratingBodyMismatch = reviews.filter((review) => {
      const body = String(review.body || '');
      return (Number(review.stars) >= 4 && NEGATIVE_PATTERN.test(body) && !POSITIVE_PATTERN.test(body)) ||
        (Number(review.stars) <= 2 && POSITIVE_PATTERN.test(body) && !NEGATIVE_PATTERN.test(body));
    });
    if (reviews.length >= 8 && ratingBodyMismatch.length / reviews.length >= 0.3) {
      addSignal(signals, 'rating_body_mismatch', 'text', 7, reviewQuantityReliability * 0.75, '星評価と本文の方向が一致しないレビューが多い', `${ratingBodyMismatch.length}/${reviews.length}件`);
    }

    const vineCount = reviews.filter((review) => review.vine === true).length;
    if (vineCount) addObservation(observations, 'vine_reviews', 'Vineレビューを検出', `${vineCount}/${reviews.length}件（Vine自体は不正扱いしません）`);

    const nonVinePositive = positiveReviews.filter((item) => item.review.vine !== true);
    const unverifiedPositive = nonVinePositive.filter((item) => item.review.verified === false);
    const nonVineNegative = negativeReviews.filter((item) => item.review.vine !== true);
    const unverifiedNegative = nonVineNegative.filter((item) => item.review.verified === false);
    const positiveTextSupport = textClusters.strength >= 0.35 || genericPositiveLowerBound >= WILSON_THRESHOLDS.genericDirection;
    const negativeTextSupport = textClusters.strength >= 0.35 || genericNegativeLowerBound >= WILSON_THRESHOLDS.genericDirection;

    if (
      nonVinePositive.length >= 6 &&
      wilsonLowerBound(unverifiedPositive.length, nonVinePositive.length) >= WILSON_THRESHOLDS.unverifiedPositive &&
      positiveTextSupport
    ) {
      addSignal(signals, 'unverified_positive_cluster', 'provenance', 9, reviewQuantityReliability, '購入確認のない高評価が他の兆候と重なる', `${unverifiedPositive.length}/${nonVinePositive.length}件`);
    }
    if (
      nonVineNegative.length >= 5 &&
      wilsonLowerBound(unverifiedNegative.length, nonVineNegative.length) >= WILSON_THRESHOLDS.unverifiedNegative &&
      negativeTextSupport
    ) {
      addSignal(signals, 'unverified_negative_cluster', 'provenance', 9, reviewQuantityReliability, '購入確認のない低評価が他の兆候と重なる', `${unverifiedNegative.length}/${nonVineNegative.length}件`);
    }

    let coordinatedDirection = null;
    if (temporalBurst) {
      coordinatedDirection = temporalSupport.direction;
      const directionCount = temporalSupport.direction === 'positive'
        ? getDirectionCount(temporalBurst.indices.map((index) => reviews[index]), 'positive')
        : getDirectionCount(temporalBurst.indices.map((index) => reviews[index]), 'negative');
      const directionLowerBound = wilsonLowerBound(directionCount, temporalBurst.count);
      let hasPolarizedTimeOverlap = false;

      if (
        polarizedDistribution &&
        temporalSupport.direction === 'positive' &&
        temporalBurst.vineRatio < 0.5 &&
        temporalBurst.count >= Math.max(5, Math.ceil(temporalBurst.total * 0.4))
      ) {
        const overlapPoints = 10 *
          smoothstep(temporalBurst.strength, 0.18, 0.22) *
          smoothstep(temporalBurst.highLowerBound, 0.495, 0.605);
        hasPolarizedTimeOverlap = addSignal(
          signals,
          'polarized_time_overlap',
          'coordination',
          overlapPoints,
          Math.min(reviewQuantityReliability, countReliability),
          '評価の二極化と短期の高評価集中が重なる',
          `${temporalBurst.windowDays}日以内に高評価 ${temporalBurst.count}/${temporalBurst.total}件（${temporalBurst.start}〜${temporalBurst.end}）`
        );
      }

      if (temporalBurst.vineRatio >= 0.5) {
        addObservation(observations, 'vine_launch_burst', '短期間集中の多くがVineレビュー', `${temporalBurst.windowDays}日以内に${temporalBurst.count}/${temporalBurst.total}件、Vine ${Math.round(temporalBurst.vineRatio * 100)}%`);
      } else if (
        temporalBurst.strength >= 0.45 &&
        directionLowerBound >= WILSON_THRESHOLDS.directionModerate
      ) {
        const evidence = `${temporalBurst.windowDays}日以内に${temporalBurst.count}/${temporalBurst.total}件（${temporalBurst.start}〜${temporalBurst.end}）`;
        if (temporalSupport.corroborated) {
          addSignal(
            signals,
            'directional_time_burst',
            'temporal',
            temporalSupport.corroborationStrength *
              smoothstep(temporalBurst.strength, 0.45, 0.55) *
              smoothstep(directionLowerBound, 0.405, 0.55) *
              (8 + 4 * smoothstep(temporalBurst.strength, 0.72, 0.88)),
            reviewQuantityReliability,
            coordinatedDirection === 'positive' ? '高評価が短期間に集中' : '低評価が短期間に集中',
            evidence
          );
        } else if (!hasPolarizedTimeOverlap) {
          addObservation(observations, 'uncorroborated_time_cluster', '表示レビューに短期間の日付集中がある', `${evidence}（選択表示された標本のため単独では加点しません）`);
        }
      } else if (
        !hasPolarizedTimeOverlap &&
        temporalBurst.strength >= 0.225 &&
        directionLowerBound >= WILSON_THRESHOLDS.directionModerate
      ) {
        const evidence = `${temporalBurst.windowDays}日以内に${temporalBurst.count}/${temporalBurst.total}件（${temporalBurst.start}〜${temporalBurst.end}）`;
        addObservation(observations, 'uncorroborated_time_cluster', '表示レビューに短期間の日付集中がある', `${evidence}（選択表示された標本のため単独では加点しません）`);
      }

      let duplicateCampaignAdded = false;
      if (temporalBurst.vineRatio < 0.5) {
        duplicateCampaignAdded = addSignal(
          signals,
          'co_burst_duplicate_campaign',
          'coordination',
          20 *
            smoothstep(temporalBurst.strength, 0.36, 0.44) *
            smoothstep(temporalSupport.burstDuplicateLowerBound, 0.135, 0.165) *
            smoothstep(textClusters.strength, 0.315, 0.385),
          Math.min(reviewQuantityReliability, 0.55 + temporalBurst.strength * 0.45),
          '投稿日集中と本文重複が同じレビュー群で発生',
          `集中期間内の類似本文 ${temporalSupport.burstDuplicateCount}/${temporalBurst.count}件`
        );
      }
      if (
        !duplicateCampaignAdded &&
        temporalBurst.vineRatio < 0.5 &&
        (temporalSupport.directionalUnverifiedSupport || temporalSupport.directionalDistributionSupport)
      ) {
        addSignal(
          signals,
          'co_burst_generic_campaign',
          'coordination',
          14 *
            Math.max(temporalSupport.unverifiedSupportStrength, temporalSupport.distributionSupportStrength) *
            smoothstep(temporalBurst.strength, 0.405, 0.495) *
            smoothstep(temporalBurst.genericLowerBound, 0.315, 0.385) *
            smoothstep(directionLowerBound, 0.45, 0.55),
          reviewQuantityReliability,
          '投稿日集中・評価方向・汎用本文が同時に偏る',
          `集中期間の汎用本文 ${Math.round(temporalBurst.genericRatio * 100)}%`
        );
      }
    }

    const suspiciousPositiveRisk = safeDivide(
      individualReviews.filter((item) => item.direction === 'positive').reduce((sum, item) => sum + item.risk, 0),
      positiveReviews.length,
      0
    );
    const suspiciousNegativeRisk = safeDivide(
      individualReviews.filter((item) => item.direction === 'negative').reduce((sum, item) => sum + item.risk, 0),
      negativeReviews.length,
      0
    );

    if (distributionData.usable) {
      const p = distributionData.normalized;
      if (p[5] >= 0.82 && suspiciousPositiveRisk >= 0.28 && positiveReviews.length >= 5) {
        addSignal(signals, 'distribution_positive_campaign_overlap', 'coordination', 9, reviewQuantityReliability * countReliability, '★5偏重と高評価レビュー側の複合兆候が一致', `高評価側の疑わしさ ${Math.round(suspiciousPositiveRisk * 100)}%`);
      }
      if (p[1] >= 0.16 && suspiciousNegativeRisk >= 0.3 && negativeReviews.length >= 4) {
        addSignal(signals, 'distribution_negative_campaign_overlap', 'coordination', 9, reviewQuantityReliability * countReliability, '★1比率と低評価レビュー側の複合兆候が一致', `低評価側の疑わしさ ${Math.round(suspiciousNegativeRisk * 100)}%`);
      }
    }

    const variations = reviews.map((review) => review.variation).filter(Boolean);
    const variationCounts = new Map();
    for (const variation of variations) variationCounts.set(variation, (variationCounts.get(variation) || 0) + 1);
    if (variationCounts.size >= 4 && variations.length >= 7) {
      const largestVariation = Math.max(...variationCounts.values());
      if (largestVariation / variations.length < 0.5) {
        addSignal(signals, 'mixed_variations', 'applicability', 6, reviewQuantityReliability, '複数バリエーションのレビューが混在', `${variationCounts.size}種類 / 最大グループ ${largestVariation}件`);
      }
    }

    const groupScores = capSignalsByGroup(signals);
    const listingRiskScore = groupScores.listing;
    let reviewRiskScore = Math.round(clamp(
      Object.entries(groupScores)
        .filter(([groupKey]) => groupKey !== 'listing')
        .reduce((sum, [, value]) => sum + value, 0),
      0,
      100
    ));
    const strongCoreGroups = ['distribution', 'text', 'temporal', 'provenance']
      .filter((groupKey) => groupScores[groupKey] >= ({ distribution: 6, text: 8, temporal: 6, provenance: 5 }[groupKey]));
    const hasReviewEvidence = groupScores.text + groupScores.temporal + groupScores.provenance + groupScores.coordination > 0;

    if (!hasReviewEvidence) reviewRiskScore = Math.min(reviewRiskScore, 32);
    else if (strongCoreGroups.length === 0 && groupScores.coordination < 8) reviewRiskScore = Math.min(reviewRiskScore, 38);
    else if (strongCoreGroups.length === 1 && groupScores.coordination < 8) reviewRiskScore = Math.min(reviewRiskScore, 48);
    if (reviews.length < 6) reviewRiskScore = Math.min(reviewRiskScore, 45);
    const score = Math.round(clamp(reviewRiskScore + listingRiskScore, 0, 100));

    const sufficient = confidenceInfo.value >= 35 && Number.isFinite(averageRating) && (distributionData.usable || reviews.length >= 6);
    const adjusted = computeAdjustedRating({
      averageRating,
      distribution,
      reviews,
      reviewAnalysis: individualReviews,
      confidence: confidenceInfo.value
    });
    const classification = getLabel(score, sufficient, confidenceInfo.value);

    if (brand && title) {
      if (!brandMatchesTitle(brand, title)) {
        addObservation(observations, 'brand_not_in_title', 'ブランド名が商品名に含まれていない', `${brand}（不正判定には加点しません）`);
      }
    }

    return {
      version: 2,
      score,
      riskScore: score,
      reviewRiskScore,
      listingRiskScore,
      sufficient,
      label: classification.label,
      tone: classification.tone,
      confidence: confidenceInfo.value,
      confidenceLabel: confidenceInfo.label,
      adjustedRating: adjusted?.rating ?? null,
      adjustmentDelta: adjusted?.delta ?? null,
      adjustmentStrength: adjusted?.strength ?? null,
      // 旧UIとの互換用。v2では注意度の線形変換ではなく、表示レビューに基づく参考補正値。
      trustStars: adjusted?.rating ?? null,
      signals: signals.sort((left, right) => right.points - left.points || left.group.localeCompare(right.group, 'ja')),
      observations,
      groupScores,
      coverage: confidenceInfo.coverage,
      coverageCount: confidenceInfo.coverageCount,
      coverageTotal: confidenceInfo.coverageTotal,
      weightedRating: getWeightedRating(distribution),
      sampleSize: reviews.length,
      diagnostics: {
        distributionSum: distributionData.sum,
        textClusters: {
          largestSize: textClusters.largestSize,
          largestRatio: roundTo(textClusters.largestRatio, 3),
          averageSimilarity: roundTo(textClusters.averageSimilarity, 3),
          strength: roundTo(textClusters.strength, 3)
        },
        temporalBurst: temporalBurst ? {
          windowDays: temporalBurst.windowDays,
          count: temporalBurst.count,
          total: temporalBurst.total,
          strength: roundTo(temporalBurst.strength, 3),
          highRatio: roundTo(temporalBurst.highRatio, 3),
          lowRatio: roundTo(temporalBurst.lowRatio, 3),
          vineRatio: roundTo(temporalBurst.vineRatio, 3)
        } : null,
        averageIndividualRisk: roundTo(safeDivide(individualReviews.reduce((sum, item) => sum + item.risk, 0), individualReviews.length, 0), 3),
        coordinatedDirection
      }
    };
  }

  return {
    analyzeProduct,
    collectClaimConflicts,
    distributionInfo,
    findDateCluster,
    findRepeatedTitleWord,
    findTemporalBurst,
    findTextClusters,
    getGenericness,
    getReviewTextSimilarity,
    getWeightedRating,
    isCompleteDistribution,
    isGenericReviewBody,
    normalizeReviewBody
  };
});
