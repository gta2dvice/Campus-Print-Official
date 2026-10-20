# Frontend Performance Audit Plan

This plan outlines the deep-dive audit of the frontend performance for the Campus Print project.

## 1. Asset Audit
- **Images**: Identify oversized images in `client-react/public` and `client-react/public/assets`. Check for missing WebP/AVIF formats.
- **SVGs**: Analyze `cp.svg`, `favicon.svg`, and `icons.svg` for unnecessary complexity or lack of optimization.
- **Fonts**: Inspect `client-react/src/index.css` and `client-react/src/styles/*.css` for font loading strategies (swap, preload).

## 2. Animation Analysis
- **rAF Loops**: Analyze `client-react/src/lib/floatingLines.js` for `requestAnimationFrame` efficiency and cleanup.
- **CSS Filters**: Audit `client-react/src/styles/*.css` for `backdrop-filter: blur()` and `filter: blur()` usage, especially on large elements or during scrolls.
- **Scroll Effects**: Review `client-react/src/pages/Home.jsx` for `window.addEventListener('scroll')` and `IntersectionObserver` implementation. Verify cleanup in `useEffect` return functions.

## 3. Rendering Patterns
- **Re-renders**: Examine `client-react/src/pages/Home.jsx` and other large pages for inefficient state updates (e.g., `setFiles` in a loop or expensive calculations inside the render body).
- **Expensive Calculations**: Review `calcPrice` and `getFileCost` in `Home.jsx` to see if they should be memoized with `useMemo`.
- **Context Usage**: Analyze `client-react/src/context/AuthContext` for potential broad re-renders when auth state changes.

## 4. Bundle Analysis
- **Library Weights**: Check `client-react/package.json` for heavy dependencies (e.g., `three.js`).
- **Code Splitting**: Inspect `client-react/src/App.jsx` to see if major routes (Admin, Super Admin, Home) are lazy-loaded using `React.lazy` and `Suspense`.

## 5. CSS/Layout Audit
- **Layout Thrashing**: Search for patterns where DOM reads (e.g., `getBoundingClientRect`) are interleaved with writes in `Home.jsx` or `floatingLines.js`.
- **DOM Nesting**: Inspect the structure of the `Home` page and Admin dashboards for excessive nesting.
- **Expensive Selectors**: Review `client-react/src/styles/*.css` for overly complex selectors.

## 6. Interaction Analysis
- **Input Latency**: Trace the path from file upload (`handleUploadClick` -> `addFiles` -> `detectPagesFor`) to UI updates in `Home.jsx`.
- **Blocking Tasks**: Identify any synchronous heavy operations (like PDF page counting in `countPdfPagesClient`) that might block the main thread.

## Deliverables
- A detailed report with absolute file paths and line numbers for every identified bottleneck.
- Specific recommendations for each finding.
