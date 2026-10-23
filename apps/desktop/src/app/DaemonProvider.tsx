import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, REQUIRED_CAPABILITIES, api, type Health, type ToolInfo } from '../api';

export type ConnectionState = 'checking' | 'online' | 'offline';

type DaemonContextValue = {
  connection: ConnectionState;
  health: Health | null;
  tools: ToolInfo[];
  lastError: string | null;
  /** True when the running daemon predates routes this UI needs. */
  staleDaemon: boolean;
  refresh: () => Promise<void>;
};

const DaemonContext = createContext<DaemonContextValue>({
  connection: 'checking',
  health: null,
  tools: [],
  lastError: null,
  staleDaemon: false,
  refresh: async () => {},
});

const RETRY_MS = 2000;

export function DaemonProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [health, setHealth] = useState<Health | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [staleDaemon, setStaleDaemon] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api.health();
      setHealth(result);
      const missing = REQUIRED_CAPABILITIES.filter(
        (capability) => !(result.capabilities ?? []).includes(capability),
      );
      setStaleDaemon(missing.length > 0);
      setConnection(result.ok ? 'online' : 'offline');
      const toolList = await api.tools();
      setTools(toolList.tools);
      setLastError(null);
    } catch (cause) {
      setConnection('offline');
      setHealth(null);
      setLastError(cause instanceof ApiError ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (connection !== 'offline') return undefined;
    const timer = window.setInterval(() => {
      void refresh();
    }, RETRY_MS);
    return () => window.clearInterval(timer);
  }, [connection, refresh]);

  const value = useMemo(
    () => ({ connection, health, tools, lastError, staleDaemon, refresh }),
    [connection, health, tools, lastError, staleDaemon, refresh],
  );

  return <DaemonContext.Provider value={value}>{children}</DaemonContext.Provider>;
}

export function useDaemon(): DaemonContextValue {
  return useContext(DaemonContext);
}
