(function (root, factory) {
  'use strict';

  const base = typeof module === 'object' && module.exports
    ? require('./scoring-base.js')
    : root.ReviewTrustBase;
  const api = factory(base);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.ReviewTrustFeatures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (base) {
  'use strict';

  if (!base) throw new Error('ReviewTrustBase is required');
  const {
    DAY_MS,
    STARS,
    GROUP_CAPS,
    GROUP_LABELS,
    PROMOTIONAL_REVIEW_PATTERN,
    clamp,
    safeDivide,
    wilsonLowerBound,
    smoothstep,
    normalizeReviewBody,
    charLength,
    roundTo,
    distributionInfo,
    getWeightedRating,
    getGenericness,
    findDateCluster
  } = base;

  function findTemporalBurst(reviews) {
    const dated = reviews
      .map((review, index) => ({ index, timestamp: Date.parse(review.date) }))
      .filter((item) => Number.isFinite(item.timestamp))
      .sort((left, right) => left.timestamp - right.timestamp);
    if (dated.length < 6) return null;

    const spanDays = Math.max(1, (dated[dated.length - 1].timestamp - dated[0].timestamp) / DAY_MS + 1);
    let best = null;

    for (const windowDays of [14, 30, 90]) {
      if (spanDays <= windowDays * 1.4) continue;
      const cluster = findDateCluster(reviews, windowDays);
      if (!cluster) continue;
      const expectedRatio = clamp(windowDays / spanDays, 0.01, 0.95);
      const expectedCount = dated.length * expectedRatio;
      const variance = dated.length * expectedRatio * (1 - expectedRatio);
      const zScore = variance > 0 ? (cluster.count - expectedCount) / Math.sqrt(variance) : 0;
      const excessRatio = cluster.ratio - expectedRatio;
      const quantityFactor = clamp((dated.length - 5) / 7, 0.25, 1);
      // 3種類の窓を全位置で走査した最大値は、単一窓のz値より大きくなりやすい。
      // 走査統計の簡易補正として立ち上がりを2.4へ引き上げる。
      const scanAdjustedStrength = clamp(
        (Math.max(0, excessRatio - 0.12) / 0.5) * 0.65 + (Math.max(0, zScore - 2.4) / 4) * 0.35,
        0,
        1
      ) * quantityFactor;

      const oldestTimestamp = dated[0].timestamp;
      const clusterStartTimestamp = Date.parse(cluster.start);
      const frontToleranceDays = Math.max(3, Math.min(14, windowDays * 0.25));
      const frontAnchored = Number.isFinite(clusterStartTimestamp) &&
        (clusterStartTimestamp - oldestTimestamp) / DAY_MS <= frontToleranceDays;
      // 観測期間の先頭に接する集中は発売直後の自然集中と区別しにくいため減衰する。
      const launchEdgeFactor = frontAnchored ? 0.45 : 1;
      const strength = scanAdjustedStrength * launchEdgeFactor;

      const candidate = {
        ...cluster,
        spanDays,
        expectedRatio,
        excessRatio,
        zScore,
        scanAdjustedStrength,
        frontAnchored,
        launchEdgeFactor,
        strength
      };
      if (!best || candidate.strength > best.strength || (candidate.strength === best.strength && candidate.count > best.count)) {
        best = candidate;
      }
    }

    if (!best) return null;
    const members = best.indices.map((index) => reviews[index]);
    const outside = reviews.filter((_, index) => !best.indices.includes(index) && Number.isFinite(Date.parse(reviews[index].date)));
    const meanStars = (items) => {
      const stars = items.map((review) => review.stars).filter(Number.isFinite);
      return stars.length ? stars.reduce((sum, value) => sum + value, 0) / stars.length : null;
    };
    const highRatio = safeDivide(members.filter((review) => Number(review.stars) >= 4).length, members.length, 0);
    const lowRatio = safeDivide(members.filter((review) => Number(review.stars) <= 2).length, members.length, 0);
    const vineRatio = safeDivide(members.filter((review) => review.vine === true).length, members.length, 0);
    const genericCount = members.filter((review) => getGenericness(review.body) >= 0.68).length;
    const genericRatio = safeDivide(genericCount, members.length, 0);
    const burstMean = meanStars(members);
    const outsideMean = meanStars(outside);

    return {
      ...best,
      highRatio,
      lowRatio,
      vineRatio,
      genericRatio,
      genericLowerBound: wilsonLowerBound(genericCount, members.length),
      highLowerBound: wilsonLowerBound(members.filter((review) => Number(review.stars) >= 4).length, members.length),
      lowLowerBound: wilsonLowerBound(members.filter((review) => Number(review.stars) <= 2).length, members.length),
      burstMean,
      outsideMean,
      ratingShift: Number.isFinite(burstMean) && Number.isFinite(outsideMean) ? Math.abs(burstMean - outsideMean) : null
    };
  }

  function addSignal(signals, id, groupKey, rawPoints, reliability, text, evidence) {
    const effectiveReliability = clamp(Number.isFinite(reliability) ? reliability : 1, 0, 1);
    const points = Math.round(Math.max(0, rawPoints) * effectiveReliability);
    if (points <= 0) return false;
    signals.push({
      id,
      groupKey,
      group: GROUP_LABELS[groupKey] || groupKey,
      rawPoints,
      reliability: roundTo(effectiveReliability, 2),
      points,
      text,
      evidence: evidence || ''
    });
    return true;
  }

  function addObservation(observations, id, text, evidence) {
    observations.push({ id, text, evidence: evidence || '' });
  }

  function getReviewDirection(review) {
    if (Number(review.stars) >= 4) return 'positive';
    if (Number(review.stars) <= 2) return 'negative';
    return 'neutral';
  }

  function analyzeIndividualReviews(reviews, textClusters, temporalBurst, temporalCorroboration = 0) {
    const burstMembers = new Set(temporalBurst?.indices || []);
    const temporalCorroborationStrength = typeof temporalCorroboration === 'boolean'
      ? Number(temporalCorroboration)
      : clamp(Number(temporalCorroboration) || 0, 0, 1);
    const suspiciousBurst = Boolean(
      temporalBurst &&
      temporalCorroborationStrength > 0 &&
      temporalBurst.strength >= 0.45 &&
      temporalBurst.vineRatio < 0.5 &&
      Math.max(temporalBurst.highLowerBound, temporalBurst.lowLowerBound) >= 0.43
    );

    return reviews.map((review, index) => {
      const genericness = getGenericness(review.body);
      const clusterIndex = textClusters.membership[index];
      const cluster = Number.isInteger(clusterIndex) ? textClusters.clusters[clusterIndex] : null;
      let risk = 0.02;

      if (cluster?.size >= 3) {
        const clusterRamp = smoothstep(textClusters.strength, 0.315, 0.385);
        risk += clusterRamp * (
          0.38 +
          Math.min(0.2, (cluster.size - 3) * 0.06) +
          Math.max(0, cluster.averageSimilarity - 0.65) * 0.35
        );
      } else if (cluster?.maximumSimilarity >= 0.9) {
        risk += 0.2;
      }
      // 汎用本文はクラスタ対象外だが、将来の入力互換も考えて二重加算を防ぐ。
      if (!cluster) {
        risk += 0.08 * smoothstep(genericness, 0.612, 0.748);
        risk += 0.06 * smoothstep(genericness, 0.72, 0.88);
      }
      if (review.verified === false && review.vine !== true) risk += 0.07;
      if (suspiciousBurst && burstMembers.has(index)) {
        risk += 0.18 * temporalCorroborationStrength * temporalBurst.strength * smoothstep(temporalBurst.strength, 0.405, 0.495);
      }
      if (PROMOTIONAL_REVIEW_PATTERN.test(String(review.body || ''))) risk += 0.08;
      if (genericness <= 0.2 && charLength(normalizeReviewBody(review.body)) >= 60) risk -= 0.05;
      const helpfulVotes = Math.max(0, Number(review.helpfulVotes) || 0);
      // 参考票は操作される可能性もあるため、加点には使わず最大0.06だけ減衰する。
      risk -= Math.min(0.06, Math.log10(1 + helpfulVotes) * 0.025);
      if (review.vine === true) risk *= 0.35;

      return {
        index,
        direction: getReviewDirection(review),
        genericness,
        clusterIndex,
        inBurst: burstMembers.has(index),
        risk: clamp(risk, 0, 0.9)
      };
    });
  }

  function computeAdjustedRating({ averageRating, distribution, reviews, reviewAnalysis, confidence }) {
    const info = distributionInfo(distribution);
    if (!info.usable || reviews.length < 6 || confidence < 35) return null;

    const baseHistogramRating = getWeightedRating(distribution);
    const baseRating = Number.isFinite(averageRating) ? averageRating : baseHistogramRating;
    if (!Number.isFinite(baseRating)) return null;

    const priorStrength = 4;
    const priorRisk = 0.04;
    const overallRisk = safeDivide(reviewAnalysis.reduce((sum, item) => sum + item.risk, 0), reviewAnalysis.length, priorRisk);
    const bucketRisk = {};

    for (const star of STARS) {
      const matching = reviewAnalysis.filter((item) => Math.round(Number(reviews[item.index]?.stars)) === star);
      const riskSum = matching.reduce((sum, item) => sum + item.risk, 0);
      const fallbackPrior = matching.length ? priorRisk : (priorRisk * 0.6 + overallRisk * 0.4);
      bucketRisk[star] = (priorStrength * fallbackPrior + riskSum) / (priorStrength + matching.length);
    }

    const sampleStars = reviews.map((review) => Number(review.stars)).filter(Number.isFinite);
    const sampleMean = sampleStars.length ? sampleStars.reduce((sum, value) => sum + value, 0) / sampleStars.length : baseRating;
    const distinctStars = new Set(sampleStars.map((value) => Math.round(value))).size;
    const selectionFactor = clamp(1 - Math.abs(sampleMean - baseRating) / 2.5, 0.35, 1);
    const quantityFactor = clamp(reviews.length / 12, 0.4, 1);
    const starCoverageFactor = clamp(0.55 + distinctStars * 0.09, 0.55, 1);
    const correctionStrength = clamp((confidence - 25) / 75, 0, 1) * 0.85 * selectionFactor * quantityFactor * starCoverageFactor;

    const adjustedWeights = {};
    let totalWeight = 0;
    for (const star of STARS) {
      adjustedWeights[star] = info.normalized[star] * (1 - correctionStrength * bucketRisk[star]);
      totalWeight += adjustedWeights[star];
    }
    if (totalWeight <= 0) return null;

    const adjustedHistogramRating = STARS.reduce((sum, star) => sum + star * adjustedWeights[star] / totalWeight, 0);
    const delta = clamp(adjustedHistogramRating - baseHistogramRating, -0.7, 0.7);
    const adjustedRating = clamp(baseRating + delta, 1, 5);

    return {
      rating: roundTo(adjustedRating, 1),
      delta: roundTo(adjustedRating - baseRating, 2),
      strength: roundTo(correctionStrength, 2),
      bucketRisk: Object.fromEntries(STARS.map((star) => [star, roundTo(bucketRisk[star], 3)]))
    };
  }

  function capSignalsByGroup(signals) {
    const grouped = new Map();
    for (const signal of signals) {
      if (!grouped.has(signal.groupKey)) grouped.set(signal.groupKey, []);
      grouped.get(signal.groupKey).push(signal);
    }

    const groupScores = {};
    for (const [groupKey, groupSignals] of grouped) {
      const total = groupSignals.reduce((sum, signal) => sum + signal.points, 0);
      groupScores[groupKey] = Math.min(total, GROUP_CAPS[groupKey] || total);
    }
    for (const groupKey of Object.keys(GROUP_CAPS)) {
      if (!Number.isFinite(groupScores[groupKey])) groupScores[groupKey] = 0;
    }
    return groupScores;
  }

  function calculateConfidence({ averageRating, reviewCount, distribution, title, details, reviews }) {
    const info = distributionInfo(distribution);
    const textCount = reviews.filter((review) => charLength(normalizeReviewBody(review.body)) >= 8).length;
    const datedCount = reviews.filter((review) => Number.isFinite(Date.parse(review.date))).length;
    const provenanceCount = reviews.filter((review) => typeof review.verified === 'boolean' || review.vine === true).length;

    const coverageValues = {
      rating: Number.isFinite(averageRating) && Number.isFinite(reviewCount) ? 1 : 0,
      distribution: info.valid ? 1 : info.usable ? 0.65 : 0,
      listing: title && details ? 1 : title ? 0.5 : 0,
      reviewText: clamp(textCount / 10, 0, 1),
      reviewDates: clamp(datedCount / 10, 0, 1) * safeDivide(datedCount, Math.max(reviews.length, 1), 0),
      provenance: clamp(provenanceCount / 10, 0, 1)
    };
    const weights = { rating: 0.15, distribution: 0.25, listing: 0.1, reviewText: 0.25, reviewDates: 0.15, provenance: 0.1 };
    let confidence = Object.keys(weights).reduce((sum, key) => sum + coverageValues[key] * weights[key], 0) * 100;

    if (!reviews.length) confidence = Math.min(confidence, 45);
    else if (reviews.length < 4) confidence = Math.min(confidence, 55);
    confidence = Math.min(confidence, 86);
    if (info.usable && !info.valid) confidence -= 5;

    const coverage = {
      rating: coverageValues.rating === 1,
      distribution: info.valid,
      listing: coverageValues.listing === 1,
      reviewText: textCount >= 6,
      reviewDates: datedCount >= 6,
      provenance: provenanceCount >= 6
    };

    return {
      value: Math.round(clamp(confidence, 0, 100)),
      label: confidence >= 70 ? '高' : confidence >= 45 ? '中' : '低',
      coverage,
      coverageCount: Object.values(coverage).filter(Boolean).length,
      coverageTotal: Object.keys(coverage).length,
      textCount,
      datedCount,
      provenanceCount,
      distributionInfo: info
    };
  }

  function getLabel(score, sufficient, confidence) {
    if (!sufficient) return { label: '判定材料不足', tone: 'unknown' };
    const suffix = confidence < 45 ? '（低確度）' : '';
    if (score >= 65) return { label: `要注意${suffix}`, tone: 'high' };
    if (score >= 50) return { label: `注意${suffix}`, tone: 'medium' };
    if (score >= 25) return { label: `確認推奨${suffix}`, tone: 'guarded' };
    return { label: '目立つ異常は少ない', tone: 'low' };
  }

  return {
    findTemporalBurst,
    addSignal,
    addObservation,
    getReviewDirection,
    analyzeIndividualReviews,
    computeAdjustedRating,
    capSignalsByGroup,
    calculateConfidence,
    getLabel
  };
});
