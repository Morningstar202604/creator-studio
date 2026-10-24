import type React from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { DaemonProvider } from './DaemonProvider';
import { ApprovalsPage } from '../pages/ApprovalsPage';
import { ProjectsPage } from '../pages/ProjectsPage';
import { WorkspacePage } from '../pages/WorkspacePage';
import { RunsPage } from '../pages/RunsPage';
import { ScriptPage } from '../pages/ScriptPage';
import { PackagePage, ResearchPage, ShotListPage, TopicPage } from '../pages/StagePage';
import { PublishPage } from '../pages/PublishPage';
import { SettingsPage } from '../pages/SettingsPage';
import { OnboardingPage } from '../pages/OnboardingPage';
import { LibraryPage } from '../pages/LibraryPage';
import { AutomationsPage } from '../pages/AutomationsPage';
import { ReviewPage } from '../pages/ReviewPage';
import { PlaceholderPage } from '../components/PlaceholderPage';

export const ROUTES = {
  onboarding: '/onboarding',
  projects: '/',
  project: (id: string) => `/p/${id}`,
  topic: (id: string) => `/p/${id}/topic`,
  research: (id: string) => `/p/${id}/research`,
  script: (id: string) => `/p/${id}/script`,
  shotlist: (id: string) => `/p/${id}/shotlist`,
  package: (id: string) => `/p/${id}/package`,
  publish: (id: string) => `/p/${id}/publish`,
  review: (id: string) => `/p/${id}/review`,
  runs: '/runs',
  approvals: '/approvals',
  library: '/library',
  automations: '/automations',
  settings: '/settings',
} as const;

export function AppRoutes(): React.ReactElement {
  return (
    <HashRouter>
      <DaemonProvider>
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/p/:id" element={<WorkspacePage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/p/:id/script" element={<ScriptPage />} />
          <Route path="/p/:id/topic" element={<TopicPage />} />
          <Route path="/p/:id/research" element={<ResearchPage />} />
          <Route path="/p/:id/shotlist" element={<ShotListPage />} />
          <Route path="/p/:id/package" element={<PackagePage />} />
          <Route path="/p/:id/publish" element={<PublishPage />} />
          <Route path="/p/:id/review" element={<ReviewPage />} />
          <Route
            path="*"
            element={
              <PlaceholderPage
                title="页面不存在"
                taskId="—"
                docSection="ARCHITECTURE §5.1"
                description="地址不匹配任何已知路由。"
              />
            }
          />
        </Routes>
      </DaemonProvider>
    </HashRouter>
  );
}
