// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { PasswordInput } from './password-input';

afterEach(cleanup);

const labels = { show: 'Show password', hide: 'Hide password' };

describe('PasswordInput', () => {
  it('hides the password until the eye button shows it, and hides it again', async () => {
    render(
      <>
        <label htmlFor="pw">Password</label>
        <PasswordInput id="pw" labels={labels} defaultValue="secret" />
      </>,
    );
    const field = screen.getByLabelText('Password');
    expect(field.getAttribute('type')).toBe('password');

    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field.getAttribute('type')).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(field.getAttribute('type')).toBe('password');
  });

  it('is not a submit button and keeps the field named by its own label', async () => {
    let submitted = false;
    render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitted = true;
        }}
      >
        <label htmlFor="pw">Password</label>
        <PasswordInput id="pw" labels={labels} />
      </form>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(submitted).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Password' })).toBeTruthy();
  });
});
