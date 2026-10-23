// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { BrandProvider } from '../../components/theme-provider';
import AppLayout from './layout';

vi.mock('../providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

describe('signed-in guard', () => {
  it('shows a skeleton while the session restores', () => {
    mockState.status = 'loading';
    render(<AppLayout>content</AppLayout>);
    expect(screen.getByTestId('shell-loading')).toBeTruthy();
    expect(screen.queryByText('content')).toBeNull();
    expect(mockState.router.replace).not.toHaveBeenCalled();
  });

  it('sends anonymous visitors to /login with the current path', () => {
    mockState.status = 'anonymous';
    mockState.pathname = '/inventory';
    render(<AppLayout>content</AppLayout>);
    expect(mockState.router.replace).toHaveBeenCalledWith('/login?next=%2Finventory');
    expect(screen.queryByText('content')).toBeNull();
  });

  it('renders the shell with a skip link and the main landmark when signed in', () => {
    mockState.session = sessionFixture();
    render(
      <BrandProvider brand={{ productName: 'Gastro Demo', logoUrl: null }}>
        <AppLayout>content</AppLayout>
      </BrandProvider>,
    );
    expect(screen.getByRole('main').textContent).toBe('content');
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe(
      '#main',
    );
  });
});
