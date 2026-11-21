import { useToasts, useRoute } from './hooks';
import { usePoll } from './hooks';
import { Dashboard } from './pages/Dashboard';
import { Monitor } from './pages/Monitor';
import { Moments } from './pages/Moments';
import { Missions } from './pages/Missions';
import { Studio } from './pages/Studio';
import { Approval } from './pages/Approval';
import { Publishing } from './pages/Publishing';
import { Analytics } from './pages/Analytics';
import { Settings } from './pages/Settings';

const NAV = [
  { path: '/', label: 'Dashboard', icon: '◉' },
  { path: '/monitor', label: 'Live Monitor', icon: '📡' },
  { path: '/moments', label: 'Detected Moments', icon: '⚡' },
  { path: '/missions', label: 'Missions', icon: '🎯' },
  { path: '/studio', label: 'Clip Studio', icon: '🎬' },
  { path: '/approval', label: 'Approval Queue', icon: '✅' },
  { path: '/publishing', label: 'Publishing', icon: '🚀' },
  { path: '/analytics', label: 'Analytics', icon: '📈' },
  { path: '/settings', label: 'Settings', icon: '⚙️' },
];

const busyCount = (c?: Record<string, number>) => (c?.active || 0) + (c?.waiting || 0) + (c?.delayed || 0);

export function App() {
  const { path, query } = useRoute();
  const toasts = useToasts();
  const { data: dash } = usePoll<any>('/api/dashboard', 8000);
  const pending = dash?.clips?.ready || 0;

  const section = '/' + (path.split('/')[1] || '');
  let page;
  if (section === '/monitor') page = <Monitor />;
  else if (section === '/moments') page = <Moments query={query} />;
  else if (section === '/missions') page = <Missions />;
  else if (section === '/studio') page = <Studio clipId={path.split('/')[2]} />;
  else if (section === '/approval') page = <Approval />;
  else if (section === '/publishing') page = <Publishing />;
  else if (section === '/analytics') page = <Analytics />;
  else if (section === '/settings') page = <Settings query={query} />;
  else page = <Dashboard />;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="logo">▶</div>
          <div>
            <b>ClipBit</b>
            <div className="muted small">AI Shorts from live streams</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <a key={n.path} href={`#${n.path}`} className={section === n.path ? 'active' : ''}>
              <span className="nav-icon">{n.icon}</span>
              {n.label}
              {n.path === '/approval' && pending > 0 && <span className="pill">{pending}</span>}
            </a>
          ))}
        </nav>
        <div className="side-foot muted small">
          {dash ? (
            <>
              <div>{dash.streams?.live || 0} live · {busyCount(dash.queues?.analyze)} analysing</div>
              <div>{busyCount(dash.queues?.render)} rendering · {busyCount(dash.queues?.upload)} uploading</div>
            </>
          ) : (
            'connecting…'
          )}
        </div>
      </aside>
      <main className="main">{page}</main>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}
