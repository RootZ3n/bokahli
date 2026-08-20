import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPathLike, isValidModelId, isValidDigest } from '../dist/identity.js';

// The public-identity boundary is the whole point of Bokahli's EXACT mode.
// If any of these regress, a filesystem path can become a model identity.
test('filesystem paths are never valid identities', () => {
  for (const bad of [
    '/home/zen/models/Qwen_Qwen3.5-35B-A3B-Q2_K.gguf',
    'Qwen_Qwen3.5-35B-A3B-Q2_K.gguf',
    './models/x.gguf',
    '~/models/x.gguf',
    'C:\\models\\x.gguf',
    'models/x.safetensors',
    'x.bin',
    'x.onnx',
  ]) {
    assert.equal(isPathLike(bad), true, `${bad} should be path-like`);
    assert.equal(isValidModelId(bad), false, `${bad} must not be a valid modelId`);
  }
});

test('stable catalog identities are accepted', () => {
  for (const good of ['qwen3.5-35b-a3b.q2-k', 'a', 'llama3.1-8b.q4-k-m']) {
    assert.equal(isValidModelId(good), true, `${good} should be valid`);
  }
});

test('uppercase, spaces, and empty are rejected', () => {
  for (const bad of ['Qwen3.5', 'model name', '', '-leading-dash']) {
    assert.equal(isValidModelId(bad), false, `${bad} must be rejected`);
  }
});

test('digests must be sha256:<64 hex>', () => {
  assert.equal(isValidDigest(`sha256:${'a'.repeat(64)}`), true);
  assert.equal(isValidDigest(`sha256:${'A'.repeat(64)}`), false, 'uppercase hex rejected');
  assert.equal(isValidDigest(`sha256:${'a'.repeat(63)}`), false, 'short digest rejected');
  assert.equal(isValidDigest('a'.repeat(64)), false, 'bare hex without prefix rejected');
  assert.equal(isValidDigest('md5:' + 'a'.repeat(32)), false, 'non-sha256 rejected');
  assert.equal(isValidDigest(undefined), false);
});
