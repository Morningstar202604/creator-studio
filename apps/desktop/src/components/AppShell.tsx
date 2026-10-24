import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useDaemon } from '../app/DaemonProvider';
import { api, apiExtra, type Approval, type BudgetSettings, type ModelInfo, type Usage } from '../api';
import { useTheme } from '../lib/theme';
import { formatCny } from '../lib/format';

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

type ShellData = {
  pending: number;
  budget: BudgetSettings | null;
  model: ModelInfo | null;
  spend: number;
};

function useShellData(): ShellData {
  const [pending, setPending] = useState(0);
  const [budget, setBudget] = useState<BudgetSettings | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [spend, setSpend] = useState(0);

  const load = useCallback(async () => {
    try {
      const [approvals, budgetResult, models, usage] = await Promise.all([
        api.listApprovals('pending'),
        api.getBudget(),
        api.listModels(),
        apiExtra.usage().catch(() => null),
      ]);
      setPending(approvals.approvals.length);
      setBudget(budgetResult.budget);
      setModel(models.models[0] ?? null);
      if (usage !== null) setSpend(usage.totals.cost);
    } catch {
      // Shell chrome is decorative; page-level errors carry the real message.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return { pending, budget, model, spend };
}

export function TopBar({ title }: { title: ReactNode }): React.ReactElement {
  const { connection, staleDaemon, health } = useDaemon();
  const { mode, setMode } = useTheme();
  const { pending, budget, model, spend } = useShellData();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        window.location.hash = '#/approvals';
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const overBudget = budget !== null && budget.monthlyCostCny > 0 && spend > budget.monthlyCostCny;
  const nearBudget =
    budget !== null && budget.monthlyCostCny > 0 && spend > budget.monthlyCostCny * (budget.warnAtPercent / 100);

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="返回项目列表">
          <span className="brand-mark" aria-hidden="true">
            稿
          </span>
          <span className="brand-text">
            <span className="wordmark">稿台</span>
            <span className="wordmark-sub">Creator Studio</span>
          </span>
        </Link>
        <div className="crumb">{title}</div>
        <div className="topbar-right">
          <button
            className="ghost-chip"
            onClick={() => setPaletteOpen(true)}
            aria-label="打开命令面板"
            title="命令面板 (Ctrl+K)"
          >
            <span aria-hidden="true">⌕</span>
            <span className="kbd">Ctrl K</span>
          </button>
          {budget !== null && (
            <span
              className={`chip${overBudget || nearBudget ? ' warn' : ''}`}
              title="本月模型花费 / 预算上限"
            >
              <span className="dot" />
              {formatCny(spend)} / {formatCny(budget.monthlyCostCny)}
            </span>
          )}
          {model !== null && (
            <NavLink
              to="/settings"
              className={`chip model-chip${model.keyConfigured === false ? ' warn' : ''}`}
              title={
                model.keyConfigured === false
                  ? '这个模型还没有密钥，去设置里填入后才能生成'
                  : `${model.baseUrl} · ${model.model}`
              }
            >
              {model.name}
              {model.keyConfigured === false ? '（缺密钥）' : ''}
            </NavLink>
          )}
          <NavLink to="/approvals" className={({ isActive }) => `chip approval-chip${isActive ? ' active' : ''}`}>
            <span className="dot" />
            待办 {pending}
          </NavLink>
          {staleDaemon && (
            <span className="chip warn" title="正在运行的 daemon 版本早于当前界面，请完全退出后重新打开">
              <span className="dot" />
              daemon 版本过旧（pid {health?.pid ?? '?'}）
            </span>
          )}
          <span className={`chip ${connection}`} title={connection === 'online' ? health?.workspaceRoot : undefined}>
            <span className="dot" />
            {connection === 'online' ? '本地已连接' : connection === 'checking' ? '连接中' : 'daemon 未启动'}
          </span>
          <button
            className="icon-btn"
            title={`主题：${mode === 'system' ? '跟随系统' : mode === 'dark' ? '深色' : '浅色'}`}
            aria-label="切换主题"
            onClick={() => setMode(mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light')}
          >
            {mode === 'light' ? '☀' : mode === 'dark' ? '☾' : '◐'}
          </button>
        </div>
      </header>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  );
}

type PaletteItem = { id: string; label: string; hint: string; to: string };

function CommandPalette({ onClose }: { onClose: () => void }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [projectItems, setProjectItems] = useState<PaletteItem[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    inputRef.current?.focus();
    void api
      .listProjects()
      .then((result) =>
        setProjectItems(
          result.projects.slice(0, 20).map((project) => ({
            id: project.id,
            label: project.title,
            hint: `项目 · ${project.stage}`,
            to: `/p/${project.id}`,
          })),
        ),
      )
      .catch(() => setProjectItems([]));
  }, []);

  const staticItems: PaletteItem[] = [
    { id: 'new', label: '新建项目', hint: '主页右上角', to: '/' },
    { id: 'runs', label: '任务', hint: '所有运行记录', to: '/runs' },
    { id: 'approvals', label: '待办', hint: '需要你决定的事', to: '/approvals' },
    { id: 'library', label: '资料库', hint: '跨项目产物', to: '/library' },
    { id: 'automations', label: '自动化', hint: '定时生成', to: '/automations' },
    { id: 'settings', label: '设置', hint: '模型 / 权限 / 预算', to: '/settings' },
  ];

  const items = useMemo(() => {
    const all = [...projectItems, ...staticItems];
    if (query.trim() === '') return all;
    const needle = query.trim().toLowerCase();
    return all.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(needle));
  }, [projectItems, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const choose = (item: PaletteItem | undefined): void => {
    if (item === undefined) return;
    navigate(item.to);
    onClose();
  };

  return (
    <div className="palette-backdrop" role="presentation" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="搜索项目、跳到页面…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, items.length - 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            }
            if (event.key === 'Enter') choose(items[active]);
          }}
        />
        <ul className="palette-list" role="listbox">
          {items.length === 0 && <li className="palette-empty">没有匹配项</li>}
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                className={`palette-item${index === active ? ' active' : ''}`}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(item)}
              >
                <span className="palette-label">{item.label}</span>
                <span className="hint">{item.hint}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="palette-foot hint">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  );
}

export function SideNav(): React.ReactElement {
  const { pending } = useShellData();
  return (
    <nav className="sidenav" aria-label="主导航">
      <div className="nav-group">
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
            <span className="nav-label">{item.label}</span>
            {item.to === '/approvals' && pending > 0 && <span className="nav-badge">{pending}</span>}
          </NavLink>
        ))}
      </div>
      <div className="nav-foot">
        <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <span className="nav-icon" aria-hidden="true">
            ⚙
          </span>
          <span className="nav-label">设置</span>
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

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: ReactNode;
}): React.ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        ▤
      </div>
      <h2>{title}</h2>
      <p className="hint">{hint}</p>
      {action !== undefined && <div className="row center">{action}</div>}
    </div>
  );
}

export function PageHead({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
}): React.ReactElement {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle !== undefined && <div className="page-sub">{subtitle}</div>}
      </div>
      <div className="spacer" />
      {children}
    </div>
  );
}

export function ApprovalList({
  approvals,
  onDecide,
  onResume,
}: {
  approvals: Approval[];
  onDecide: (id: string, decision: 'approved' | 'rejected') => Promise<void>;
  onResume?: (runId: string, approvalId: string) => Promise<void>;
}): React.ReactElement {
  return (
    <div className="appr-list">
      {approvals.map((approval) => (
        <article key={approval.id} className={`appr ${approval.kind === 'delete' ? 'risk-high' : 'risk-mid'}`}>
          <div className="appr-top">
            <span className={`badge ${approval.kind === 'delete' ? 'danger' : 'warn'}`}>{approval.kind}</span>
            <span className="when">{new Date(approval.requestedAt).toLocaleString('zh-CN')}</span>
          </div>
          <div className="appr-body">
            Run <code>{approval.runId.slice(0, 8)}</code> · step <code>{approval.stepId}</code>
          </div>
          <div className="appr-actions">
            <button className="btn sm" onClick={() => void onDecide(approval.id, 'rejected')}>
              拒绝
            </button>
            <button className="btn sm primary" onClick={() => void onDecide(approval.id, 'approved')}>
              批准
            </button>
            {onResume !== undefined && (
              <button className="btn sm" onClick={() => void onResume(approval.runId, approval.id)}>
                批准并继续执行
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

export type { Usage };
