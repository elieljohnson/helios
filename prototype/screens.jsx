/* global React, Icon, Chip, AnimatedNumber, FlowViz, HELIOS_DATA,
   SolarCard, EVCard, PowerwallCard, CostCard, WeatherCard, Stat */

// ─────────────────────────────────────────────────────────────
// Home screen — hero + chips + flow + cards
// ─────────────────────────────────────────────────────────────
function HomeScreen({ state, variant, focus, setFocus, onNav, expandedCard, setExpandedCard, scrubTime, now }) {
  const statusColor = state.status_word === 'Alert' ? 'var(--alert)' : 'var(--battery)';
  const heroColor = state.status_word === 'Alert' ? 'var(--alert)' : 'var(--battery)';

  return (
    <div style={{ padding: '16px 16px 120px' }}>
      {/* Status line + settings */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600 }}>
          {HELIOS_DATA.system.location} · <span className="mono" style={{ textTransform: 'none', letterSpacing: 0 }}>{now}</span>
        </div>
        <button onClick={() => onNav('settings')}
          style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', padding: 4, cursor: 'pointer' }}>
          <Icon name="settings" size={18} />
        </button>
      </div>

      {/* HERO: self-sufficiency */}
      <div style={{ marginTop: 12, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span className="h-hero" style={{ fontSize: 92, color: heroColor, lineHeight: 0.9 }}>
            <AnimatedNumber value={state.self_sufficiency} decimals={0} />
          </span>
          <span className="h-hero" style={{ fontSize: 36, color: heroColor, opacity: 0.6 }}>%</span>
        </div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: statusColor }} />
          <span style={{ color: 'var(--text-secondary)', fontSize: 15, fontWeight: 500 }}>
            {state.status_word}
          </span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>· self-sufficient today</span>
        </div>
      </div>

      {/* Chip row moved into flow viz — chips now sit next to each icon */}

      {/* Flow viz */}
      <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0 20px', position: 'relative' }}>
        <FlowViz variant={variant} state={state} size={340} focus={focus}
          onNodeTap={(k) => setFocus(focus === k ? null : k)} />
      </div>

      {scrubTime && (
        <div style={{ marginBottom: 20, padding: '10px 14px', background: 'var(--surface-card)',
          borderRadius: 14, border: '0.5px solid var(--hairline)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
          <Icon name="clock" size={14} />
          <span>Replaying <b style={{ color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace' }}>{scrubTime}</b></span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>time scrub active</span>
        </div>
      )}

      {/* Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SolarCard state={state} expanded={expandedCard === 'solar'} onToggle={() => setExpandedCard(expandedCard === 'solar' ? null : 'solar')} />
        <EVCard state={state} expanded={expandedCard === 'vehicle'} onToggle={() => setExpandedCard(expandedCard === 'vehicle' ? null : 'vehicle')} />
        <PowerwallCard state={state} expanded={expandedCard === 'battery'} onToggle={() => setExpandedCard(expandedCard === 'battery' ? null : 'battery')} />
        <CostCard state={state} expanded={expandedCard === 'cost'} onToggle={() => setExpandedCard(expandedCard === 'cost' ? null : 'cost')} />
        <WeatherCard state={state} expanded={expandedCard === 'weather'} onToggle={() => setExpandedCard(expandedCard === 'weather' ? null : 'weather')} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Activity Timeline
// ─────────────────────────────────────────────────────────────
function ActivityScreen({ onNav }) {
  const [filter, setFilter] = React.useState('all');
  const [expanded, setExpanded] = React.useState(null);
  const filters = [
    { k: 'all', label: 'All' },
    { k: 'reserve', label: 'Reserve', color: 'var(--battery)' },
    { k: 'charge', label: 'Charge', color: 'var(--vehicle)' },
    { k: 'forecast', label: 'Forecast', color: 'var(--grid)' },
    { k: 'alert', label: 'Alerts', color: 'var(--alert)' },
  ];
  const eventColor = (t) => ({
    reserve: 'var(--battery)', charge: 'var(--vehicle)', forecast: 'var(--grid)',
    alert: 'var(--alert)', info: 'var(--text-tertiary)',
  }[t] || 'var(--text-tertiary)');
  const items = HELIOS_DATA.activity.filter(a => filter === 'all' || a.type === filter);

  return (
    <div style={{ padding: '16px 16px 120px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 10 }}>
        Today — 8 automated decisions
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <span className="h-hero" style={{ fontSize: 64 }}>8</span>
        <span style={{ fontSize: 15, color: 'var(--text-secondary)' }}>decisions</span>
      </div>
      <div style={{ color: 'var(--text-tertiary)', fontSize: 13, marginBottom: 20 }}>
        Every reserve change, charge start, and forecast update — logged.
      </div>

      {/* Filter row */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, overflowX: 'auto', paddingBottom: 4 }} className="h-scroll">
        {filters.map(f => (
          <button key={f.k} onClick={() => setFilter(f.k)}
            style={{
              padding: '6px 12px', borderRadius: 999,
              fontSize: 12, fontWeight: 500, letterSpacing: '0.04em',
              background: filter === f.k ? 'var(--text-primary)' : 'var(--surface-card)',
              color: filter === f.k ? 'var(--surface-card)' : 'var(--text-secondary)',
              border: '0.5px solid var(--hairline)',
              cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
            {f.color && <span style={{ width: 6, height: 6, borderRadius: 3, background: f.color }} />}
            {f.label}
          </button>
        ))}
      </div>

      {/* Timeline */}
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', left: 7, top: 8, bottom: 8, width: 1, background: 'var(--hairline)' }} />
        {items.map((a, i) => {
          const isOpen = expanded === i;
          return (
            <div key={i} style={{ position: 'relative', paddingLeft: 28, marginBottom: 12 }}>
              <div style={{
                position: 'absolute', left: 3, top: 8, width: 9, height: 9, borderRadius: '50%',
                background: eventColor(a.type),
                boxShadow: `0 0 0 3px var(--surface-warm)`,
              }} />
              <div onClick={() => setExpanded(isOpen ? null : i)}
                style={{
                  padding: '10px 14px', background: 'var(--surface-card)',
                  borderRadius: 14, border: '0.5px solid var(--hairline)',
                  cursor: 'pointer',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{a.t}</span>
                  <span style={{ flex: 1, fontSize: 14, color: 'var(--text-primary)', fontWeight: 500, lineHeight: 1.35 }}>
                    {a.title}
                  </span>
                </div>
                {isOpen && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--hairline)',
                    fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {a.reason}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Settings — editable TOU, reserve, EV target, departure
// ─────────────────────────────────────────────────────────────
function SettingsScreen({ state, onNav, onReserveChange }) {
  const [reserve, setReserve] = React.useState(state.pw_reserve);
  const [evTarget, setEvTarget] = React.useState(state.ev_target);
  const [departure, setDeparture] = React.useState('07:30');
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [confirmVal, setConfirmVal] = React.useState(null);

  const requestReserveChange = (v) => {
    setConfirmVal(v);
    setConfirmOpen(true);
  };
  const commitReserve = () => {
    setReserve(confirmVal);
    onReserveChange && onReserveChange(confirmVal);
    setConfirmOpen(false);
  };

  return (
    <div style={{ padding: '16px 16px 120px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 10 }}>
        System
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>
        {HELIOS_DATA.system.location}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
        {HELIOS_DATA.system.utility} · IQ8X 9.5 kW · 3× Powerwall · Rivian R1T
      </div>

      {/* Reserve */}
      <Section title="Powerwall reserve" hint="Minimum state-of-charge kept for backup">
        <div className="h-card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
            <span className="h-hero" style={{ fontSize: 40, color: 'var(--battery)' }}>{reserve}</span>
            <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>%</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-tertiary)' }} className="mono">
              ≈ {(reserve/100 * 40.5).toFixed(1)} kWh
            </span>
          </div>
          <ReserveSlider value={reserve} onChange={requestReserveChange} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8, fontFamily: 'JetBrains Mono, monospace' }}>
            <span>0%</span><span>50%</span><span>100%</span>
          </div>
        </div>
      </Section>

      {/* EV target */}
      <Section title="EV charge target" hint="Daily target state-of-charge">
        <div className="h-card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
            <span className="h-hero" style={{ fontSize: 40, color: 'var(--vehicle)' }}>{evTarget}</span>
            <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>%</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-tertiary)' }} className="mono">
              ≈ {Math.round(evTarget/100 * 135 * 3.1)} mi
            </span>
          </div>
          <RangeSlider value={evTarget} min={50} max={100} color="var(--vehicle)" onChange={setEvTarget} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8, fontFamily: 'JetBrains Mono, monospace' }}>
            <span>50%</span><span>75%</span><span>100%</span>
          </div>
        </div>
      </Section>

      {/* Departure */}
      <Section title="Departure" hint="When the EV needs to be ready">
        <div className="h-card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14 }}>
          <Icon name="clock" size={22} color="var(--text-secondary)" />
          <input type="time" value={departure} onChange={(e) => setDeparture(e.target.value)}
            style={{
              border: 'none', background: 'transparent', fontSize: 28, fontWeight: 600,
              fontFamily: 'Inter Display, Inter, system-ui',
              color: 'var(--text-primary)', outline: 'none',
              fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
            }} />
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-tertiary)' }} className="mono">
            Thu, Apr 24
          </span>
        </div>
      </Section>

      {/* TOU schedule */}
      <Section title="Time-of-use schedule" hint="PG&E E-TOU-C periods and rates">
        <div className="h-card" style={{ padding: 16 }}>
          {HELIOS_DATA.tou.map((t, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 0',
              borderBottom: i < HELIOS_DATA.tou.length - 1 ? '0.5px solid var(--hairline)' : 'none',
            }}>
              <span style={{
                padding: '2px 8px', borderRadius: 999, fontSize: 10, letterSpacing: '0.08em',
                textTransform: 'uppercase', fontWeight: 600,
                background: t.period === 'peak' ? 'var(--alert-soft)' : t.period === 'mid-peak' ? 'var(--solar-soft)' : 'var(--surface-inset)',
                color: t.period === 'peak' ? 'var(--alert)' : t.period === 'mid-peak' ? 'var(--solar)' : 'var(--text-secondary)',
              }}>{t.period}</span>
              <span className="mono" style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                {t.from}–{t.to}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--text-primary)', fontWeight: 500 }} className="mono">
                ${t.rate.toFixed(2)}/kWh
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Priority cascade */}
      <Section title="Priority cascade" hint="Drag to reorder. Solar always feeds home first.">
        <div className="h-card" style={{ padding: 8 }}>
          {[
            { name: 'Home load', color: 'var(--home)', icon: 'home', fixed: true },
            { name: 'EV charging', color: 'var(--vehicle)', icon: 'car' },
            { name: 'Powerwall', color: 'var(--battery)', icon: 'battery' },
            { name: 'Grid export', color: 'var(--grid)', icon: 'grid' },
          ].map((p, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '12px 10px',
              borderBottom: i < 3 ? '0.5px solid var(--hairline)' : 'none',
            }}>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono, monospace', width: 14 }}>{i+1}</span>
              <span style={{ color: p.color }}><Icon name={p.icon} size={18} /></span>
              <span style={{ fontSize: 15, color: 'var(--text-primary)', fontWeight: 500 }}>{p.name}</span>
              {p.fixed && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-tertiary)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Fixed</span>}
              {!p.fixed && <span style={{ marginLeft: 'auto', color: 'var(--text-tertiary)', cursor: 'grab' }}>
                <svg width="12" height="18" viewBox="0 0 12 18"><circle cx="3" cy="3" r="1.2" fill="currentColor"/><circle cx="9" cy="3" r="1.2" fill="currentColor"/><circle cx="3" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="3" cy="15" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/></svg>
              </span>}
            </div>
          ))}
        </div>
      </Section>

      {confirmOpen && (
        <ConfirmDialog
          title="Set Powerwall reserve"
          body={<>Change reserve from <b>{reserve}%</b> to <b style={{color:'var(--battery)'}}>{confirmVal}%</b>?
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
              Helios will call <span className="mono">POST /api/reserve</span> via the Tesla Fleet API.
              This overrides the next automation cycle.
            </div></>}
          primary="Confirm"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={commitReserve}
        />
      )}
    </div>
  );
}

function Section({ title, hint, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ marginBottom: 10, padding: '0 4px' }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600 }}>{title}</div>
        {hint && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function RangeSlider({ value, min = 0, max = 100, color = 'var(--battery)', onChange }) {
  const trackRef = React.useRef(null);
  const start = (e) => {
    const set = (clientX) => {
      const r = trackRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const v = Math.round(min + pct * (max - min));
      onChange(v);
    };
    set(e.clientX);
    const move = (ev) => set(ev.clientX);
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div ref={trackRef} onPointerDown={start}
      style={{ height: 28, display: 'flex', alignItems: 'center', position: 'relative', cursor: 'pointer', touchAction: 'none' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 4, borderRadius: 2, background: 'var(--surface-inset)', transform: 'translateY(-50%)' }} />
      <div style={{ position: 'absolute', left: 0, width: `${pct}%`, top: '50%', height: 4, borderRadius: 2, background: color, transform: 'translateY(-50%)' }} />
      <div style={{
        position: 'absolute', left: `${pct}%`, top: '50%',
        transform: 'translate(-50%, -50%)', width: 22, height: 22, borderRadius: '50%',
        background: 'var(--surface-card)', border: `1.5px solid ${color}`,
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
      }} />
    </div>
  );
}

function ReserveSlider(props) { return <RangeSlider {...props} color="var(--battery)" />; }

function ConfirmDialog({ title, body, primary, onCancel, onConfirm }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 1000 }}
      onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 420, background: 'var(--surface-elevated)', borderRadius: '22px 22px 0 0',
          padding: 24, fontFamily: 'var(--font-sans)' }}>
        <div style={{ fontSize: 19, fontWeight: 600, marginBottom: 10, letterSpacing: '-0.01em' }}>{title}</div>
        <div style={{ fontSize: 15, color: 'var(--text-primary)', lineHeight: 1.5, marginBottom: 22 }}>{body}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} className="h-btn" style={{ flex: 1 }}>Cancel</button>
          <button onClick={onConfirm} className="h-btn primary" style={{ flex: 1 }}>{primary}</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { HomeScreen, ActivityScreen, SettingsScreen, ConfirmDialog, RangeSlider });
