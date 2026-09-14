// tests/render-outline.test.js — src/render/outline.js の DOM に依存しない
// 純粋関数(computeHeadingNumbers / computeIndentLevels)の単体テスト。

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHeadingNumbers, computeIndentLevels } from '../src/render/outline.js';

test('computeHeadingNumbers: 形式は h2=1. h3=1-2. h4=1-2-3.', () => {
  const headings = [{ level: 2 }, { level: 3 }, { level: 4 }];
  assert.deepEqual(computeHeadingNumbers(headings, 6), ['1.', '1-1.', '1-1-1.']);
});

test('computeHeadingNumbers: h1 で数え直す(h1 自体には付かない)', () => {
  const headings = [{ level: 1 }, { level: 2 }, { level: 1 }, { level: 2 }];
  assert.deepEqual(computeHeadingNumbers(headings, 6), [null, '1.', null, '1.']);
});

test('computeHeadingNumbers: 兄弟の h2 が来ると深い階層は数え直される', () => {
  const headings = [{ level: 2 }, { level: 3 }, { level: 2 }, { level: 3 }];
  assert.deepEqual(computeHeadingNumbers(headings, 6), ['1.', '1-1.', '2.', '2-1.']);
});

test('computeHeadingNumbers: 抜けた階層(h2 の次に h4)は 1 として数える', () => {
  const headings = [{ level: 2 }, { level: 4 }];
  assert.deepEqual(computeHeadingNumbers(headings, 6), ['1.', '1-1-1.']);
});

test('computeHeadingNumbers: nonum は番号を付けず、番号も消費しない', () => {
  const headings = [{ level: 2 }, { level: 2, nonum: true }, { level: 2 }];
  assert.deepEqual(computeHeadingNumbers(headings, 6), ['1.', null, '2.']);
});

test('computeHeadingNumbers: nonum の配下(より深い見出し)にも付けず、同じかより浅い見出しで抑制が終わる', () => {
  const headings = [
    { level: 2 }, // 1.
    { level: 2, nonum: true }, // なし
    { level: 3 }, // なし(nonum の配下)
    { level: 3 }, // なし(同上)
    { level: 2 }, // 2.(抑制が終わる)
    { level: 3 }, // 2-1.
  ];
  assert.deepEqual(computeHeadingNumbers(headings, 6), ['1.', null, null, null, '2.', '2-1.']);
});

test('computeHeadingNumbers: depth より深い見出しには付けず、消費もしない', () => {
  const headings = [{ level: 2 }, { level: 3 }, { level: 4 }, { level: 3 }];
  assert.deepEqual(computeHeadingNumbers(headings, 3), ['1.', '1-1.', null, '1-2.']);
});

test('computeIndentLevels: 見出しは level-2 段、本文は直前の見出しの level-1 段', () => {
  const blocks = [
    { headingLevel: 2, isFootnotes: false }, // 0
    { headingLevel: null, isFootnotes: false }, // 1(h2 の本文)
    { headingLevel: 3, isFootnotes: false }, // 1
    { headingLevel: null, isFootnotes: false }, // 2(h3 の本文)
  ];
  assert.deepEqual(computeIndentLevels(blocks), [0, 1, 1, 2]);
});

test('computeIndentLevels: h1 の後・最初の見出しより前は 0 段', () => {
  const blocks = [
    { headingLevel: null, isFootnotes: false }, // 最初の見出しより前
    { headingLevel: 1, isFootnotes: false },
    { headingLevel: null, isFootnotes: false }, // h1 の後
  ];
  assert.deepEqual(computeIndentLevels(blocks), [0, 0, 0]);
});

test('computeIndentLevels: 脚注(section.footnotes・hr.footnotes-sep)は常に 0 段', () => {
  const blocks = [
    { headingLevel: 4, isFootnotes: false }, // 2
    { headingLevel: null, isFootnotes: true }, // 0(hr.footnotes-sep)
    { headingLevel: null, isFootnotes: true }, // 0(section.footnotes)
  ];
  assert.deepEqual(computeIndentLevels(blocks), [2, 0, 0]);
});

test('computeIndentLevels: 5 段でクランプする(h6 の本文)', () => {
  const blocks = [
    { headingLevel: 6, isFootnotes: false }, // 4
    { headingLevel: null, isFootnotes: false }, // 5
  ];
  assert.deepEqual(computeIndentLevels(blocks), [4, 5]);
});
