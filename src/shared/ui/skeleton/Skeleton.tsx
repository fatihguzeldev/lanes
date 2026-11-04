import './Skeleton.css';

export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`skeleton${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}
