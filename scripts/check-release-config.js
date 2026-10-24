'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const iconPath = path.join(root, pkg.build?.win?.icon || '');

assert.equal(pkg.productName, 'Lumo', 'Product name must remain Lumo.');
assert.equal(pkg.version, lock.version, 'package.json and package-lock.json versions must match.');
assert.equal(pkg.version, lock.packages?.['']?.version, 'Lockfile root package version must match package.json.');
assert.ok(pkg.build?.appId, 'A stable application ID is required for Windows packaging.');
assert.equal(pkg.build?.asar, true, 'Packaged app should use ASAR.');
assert.ok(fs.existsSync(iconPath), `Windows icon is missing: ${iconPath}`);
assert.ok(fs.existsSync(path.join(root, 'src', 'permissions.js')), 'Site permission policy module is missing.');
assert.ok(fs.existsSync(path.join(root, 'src', 'bookmarks.js')), 'Bookmark import/export module is missing.');
const newTabHtml = fs.readFileSync(path.join(root, 'src', 'newtab.html'), 'utf8');
assert.match(newTabHtml, /href="https:\/\/www\.cscastart\.com\/"/, 'CSCA Start quick link must use the confirmed www hostname.');
assert.ok(pkg.build?.extraResources?.some((item) => item.from === 'assets/lumo.ico' && item.to === 'assets/lumo.ico'), 'Runtime window icon must be copied to resources.');
assert.ok(pkg.build?.win?.target?.some((item) => (typeof item === 'string' ? item : item.target) === 'nsis'), 'NSIS installer target is required.');
assert.ok(pkg.build?.win?.target?.some((item) => (typeof item === 'string' ? item : item.target) === 'portable'), 'Portable target is required.');
assert.ok(pkg.scripts?.['dist:win:installer'] && pkg.scripts?.['dist:win:portable'] && pkg.scripts?.['pack:win'], 'Expected Windows packaging scripts are missing.');

const header = Buffer.alloc(6);
const fd = fs.openSync(iconPath, 'r');
try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
assert.equal(header.readUInt16LE(0), 0, 'Icon file has invalid reserved header.');
assert.equal(header.readUInt16LE(2), 1, 'Icon file is not an ICO resource.');
assert.ok(header.readUInt16LE(4) > 0, 'Icon file contains no images.');

console.log(`[Lumo] Release config OK (${pkg.version}); Windows installer and portable targets are configured.`);
