// One service worker per fcd: the root comes from the bundle's address, and
// a family page at <root>/f/<id>/ registers the root's worker too.

import { describe, expect, it } from 'vitest';
import { rootOf } from './pwa.ts';

describe('service worker root', () => {
  it('is the app root, or the root of the fcd for a /f/ family', () => {
    expect(rootOf('https://chat.example/assets/main-1.js').href).toBe('https://chat.example/');
    expect(rootOf('https://chat.example/f/abcdefghijklmnop/assets/main-1.js').href).toBe('https://chat.example/');
    expect(rootOf('https://example.org/chat/f/abcdefghijklmnop/assets/main-1.js').href).toBe('https://example.org/chat/');
    expect(rootOf('https://example.org/chat/assets/main-1.js').href).toBe('https://example.org/chat/');
    // Not a family id: left as it is.
    expect(rootOf('https://example.org/f/notanid/assets/x.js').href).toBe('https://example.org/f/notanid/');
  });
});
