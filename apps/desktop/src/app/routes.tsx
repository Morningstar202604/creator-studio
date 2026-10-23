import type React from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { DaemonProvider } from './DaemonProvider';
import { ApprovalsPage } from '../pages/ApprovalsPage';
import { ProjectsPage } from '../pages/ProjectsPage';
import { WorkspacePage } from '../pages/WorkspacePage';
import { RunsPage } from '../pages/RunsPage';
import { ScriptPage } from '../pages/ScriptPage';
import { PackagePage, ResearchPage, TopicPage } from '../pages/StagePage';
import { PublishPage } from '../pages/PublishPage';
import { SettingsPage } from '../pages/SettingsPage';
import { OnboardingPage } from '../pages/OnboardingPage';
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

const PLACEHOLDERS: Array<{ path: string; title: string; taskId: string; docSection: string; description: string }> = [
  {
    path: '/p/:id/shotlist',
    title: '分镜',
    taskId: 'P1 阶段',
    docSection: 'UI-SPEC §5.6',
    description: '镜头清单表格，含描述、素材缩略图、时长，支持拖拽排序。',
  },
  {
    path: '/p/:id/review',
    title: '复盘',
    taskId: 'P1 阶段',
    docSection: 'UI-SPEC §5.9',
    description: '指标卡、趋势图、与近 5 期对比、Agent 归因结论。',
  },
  {
    path: '/library',
    title: '资料库',
    taskId: 'P1 阶段',
    docSection: 'UI-SPEC §5.12',
    description: '跨项目素材与资料卡，按标签与引用次数检索。',
  },
  {
    path: '/automations',
    title: '自动化',
    taskId: 'P1 阶段',
    docSection: 'UI-SPEC §5.13',
    description: '定时任务与云端任务规则，含下次运行时间与开关。',
  },
];

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
          <Route path="/p/:id/script" element={<ScriptPage />} />
          <Route path="/p/:id/topic" element={<TopicPage />} />
          <Route path="/p/:id/research" element={<ResearchPage />} />
          <Route path="/p/:id/package" element={<PackagePage />} />
          <Route path="/p/:id/publish" element={<PublishPage />} />
          {PLACEHOLDERS.map((placeholder) => (
            <Route
              key={placeholder.path}
              path={placeholder.path}
              element={
                <PlaceholderPage
                  title={placeholder.title}
                  taskId={placeholder.taskId}
                  docSection={placeholder.docSection}
                  description={placeholder.description}
                />
              }
            />
          ))}
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
