'use strict';

const { isWebUrl } = require('./core');

const MAX_BOOKMARKS = 500;
const MAX_BOOKMARK_TITLE = 500;

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&#x([\da-f]{1,6});/gi, (_match, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&#(\d{1,7});/g, (_match, code) => safeCodePoint(parseInt(code, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function safeCodePoint(code) {
  try { return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; }
  catch { return ''; }
}

function cleanTitle(rawTitle, url, stripMarkup = false) {
  const raw = String(rawTitle ?? '');
  const displayText = stripMarkup ? raw.replace(/<[^>]*>/g, ' ') : raw;
  const title = decodeHtmlEntities(displayText)
    .replace(/\s+/g, ' ').trim().slice(0, MAX_BOOKMARK_TITLE);
  return title || url;
}

function normalizeBookmarkRecord(item, now = Date.now()) {
  if (!item || typeof item !== 'object' || !isWebUrl(item.url)) return null;
  let url;
  try { url = new URL(item.url).toString(); } catch { return null; }
  return {
    url,
    title: cleanTitle(item.title, url),
    addedAt: Number.isFinite(item.addedAt) && item.addedAt > 0 ? item.addedAt : now,
  };
}

function dedupeBookmarks(items, limit = MAX_BOOKMARKS) {
  const out = [];
  const seen = new Set();
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_BOOKMARKS) : MAX_BOOKMARKS;
  for (const candidate of Array.isArray(items) ? items : []) {
    const bookmark = normalizeBookmarkRecord(candidate);
    if (!bookmark || seen.has(bookmark.url)) continue;
    seen.add(bookmark.url);
    out.push(bookmark);
    if (out.length >= safeLimit) break;
  }
  return out;
}

function parseJsonBookmarks(text) {
  const parsed = JSON.parse(text);
  const rawItems = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.bookmarks) ? parsed.bookmarks : null;
  if (!rawItems) throw new Error('The JSON file must contain a bookmarks array.');
  return dedupeBookmarks(rawItems);
}

function parseNetscapeBookmarks(text) {
  const bookmarks = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchorPattern.exec(text)) && bookmarks.length < MAX_BOOKMARKS) {
    const attributes = match[1] || '';
    const hrefMatch = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const rawUrl = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '';
    const url = decodeHtmlEntities(rawUrl.trim());
    if (!isWebUrl(url)) continue;
    const title = cleanTitle(match[2], url, true);
    const addedAtMatch = attributes.match(/\badd_date\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i);
    const rawDate = addedAtMatch?.[1] ?? addedAtMatch?.[2] ?? addedAtMatch?.[3];
    const seconds = rawDate ? Number(rawDate) : 0;
    bookmarks.push({ url, title, addedAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now() });
  }
  return dedupeBookmarks(bookmarks);
}

function parseBookmarkImport(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!source) throw new Error('The selected bookmark file is empty.');
  if (source.startsWith('[') || source.startsWith('{')) return parseJsonBookmarks(source);
  const parsed = parseNetscapeBookmarks(source);
  if (!parsed.length) throw new Error('No valid HTTP or HTTPS bookmarks were found in this file.');
  return parsed;
}

function bookmarksToNetscapeHtml(items) {
  const bookmarks = dedupeBookmarks(items);
  const escape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const entries = bookmarks.map((item) => {
    const timestamp = Math.floor((item.addedAt || Date.now()) / 1000);
    return `    <DT><A HREF="${escape(item.url)}" ADD_DATE="${timestamp}">${escape(item.title || item.url)}</A>`;
  }).join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Lumo Bookmarks</TITLE>\n<H1>Lumo Bookmarks</H1>\n<DL><p>\n${entries}\n</DL><p>\n`;
}

function mergeImportedBookmarks(existing, incoming, limit = MAX_BOOKMARKS) {
  // Existing entries are retained first so importing a large file cannot evict
  // bookmarks already stored in Lumo. Imported duplicates are ignored by URL.
  const current = dedupeBookmarks(existing, limit);
  const seen = new Set(current.map((item) => item.url));
  const result = [...current];
  let added = 0;
  for (const item of dedupeBookmarks(incoming, MAX_BOOKMARKS)) {
    if (seen.has(item.url) || result.length >= limit) continue;
    seen.add(item.url);
    result.push(item);
    added += 1;
  }
  return { bookmarks: result, added, duplicates: Math.max(0, dedupeBookmarks(incoming).length - added) };
}

module.exports = { MAX_BOOKMARKS, normalizeBookmarkRecord, dedupeBookmarks, parseBookmarkImport, bookmarksToNetscapeHtml, mergeImportedBookmarks };
