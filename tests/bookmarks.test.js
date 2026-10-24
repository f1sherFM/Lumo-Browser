'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseBookmarkImport,
  bookmarksToNetscapeHtml,
  mergeImportedBookmarks,
  dedupeBookmarks,
} = require('../src/bookmarks');

test('imports standard Netscape bookmark HTML and decodes entities', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
    <DL><p>
      <DT><A HREF="https://example.com/?a=1&amp;b=2" ADD_DATE="1700000000">Research &amp; Notes</A>
      <DT><A HREF='https://second.example/'>Second site</A>
      <DT><A HREF="javascript:alert(1)">Unsafe</A>
    </DL>`;
  const parsed = parseBookmarkImport(html);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, 'https://example.com/?a=1&b=2');
  assert.equal(parsed[0].title, 'Research & Notes');
  assert.equal(parsed[0].addedAt, 1700000000 * 1000);
  assert.equal(parsed[1].title, 'Second site');
});

test('imports Lumo JSON bookmark arrays and rejects non-web addresses', () => {
  const parsed = parseBookmarkImport(JSON.stringify({ bookmarks: [
    { url: 'https://example.com/', title: 'Example' },
    { url: 'file:///secret.txt', title: 'No' },
    { url: 'https://example.com/', title: 'Duplicate' },
  ] }));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'Example');
  assert.throws(() => parseBookmarkImport('{"notBookmarks":[]}'), /bookmarks array/);
  assert.throws(() => parseBookmarkImport('<html><body>nothing here</body></html>'), /No valid/);
});

test('exports standard bookmark HTML and can round-trip it', () => {
  const original = [
    { url: 'https://example.com/path?a=1&b=2', title: 'Research & Notes', addedAt: 1700000000000 },
    { url: 'https://another.example/', title: '<Second>', addedAt: 1700000001000 },
  ];
  const html = bookmarksToNetscapeHtml(original);
  assert.match(html, /NETSCAPE-Bookmark-file-1/);
  assert.match(html, /Research &amp; Notes/);
  assert.match(html, /&lt;Second&gt;/);
  const restored = parseBookmarkImport(html);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].url, original[0].url);
  assert.equal(restored[0].title, original[0].title);
});

test('bookmark deduplication is by URL and import never evicts existing bookmarks', () => {
  const existing = [{ url: 'https://saved.example/', title: 'Saved', addedAt: 1 }];
  const incoming = [
    { url: 'https://saved.example/', title: 'Duplicate' },
    { url: 'https://new.example/', title: 'New' },
  ];
  const merged = mergeImportedBookmarks(existing, incoming, 10);
  assert.equal(merged.added, 1);
  assert.equal(merged.duplicates, 1);
  assert.deepEqual(merged.bookmarks.map((item) => item.url), ['https://saved.example/', 'https://new.example/']);
  assert.equal(dedupeBookmarks([...incoming, ...incoming]).length, 2);
});
