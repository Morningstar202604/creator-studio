import type React from 'react';
import { AppShell } from './AppShell';

export function PlaceholderPage({
  title,
  taskId,
  docSection,
  description,
}: {
  title: string;
  taskId: string;
  docSection: string;
  description: string;
}): React.ReactElement {
  return (
    <AppShell title={<b>{title}</b>}>
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <div className="page-sub">该页面尚未实现</div>
        </div>
      </div>
      <div className="panel">
        <p>{description}</p>
        <p className="hint">
          对应任务 {taskId} · 规格见 {docSection}
        </p>
      </div>
    </AppShell>
  );
}
