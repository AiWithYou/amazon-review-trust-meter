'use strict';
// Compare the checked-in v2.1 implementation with the current implementation.
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const current = require('../scoring-base.js');
const revision = process.argv[2] || 'v2.1.0';
const baselineSource = execFileSync('git', ['show', `${revision}:scoring-base.js`], { encoding: 'utf8' });
const baselineModule = { exports: {} };
// Same V8 realm for both versions, with only the CommonJS exports supplied.
new Function('module', baselineSource)(baselineModule);
const baseline = baselineModule.exports;
const cases = [
  ['short-20', 20, 1], ['long-20', 20, 18], ['mixed-24', 24, 4]
].map(([name, size, repeats]) => ({ name, reviews: Array.from({ length: size }, (_, i) => ({
  body: (`${i % 3 === 0 ? '通勤で毎日使用。音声が明瞭で接続も安定し、電池は十分持ちます。' : '机で使うと振動が少し気になりますが、操作と充電は簡単でした。'}使用条件${i}、室温${20 + i}度。`).repeat(repeats)
})) }));
function measure(fn, reviews) {
  for (let i = 0; i < 30; i++) fn(reviews);
  const timings = [];
  for (let round = 0; round < 9; round++) {
    const begin = performance.now();
    for (let i = 0; i < 30; i++) fn(reviews);
    timings.push((performance.now() - begin) / 30);
  }
  return timings.sort((a,b) => a-b)[4];
}
const result = cases.map(({name, reviews}) => {
  assert.deepEqual(current.findTextClusters(reviews), baseline.findTextClusters(reviews));
  const before = measure(baseline.findTextClusters, reviews);
  const after = measure(current.findTextClusters, reviews);
  return { name, baselineMs: +before.toFixed(3), currentMs: +after.toFixed(3), speedup: +(before / after).toFixed(2), identical: true };
});
console.log(JSON.stringify({ node: process.version, revision, statistic: 'median of 9 batches, 30 calls per batch, 30 warmups', result }, null, 2));
