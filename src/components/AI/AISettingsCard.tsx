import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
  Sparkles,
  Eye,
  EyeOff,
  Loader2,
  Check,
  AlertCircle,
  ChevronDown,
  Trash2,
  Lock,
  Unlock,
  ShieldCheck,
} from 'lucide-react';
import { useAISettings } from '@/hooks/useAISettings';
import { PROVIDER_LIST, PROVIDERS, providerNeedsKey } from '@/lib/ai/registry';
import { ProviderId, AIError } from '@/lib/ai/types';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type SlotKey = 'primary' | 'backup';
type TestStatus = 'idle' | 'loading' | 'success' | 'error';

function ProviderSlot({ slot, label }: { slot: SlotKey; label: string }) {
  const { settings, update } = useAISettings();
  const current = settings[slot];
  const [provider, setProvider] = useState<ProviderId>(current?.provider ?? 'openai');
  const [model, setModel] = useState<string>(
    current?.model ?? PROVIDERS[current?.provider ?? 'openai'].defaultModel
  );
  const [apiKey, setApiKey] = useState<string>(current?.apiKey ?? '');
  const [baseUrl, setBaseUrl] = useState<string>(
    current?.baseUrl ?? PROVIDERS[current?.provider ?? 'openai'].defaultBaseUrl ?? ''
  );
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');

  const providerDef = PROVIDERS[provider];

  const handleProviderChange = (p: ProviderId) => {
    setProvider(p);
    setModel(PROVIDERS[p].defaultModel);
    setBaseUrl(PROVIDERS[p].defaultBaseUrl ?? '');
    setTestStatus('idle');
  };

  const needsKey = providerNeedsKey(provider);
  const needsBaseUrl = !!providerDef.needsBaseUrl;
  const allowCustomModel = !!providerDef.allowCustomModel;
  const isPresetModel = providerDef.models.some((m) => m.id === model);

  const handleSave = () => {
    if (needsKey && !apiKey.trim()) {
      toast.error('Enter an API key');
      return;
    }
    try {
      update({
        ...settings,
        [slot]: {
          provider,
          model: model.trim(),
          apiKey: needsKey ? apiKey.trim() : '',
          ...(needsBaseUrl ? { baseUrl: baseUrl.trim() || providerDef.defaultBaseUrl } : {}),
        },
      });
      toast.success(`${label} provider saved`, {
        description: 'Please keep a backup of your API key in a safe place. Keys are stored locally in your browser cache, and Artix does not store a copy on our servers.',
      });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handleTest = async () => {
    if (needsKey && !apiKey.trim()) {
      setTestStatus('error');
      setTestMessage('Enter an API key first');
      return;
    }
    setTestStatus('loading');
    setTestMessage('');
    try {
      await providerDef.testConnection({
        apiKey: needsKey ? apiKey.trim() : '',
        model: model.trim(),
        baseUrl: needsBaseUrl ? (baseUrl.trim() || providerDef.defaultBaseUrl) : undefined,
      });
      setTestStatus('success');
      setTestMessage('Connection OK');
    } catch (err) {
      const e = err as AIError;
      setTestStatus('error');
      setTestMessage(e.message || 'Connection failed');
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="text-sm font-medium">{label}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label>Provider</Label>
          <Select value={provider} onValueChange={(v) => handleProviderChange(v as ProviderId)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_LIST.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>Model</Label>
          <Select
            value={isPresetModel ? model : '__custom__'}
            onValueChange={(v) => {
              if (v === '__custom__') return;
              setModel(v);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Pick a model" />
            </SelectTrigger>
            <SelectContent>
              {providerDef.models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
              {allowCustomModel && (
                <SelectItem value="__custom__">Custom…</SelectItem>
              )}
            </SelectContent>
          </Select>
          {allowCustomModel && (
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Or type a custom model id"
              className="font-mono text-xs"
            />
          )}
        </div>
      </div>
      {needsBaseUrl && (
        <div className="grid gap-2">
          <Label>Base URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={providerDef.defaultBaseUrl}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            Ollama must be running locally. If you get a CORS error, restart with{' '}
            <code className="text-[10px]">OLLAMA_ORIGINS=* ollama serve</code>.
          </p>
        </div>
      )}
      {needsKey ? (
        <div className="grid gap-2">
          <Label>API key</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={`Paste your ${providerDef.label} key`}
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-amber-400/90 flex items-center gap-1.5 mt-0.5">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            Keep a backup copy of your API key in a safe place. If your browser cache is cleared, Artix will not be able to recover it.
          </p>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground rounded-md border border-border bg-muted/30 p-3">
          No key needed — calls your local Ollama server directly from the browser.
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={handleSave} size="sm">
          Save
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={testStatus === 'loading'}
          className="gap-2"
        >
          {testStatus === 'loading' && <Loader2 className="h-4 w-4 animate-spin" />}
          Test connection
        </Button>
        {testStatus !== 'idle' && testStatus !== 'loading' && (
          <span
            className={cn(
              'text-xs flex items-center gap-1',
              testStatus === 'success' ? 'text-success' : 'text-destructive'
            )}
          >
            {testStatus === 'success' ? (
              <Check className="h-3 w-3" />
            ) : (
              <AlertCircle className="h-3 w-3" />
            )}
            {testMessage}
          </span>
        )}
      </div>
    </div>
  );
}

function EncryptionPanel() {
  const {
    encrypted,
    unlocked,
    unlock,
    lock,
    enableEncryption,
    disableEncryption,
    changePassphrase,
    clear,
  } = useAISettings();
  const [open, setOpen] = useState(false);
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [oldPass, setOldPass] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      setPass1('');
      setPass2('');
      setOldPass('');
    } catch (err) {
      toast.error((err as Error).message || 'Operation failed');
    } finally {
      setBusy(false);
    }
  };

  // Locked state — show unlock form and reset vault dialog if passphrase is forgotten
  if (encrypted && !unlocked) {
    return (
      <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Lock className="h-4 w-4 text-amber-500" />
          AI keys are encrypted &amp; locked
        </div>
        <p className="text-xs text-muted-foreground">
          Enter your passphrase to unlock keys for this session.
        </p>
        <div className="flex gap-2">
          <Input
            type="password"
            placeholder="Passphrase"
            value={pass1}
            onChange={(e) => setPass1(e.target.value)}
            className="font-mono"
          />
          <Button
            size="sm"
            disabled={busy || !pass1}
            onClick={() => run(() => unlock(pass1), 'Unlocked')}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Unlock'}
          </Button>
        </div>

        <div className="pt-2 border-t border-amber-500/20 flex justify-between items-center">
          <span className="text-xs text-muted-foreground">Forgot your passphrase?</span>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10">
                <Trash2 className="h-3 w-3 mr-1" />
                Reset Key Vault
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset Encrypted AI Key Vault?</AlertDialogTitle>
                <AlertDialogDescription>
                  Because AES-256-GCM encryption is zero-knowledge, lost passphrases cannot be decrypted.
                  Resetting will clear the encrypted key vault from this browser so you can enter fresh API keys.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    clear();
                    toast.success('Key vault reset. You can now add fresh API keys.');
                  }}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Reset Vault
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
          <ShieldCheck className="h-4 w-4 text-primary" />
          Encryption{' '}
          <span className="text-xs text-muted-foreground">
            ({encrypted ? 'enabled' : 'off'})
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <div className="space-y-3 rounded-md border border-border p-4">
          {!encrypted ? (
            <>
              <p className="text-xs text-muted-foreground">
                Encrypt your stored API keys with a passphrase (AES-256-GCM, PBKDF2). You'll be asked
                for the passphrase once per browser session.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  type="password"
                  placeholder="Passphrase (min 8 chars)"
                  value={pass1}
                  onChange={(e) => setPass1(e.target.value)}
                  className="font-mono"
                />
                <Input
                  type="password"
                  placeholder="Confirm passphrase"
                  value={pass2}
                  onChange={(e) => setPass2(e.target.value)}
                  className="font-mono"
                />
              </div>
              <Button
                size="sm"
                disabled={busy || pass1.length < 8 || pass1 !== pass2}
                onClick={() => run(() => enableEncryption(pass1), 'Encryption enabled')}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Enable encryption'}
              </Button>
              {pass1 && pass2 && pass1 !== pass2 && (
                <p className="text-xs text-destructive">Passphrases don't match.</p>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Keys are encrypted. Unlocked for this session.
              </p>
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    lock();
                    toast.success('Locked');
                  }}
                  className="gap-2"
                >
                  <Lock className="h-4 w-4" />
                  Lock now
                </Button>
              </div>

              <div className="pt-2 border-t border-border space-y-2">
                <Label className="text-xs">Change passphrase</Label>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Input
                    type="password"
                    placeholder="Current"
                    value={oldPass}
                    onChange={(e) => setOldPass(e.target.value)}
                    className="font-mono"
                  />
                  <Input
                    type="password"
                    placeholder="New"
                    value={pass1}
                    onChange={(e) => setPass1(e.target.value)}
                    className="font-mono"
                  />
                  <Input
                    type="password"
                    placeholder="Confirm new"
                    value={pass2}
                    onChange={(e) => setPass2(e.target.value)}
                    className="font-mono"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !oldPass || pass1.length < 8 || pass1 !== pass2}
                  onClick={() => run(() => changePassphrase(oldPass, pass1), 'Passphrase changed')}
                >
                  Change passphrase
                </Button>
              </div>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AISettingsCard() {
  const { settings, clear, encrypted, unlocked } = useAISettings();
  const [backupOpen, setBackupOpen] = useState(!!settings.backup);
  const locked = encrypted && !unlocked;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          AI Configuration
        </CardTitle>
        <CardDescription>
          Bring your own key — keys are stored only in your browser and sent directly to the provider.
          Artix never sees them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <EncryptionPanel />

        {!locked && (
          <>
            <ProviderSlot slot="primary" label="Primary provider" />

            <Collapsible open={backupOpen} onOpenChange={setBackupOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2">
                  <ChevronDown
                    className={cn('h-4 w-4 transition-transform', backupOpen && 'rotate-180')}
                  />
                  Backup provider (optional)
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <ProviderSlot slot="backup" label="Backup provider" />
              </CollapsibleContent>
            </Collapsible>

            <div className="pt-2">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2 text-destructive">
                    <Trash2 className="h-4 w-4" />
                    Clear all AI keys
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove all AI keys?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This deletes your AI provider keys (and any encryption blob) from this browser.
                      You can paste them again any time.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        clear();
                        toast.success('AI keys cleared');
                      }}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Clear
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
