// tests/workspace.test.js
//
// src/fs/workspace.js の DOM に依存しない部分(命名規則・純粋なエラー判定関数)
// を node:test で検証する。FSA API 呼び出しそのものはブラウザ専用のため
// dev/harness.mjs 側の E2E で検証する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDB_NAME, IDB_STORE, isTransientFsError, ConflictError } from '../src/fs/workspace.js';

test('IndexedDB の名前空間には mdpreview の接頭辞が付いている(task-kanri と保存領域を共有するため)', () => {
  assert.ok(IDB_NAME.startsWith('mdpreview'), `IDB_NAME=${IDB_NAME} は mdpreview で始まっていません`);
  assert.ok(IDB_STORE.length > 0);
});

test('isTransientFsError: SMB 由来の一時的なエラーを一時的と判定する', () => {
  assert.equal(isTransientFsError({ name: 'InvalidStateError' }), true);
  assert.equal(isTransientFsError({ name: 'NoModificationAllowedError' }), true);
  assert.equal(isTransientFsError({ message: 'The file or directory state had changed' }), true);
  assert.equal(isTransientFsError({ message: 'state cached is stale' }), true);
});

test('isTransientFsError: 恒久的なエラーは一時的と判定しない', () => {
  assert.equal(isTransientFsError({ name: 'NotFoundError' }), false);
  assert.equal(isTransientFsError(new Error('plain error')), false);
  assert.equal(isTransientFsError(undefined), false);
});

test('isTransientFsError: 保存時の競合(ConflictError)は再試行しない', () => {
  assert.equal(isTransientFsError(new ConflictError()), false);
});
