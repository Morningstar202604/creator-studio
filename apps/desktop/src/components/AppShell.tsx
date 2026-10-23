import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useDaemon } from '../app/DaemonProvider';

const NAV_ITEMS: Array<{ to: string; label: string; icon: string }> = [
  { to: '/', label: '项目', icon: '▤' },
  { to: '/runs', label: '任务', icon: '◷' },
  { to: '/approvals', label: '待办', icon: '◑' },
  { to: '/library', label: '资料库', icon: '▧' },
  { to: '/automations', label: '自动化', icon: '◔' },
];

export function SkipLink(): React.ReactElement {
  return (
    <a className="skip" href="#main">
      跳到主内容
    </a>
  );
}

export function TopBar({ title }: { title: ReactNode }): React.ReactElement {
  const { connection, staleDaemon, health } = useDaemon();
  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label="返回项目列表">
        <span className="wordmark">稿台</span>
        <span className="wordmark-sub">创作制片台</span>
      </Link>
      <div className="crumb">{title}</div>
      <div className="topbar-right">
        {staleDaemon && (
          <span className="chip warn" title="正在运行的 daemon 版本早于当前界面，请完全退出后重新打开">
            <span className="dot" />
            daemon 版本过旧（pid {health?.pid ?? '?'}）
          </span>
        )}
        <span className={`chip ${connection}`}>
          <span className="dot" />
          {connection === 'online' ? '本地 daemon 已连接' : connection === 'checking' ? '连接中' : 'daemon 未启动'}
        </span>
      </div>
    </header>
  );
}

export function SideNav(): React.ReactElement {
  return (
    <nav className="sidenav" aria-label="主导航">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          <span className="nav-icon" aria-hidden="true">
            {item.icon}
          </span>
          {item.label}
        </NavLink>
      ))}
      <div className="nav-foot">
        <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <span className="nav-icon" aria-hidden="true">
            ⚙
          </span>
          设置
        </NavLink>
      </div>
    </nav>
  );
}

export function AppShell({ title, children }: { title: ReactNode; children: ReactNode }): React.ReactElement {
  return (
    <>
      <SkipLink />
      <div className="app">
        <TopBar title={title} />
        <div className="shell">
          <SideNav />
          <main className="main" id="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
