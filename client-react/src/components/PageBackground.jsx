import { useEffect, useRef } from 'react';

const LINES_GRADIENT = ['#2563EB', '#38BDF8', '#60A5FA'];
const MOBILE_QUERY = '(max-width: 768px)';

function isMobile() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getConfig() {
  const mobile = isMobile();
  return {
    linesGradient: LINES_GRADIENT,
    enabledWaves: ['top', 'middle', 'bottom'],
    lineCount: mobile ? [3, 4, 3] : [5, 7, 5],
    lineDistance: [8, 6, 8],
    animationSpeed: 0.45,
    interactive: !mobile,
    parallax: !mobile,
    bendRadius: 5,
    bendStrength: -0.35,
    mouseDamping: 0.06,
    parallaxStrength: 0.12,
    mixBlendMode: 'normal',
    lowPower: mobile
  };
}

function schedule(fn) {
  const start = () => requestAnimationFrame(fn);
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(start, { timeout: 400 });
  } else {
    window.setTimeout(start, 0);
  }
}

/** Renders the animated Three.js background used on Home/About/Select-Location/Ticket. */
export default function PageBackground() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let dispose = () => {};
    let cancelled = false;
    let media;
    let onChange;

    schedule(async () => {
      if (cancelled) return;
      try {
        const { mountFloatingLines } = await import('../lib/floatingLines.js');
        if (cancelled) return;
        dispose = mountFloatingLines(el, getConfig()) || (() => {});

        media = window.matchMedia(MOBILE_QUERY);
        onChange = () => {
          dispose();
          el.replaceChildren();
          dispose = mountFloatingLines(el, getConfig()) || (() => {});
        };
        if (media.addEventListener) media.addEventListener('change', onChange);
        else media.addListener(onChange);
      } catch (error) {
        console.warn('FloatingLines failed to load, using static fallback.', error);
      }
    });

    return () => {
      cancelled = true;
      dispose();
      if (media) {
        if (media.removeEventListener) media.removeEventListener('change', onChange);
        else media.removeListener(onChange);
      }
      el.replaceChildren();
    };
  }, []);

  return <div className="page-background" id="page-background" ref={ref} />;
}
