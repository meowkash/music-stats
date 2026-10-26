import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashText } from '../src/utils/persist/generations';

const vectors = ['', 'abc', 'Beyoncé 🎵\n東京', 'x'.repeat(1024 * 1024 + 1)];
const expected = vectors.map(text => createHash('sha256').update(text).digest('hex').slice(0, 16));
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
try {
  for (const crypto of [globalThis.crypto, undefined, { subtle: { digest: async () => { throw new Error('Unavailable'); } } }]) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: crypto });
    assert.deepEqual(await Promise.all(vectors.map(hashText)), expected);
  }
} finally {
  if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  else Reflect.deleteProperty(globalThis, 'crypto');
}
assert.notEqual(await hashText('verified'), await hashText('modified'));
console.log('SHA-256 matches Node for native, unavailable, and failing Web Crypto, including Unicode and large input.');
