import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function sanitizeRedirectUrl(url?: string | null, defaultPath = '/dashboard'): string {
  if (!url) return defaultPath;
  const trimmed = url.trim();
  // Prevent protocol-relative open redirects starting with // or javascript:
  if (trimmed.startsWith('//') || trimmed.toLowerCase().startsWith('javascript:')) {
    return defaultPath;
  }
  // Allow relative paths starting with /
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed;
  }
  return defaultPath;
}

