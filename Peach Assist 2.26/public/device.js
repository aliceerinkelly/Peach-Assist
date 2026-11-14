/* Labels the page with the device it is running on, before anything is painted.
   Sets data-os, data-form and data-orient on <html>, plus --vh so a phone's
   collapsing URL bar cannot cut the layout short. No dependencies, ~1 KB. */
(function () {
  var ua = navigator.userAgent || '';
  var touchPoints = navigator.maxTouchPoints || 0;

  var os = 'other';
  if (/iPhone|iPad|iPod/i.test(ua)) os = 'ios';
  else if (/Android/i.test(ua)) os = 'android';
  else if (/Windows/i.test(ua)) os = 'windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'mac';
  else if (/CrOS/i.test(ua)) os = 'chromeos';
  else if (/Linux/i.test(ua)) os = 'linux';

  // iPadOS 13 and later pretend to be a Mac; the touch points give it away.
  if (os === 'mac' && touchPoints > 1) os = 'ios';

  var width = 0;
  var height = 0;

  function measure() {
    width = window.innerWidth || document.documentElement.clientWidth || 0;
    height = window.innerHeight || document.documentElement.clientHeight || 0;
  }

  function formFactor() {
    var touch = touchPoints > 0 || 'ontouchstart' in window;
    if (!touch) return width < 700 ? 'narrow' : 'desktop';
    if (width < 600) return 'phone';
    if (width < 1024) return 'tablet';
    return 'desktop';
  }

  function apply() {
    measure();
    var root = document.documentElement;
    root.setAttribute('data-os', os);
    root.setAttribute('data-form', formFactor());
    root.setAttribute('data-orient', height >= width ? 'portrait' : 'landscape');
    // 1% of the real viewport height, so CSS can avoid 100vh on phones.
    root.style.setProperty('--vh', (height * 0.01) + 'px');
  }

  apply();

  var queued = false;
  function onResize() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; apply(); });
  }

  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });

  // For scripts that need to branch on the device.
  window.deviceInfo = {
    os: os,
    form: function () { return formFactor(); },
    width: function () { return width; },
    height: function () { return height; },
    isPhone: function () { return formFactor() === 'phone'; }
  };
})();
