/* global React, ReactDOM, IOSDevice, HomeScreen, ActivityScreen, SettingsScreen,
   Icon, HELIOS_DATA, useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakSlider */
// Helios App — mobile prototype rendered inside an iOS frame.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "scenario": "optimized",
  "variant": "bar",
  "dark": false,
  "hueShift": 0,
  "density": "comfortable"
}/*EDITMODE-END*/;

function HeliosApp({ frame = true, variant, scenario, dark, density, hueShift = 0, standalone = false }) {
  const [tab, setTab] = React.useState('home');
  const [focus, setFocus] = React.useState(null);
  const [expandedCard, setExpandedCard] = React.useState(null);
  const [scrubTime, setScrubTime] = React.useState(null);
  const [manualReserve, setManualReserve] = React.useState(null);
  const [toast, setToast] = React.useState(null);

  // Live 1-sec jitter on state to feel alive
  const baseState = HELIOS_DATA.scenarios[scenario] || HELIOS_DATA.scenarios.optimized;
  const [jitter, setJitter] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setJitter(Math.random()), 2000);
    return () => clearInterval(t);
  }, []);

  const state = React.useMemo(() => {
    const s = { ...baseState };
    if (s.solar_w > 0) s.solar_w = Math.round(s.solar_w + (jitter - 0.5) * 400);
    if (s.ev_w > 0) s.ev_w = Math.round(s.ev_w + (jitter - 0.5) * 200);
    s.home_w = Math.round(s.home_w + (jitter - 0.5) * 120);
    if (manualReserve !== null) s.pw_reserve = manualReserve;
    return s;
  }, [baseState, jitter, manualReserve]);

  const now = new Date().toTimeString().slice(0, 5);

  const onReserveChange = (v) => {
    setManualReserve(v);
    setToast(`Reserve set to ${v}% · POST /api/reserve`);
    setTimeout(() => setToast(null), 2800);
  };

  const content = (
    <div className={`helios theme-${dark ? 'dark' : 'light'} density-${density || 'comfortable'}`}
      style={{
        background: 'var(--surface-warm)',
        minHeight: '100%',
        position: 'relative',
        color: 'var(--text-primary)',
        filter: hueShift ? `hue-rotate(${hueShift}deg)` : 'none',
      }}>
      {/* top safe area when in iOS frame */}
      <div style={{ height: frame ? 58 : 0 }} />

      {tab === 'home' && (
        <HomeScreen
          state={state}
          variant={variant}
          focus={focus}
          setFocus={setFocus}
          onNav={setTab}
          expandedCard={expandedCard}
          setExpandedCard={setExpandedCard}
          scrubTime={scrubTime}
          now={now}
        />
      )}
      {tab === 'activity' && <ActivityScreen onNav={setTab} />}
      {tab === 'settings' && <SettingsScreen state={state} onNav={setTab} onReserveChange={onReserveChange} />}

      {/* Time scrubber — home only */}
      {tab === 'home' && (
        <TimeScrubber setScrubTime={setScrubTime} scrubTime={scrubTime} />
      )}

      {/* Tab bar */}
      <TabBar tab={tab} setTab={setTab} />

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'absolute', bottom: 110, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--text-primary)', color: 'var(--surface-card)',
          padding: '10px 16px', borderRadius: 999, fontSize: 13, fontWeight: 500,
          whiteSpace: 'nowrap', boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
          zIndex: 200,
        }}>{toast}</div>
      )}
    </div>
  );

  if (!frame) return content;

  return (
    <IOSDevice dark={dark} width={402} height={874}>
      {content}
    </IOSDevice>
  );
}

function TabBar({ tab, setTab }) {
  const tabs = [
    { k: 'home', icon: 'home', label: 'Home' },
    { k: 'activity', icon: 'activity', label: 'Activity' },
    { k: 'settings', icon: 'settings', label: 'Settings' },
  ];
  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0,
      padding: '10px 16px 26px',
      background: 'linear-gradient(to top, var(--surface-warm) 60%, transparent)',
      display: 'flex', justifyContent: 'center',
      zIndex: 100,
    }}>
      <div style={{
        display: 'flex', gap: 4,
        background: 'var(--surface-card)',
        border: '0.5px solid var(--hairline)',
        borderRadius: 999, padding: 4,
      }}>
        {tabs.map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            style={{
              border: 'none', background: tab === t.k ? 'var(--surface-elevated)' : 'transparent',
              color: tab === t.k ? 'var(--text-primary)' : 'var(--text-tertiary)',
              padding: '9px 16px', borderRadius: 999, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 13, fontWeight: 500,
              fontFamily: 'var(--font-sans)',
              transition: 'all .15s',
            }}>
            <Icon name={t.icon} size={15} />
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TimeScrubber({ setScrubTime, scrubTime }) {
  const [playing, setPlaying] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [h, setH] = React.useState(new Date().getHours());

  React.useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setH(x => {
        const next = (x + 1) % 24;
        setScrubTime(`${String(next).padStart(2,'0')}:00`);
        return next;
      });
    }, 400);
    return () => clearInterval(t);
  }, [playing, setScrubTime]);

  const set = (hh) => { setH(hh); setScrubTime(`${String(hh).padStart(2,'0')}:00`); };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{
          position: 'absolute', bottom: 92, right: 16, zIndex: 90,
          width: 38, height: 38, borderRadius: '50%',
          background: 'var(--surface-card)', border: '0.5px solid var(--hairline)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-secondary)', cursor: 'pointer',
        }} title="Replay today">
        <Icon name="clock" size={18} />
      </button>
    );
  }

  return (
    <div style={{
      position: 'absolute', bottom: 92, left: 16, right: 16, zIndex: 90,
      background: 'var(--surface-card)', border: '0.5px solid var(--hairline)',
      borderRadius: 18, padding: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <button onClick={() => setPlaying(p => !p)}
          style={{ width: 32, height: 32, borderRadius: 16, background: 'var(--text-primary)',
            color: 'var(--surface-card)', border: 'none', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Icon name={playing ? 'pause' : 'play'} size={14} color="var(--surface-card)"/>
        </button>
        <span className="mono" style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 600 }}>
          {String(h).padStart(2,'0')}:00
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>replay today</span>
        <button onClick={() => { setOpen(false); setPlaying(false); setScrubTime(null); }}
          style={{ border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0, fontSize: 14 }}>✕</button>
      </div>
      <input type="range" min={0} max={23} step={1} value={h}
        onChange={(e) => set(+e.target.value)}
        style={{ width: '100%' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-tertiary)',
        fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>
        <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
      </div>
    </div>
  );
}

Object.assign(window, { HeliosApp, TWEAK_DEFAULTS });
