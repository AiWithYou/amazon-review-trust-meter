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
    analyzeIndividualReviews,
    computeAdjustedRating,
    capSignalsByGroup,
    calculateConfidence,
    getLabel
  } = features;

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
        verified: typeof review.verified === 'boolean' ? review.verified : null
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
    const promotionalTerms = ['最高', '最強', '驚き', '大音量', '重低音', '高音質', '先端', '究極', '圧倒的', '革命', '超強力']
      .filter((term) => title.includes(term));
    if (promotionalTerms.length >= 5) {
      addSignal(signals, 'promotional_title', 'listing', 4, 1, '強い宣伝表現が商品名に集中', promotionalTerms.join('・'));
    }
    const claimConflicts = collectClaimConflicts(title, details);
    if (claimConflicts.length) {
      const evidence = claimConflicts
        .slice(0, 3)
        .map((conflict) => `${conflict.label}: 商品名 ${conflict.title.join('/')} ↔ 説明 ${conflict.details.join('/')}`)
        .join('、');
      addSignal(signals, 'claim_conflicts', 'listing', Math.min(8, 4 + (claimConflicts.length - 1) * 2), 0.9, '商品名と説明の仕様値が一致しない', evidence);
    }

    // 評価分布は単独では弱い根拠として扱う。
    if (distributionData.usable) {
      const p = distributionData.normalized;
      const five = p[5];
      const one = p[1];
      const middle = p[2] + p[3] + p[4];
      const positive = p[4] + p[5];
      const entropy = getDistributionEntropy(p);

      if (five >= 0.92 && Number(reviewCount) >= 20) {
        addSignal(signals, 'extreme_five_star_skew', 'distribution', five >= 0.97 ? 10 : 7, countReliability, '★5への集中が極端', `★5 ${Math.round(five * 100)}% / ${reviewCount.toLocaleString('ja-JP')}件`);
      } else if (positive >= 0.98 && p[1] + p[2] <= 0.01 && Number(reviewCount) >= 30) {
        addSignal(signals, 'near_perfect_distribution', 'distribution', 6, countReliability, '高評価だけにほぼ集中', `★4〜5 ${Math.round(positive * 100)}%`);
      }

      if (five >= 0.7 && one >= 0.14 && middle <= 0.18) {
        addSignal(signals, 'polarized_distribution', 'distribution', 8, countReliability, '★5と★1への二極化が強い', `★5 ${Math.round(five * 100)}% / ★1 ${Math.round(one * 100)}%`);
      }

      if (entropy !== null && entropy < 0.28 && five >= 0.85 && Number(reviewCount) >= 15) {
        addSignal(signals, 'low_entropy_distribution', 'distribution', 5, countReliability, '評価分布の偏りが非常に大きい', `分布エントロピー ${entropy.toFixed(2)}`);
      }

      const weightedRating = getWeightedRating(distribution);
      const mismatch = Number.isFinite(averageRating) ? Math.abs(weightedRating - averageRating) : 0;
      if (mismatch >= 0.24) {
        addSignal(signals, 'rating_mismatch', 'distribution', mismatch >= 0.45 ? 10 : 7, countReliability, '平均評価と星別分布が整合しにくい', `表示 ${averageRating.toFixed(1)} / 分布換算 ${weightedRating.toFixed(1)}`);
      }

      if (!distributionData.valid) {
        addObservation(observations, 'distribution_rounding', '星別割合の合計が100%からやや外れている', `合計 ${roundTo(distributionData.sum, 1)}%`);
      }
    } else {
      addObservation(observations, 'distribution_missing', '星別評価分布を十分に取得できなかった');
    }

    const textClusters = findTextClusters(reviews);
    const temporalBurst = findTemporalBurst(reviews);
    const individualReviews = analyzeIndividualReviews(reviews, textClusters, temporalBurst);

    const positiveReviews = reviews.map((review, index) => ({ review, analysis: individualReviews[index] })).filter((item) => item.analysis.direction === 'positive');
    const negativeReviews = reviews.map((review, index) => ({ review, analysis: individualReviews[index] })).filter((item) => item.analysis.direction === 'negative');
    const genericPositive = positiveReviews.filter((item) => item.analysis.genericness >= 0.68);
    const genericNegative = negativeReviews.filter((item) => item.analysis.genericness >= 0.68);

    if (textClusters.largestSize >= 3 && textClusters.strength >= 0.35) {
      addSignal(
        signals,
        'duplicate_text_cluster',
        'text',
        14 + Math.min(10, (textClusters.largestSize - 3) * 3),
        reviewQuantityReliability,
        '似た本文のレビュー群がある',
        `${textClusters.largestSize}/${textClusters.eligibleCount}件、平均類似度 ${Math.round(textClusters.averageSimilarity * 100)}%`
      );
    } else if (textClusters.largestSize === 2 && textClusters.maximumSimilarity >= 0.92) {
      addSignal(signals, 'near_duplicate_pair', 'text', 6, reviewQuantityReliability * 0.7, 'ほぼ同一のレビュー本文がある', `最大類似度 ${Math.round(textClusters.maximumSimilarity * 100)}%`);
    }

    if (positiveReviews.length >= 5) {
      const ratio = genericPositive.length / positiveReviews.length;
      if (ratio >= 0.6) {
        addSignal(signals, 'generic_positive_concentration', 'text', ratio >= 0.8 ? 12 : 9, reviewQuantityReliability, '高評価レビューに短文・汎用表現が多い', `${genericPositive.length}/${positiveReviews.length}件（${Math.round(ratio * 100)}%）`);
      }
    }
    if (negativeReviews.length >= 4) {
      const ratio = genericNegative.length / negativeReviews.length;
      if (ratio >= 0.65) {
        addSignal(signals, 'generic_negative_concentration', 'text', ratio >= 0.85 ? 12 : 9, reviewQuantityReliability, '低評価レビューに短文・汎用表現が多い', `${genericNegative.length}/${negativeReviews.length}件（${Math.round(ratio * 100)}%）`);
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
    const positiveTextSupport = textClusters.strength >= 0.35 || safeDivide(genericPositive.length, positiveReviews.length, 0) >= 0.6;
    const negativeTextSupport = textClusters.strength >= 0.35 || safeDivide(genericNegative.length, negativeReviews.length, 0) >= 0.65;

    if (nonVinePositive.length >= 6 && unverifiedPositive.length / nonVinePositive.length >= 0.65 && positiveTextSupport) {
      addSignal(signals, 'unverified_positive_cluster', 'provenance', 9, reviewQuantityReliability, '購入確認のない高評価が他の兆候と重なる', `${unverifiedPositive.length}/${nonVinePositive.length}件`);
    }
    if (nonVineNegative.length >= 5 && unverifiedNegative.length / nonVineNegative.length >= 0.7 && negativeTextSupport) {
      addSignal(signals, 'unverified_negative_cluster', 'provenance', 9, reviewQuantityReliability, '購入確認のない低評価が他の兆候と重なる', `${unverifiedNegative.length}/${nonVineNegative.length}件`);
    }

    let coordinatedDirection = null;
    if (temporalBurst) {
      const burstDuplicateCount = temporalBurst.indices.filter((index) => Number.isInteger(textClusters.membership[index])).length;
      const burstDuplicateRatio = safeDivide(burstDuplicateCount, temporalBurst.count, 0);
      const directionRatio = Math.max(temporalBurst.highRatio, temporalBurst.lowRatio);
      coordinatedDirection = temporalBurst.highRatio >= temporalBurst.lowRatio ? 'positive' : 'negative';

      if (temporalBurst.vineRatio >= 0.5) {
        addObservation(observations, 'vine_launch_burst', '短期間集中の多くがVineレビュー', `${temporalBurst.windowDays}日以内に${temporalBurst.count}/${temporalBurst.total}件、Vine ${Math.round(temporalBurst.vineRatio * 100)}%`);
      } else if (temporalBurst.strength >= 0.5 && directionRatio >= 0.7) {
        addSignal(
          signals,
          'directional_time_burst',
          'temporal',
          temporalBurst.strength >= 0.8 ? 12 : 8,
          reviewQuantityReliability,
          coordinatedDirection === 'positive' ? '高評価が短期間に集中' : '低評価が短期間に集中',
          `${temporalBurst.windowDays}日以内に${temporalBurst.count}/${temporalBurst.total}件（${temporalBurst.start}〜${temporalBurst.end}）`
        );
      }

      if (temporalBurst.vineRatio < 0.5 && temporalBurst.strength >= 0.4 && burstDuplicateRatio >= 0.4 && textClusters.strength >= 0.35) {
        addSignal(
          signals,
          'co_burst_duplicate_campaign',
          'coordination',
          20,
          Math.min(reviewQuantityReliability, 0.55 + temporalBurst.strength * 0.45),
          '投稿日集中と本文重複が同じレビュー群で発生',
          `集中期間内の類似本文 ${burstDuplicateCount}/${temporalBurst.count}件`
        );
      } else if (
        temporalBurst.vineRatio < 0.5 &&
        temporalBurst.strength >= 0.45 &&
        temporalBurst.genericRatio >= 0.55 &&
        directionRatio >= 0.75
      ) {
        addSignal(
          signals,
          'co_burst_generic_campaign',
          'coordination',
          14,
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
    let score = Object.values(groupScores).reduce((sum, value) => sum + value, 0);
    const strongCoreGroups = ['distribution', 'text', 'temporal', 'provenance']
      .filter((groupKey) => groupScores[groupKey] >= ({ distribution: 6, text: 8, temporal: 6, provenance: 5 }[groupKey]));
    const hasReviewEvidence = groupScores.text + groupScores.temporal + groupScores.provenance + groupScores.coordination > 0;

    if (!hasReviewEvidence) score = Math.min(score, 32);
    else if (strongCoreGroups.length === 0 && groupScores.coordination < 8) score = Math.min(score, 38);
    else if (strongCoreGroups.length === 1 && groupScores.coordination < 8) score = Math.min(score, 48);
    if (reviews.length < 6) score = Math.min(score, 45);
    score = Math.round(clamp(score, 0, 100));

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
      const normalizedBrand = brand.normalize('NFKC').toLowerCase().replace(/[^a-z0-9ぁ-んァ-ヶ一-龠々ー]/g, '');
      const normalizedTitle = title.normalize('NFKC').toLowerCase().replace(/[^a-z0-9ぁ-んァ-ヶ一-龠々ー]/g, '');
      if (normalizedBrand && !normalizedTitle.includes(normalizedBrand)) {
        addObservation(observations, 'brand_not_in_title', 'ブランド名が商品名に含まれていない', `${brand}（不正判定には加点しません）`);
      }
    }

    return {
      version: 2,
      score,
      riskScore: score,
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
