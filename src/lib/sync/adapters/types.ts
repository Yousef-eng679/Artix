import { OutboxEntry } from '@/lib/local/types';

export interface PushResult {
  version?: string;
  updated_at?: string;
}

export interface EntityPushAdapter {
  push(entry: OutboxEntry, supabase: any): Promise<PushResult | null>;
}
