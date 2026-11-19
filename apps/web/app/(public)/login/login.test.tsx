// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../../test/mocks';
import { BrandProvider } from '../../../components/theme-provider';
import LoginPage from './page';

const brand = ({ children }: { children: React.ReactNode }) => (
  <BrandProvider brand={{ productName: 'AsiaMight', logoUrl: null, navLayout: 'operations' }}>
    {children}
  </BrandProvider>
);

vi.mock('../../providers', async () => (await import('../../../test/mocks')).providersMock());
vi.mock('next/navigation', async () => (await import('../../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

describe('/login', () => {
  it('stays to add another account while one is signed in (item 15)', async () => {
    mockState.status = 'authenticated';
    mockState.search = 'add=1';
    render(<LoginPage />, { wrapper: brand });
    expect(await screen.findByTestId('add-account-cancel')).toBeTruthy();
    expect(mockState.router.replace).not.toHaveBeenCalled();
  });

  it('sends someone signed in on without ?add=1', async () => {
    mockState.status = 'authenticated';
    render(<LoginPage />, { wrapper: brand });
    await vi.waitFor(() => expect(mockState.router.replace).toHaveBeenCalled());
  });
});
