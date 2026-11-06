export function Brand({ large = false }: { large?: boolean }) {
  return (
    <span className={`site-brand${large ? ' site-brand--large' : ''}`}>
      <span className="site-brand__mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      lanes
    </span>
  );
}
