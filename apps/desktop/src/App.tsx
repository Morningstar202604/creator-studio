import { useEffect } from 'react';
import type React from 'react';
import { AppRoutes } from './app/routes';
import { api } from './api';

/**
 * Sends a brand-new install to the first-run wizard exactly once. It is a no-op
 * when the endpoint is missing (older daemon, unit tests) or the daemon is offline,
 * so the shell is never trapped behind a redirect loop.
 */
function useFirstRunGate(): void {
  useEffect(() => {
    const status = (api as { onboardingStatus?: () => Promise<{ completed: boolean }> }).onboardingStatus;
    if (typeof status !== 'function') return;
    // Only the landing route is gated: deep links (settings, a project) are
    // explicit user intent and must not be hijacked by the wizard.
    const hash = window.location.hash;
    if (hash !== '' && hash !== '#/' && hash !== '#') return;
    void status()
      .then((result) => {
        if (result.completed === false) window.location.hash = '#/onboarding';
      })
      .catch(() => {
        // Daemon offline: the top bar already reports the connection state.
      });
  }, []);
}

export function App(): React.ReactElement {
  useFirstRunGate();
  return <AppRoutes />;
}
