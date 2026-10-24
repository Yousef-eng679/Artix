import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useSubscription } from '@/hooks/useSubscription';
import { supabase } from '@/integrations/supabase/client';
import { PLAN_LIMITS, PLAN_PRICES } from '@/lib/plans';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { Check, Sparkles, ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export default function Pricing() {
  const { user } = useAuth();
  const { planTier, isLoading: subLoading } = useSubscription();
  const navigate = useNavigate();
  const [loadingPriceId, setLoadingPriceId] = useState<string | null>(null);

  const handleUpgrade = async (priceId: string, billingCycle: 'monthly' | 'annual') => {
    if (!user) {
      navigate('/auth');
      return;
    }
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
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="p-6 border-b border-border/50 bg-background/80 backdrop-blur-xl sticky top-0 z-30 flex items-center justify-between">
        <Button variant="ghost" className="gap-2" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      </header>

      <main className="flex-1 flex flex-col items-center py-20 px-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center max-w-2xl mb-16"
        >
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6 bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">
            Simple, transparent pricing
          </h1>
          <p className="text-lg text-muted-foreground">
            Choose the plan that's right for you. Upgrade to Pro for unlimited access.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-8 w-full max-w-5xl">
          {/* Free Tier */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 }}
            className="flex flex-col rounded-3xl border border-border/50 bg-card/40 backdrop-blur-xl p-8"
          >
            <div className="mb-8">
              <h2 className="text-2xl font-semibold mb-2">Free</h2>
              <div className="text-4xl font-bold mb-2">$0</div>
              <p className="text-muted-foreground">Perfect for getting started.</p>
            </div>

            <div className="flex-1 space-y-4 mb-8">
              <FeatureItem text={`${PLAN_LIMITS.free.projects} Projects`} />
              <FeatureItem text={`${PLAN_LIMITS.free.documents} Documents`} />
              <FeatureItem text={`${PLAN_LIMITS.free.systemDesigns} System Designs`} />
              <FeatureItem text={`${PLAN_LIMITS.free.aiGenerationsPerMonth} AI Generations/month`} />
            </div>

            <Button
              variant="outline"
              className="w-full h-12 text-lg"
              disabled={planTier === 'free'}
            >
              {planTier === 'free' ? 'Current Plan' : 'Free Plan'}
            </Button>
          </motion.div>

          {/* Pro Tier */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="flex flex-col rounded-3xl border-2 border-primary bg-card/60 backdrop-blur-xl p-8 relative overflow-hidden group shadow-[0_0_40px_-15px_rgba(var(--primary),0.3)]"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-transparent pointer-events-none" />
            <div className="absolute top-0 right-0 p-4">
              <div className="bg-primary text-primary-foreground text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> Recommended
              </div>
            </div>

            <div className="mb-8 relative">
              <h2 className="text-2xl font-semibold mb-2 text-primary">Pro</h2>
              <div className="text-4xl font-bold mb-2">
                {PLAN_PRICES.monthly.label}
              </div>
              <p className="text-muted-foreground">Or {PLAN_PRICES.annual.label} billed annually.</p>
            </div>

            <div className="flex-1 space-y-4 mb-8 relative">
              <FeatureItem text="Unlimited Projects" />
              <FeatureItem text="Unlimited Documents" />
              <FeatureItem text="Unlimited System Designs" />
              <FeatureItem text="Unlimited AI Generations" />
              <FeatureItem text="Priority Support" />
            </div>

            <div className="space-y-4 relative">
              {planTier === 'pro' ? (
                <Button className="w-full h-12 text-lg" disabled>
                  Current Plan
                </Button>
              ) : (
                <>
                  <Button
                    className="w-full h-12 text-lg relative overflow-hidden"
                    onClick={() => handleUpgrade(PLAN_PRICES.monthly.priceId, 'monthly')}
                    disabled={loadingPriceId !== null}
                  >
                    {loadingPriceId === PLAN_PRICES.monthly.priceId ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <>Upgrade Monthly</>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full h-12 text-lg border-primary/20 hover:bg-primary/10"
                    onClick={() => handleUpgrade(PLAN_PRICES.annual.priceId, 'annual')}
                    disabled={loadingPriceId !== null}
                  >
                    {loadingPriceId === PLAN_PRICES.annual.priceId ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <>Upgrade Annually (Save $24)</>
                    )}
                  </Button>
                </>
              )}
            </div>
          </motion.div>
        </div>
      </main>
    </div>
  );
}

function FeatureItem({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="rounded-full bg-primary/20 p-1">
        <Check className="h-4 w-4 text-primary" />
      </div>
      <span>{text}</span>
    </div>
  );
}
