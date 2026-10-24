'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getWebOrigin, isSecurePermissionOrigin, describePermission, permissionDecisionKey } = require('../src/permissions');

test('permission requests are keyed to a normalized HTTP(S) origin', () => {
  assert.equal(getWebOrigin('https://Example.com:443/path?q=1'), 'https://example.com');
  assert.equal(getWebOrigin('http://localhost:8080/a'), 'http://localhost:8080');
  assert.equal(getWebOrigin('file:///C:/private.txt'), '');
  assert.equal(getWebOrigin('lumo://app/newtab.html'), '');
  assert.equal(getWebOrigin('not a url'), '');
});

test('only explicitly supported permission types can show a prompt', () => {
  assert.equal(describePermission('geolocation'), 'your location');
  assert.equal(describePermission('notifications'), 'desktop notifications');
  assert.equal(describePermission('clipboard-read'), 'the contents of your clipboard');
  assert.equal(describePermission('display-capture'), '');
  assert.equal(describePermission('unknown'), '');
});

test('media prompt describes requested devices accurately', () => {
  assert.equal(describePermission('media', { mediaTypes: ['video'] }), 'your camera');
  assert.equal(describePermission('media', { mediaTypes: ['audio'] }), 'your microphone');
  assert.equal(describePermission('media', { mediaTypes: ['audio', 'video'] }), 'your camera and microphone');
  assert.equal(describePermission('media'), 'your camera or microphone');
});

test('permission decision keys separate sites and permission types', () => {
  assert.equal(permissionDecisionKey('https://example.com/path', 'notifications'), 'https://example.com\u0000notifications');
  assert.notEqual(permissionDecisionKey('https://example.com', 'geolocation'), permissionDecisionKey('https://example.com', 'notifications'));
  assert.notEqual(permissionDecisionKey('https://example.com', 'notifications'), permissionDecisionKey('https://other.example', 'notifications'));
  assert.equal(permissionDecisionKey('https://example.com', 'unknown'), '');
  assert.equal(permissionDecisionKey('file:///tmp/page.html', 'notifications'), '');
});


test('site permissions are limited to HTTPS and loopback HTTP origins', () => {
  assert.equal(isSecurePermissionOrigin('https://example.com'), true);
  assert.equal(isSecurePermissionOrigin('http://localhost:3000'), true);
  assert.equal(isSecurePermissionOrigin('http://127.0.0.1:8080'), true);
  assert.equal(isSecurePermissionOrigin('http://127.22.1.5'), true);
  assert.equal(isSecurePermissionOrigin('http://example.com'), false);
  assert.equal(isSecurePermissionOrigin('file:///tmp/page.html'), false);
});
