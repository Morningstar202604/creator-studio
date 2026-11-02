import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, SqliteAutomationStore, SqliteProjectStore } from '../src/index.js';

/**
 * A run row is written as `running` before the model call and updated after it. If
 * the daemon dies in between, that row stays `running` forever and the UI shows a
 * run that will never finish. Startup corrects it once, which is what these tests
 * pin down.
 *
 * Projects are created for real because `automation_runs` has a foreign key to
 * `automations`, which in turn references `projects`.
 */
describe('automation run recovery', () => {
  let db: ReturnType<typeof openDatabase>;
  let store: SqliteAutomationStore;
  let projectId: string;

  beforeEach(() => {
    const workspace = mkdtempSync(join(tmpdir(), 'cs-automation-'));
    db = openDatabase({ path: join(workspace, 'db.sqlite') });
    const projects = new SqliteProjectStore(db);
    projectId = projects.create({
      id: 'project-1',
      ownerId: 'local-user',
      title: '自动化测试',
      platform: 'bilibili',
      workspacePath: workspace,
    }).id;
    store = new SqliteAutomationStore(db);
  });

  function seedAutomation(): string {
    return store.create({
      projectId,
      name: '每日选题',
      kind: 'topic-card',
      prompt: 'AI 与就业',
      intervalMinutes: 60,
      enabled: true,
    }).id;
  }

  it('marks a run left running by a dead process as interrupted', () => {
    const automationId = seedAutomation();
    const run = store.startRun(automationId);
    expect(store.listRuns(automationId, 5)[0]?.status).toBe('running');

    expect(store.recoverInterruptedRuns()).toBe(1);

    const recovered = store.listRuns(automationId, 5).find((entry) => entry.id === run.id);
    expect(recovered?.status).toBe('interrupted');
    expect(recovered?.endedAt).not.toBeNull();
  });

  it('leaves finished runs untouched', () => {
    const automationId = seedAutomation();
    const run = store.startRun(automationId);
    store.finishRun(run.id, { ok: true, artifactId: 'artifact-1' });

    expect(store.recoverInterruptedRuns()).toBe(0);
    expect(store.listRuns(automationId, 5)[0]?.status).toBe('succeeded');
  });

  it('is idempotent, so a second startup changes nothing', () => {
    const automationId = seedAutomation();
    store.startRun(automationId);

    expect(store.recoverInterruptedRuns()).toBe(1);
    expect(store.recoverInterruptedRuns()).toBe(0);
    expect(store.listRuns(automationId, 5)[0]?.status).toBe('interrupted');
  });
});
