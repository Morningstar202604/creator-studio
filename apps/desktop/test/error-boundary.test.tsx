import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

function Boom(): React.ReactElement {
  throw new Error('页面炸了');
}

describe('R1 a render crash is contained and recoverable', () => {
  it('shows the failure, names the area, and does not take the rest of the app with it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary title="任务页">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('任务页 出错了')).toBeTruthy();
    // The message must say the data is safe — that is the user's next question.
    expect(screen.getByText(/项目数据还在磁盘上/)).toBeTruthy();
    expect(screen.getByText('页面炸了')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试这一页' })).toBeTruthy();
    spy.mockRestore();
  });

  it('retries and renders the children once the thrown component recovers', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Flaky(): React.ReactElement {
      if (shouldThrow) throw new Error('第一次失败');
      return <div>恢复成功</div>;
    }
    render(
      <ErrorBoundary title="设置页">
        <Flaky />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: '重试这一页' }));
    expect(screen.getByText('恢复成功')).toBeTruthy();
    spy.mockRestore();
  });

  it('clears the error when the location changes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary title="项目页" resetKey="/p/1">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('项目页 出错了')).toBeTruthy();
    rerender(
      <ErrorBoundary title="项目页" resetKey="/p/2">
        <div>另一个项目</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('另一个项目')).toBeTruthy();
    spy.mockRestore();
  });
});
