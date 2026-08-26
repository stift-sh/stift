export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" fill="#202020" rx="6" />
      <rect x="24" y="4" width="4" height="4" fill="#ff682c" />
      <text x="16" y="23" fontFamily="'Inter Tight', 'Inter', sans-serif" fontSize="20" fill="#ffffff" textAnchor="middle">
        S
      </text>
    </svg>
  );
}
