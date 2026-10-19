/** Renders the horizontal ripped-paper background used across the app. */
export default function PageBackground({ className = '' }) {
  return (
    <div
      className={`page-background ${className}`.trim()}
      id="page-background"
      aria-hidden="true"
    />
  );
}
