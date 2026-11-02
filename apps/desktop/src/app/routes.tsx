import { lazy, Suspense, type ComponentType } from 'react';
import type React from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { DaemonProvider } from './DaemonProvider';
import { PlaceholderPage } from '../components/PlaceholderPage';

function lazyPage<T, K extends keyof T>(loader: () => Promise<T>, name: K) {
  return lazy(async () => ({ default: (await loader())[name] as ComponentType }));
}

const ApprovalsPage = lazyPage(() => import('../pages/ApprovalsPage'), 'ApprovalsPage');
const ProjectsPage = lazyPage(() => import('../pages/ProjectsPage'), 'ProjectsPage');
const WorkspacePage = lazyPage(() => import('../pages/WorkspacePage'), 'WorkspacePage');
const RunsPage = lazyPage(() => import('../pages/RunsPage'), 'RunsPage');
const ScriptPage = lazyPage(() => import('../pages/ScriptPage'), 'ScriptPage');
const StagePageModule = () => import('../pages/StagePage');
const GenericStagePage = lazyPage(StagePageModule, 'GenericStagePage');
const PackagePage = lazyPage(StagePageModule, 'PackagePage');
const ResearchPage = lazyPage(StagePageModule, 'ResearchPage');
const ShotListPage = lazyPage(StagePageModule, 'ShotListPage');
const TopicPage = lazyPage(StagePageModule, 'TopicPage');
const PublishPage = lazyPage(() => import('../pages/PublishPage'), 'PublishPage');
const SettingsPage = lazyPage(() => import('../pages/SettingsPage'), 'SettingsPage');
const OnboardingPage = lazyPage(() => import('../pages/OnboardingPage'), 'OnboardingPage');
const LibraryPage = lazyPage(() => import('../pages/LibraryPage'), 'LibraryPage');
const AutomationsPage = lazyPage(() => import('../pages/AutomationsPage'), 'AutomationsPage');
const ReviewPage = lazyPage(() => import('../pages/ReviewPage'), 'ReviewPage');
const ProjectMemoryRoute = lazyPage(() => import('../pages/MemoryPage'), 'ProjectMemoryRoute');
const EntitiesPage = lazyPage(() => import('../pages/EntitiesPage'), 'EntitiesPage');
const GraphPage = lazyPage(() => import('../pages/GraphPage'), 'GraphPage');
const TimelinePage = lazyPage(() => import('../pages/TimelinePage'), 'TimelinePage');
const DocumentPage = lazyPage(() => import('../pages/DocumentPage'), 'DocumentPage');

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
  memory: (id: string) => `/p/${id}/memory`,
  graph: (id: string) => `/p/${id}/graph`,
  timeline: (id: string) => `/p/${id}/timeline`,
  stage: (id: string, stageKey: string) => `/p/${id}/stage/${stageKey}`,
  document: (id: string, entityType: string) => `/p/${id}/write/${entityType}`,
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
        <Suspense fallback={<div className="empty">正在加载页面…</div>}>
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
          <Route path="/p/:id/stage/:stageKey" element={<GenericStagePage />} />
          <Route path="/p/:id/publish" element={<PublishPage />} />
          <Route path="/p/:id/review" element={<ReviewPage />} />
          <Route path="/p/:id/memory" element={<ProjectMemoryRoute />} />
          <Route path="/p/:id/cards/:entityType" element={<EntitiesPage />} />
          <Route path="/p/:id/write/:entityType" element={<DocumentPage />} />
          <Route path="/p/:id/graph" element={<GraphPage />} />
          <Route path="/p/:id/timeline" element={<TimelinePage />} />
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
        </Suspense>
      </DaemonProvider>
    </HashRouter>
  );
}
