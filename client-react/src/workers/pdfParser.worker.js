// This worker handles CPU-intensive PDF page counting off the main thread.
self.onmessage = async (e) => {
  const { type, file } = e.data;

  if (type === 'COUNT_PAGES') {
    try {
      if (!file) {
        self.postMessage({ type: 'COUNT_RESULT', pages: null, error: 'No file provided' });
        return;
      }

      // Read the file into an ArrayBuffer
      const buffer = await file.arrayBuffer();

      // Decode as latin1 to search for PDF metadata tags
      const text = new TextDecoder('latin1').decode(new Uint8Array(buffer));

      // Strategy 1: Look for /Count tags
      const counts = [...text.matchAll(/\/Count\s+(\d+)/gi)]
        .map((m) => parseInt(m[1], 10))
        .filter((c) => !isNaN(c) && c > 0);

      if (counts.length > 0) {
        self.postMessage({ type: 'COUNT_RESULT', pages: Math.max(...counts), error: null });
        return;
      }

      // Strategy 2: Count occurrences of /Page type tags
      const pageMatches = [...text.matchAll(/\/Type\s*\/Page\b/gi)];
      if (pageMatches.length > 0) {
        self.postMessage({ type: 'COUNT_RESULT', pages: pageMatches.length, error: null });
        return;
      }

      self.postMessage({ type: 'COUNT_RESULT', pages: null, error: 'Could not detect page count' });
    } catch (error) {
      self.postMessage({ type: 'COUNT_RESULT', pages: null, error: error.message });
    }
  }
};
