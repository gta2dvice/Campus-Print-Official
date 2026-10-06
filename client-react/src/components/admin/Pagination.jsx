export default function Pagination({ page, limit, total, onPage }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) return null;
  return (
    <div className="mt-5 flex items-center justify-center gap-4 text-sm text-gray-600">
      <button
        className="whitespace-nowrap rounded-full border border-gray-200 px-3 py-1.5 text-xs font-semibold max-sm:px-4 max-sm:py-2.5 transition hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-200 disabled:hover:bg-transparent disabled:hover:text-gray-600"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        ← Prev
      </button>
      <span className="whitespace-nowrap">Page {page} of {totalPages}</span>
      <button
        className="whitespace-nowrap rounded-full border border-gray-200 px-3 py-1.5 text-xs font-semibold max-sm:px-4 max-sm:py-2.5 transition hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-200 disabled:hover:bg-transparent disabled:hover:text-gray-600"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
    </div>
  );
}
