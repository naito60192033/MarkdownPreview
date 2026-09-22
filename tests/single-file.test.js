// tests/single-file.test.js — src/fs/single-file.js の単体テスト
//
// 「1 ファイルだけのワークスペース」を装う偽ハンドルが、fs/workspace.js の
// 期待(NotFoundError で「無い」と判断する)どおりに振る舞うことを確かめる。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFileRoot, WRITE_DENIED_MESSAGE } from '../src/fs/single-file.js';
import { readTextByPath, readBlobByPath, getFileHandleByPath } from '../src/fs/workspace.js';

function fakeFileHandle(name, text, { permission = 'granted' } = {}) {
  const calls = { query: 0, request: 0 };
  return {
    calls,
    kind: 'file',
    name,
    async getFile() {
      return { lastModified: 1000, async text() { return text; } };
    },
    async queryPermission() {
      calls.query++;
      return permission;
    },
    async requestPermission() {
      calls.request++;
      return 'granted';
    },
  };
}

test('自分自身は readTextByPath で読める', async () => {
  const root = createSingleFileRoot(fakeFileHandle('memo.md', '# こんにちは'));
  const result = await readTextByPath(root, 'memo.md');
  assert.deepEqual(result, { text: '# こんにちは', lastModified: 1000 });
});

test('他のファイルは NotFoundError になり、readTextByPath は null を返す', async () => {
  const root = createSingleFileRoot(fakeFileHandle('memo.md', 'x'));
  assert.equal(await readTextByPath(root, 'style.css'), null);
  assert.equal(await readTextByPath(root, 'other.md'), null);
});

test('フォルダを挟んだパス(画像・@import)も null になり、例外にはならない', async () => {
  const root = createSingleFileRoot(fakeFileHandle('memo.md', 'x'));
  assert.equal(await readBlobByPath(root, 'images/memo/a.png'), null);
  assert.equal(await readTextByPath(root, '共通/用語.md'), null);
});

test('create: true(新規作成・画像の保存)は分かる文言の Error になる', async () => {
  const root = createSingleFileRoot(fakeFileHandle('memo.md', 'x'));
  await assert.rejects(
    () => getFileHandleByPath(root, 'images/memo/a.png', { create: true }),
    (e) => e.message === WRITE_DENIED_MESSAGE
  );
  await assert.rejects(
    () => getFileHandleByPath(root, 'new.md', { create: true }),
    (e) => e.message === WRITE_DENIED_MESSAGE
  );
});

test('values() は自分自身だけを返す', async () => {
  const fh = fakeFileHandle('memo.md', 'x');
  const root = createSingleFileRoot(fh);
  const names = [];
  for await (const entry of root.values()) names.push(entry.name);
  assert.deepEqual(names, ['memo.md']);
});

test('ensureWritePermission: 既に許可済みなら要求しない', async () => {
  const fh = fakeFileHandle('memo.md', 'x', { permission: 'granted' });
  const root = createSingleFileRoot(fh);
  assert.equal(await root.ensureWritePermission(), true);
  assert.equal(fh.calls.request, 0, '許可済みなのに requestPermission を呼んでいます');
});

test('ensureWritePermission: 未許可なら要求し、許可されたら true', async () => {
  const fh = fakeFileHandle('memo.md', 'x', { permission: 'prompt' });
  const root = createSingleFileRoot(fh);
  assert.equal(await root.ensureWritePermission(), true);
  assert.equal(fh.calls.request, 1);
});

test('ensureWritePermission: 拒否されたら false', async () => {
  const fh = fakeFileHandle('memo.md', 'x', { permission: 'prompt' });
  fh.requestPermission = async () => 'denied';
  const root = createSingleFileRoot(fh);
  assert.equal(await root.ensureWritePermission(), false);
});

test('isSingleFile と fileName で、画面側が単体表示だと判定できる', () => {
  const root = createSingleFileRoot(fakeFileHandle('障害対応.md', 'x'));
  assert.equal(root.isSingleFile, true);
  assert.equal(root.fileName, '障害対応.md');
  assert.equal(root.kind, 'directory');
});
