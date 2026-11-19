// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrandProvider } from './theme-provider';
import { AuthLogo, AuthName, Wordmark } from './wordmark';

afterEach(cleanup);

describe('Wordmark', () => {
  it('renders the product name as text while the partner has no logo', () => {
    render(
      <BrandProvider brand={{ productName: 'Gastro Demo', logoUrl: null }}>
        <Wordmark />
      </BrandProvider>,
    );
    expect(screen.getByTestId('wordmark').textContent).toBe('Gastro Demo');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders the logo file with the product name as its alt text', () => {
    render(
      <BrandProvider brand={{ productName: 'Gastro Demo', logoUrl: '/brand/demo/logo.svg' }}>
        <Wordmark />
      </BrandProvider>,
    );
    const img = screen.getByRole('img', { name: 'Gastro Demo' });
    expect(img.getAttribute('src')).toBe('/brand/demo/logo.svg');
  });

  it('puts the product name beside the logo in the sidebar (item 2)', () => {
    render(
      <BrandProvider brand={{ productName: 'Gastro Demo', logoUrl: '/brand/demo/logo.svg' }}>
        <Wordmark withName />
      </BrandProvider>,
    );
    expect(screen.getByTestId('wordmark-with-name').textContent).toBe('Gastro Demo');
    expect(screen.getByRole('img', { name: 'Gastro Demo' })).toBeTruthy();
  });

  it('signs in with the logo in the corner and the name centred (item 3)', () => {
    render(
      <BrandProvider brand={{ productName: 'Gastro Demo', logoUrl: '/brand/demo/logo.svg' }}>
        <AuthLogo />
        <AuthName />
      </BrandProvider>,
    );
    expect(screen.getByTestId('auth-logo').getAttribute('src')).toBe('/brand/demo/logo.svg');
    expect(screen.getByTestId('auth-product-name').textContent).toBe('Gastro Demo');
    cleanup();
    // Without a logo: the text wordmark alone.
    render(
      <BrandProvider brand={{ productName: 'Gastro Demo', logoUrl: null }}>
        <AuthLogo />
        <AuthName />
      </BrandProvider>,
    );
    expect(screen.queryByTestId('auth-logo')).toBeNull();
    expect(screen.getByTestId('wordmark').textContent).toBe('Gastro Demo');
  });
});
