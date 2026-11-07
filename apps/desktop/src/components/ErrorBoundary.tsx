import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  /** Shown above the technical detail; should name the area that failed. */
  title: string;
  children: ReactNode;
  /** Remounts the boundary when it changes — used to retry after navigation. */
  resetKey?: string;
};

type State = { error: Error | null };

/**
 * Keeps one broken page from taking the whole app down.
 *
 * Without this, a render-time throw anywhere below the router unmounts the entire
 * tree and the user sees a blank window with no way back — the daemon is fine, the
 * data is fine, but the app is gone until they restart it. The boundary catches the
 * throw, keeps the shell (navigation still works) and offers a retry.
 *
 * It does not catch async failures; those are handled at the call site as values,
 * which is where a retry can be meaningful.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console is the only channel a local-first desktop app has before any remote
    // telemetry is configured; the message includes the component stack so a user
    // pasting a bug report gives something actionable.
    console.error('render failed', error, info.componentStack);
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="panel error-panel error-boundary" role="alert">
        <div className="panel-title">{this.props.title} 出错了</div>
        <p className="hint">
          这一页没能渲染，其他页面不受影响。项目数据还在磁盘上，没有丢失。
        </p>
        <pre className="output error-detail">{this.state.error.message}</pre>
        <div className="row">
          <button className="btn sm" onClick={() => this.setState({ error: null })}>
            重试这一页
          </button>
          <button className="btn sm" onClick={() => window.location.reload()}>
            重新加载应用
          </button>
        </div>
      </div>
    );
  }
}
