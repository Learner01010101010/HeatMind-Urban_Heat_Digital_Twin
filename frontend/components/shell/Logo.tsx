export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <defs>
        <linearGradient id="hm-logo" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="0.55" stopColor="#facc15" />
          <stop offset="1" stopColor="#ef4444" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="11" fill="#0e1420" stroke="rgba(255,255,255,.08)" />
      {/* twin grid */}
      <path d="M8 14h24M8 20h24M8 26h24M14 8v24M20 8v24M26 8v24" stroke="rgba(255,255,255,.07)" strokeWidth="1" />
      {/* heat pulse */}
      <path d="M7 24h7l3-9 5 15 3-8h8" fill="none" stroke="url(#hm-logo)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
