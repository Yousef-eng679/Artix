import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, Save, Key, Trash2, AlertTriangle, CreditCard, Crown, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useSubscription } from '@/hooks/useSubscription';
import { useUsageLimits } from '@/hooks/useUsageLimits';
import { toast } from 'sonner';
import { AISettingsCard } from '@/components/AI/AISettingsCard';
import { supabase } from '@/integrations/supabase/client';

const Settings = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading, signOut, updatePassword } = useAuth();
  const { profile, isLoading: profileLoading, updateProfile } = useProfile();

  const [displayName, setDisplayName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth', { replace: true });
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (profile?.display_name) {
      setDisplayName(profile.display_name);
    }
  }, [profile]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) return null;

  const handleSaveProfile = async () => {
    setIsSaving(true);
    try {
      await updateProfile({ display_name: displayName.trim() || null });
      toast.success('Profile updated');
    } catch (error) {
      toast.error('Failed to update profile');
    } finally {
      setIsSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (newPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    setIsChangingPassword(true);
    try {
      const { error } = await updatePassword(newPassword);
      if (error) throw error;
      toast.success('Password changed successfully');
      setShowPasswordDialog(false);
      setNewPassword('');
      setConfirmPassword('');
    } catch (error: any) {
      toast.error(error?.message || 'Failed to change password');
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="flex items-center h-14 px-4 gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Go back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold text-foreground">Settings</h1>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto py-8 px-4 space-y-6">
        {/* Profile Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>Manage your profile information</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="display-name">Display Name</Label>
                <Input
                  id="display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Enter your display name"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  value={user.email || ''}
                  disabled
                  className="bg-muted"
                />
                <p className="text-xs text-muted-foreground">Email cannot be changed</p>
              </div>
              <Button onClick={handleSaveProfile} disabled={isSaving} className="gap-2">
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save Changes
              </Button>
            </CardContent>
          </Card>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          <AISettingsCard />
        </motion.div>

        {/* Billing Section */}
        <BillingSection />


        {/* Security Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card>
            <CardHeader>
              <CardTitle>Security</CardTitle>
              <CardDescription>Manage your account security</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                onClick={() => setShowPasswordDialog(true)}
                className="gap-2"
              >
                <Key className="h-4 w-4" />
                Change Password
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        {/* Danger Zone */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Danger Zone
              </CardTitle>
              <CardDescription>
                Irreversible account actions
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button variant="outline" onClick={handleSignOut}>
                Sign Out
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" className="gap-2 ml-2">
                    <Trash2 className="h-4 w-4" />
                    Delete Account
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. This will permanently delete your
                      account and remove all your data including projects, documents,
                      and system designs.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        toast.error('Account deletion requires contacting support');
                      }}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete Account
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </motion.div>
      </main>

      {/* Password Change Dialog */}
      <Dialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change Password</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Confirm Password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isChangingPassword) {
                    handleChangePassword();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPasswordDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleChangePassword} disabled={isChangingPassword}>
              {isChangingPassword && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Change Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

function BillingSection() {
  const navigate = useNavigate();
  const { subscription, isPro, isPastDue, isLoading: isSubLoading } = useSubscription();
  const usage = useUsageLimits();
  const [isPortalLoading, setIsPortalLoading] = useState(false);

  const handleManageBilling = async () => {
    try {
      setIsPortalLoading(true);
      const { data, error } = await supabase.functions.invoke('create-portal-session', {
        body: { return_url: window.location.origin + '/settings' }
      });
      if (error) throw error;
      if (data?.url) {
        window.location.href = data.url;
      } else {
        toast.error('Failed to open billing portal');
      }
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('Failed to send a request') || msg.includes('FunctionsFetchError') || msg.includes('404')) {
        toast.error('Edge Function create-portal-session not deployed to Supabase yet.');
      } else {
        toast.error(msg || 'Error opening billing portal');
      }
    } finally {
      setIsPortalLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.08 }}
    >
      <Card className="border-border">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-primary" />
              <CardTitle>Subscription & Billing</CardTitle>
            </div>
            <div className={`px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 ${
              isPro ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-secondary text-muted-foreground'
            }`}>
              {isPro && <Crown className="h-3.5 w-3.5" />}
              {isPro ? 'PRO TIER' : 'FREE TIER'}
            </div>
          </div>
          <CardDescription>View your plan limits, current usage, and manage subscription settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Usage Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="p-3 rounded-lg bg-secondary/50 border border-border/50">
              <div className="text-xs text-muted-foreground font-medium">Projects</div>
              <div className="text-lg font-bold text-foreground mt-1">
                {usage.projects.used} / {usage.projects.limit ?? '∞'}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-secondary/50 border border-border/50">
              <div className="text-xs text-muted-foreground font-medium">Documents</div>
              <div className="text-lg font-bold text-foreground mt-1">
                {usage.documents.used} / {usage.documents.limit ?? '∞'}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-secondary/50 border border-border/50">
              <div className="text-xs text-muted-foreground font-medium">System Designs</div>
              <div className="text-lg font-bold text-foreground mt-1">
                {usage.systemDesigns.used} / {usage.systemDesigns.limit ?? '∞'}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-secondary/50 border border-border/50">
              <div className="text-xs text-muted-foreground font-medium">AI Gens (Month)</div>
              <div className="text-lg font-bold text-foreground mt-1">
                {usage.aiGenerations.used} / {usage.aiGenerations.limit ?? '∞'}
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2 border-t border-border/50">
            <div>
              {isPro ? (
                <p className="text-xs text-muted-foreground">
                  Your Pro plan status is <span className="text-emerald-400 font-medium capitalize">{subscription?.status || 'active'}</span>.
                  {subscription?.currentPeriodEnd && ` Renews on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}.`}
                </p>
              ) : isPastDue ? (
                <p className="text-xs text-amber-400">
                  Your subscription payment is past due. Pro features are paused until payment succeeds.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  You are currently on the Free plan. Upgrade to unlock unlimited storage and AI features.
                </p>
              )}
            </div>
            {isPro || (isPastDue && Boolean(subscription?.stripeCustomerId)) ? (
              <Button
                variant="outline"
                onClick={handleManageBilling}
                disabled={isPortalLoading}
                className="gap-2 w-full sm:w-auto"
              >
                {isPortalLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                Manage Subscription
              </Button>
            ) : (
              <Button
                onClick={() => navigate('/pricing')}
                className="gap-2 w-full sm:w-auto bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white"
              >
                <Crown className="h-4 w-4" />
                Upgrade to Pro
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default Settings;

