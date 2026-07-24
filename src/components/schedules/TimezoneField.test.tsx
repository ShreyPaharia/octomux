import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimezoneField } from './TimezoneField';

// JSDOM does not implement Intl.supportedValuesOf — mock it before each test.
const FAKE_ZONES = [
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Asia/Tokyo',
  'Australia/Sydney',
];

describe('TimezoneField', () => {
  beforeEach(() => {
    vi.stubGlobal('Intl', {
      ...Intl,
      supportedValuesOf: vi.fn((key: string) => (key === 'timeZone' ? FAKE_ZONES : [])),
      DateTimeFormat: Intl.DateTimeFormat,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders with UTC placeholder when value is empty', () => {
    render(<TimezoneField value="" onChange={vi.fn()} />);
    const input = screen.getByTestId('timezone-input');
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).placeholder).toBe('UTC');
  });

  it('opens dropdown on focus and shows timezone options', async () => {
    const user = userEvent.setup();
    render(<TimezoneField value="" onChange={vi.fn()} />);

    await user.click(screen.getByTestId('timezone-input'));

    expect(await screen.findByTestId('timezone-dropdown')).toBeTruthy();
    expect(screen.getByTestId('timezone-use-browser')).toBeTruthy();
    expect(screen.getByTestId('timezone-option-utc')).toBeTruthy();
  });

  it('filters options by typed text', async () => {
    const user = userEvent.setup();
    render(<TimezoneField value="" onChange={vi.fn()} />);

    await user.click(screen.getByTestId('timezone-input'));
    await user.type(screen.getByTestId('timezone-input'), 'America');

    await waitFor(() => {
      expect(screen.queryByTestId('timezone-option-America/New_York')).toBeTruthy();
      expect(screen.queryByTestId('timezone-option-America/Los_Angeles')).toBeTruthy();
      // Europe/London should not match "America"
      expect(screen.queryByTestId('timezone-option-Europe/London')).toBeNull();
    });
  });

  it('calls onChange when a timezone is selected', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimezoneField value="" onChange={onChange} />);

    await user.click(screen.getByTestId('timezone-input'));
    await user.type(screen.getByTestId('timezone-input'), 'Tokyo');

    const option = await screen.findByTestId('timezone-option-Asia/Tokyo');
    await user.pointer({ target: option, keys: '[MouseLeft]' });

    expect(onChange).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('"Use browser timezone" fills browser timezone via onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    // Stub resolvedOptions to return a known timezone
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'Europe/London',
      locale: 'en',
      calendar: 'gregory',
      numberingSystem: 'latn',
      hour12: false,
      hourCycle: 'h23',
    });

    render(<TimezoneField value="" onChange={onChange} />);
    await user.click(screen.getByTestId('timezone-input'));

    const browserBtn = await screen.findByTestId('timezone-use-browser');
    await user.pointer({ target: browserBtn, keys: '[MouseLeft]' });

    expect(onChange).toHaveBeenCalledWith('Europe/London');
  });

  it('falls back gracefully when Intl.supportedValuesOf is undefined (JSDOM default)', () => {
    // Remove the mock to simulate JSDOM without the method
    vi.unstubAllGlobals();
    vi.stubGlobal('Intl', {
      ...Intl,
      supportedValuesOf: undefined,
      DateTimeFormat: Intl.DateTimeFormat,
    });

    const onChange = vi.fn();
    expect(() => render(<TimezoneField value="" onChange={onChange} />)).not.toThrow();
  });

  it('shows "No matching timezones" when filter matches nothing', async () => {
    const user = userEvent.setup();
    render(<TimezoneField value="" onChange={vi.fn()} />);

    await user.click(screen.getByTestId('timezone-input'));
    await user.type(screen.getByTestId('timezone-input'), 'zzznomatch');

    await waitFor(() => {
      expect(screen.getByText(/no matching timezones/i)).toBeTruthy();
    });
  });

  it('calls onChange with empty string when UTC option is selected', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimezoneField value="Asia/Tokyo" onChange={onChange} />);

    await user.click(screen.getByTestId('timezone-input'));
    const utcOption = await screen.findByTestId('timezone-option-utc');
    await user.pointer({ target: utcOption, keys: '[MouseLeft]' });

    expect(onChange).toHaveBeenCalledWith('');
  });
});
