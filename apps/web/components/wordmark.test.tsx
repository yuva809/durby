// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrandProvider } from './theme-provider';
import { Wordmark } from './wordmark';

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
});
