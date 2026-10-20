export async function countPdfPages(file) {
  return new Promise((resolve) => {
    // Initialize worker using the Vite-compatible URL pattern
    const worker = new Worker(
      new URL('../workers/pdfParser.worker.js', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e) => {
      const { type, pages, error } = e.data;
      if (type === 'COUNT_RESULT') {
        worker.terminate();
        if (error) {
          console.warn('PDF Worker Error:', error);
          resolve(null);
        } else {
          resolve(pages);
        }
      }
    };

    worker.onerror = (err) => {
      console.error('PDF Worker Fatal Error:', err);
      worker.terminate();
      resolve(null);
    };

    // Send the file to the worker
    worker.postMessage({ type: 'COUNT_PAGES', file });
  });
}
