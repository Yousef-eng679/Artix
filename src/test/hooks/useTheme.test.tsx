import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { ThemeProvider, useTheme } from '@/hooks/useTheme';

describe('useTheme Hook', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark', 'light');
  });

  it('should throw error when used outside ThemeProvider', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useTheme())).toThrow('useTheme must be used inside ThemeProvider');
    consoleSpy.mockRestore();
  });

  it('should provide dark theme by default inside ThemeProvider', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    });

    expect(result.current.theme).toBe('dark');
  });

  it('should persist dark theme class to document root and localStorage', () => {
    renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    });

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(localStorage.getItem('artix-theme')).toBe('dark');
  });

  it('should enforce dark theme and ignore attempts to toggle or set light theme', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
    });

    act(() => {
      result.current.toggleTheme();
    });
    expect(result.current.theme).toBe('dark');

    act(() => {
      result.current.setTheme('light');
    });
    expect(result.current.theme).toBe('dark');
  });
});
