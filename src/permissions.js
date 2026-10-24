'use strict';

// Permissions deliberately start with a small, reviewable allowlist. Unknown
// permissions (including device enumeration, screen capture and external-app
// launch requests) are denied until Lumo has an explicit policy for them.
const PROMPTABLE_PERMISSIONS = Object.freeze({
  geolocation: 'your location',
  notifications: 'desktop notifications',
  media: 'your camera or microphone',
  'clipboard-read': 'the contents of your clipboard',
});

function getWebOrigin(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl ?? ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch {
    return '';
  }
}


function isSecurePermissionOrigin(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl ?? ''));
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'http:') return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]') return true;
    const ipv4 = hostname.split('.').map((part) => Number(part));
    return ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && ipv4[0] === 127;
  } catch {
    return false;
  }
}

function describePermission(permission, details = {}) {
  if (!Object.prototype.hasOwnProperty.call(PROMPTABLE_PERMISSIONS, permission)) return '';
  if (permission !== 'media') return PROMPTABLE_PERMISSIONS[permission];

  const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  const wantsVideo = types.includes('video');
  const wantsAudio = types.includes('audio');
  if (wantsVideo && wantsAudio) return 'your camera and microphone';
  if (wantsVideo) return 'your camera';
  if (wantsAudio) return 'your microphone';
  return PROMPTABLE_PERMISSIONS.media;
}

function permissionDecisionKey(originOrUrl, permission) {
  const origin = getWebOrigin(originOrUrl);
  if (!origin || !describePermission(permission)) return '';
  return `${origin}\u0000${permission}`;
}

module.exports = {
  PROMPTABLE_PERMISSIONS,
  getWebOrigin,
  isSecurePermissionOrigin,
  describePermission,
  permissionDecisionKey,
};
