import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { motion } from 'framer-motion';
import { Loader2, CheckCircle, Clock } from 'lucide-react';

export default function CheckoutSuccess() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'timeout'>('loading');

  useEffect(() => {
    if (!user) return;

    let retries = 0;
    const maxRetries = 10;
    
    const checkSubscription = async () => {
      try {
        const { data, error } = await supabase
          .from('subscriptions')
          .select('plan_tier, status')
          .eq('user_id', user.id)
          .single();

        if (!error && data?.plan_tier === 'pro' && data?.status === 'active') {
          setStatus('success');
          setTimeout(() => {
            navigate('/dashboard', { replace: true });
          }, 3000);
          return true;
        }
      } catch (err) {
        console.error('Error checking subscription', err);
      }
      return false;
    };

    const poll = async () => {
      const isPro = await checkSubscription();
      if (!isPro) {
        retries++;
        if (retries >= maxRetries) {
          setStatus('timeout');
        } else {
          setTimeout(poll, 2000);
        }
      }
    };

    poll();
  }, [user, navigate]);

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="max-w-md w-full bg-card/40 border border-border/50 backdrop-blur-xl rounded-2xl p-8 text-center relative overflow-hidden"
      >
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-transparent pointer-events-none" />
        
        <div className="relative">
          {status === 'loading' && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center"
            >
              <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mb-6">
                <Loader2 className="h-8 w-8 text-primary animate-spin" />
              </div>
              <h2 className="text-2xl font-bold mb-2">Setting up your Pro account...</h2>
              <p className="text-muted-foreground">Please wait while we confirm your payment.</p>
            </motion.div>
          )}

          {status === 'success' && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center"
            >
              <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-6">
                <CheckCircle className="h-8 w-8 text-green-500" />
              </div>
              <h2 className="text-2xl font-bold mb-2">You're all set!</h2>
              <p className="text-muted-foreground mb-6">Your Pro account has been activated.</p>
              <p className="text-sm text-muted-foreground animate-pulse">Redirecting to dashboard...</p>
            </motion.div>
          )}

          {status === 'timeout' && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center"
            >
              <div className="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center mb-6">
                <Clock className="h-8 w-8 text-amber-500" />
              </div>
              <h2 className="text-2xl font-bold mb-2">Taking longer than expected</h2>
              <p className="text-muted-foreground mb-8">Your upgrade will activate shortly once Stripe processes the webhook.</p>
              <button 
                onClick={() => navigate('/dashboard', { replace: true })}
                className="text-primary hover:underline font-medium"
              >
                Go to Dashboard
              </button>
            </motion.div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
