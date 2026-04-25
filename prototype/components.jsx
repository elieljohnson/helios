/* global React */
// Helios shared UI components — chips, number counter, signal dots, icons.

const SIG = {
  solar:   { main: 'var(--solar)',   soft: 'var(--solar-soft)' },
  battery: { main: 'var(--battery)', soft: 'var(--battery-soft)' },
  vehicle: { main: 'var(--vehicle)', soft: 'var(--vehicle-soft)' },
  grid:    { main: 'var(--grid)',    soft: 'var(--grid-soft)' },
  home:    { main: 'var(--home)',    soft: 'var(--home-soft)' },
  alert:   { main: 'var(--alert)',   soft: 'var(--alert-soft)' },
};

// Monoline Lucide-ish icons, stroke 1.5, rounded terminals.
function Icon({ name, size = 18, color = 'currentColor', strokeWidth = 1.5 }) {
  const s = size;
  const p = { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'sun': return (
      <svg {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
    );
    case 'cloud-sun': return (
      <svg {...p}><path d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41"/><circle cx="9" cy="9" r="3"/><path d="M13 16a4 4 0 00-4-4 4 4 0 00-4 4 3 3 0 000 6h11a3 3 0 00-3-6z"/></svg>
    );
    case 'cloud': return (<svg {...p}><path d="M17 18H7a4 4 0 01-.44-7.97 6 6 0 0111.66-1.12A4 4 0 0117 18z"/></svg>);
    case 'rain': return (<svg {...p}><path d="M17 14H7a4 4 0 01-.44-7.97 6 6 0 0111.66-1.12A4 4 0 0117 14z"/><path d="M9 17v4M13 17v4M17 17v4"/></svg>);
    case 'bolt': return (<svg {...p}><path d="M13 2L4.5 13h6L11 22l8.5-11h-6L13 2z"/></svg>);
    case 'battery': return (<svg {...p}><rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 11v2"/><path d="M6 10v4M10 10v4M14 10v4"/></svg>);
    case 'car': return (<svg {...p}><path d="M5 17h14M6 17v3M18 17v3M3 13l2-5a3 3 0 013-2h8a3 3 0 013 2l2 5v4H3v-4z"/><circle cx="7.5" cy="13.5" r="1"/><circle cx="16.5" cy="13.5" r="1"/></svg>);
    case 'home': return (<svg {...p}><path d="M3 11l9-8 9 8v10a1 1 0 01-1 1h-5v-7h-6v7H4a1 1 0 01-1-1V11z"/></svg>);
    case 'grid': return (<svg {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/><circle cx="12" cy="12" r="4"/></svg>);
    case 'activity': return (<svg {...p}><path d="M3 12h4l3-9 4 18 3-9h4"/></svg>);
    case 'settings': return (<svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9 1.65 1.65 0 004.27 7.18l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>);
    case 'arrow-right': return (<svg {...p}><path d="M5 12h14M13 5l7 7-7 7"/></svg>);
    case 'chevron-right': return (<svg {...p}><path d="M9 5l7 7-7 7"/></svg>);
    case 'chevron-down': return (<svg {...p}><path d="M5 9l7 7 7-7"/></svg>);
    case 'plus': return (<svg {...p}><path d="M12 5v14M5 12h14"/></svg>);
    case 'check': return (<svg {...p}><path d="M20 6L9 17l-5-5"/></svg>);
    case 'info': return (<svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 8v.01M11 12h1v4h1"/></svg>);
    case 'alert': return (<svg {...p}><path d="M10.3 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17v.01"/></svg>);
    case 'clock': return (<svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>);
    case 'wind': return (<svg {...p}><path d="M9.59 4.59A2 2 0 1111 8H2M12.59 19.41A2 2 0 1014 16H2M17.73 7.73A2.5 2.5 0 1119.5 12H2"/></svg>);
    case 'zap': return (<svg {...p}><path d="M13 2L4.5 13h6L11 22l8.5-11h-6L13 2z"/></svg>);
    case 'dollar': return (<svg {...p}><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>);
    case 'tune': return (<svg {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>);
    case 'play': return (<svg {...p}><path d="M6 4l14 8-14 8V4z" fill="currentColor"/></svg>);
    case 'pause': return (<svg {...p}><rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none"/></svg>);
    default: return null;
  }
}

// Animated counter. Smoothly eases toward target.
function useAnimatedNumber(value, duration = 700) {
  const [n, setN] = React.useState(value);
  const fromRef = React.useRef(value);
  const startRef = React.useRef(0);
  React.useEffect(() => {
    fromRef.current = n;
    startRef.current = performance.now();
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - startRef.current) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      setN(fromRef.current + (value - fromRef.current) * e);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line
  }, [value]);
  return n;
}

function AnimatedNumber({ value, decimals = 1, className = '', style }) {
  const n = useAnimatedNumber(value);
  return (
    <span className={`tnum ${className}`} style={style}>{n.toFixed(decimals)}</span>
  );
}

// Status chip — the Rivian chip row
function Chip({ color = 'var(--text-secondary)', label, value, active = false, onClick, ariaLabel }) {
  return (
    <button
      type="button"
      className="chip"
      onClick={onClick}
      aria-label={ariaLabel || label}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        borderColor: active ? color : 'var(--hairline)',
        boxShadow: active ? `inset 0 0 0 1px ${color}` : 'none',
      }}
    >
      <span className="dot" style={{ background: color }} />
      <span>{label}</span>
      {value !== undefined && <span className="val">{value}</span>}
    </button>
  );
}

// Tiny sparkline
function Sparkline({ values, color = 'var(--text-secondary)', width = 64, height = 20, fill = false }) {
  if (!values || !values.length) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const w = width, h = height;
  const stepX = w / (values.length - 1 || 1);
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = h - ((v - min) / (max - min || 1)) * (h - 2) - 1;
    return [x, y];
  });
  const d = 'M' + pts.map(p => p.join(',')).join(' L ');
  const area = d + ` L ${w},${h} L 0,${h} Z`;
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      {fill && <path d={area} fill={color} opacity="0.18" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

Object.assign(window, { SIG, Icon, useAnimatedNumber, AnimatedNumber, Chip, Sparkline });
