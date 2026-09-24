export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <rect x="1" y="1" width="38" height="38" rx="11" fill="var(--color-ink-900)" stroke="rgba(255,255,255,.1)" />
      {/* twin grid */}
      <path d="M8 14h24M8 20h24M8 26h24M14 8v24M20 8v24M26 8v24" stroke="rgba(255,255,255,.07)" strokeWidth="1" />
      {/* heat pulse */}
      <path d="M7 24h7l3-9 5 15 3-8h8" fill="none" stroke="#f5f6f8" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
