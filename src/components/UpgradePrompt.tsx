import { useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { PLAN_PRICES } from '@/lib/plans';
import { toast } from 'sonner';

interface UpgradePromptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  feature: string;
  used: number;
  limit: number;
}

export function UpgradePrompt({ open, onOpenChange, feature, used, limit }: UpgradePromptProps) {
  const [loadingPriceId, setLoadingPriceId] = useState<string | null>(null);

  const handleUpgrade = async (priceId: string, billingCycle: 'monthly' | 'annual') => {
    try {
      setLoadingPriceId(priceId);
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: { priceId, billingCycle, origin: window.location.origin }
      });
      if (error) throw error;
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err: any) {
      console.error('Checkout error:', err);
      const msg = err?.message || '';
      if (msg.includes('Failed to send a request') || msg.includes('FunctionsFetchError') || msg.includes('404')) {
        toast.error('Edge Function not deployed to Supabase yet. Please deploy create-checkout-session to your Supabase project.');
      } else {
        toast.error(msg || 'Failed to start checkout. Please try again later.');
      }
    } finally {
      setLoadingPriceId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] border-border/50 bg-background/95 backdrop-blur-xl p-0 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-background to-background pointer-events-none" />
        
        <div className="relative p-6">
          <DialogHeader className="mb-6">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center mb-4 mx-auto"
            >
              <Sparkles className="h-6 w-6 text-primary" />
            </motion.div>
            <DialogTitle className="text-2xl font-bold text-center">You've reached your limit</DialogTitle>
            <DialogDescription className="text-center text-base mt-2">
              You've used {used}/{limit} {feature}s on the Free plan.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-6">
            <Button
              className="w-full h-14 text-lg relative overflow-hidden group"
              onClick={() => handleUpgrade(PLAN_PRICES.monthly.priceId, 'monthly')}
              disabled={loadingPriceId !== null}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-primary/80 to-primary opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative flex items-center justify-center gap-2">
                {loadingPriceId === PLAN_PRICES.monthly.priceId ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>Upgrade Monthly — {PLAN_PRICES.monthly.label}</>
                )}
              </div>
            </Button>
            
            <Button
              variant="outline"
              className="w-full h-14 text-lg border-primary/20 hover:bg-primary/10 transition-colors"
              onClick={() => handleUpgrade(PLAN_PRICES.annual.priceId, 'annual')}
              disabled={loadingPriceId !== null}
            >
              {loadingPriceId === PLAN_PRICES.annual.priceId ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <>Upgrade Annually — {PLAN_PRICES.annual.label} (Save $24)</>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
