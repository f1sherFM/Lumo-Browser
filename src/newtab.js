'use strict';

const form = document.getElementById('searchForm');
const input = document.getElementById('searchInput');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  try {
    const result = await window.lumoNewTab.search(query);
    if (!result?.ok && result?.error) {
      input.setCustomValidity(result.error);
      input.reportValidity();
      input.setCustomValidity('');
    }
  } catch {
    input.setCustomValidity('Could not start the search. Try the address bar instead.');
    input.reportValidity();
    input.setCustomValidity('');
  }
});

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    input.focus({ preventScroll: true });
    input.select();
  }
});

let introPlayed = false;
function playIntroOnce() {
  if (introPlayed) return;
  introPlayed = true;
  const root = document.documentElement;
  const motionClass = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'motion-reduced'
    : 'motion-intro';
  // The stylesheet keeps content hidden until this class is applied, so no fully
  // rendered frame can flash before the entrance animation starts. The animation
  // class and readiness flag are applied together in the same frame.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.classList.add(motionClass, 'motion-ready');
  }));
}

if (typeof window.lumoNewTab?.onActivated === 'function') {
  window.lumoNewTab.onActivated(playIntroOnce);
}

window.addEventListener('DOMContentLoaded', () => input.focus({ preventScroll: true }));
