/* global React, SIG, Icon, Chip, AnimatedNumber, Sparkline, HELIOS_DATA, FlowViz */
// Helios detail cards — Solar, EV, Powerwall, Cost, Weather. Each expandable.

function CardShell({ signal, label, icon, spark, children, expanded, onToggle, title }) {
  return (
    <div className="h-card" onClick={onToggle}
      style={{ cursor: onToggle ? 'pointer' : 'default', transition: 'background .2s' }}>
      <div className="h-card-head">
        <span style={{ width: 8, height: 8, borderRadius: 2, background: signal }} />
        <span className="label" style={{ color: signal, opacity: 0.9 }}>{label}</span>
        {title && <span style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 6 }}>· {title}</span>}
        {spark && <span className="spark">{spark}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Solar ─────────────────────────────────────────────────
function SolarCard({ state, expanded, onToggle }) {
  const curve = HELIOS_DATA.solarCurve;
  const now = new Date().getHours();
  const max = Math.max(...curve);
  const produced = +(curve.slice(0, now + 1).reduce((a, b) => a + b, 0)).toFixed(1);
  const forecast = +(curve.reduce((a, b) => a + b, 0)).toFixed(1);
  return (
    <CardShell signal="var(--solar)" label="Solar" expanded={expanded} onToggle={onToggle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <span className="h-hero" style={{ fontSize: 52, color: 'var(--solar)' }}>
          <AnimatedNumber value={state.solar_w / 1000} decimals={1} />
        </span>
        <span style={{ fontSize: 16, color: 'var(--text-secondary)', fontWeight: 500 }}>kW</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-tertiary)' }} className="mono">
          of 9.5 peak
        </span>
      </div>
      {/* production curve */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 52, marginBottom: 10 }}>
        {curve.map((v, h) => {
          const isNow = h === now;
          const isPast = h < now;
          const hFr = max ? (v / max) : 0;
          return (
            <div key={h} style={{
              flex: 1,
              height: `${Math.max(2, hFr * 100)}%`,
              background: v === 0 ? 'var(--surface-inset)' : isPast || isNow ? 'var(--solar)' : 'var(--solar-soft)',
              borderRadius: '2px 2px 0 0',
              opacity: v === 0 ? 0.4 : isPast ? 1 : isNow ? 1 : 0.55,
              position: 'relative',
            }}>
              {isNow && v > 0 && (
                <span style={{ position: 'absolute', top: -4, left: '50%', transform: 'translateX(-50%)',
                  width: 4, height: 4, borderRadius: 2, background: 'var(--solar)',
                }} />
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono, monospace' }}>
        <span>06:00</span><span>12:00</span><span>18:00</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '0.5px solid var(--hairline)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
          <Stat label="Today, so far" value={`${produced} kWh`} />
          <Stat label="Forecast total" value={`${forecast} kWh`} />
          <Stat label="Yesterday" value="38.2 kWh" delta="+10%" deltaColor="var(--battery)" />
          <Stat label="Array" value="7× IQ8X" sub="9.5 kW peak" />
        </div>
      )}
    </CardShell>
  );
}

// ── EV ────────────────────────────────────────────────────
function EVCard({ state, expanded, onToggle }) {
  const pct = state.ev_soc;
  const circ = 2 * Math.PI * 40;
  const target = state.ev_target;
  const targetEnd = circ * (1 - target/100);
  const nowEnd = circ * (1 - pct/100);
  const src = state.ev_source;
  return (
    <CardShell signal="var(--vehicle)" label="Rivian R1T" expanded={expanded} onToggle={onToggle}>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
        <svg width="100" height="100" viewBox="0 0 100 100" style={{ flexShrink: 0 }}>
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--surface-inset)" strokeWidth="6" />
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--vehicle-soft)" strokeWidth="6"
            strokeDasharray={`${circ * (target/100)} ${circ}`}
            strokeDashoffset={circ * 0.25}
            strokeLinecap="round" />
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--vehicle)" strokeWidth="6"
            strokeDasharray={`${circ * (pct/100)} ${circ}`}
            strokeDashoffset={circ * 0.25}
            strokeLinecap="round" />
          <text x="50" y="52" textAnchor="middle" fontSize="22" fontWeight="600"
            fontFamily="Inter Display, Inter" fill="var(--text-primary)"
            style={{ fontVariantNumeric: 'tabular-nums' }}>{pct}</text>
          <text x="50" y="66" textAnchor="middle" fontSize="9" fill="var(--text-tertiary)"
            style={{ letterSpacing: '0.1em' }}>PERCENT</text>
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {state.ev_charging ? 'Charging at' : 'Parked'}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
            <span className="h-hero" style={{ fontSize: 26, color: 'var(--text-primary)' }}>
              {state.ev_charging ? <AnimatedNumber value={state.ev_w / 1000} decimals={1} /> : '—'}
            </span>
            {state.ev_charging && <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>kW</span>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono, monospace' }}>
            {state.ev_range} mi range · target {target}%
          </div>
        </div>
      </div>
      {state.ev_charging && (
        <div style={{ marginTop: 14, display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--surface-inset)' }}>
          {src.solar > 0 && <div style={{ width: `${src.solar}%`, background: 'var(--solar)' }} />}
          {src.battery > 0 && <div style={{ width: `${src.battery}%`, background: 'var(--battery)' }} />}
          {src.grid > 0 && <div style={{ width: `${src.grid}%`, background: 'var(--grid)' }} />}
        </div>
      )}
      {state.ev_charging && (
        <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
          {src.solar > 0 && <span><b style={{ color: 'var(--solar)' }}>●</b> {src.solar}% solar</span>}
          {src.battery > 0 && <span><b style={{ color: 'var(--battery)' }}>●</b> {src.battery}% battery</span>}
          {src.grid > 0 && <span><b style={{ color: 'var(--grid)' }}>●</b> {src.grid}% grid</span>}
        </div>
      )}
      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '0.5px solid var(--hairline)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
          <Stat label="Added today" value="32.4 kWh" />
          <Stat label="Est. complete" value="16:48" sub="2h 24m" />
          <Stat label="Departure" value="07:30 Thu" />
          <Stat label="Pack" value="135 kWh" sub="L2 @ 11 kW" />
        </div>
      )}
    </CardShell>
  );
}

// ── Powerwall ─────────────────────────────────────────────
function PowerwallCard({ state, expanded, onToggle }) {
  const pws = HELIOS_DATA.system.powerwalls;
  const direction = state.pw_w > 100 ? 'Charging' : state.pw_w < -100 ? 'Discharging' : 'Idle';
  const hoursLeft = state.pw_w < 0 ? (state.pw_soc/100 * 40.5 / (Math.abs(state.pw_w)/1000)) : null;
  return (
    <CardShell signal="var(--battery)" label="Powerwall" expanded={expanded} onToggle={onToggle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <span className="h-hero" style={{ fontSize: 52, color: 'var(--battery)' }}>
          <AnimatedNumber value={state.pw_soc} decimals={0} />
        </span>
        <span style={{ fontSize: 16, color: 'var(--text-secondary)', fontWeight: 500 }}>%</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-secondary)' }}>
          {direction}{state.pw_w !== 0 && <span className="mono" style={{ marginLeft: 6 }}>{(Math.abs(state.pw_w)/1000).toFixed(1)} kW</span>}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
        {pws.map(p => (
          <div key={p.id} style={{ flex: 1 }}>
            <div style={{ height: 28, borderRadius: 6, background: 'var(--surface-inset)', overflow: 'hidden', display: 'flex', alignItems: 'flex-end' }}>
              <div style={{
                width: '100%', height: `${p.soc}%`,
                background: 'linear-gradient(to top, var(--battery), var(--battery-soft))',
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono, monospace' }}>
              <span>{p.id}</span><span>{p.soc}%</span>
            </div>
          </div>
        ))}
      </div>
      {hoursLeft && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
          ~{hoursLeft.toFixed(1)}h remaining at current load
        </div>
      )}
      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '0.5px solid var(--hairline)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
          <Stat label="Reserve" value={`${state.pw_reserve}%`} sub="automated" />
          <Stat label="Mode" value={state.pw_mode} />
          <Stat label="Capacity" value="40.5 kWh" sub="3 × 13.5" />
          <Stat label="Sunset refill" value="~86%" deltaColor="var(--battery)" />
        </div>
      )}
    </CardShell>
  );
}

// ── Cost ──────────────────────────────────────────────────
function CostCard({ state, expanded, onToggle }) {
  const tou = HELIOS_DATA.tou.find(t => t.period === state.tou_period);
  const sparkData = [3.2, 2.8, 4.1, 3.7, 2.2, 1.9, state.daily_cost];
  return (
    <CardShell signal="var(--alert)" label="Cost today" expanded={expanded} onToggle={onToggle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 32, color: 'var(--text-primary)', fontWeight: 600 }}>$</span>
        <span className="h-hero" style={{ fontSize: 52 }}>
          <AnimatedNumber value={state.daily_cost} decimals={2} />
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{
          padding: '3px 8px', borderRadius: 999, fontSize: 10, letterSpacing: '0.08em',
          textTransform: 'uppercase', fontWeight: 600,
          background: state.tou_period === 'peak' ? 'var(--alert-soft)' : 'var(--surface-inset)',
          color: state.tou_period === 'peak' ? 'var(--alert)' : 'var(--text-secondary)',
        }}>{state.tou_period}</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          ${tou?.rate.toFixed(2)}/kWh · until {tou?.to}
        </span>
        <Sparkline values={sparkData} color="var(--alert)" width={64} height={22} fill />
      </div>
      <div style={{ padding: '10px 12px', background: 'var(--surface-elevated)', borderRadius: 10, fontSize: 13 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
          <span style={{ color: 'var(--text-secondary)' }}>Saved vs naive charging</span>
          <span className="mono" style={{ color: 'var(--battery)', fontWeight: 600 }}>−${state.daily_savings.toFixed(2)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)' }}>
          <span>Naive would have been</span>
          <span className="mono">${(state.daily_cost + state.daily_savings).toFixed(2)}</span>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '0.5px solid var(--hairline)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
          <Stat label="This week" value="$14.20" />
          <Stat label="Month saved" value="$182.40" deltaColor="var(--battery)" />
          <Stat label="Utility" value="PG&E E-TOU-C" />
          <Stat label="Next transition" value={tou?.to} sub="to peak $0.58" />
        </div>
      )}
    </CardShell>
  );
}

// ── Weather ───────────────────────────────────────────────
function WeatherCard({ state, expanded, onToggle }) {
  const data = HELIOS_DATA.forecast24;
  const max = Math.max(...data.map(d => d.solar));
  const week = HELIOS_DATA.forecast7;
  return (
    <CardShell signal="var(--grid)" label="Forecast" expanded={expanded} onToggle={onToggle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <span className="h-hero" style={{ fontSize: 44, color: 'var(--text-primary)' }}>
          <AnimatedNumber value={week[0].kwh} decimals={0} />
        </span>
        <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>kWh forecast today</span>
        <span style={{ marginLeft: 'auto', color: 'var(--solar)' }}><Icon name={week[0].icon} size={22}/></span>
      </div>
      {/* 24h strip with cloud overlay */}
      <div style={{ position: 'relative', height: 48, marginBottom: 10 }}>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 1 }}>
          {data.map((d, i) => (
            <div key={i} style={{
              flex: 1,
              height: `${max ? (d.solar / max) * 100 : 2}%`,
              minHeight: 2,
              background: 'var(--solar-soft)',
              borderRadius: '2px 2px 0 0',
            }} />
          ))}
        </div>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} preserveAspectRatio="none" viewBox="0 0 100 48">
          <path d={`M 0 ${48 - data[0].cloud * 0.45} ${data.map((d, i) => `L ${(i/23)*100} ${48 - d.cloud * 0.45}`).join(' ')}`}
            fill="none" stroke="var(--grid)" strokeWidth="1" strokeDasharray="2 2" opacity="0.6" />
        </svg>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono, monospace' }}>
        <span>NOW</span><span>+6h</span><span>+12h</span><span>+18h</span><span>+24h</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '0.5px solid var(--hairline)' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {week.map(d => (
              <div key={d.day} style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600, letterSpacing: '0.06em' }}>{d.day.toUpperCase()}</div>
                <div style={{ color: 'var(--solar)', margin: '6px 0 4px' }}><Icon name={d.icon} size={18} /></div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--text-primary)' }}>{d.kwh}</div>
                <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>kWh</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </CardShell>
  );
}

// ── Small stat atom ───────────────────────────────────────
function Stat({ label, value, sub, delta, deltaColor }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 17, color: 'var(--text-primary)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
        {value}{delta && <span style={{ fontSize: 12, marginLeft: 6, color: deltaColor || 'var(--text-secondary)' }}>{delta}</span>}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono, monospace' }}>{sub}</div>}
    </div>
  );
}

Object.assign(window, { SolarCard, EVCard, PowerwallCard, CostCard, WeatherCard, Stat });
