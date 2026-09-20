import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { UpgradePrompt } from '@/components/UpgradePrompt';
import { FunctionsClient } from '@supabase/functions-js';
import { PLAN_PRICES } from '@/lib/plans';
import { toast } from 'sonner';

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('UpgradePrompt Component', () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Prevent jsdom navigation errors when window.location.href is assigned
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, href: '' },
    });
  });

  it('should render dialog with feature usage details when open is true', () => {
    render(
      <UpgradePrompt
        open={true}
        onOpenChange={onOpenChange}
        feature="document"
        used={10}
        limit={10}
      />
    );

    expect(screen.getByText("You've reached your limit")).toBeInTheDocument();
    expect(screen.getByText("You've used 10/10 documents on the Free plan.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upgrade monthly/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upgrade annually/i })).toBeInTheDocument();
  });

  it('should trigger create-checkout-session with monthly price ID on monthly button click', async () => {
    const invokeSpy = vi.spyOn(FunctionsClient.prototype, 'invoke').mockImplementation(async () => {
      return { data: { url: 'https://checkout.stripe.com/pay/cs_test_monthly' }, error: null };
    });

    render(
      <UpgradePrompt
        open={true}
        onOpenChange={onOpenChange}
        feature="document"
        used={10}
        limit={10}
      />
    );

    const monthlyBtn = screen.getByRole('button', { name: /upgrade monthly/i });
    fireEvent.click(monthlyBtn);

    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith(
        'create-checkout-session',
        expect.objectContaining({
          body: expect.objectContaining({
            priceId: PLAN_PRICES.monthly.priceId,
          }),
        })
      );
    });
  });

  it('should trigger create-checkout-session with annual price ID on annual button click', async () => {
    const invokeSpy = vi.spyOn(FunctionsClient.prototype, 'invoke').mockImplementation(async () => {
      return { data: { url: 'https://checkout.stripe.com/pay/cs_test_annual' }, error: null };
    });

    render(
      <UpgradePrompt
        open={true}
        onOpenChange={onOpenChange}
        feature="system design"
        used={3}
        limit={3}
      />
    );

    const annualBtn = screen.getByRole('button', { name: /upgrade annually/i });
    fireEvent.click(annualBtn);

    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith(
        'create-checkout-session',
        expect.objectContaining({
          body: expect.objectContaining({
            priceId: PLAN_PRICES.annual.priceId,
          }),
        })
      );
    });
  });

  it('should show error toast if checkout session fails to generate URL', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(FunctionsClient.prototype, 'invoke').mockImplementation(async () => {
      return { data: null, error: new Error('Failed to send a request') };
    });

    render(
      <UpgradePrompt
        open={true}
        onOpenChange={onOpenChange}
        feature="project"
        used={3}
        limit={3}
      />
    );

    const monthlyBtn = screen.getByRole('button', { name: /upgrade monthly/i });
    fireEvent.click(monthlyBtn);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Edge Function not deployed to Supabase yet')
      );
    });

    consoleSpy.mockRestore();
  });
});
