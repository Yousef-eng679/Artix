import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Mail, Lock, ArrowRight, Loader2, CheckCircle2, AlertCircle, FileText, Network, Sparkles, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { validateEmailDeliverability } from '@/lib/emailValidation';
import { z } from 'zod';
import artixLogo from '@/assets/artix-logo.png';

const authSchema = z.object({
  email: z.string()
    .trim()
    .min(1, 'Email is required')
    .email('Please enter a valid email address')
    .max(255, 'Email must be less than 255 characters'),
  password: z.string()
    .min(6, 'Password must be at least 6 characters')
    .max(72, 'Password must be less than 72 characters'),
});

const Auth = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { signIn, signUp, signInWithGoogle, user, loading } = useAuth();
  const [isSignUp, setIsSignUp] = useState(searchParams.get('mode') === 'signup');
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [showVerification, setShowVerification] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState('');
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    try {
      const { error } = await signInWithGoogle();
      if (error) {
        toast.error(error.message || 'Failed to sign in with Google');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Error connecting to Google');
    } finally {
      setIsGoogleLoading(false);
    }
  };

  useEffect(() => {
    if (!loading && user) {
      navigate('/dashboard');
    }
  }, [user, loading, navigate]);

  const validateField = (field: 'email' | 'password', value: string) => {
    const partial = { ...formData, [field]: value };
    const result = authSchema.shape[field].safeParse(value.trim());
    if (!result.success) {
      setErrors(prev => ({ ...prev, [field]: result.error.errors[0].message }));
    } else {
      setErrors(prev => ({ ...prev, [field]: undefined }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const trimmed = { email: formData.email.trim(), password: formData.password };
    const result = authSchema.safeParse(trimmed);
    if (!result.success) {
      const fieldErrors: { email?: string; password?: string } = {};
      result.error.errors.forEach((err) => {
        if (err.path[0] === 'email') fieldErrors.email = err.message;
        if (err.path[0] === 'password') fieldErrors.password = err.message;
      });
      setErrors(fieldErrors);
      return;
    }

    setIsLoading(true);

    try {
      if (isSignUp) {
        const validation = await validateEmailDeliverability(trimmed.email);
        if (!validation.valid) {
          if (validation.reason === 'typo' && validation.suggestion) {
            toast.error(`Did you mean ${validation.suggestion}?`, {
              description: 'Check your email spelling or sign in with Google.',
            });
            setErrors({ email: `Did you mean ${validation.suggestion}?` });
          } else {
            toast.error(validation.message || "This email domain can't receive mail.", {
              description: 'Check for typos or use Google Sign-In instead.',
            });
            setErrors({ email: validation.message || "Email domain can't receive mail." });
          }
          return;
        }

        const { error } = await signUp(trimmed.email, trimmed.password);
        if (error) {
          if (error.message.includes('already registered')) {
            toast.error('This email is already registered. Please sign in instead.');
            setErrors({ email: 'This email is already registered' });
          } else if (error.message.includes('rate limit')) {
            toast.error('Too many attempts. Please wait a moment and try again.');
          } else {
            toast.error(error.message);
          }
          return;
        }
        setVerificationEmail(trimmed.email);
        setShowVerification(true);
      } else {
        const { error } = await signIn(trimmed.email, trimmed.password);
        if (error) {
          if (error.message.includes('Invalid login credentials')) {
            toast.error('Invalid email or password. Please try again.');
            setErrors({ password: 'Invalid email or password' });
          } else if (error.message.includes('Email not confirmed')) {
            toast.error('Please verify your email before signing in. Check your inbox.');
            setErrors({ email: 'Email not verified. Check your inbox for the confirmation link.' });
          } else if (error.message.includes('rate limit')) {
            toast.error('Too many login attempts. Please wait a moment.');
          } else {
            toast.error(error.message);
          }
          return;
        }
        toast.success('Welcome back!');
        navigate('/dashboard');
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (showVerification) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-8">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md text-center"
        >
          <div className="w-16 h-16 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground mb-3">Check your email</h1>
          <p className="text-muted-foreground mb-2">
            We've sent a verification link to:
          </p>
          <p className="text-foreground font-medium mb-6">{verificationEmail}</p>
          <div className="bg-card border border-border rounded-lg p-4 mb-6 text-left space-y-2">
            <p className="text-sm text-muted-foreground flex items-start gap-2">
              <Mail className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
              Open the email and click the confirmation link to activate your account.
            </p>
            <p className="text-sm text-muted-foreground flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
              If you don't see it, check your spam or junk folder.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              setShowVerification(false);
              setIsSignUp(false);
              setFormData({ email: verificationEmail, password: '' });
            }}
            className="w-full"
          >
            Back to Sign In
          </Button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex">
      <div className="flex-1 flex items-center justify-center p-8">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          className="w-full max-w-md"
        >
          <div className="flex items-center gap-2 mb-8">
            <img src={artixLogo} alt="Artix" className="w-10 h-10 rounded-lg" />
            <span className="font-bold text-xl text-foreground">Artix</span>
          </div>

          <h1 className="text-2xl font-bold text-foreground mb-2">
            {isSignUp ? 'Create your account' : 'Welcome back'}
          </h1>
          <Button
            type="button"
            variant="outline"
            onClick={handleGoogleSignIn}
            disabled={isGoogleLoading || isLoading}
            className="w-full h-11 border-border/80 hover:bg-accent/50 gap-3 font-medium text-foreground transition-all duration-200 mb-6"
          >
            {isGoogleLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : (
              <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.26v3.15C3.26 21.3 7.36 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.24c-.25-.72-.38-1.49-.38-2.24s.13-1.52.38-2.24V6.61H1.26C.46 8.2.01 10.03.01 12c0 1.97.45 3.8 1.25 5.39l4.02-3.15z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.36 0 3.26 2.7 1.26 6.61l4.02 3.15c.95-2.85 3.6-4.96 6.72-4.96z"
                />
              </svg>
            )}
            Continue with Google
          </Button>

          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border/60" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-3 text-muted-foreground font-medium">
                Or continue with email
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={formData.email}
                  onChange={(e) => {
                    setFormData({ ...formData, email: e.target.value });
                    if (errors.email) validateField('email', e.target.value);
                  }}
                  onBlur={(e) => validateField('email', e.target.value)}
                  className={`pl-10 ${errors.email ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                  autoComplete="email"
                />
              </div>
              {errors.email && (
                <p className="text-sm text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {errors.email}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={formData.password}
                  onChange={(e) => {
                    setFormData({ ...formData, password: e.target.value });
                    if (errors.password) validateField('password', e.target.value);
                  }}
                  onBlur={(e) => validateField('password', e.target.value)}
                  className={`pl-10 ${errors.password ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                  autoComplete={isSignUp ? 'new-password' : 'current-password'}
                />
              </div>
              {errors.password && (
                <p className="text-sm text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {errors.password}
                </p>
              )}
              {isSignUp && (
                <p className="text-xs text-muted-foreground">Must be at least 6 characters</p>
              )}
            </div>

            <Button type="submit" className="w-full h-11" disabled={isLoading}>
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  {isSignUp ? 'Create Account' : 'Sign In'}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-sm text-muted-foreground">
              {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
              <button
                type="button"
                onClick={() => {
                  setIsSignUp(!isSignUp);
                  setErrors({});
                }}
                className="text-primary hover:underline font-medium"
              >
                {isSignUp ? 'Sign in' : 'Sign up'}
              </button>
            </p>
          </div>
        </motion.div>
      </div>

      <div className="hidden lg:flex flex-1 items-center justify-center bg-card border-l border-border relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-30"
          style={{ background: 'var(--gradient-glow)' }}
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
          className="relative z-10 text-center p-8 max-w-md mx-auto"
        >
          <div className="w-20 h-20 rounded-2xl bg-primary/10 border border-primary/30 flex items-center justify-center mx-auto mb-6 shadow-[0_0_25px_rgba(245,158,11,0.2)] backdrop-blur-md">
            <img src={artixLogo} alt="Artix" className="h-12 w-12 object-contain" />
          </div>
          <h2 className="text-2xl font-bold text-foreground mb-3 leading-tight">
            The Developer's <span className="gradient-text">Command Center</span>
          </h2>
          <p className="text-slate-300 text-sm leading-relaxed mb-6">
            Document, design, and architect — all in one unified workspace with AI generation and BYOK key privacy.
          </p>
          <div className="flex flex-wrap justify-center gap-2.5">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-medium backdrop-blur-sm">
              <FileText className="h-3.5 w-3.5" />
              Document Forge
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-xs font-medium backdrop-blur-sm">
              <Network className="h-3.5 w-3.5" />
              System Architect
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-400 text-xs font-medium backdrop-blur-sm">
              <Sparkles className="h-3.5 w-3.5" />
              AI Prompt Suite
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium backdrop-blur-sm">
              <ShieldCheck className="h-3.5 w-3.5" />
              BYOK Privacy
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
};

export default Auth;
