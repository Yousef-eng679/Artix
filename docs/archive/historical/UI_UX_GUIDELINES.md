# UI and UX Guidelines — Artix

This document outlines the design system, color tokens, typography standards, and interaction rules for Artix.

---

## 1. Design System Aesthetic

Artix uses a dark mode SaaS interface with warm amber accents (`hsl(38 92% 50%)`), glassmorphism card surfaces, and developer-focused typography.

- **Dark Theme**: Dark mode is standard across all views.
- **Glassmorphism**: Backdrop blur classes (`backdrop-blur-md`, `backdrop-blur-xl`) paired with semi-transparent background layers (`bg-background/80`, `bg-card/50`).

---

## 2. Color Palette and Tokens (HSL Format)

All color tokens are declared in `src/index.css` using CSS custom properties in HSL format:

- **Background**: `hsl(220 14% 8%)` — Deep slate canvas (`#12151c`)
- **Card / Surface**: `hsl(220 13% 11%)` — Dark card surface (`#181c24`)
- **Foreground / Text**: `hsl(210 20% 98%)` — Off-white UI text (`#f8fafc`)
- **Muted Foreground**: `hsl(215 16% 57%)` — Muted slate text (`#64748b`)
- **Primary Accent (Warm Amber)**: `hsl(38 92% 50%)` — Golden amber (`#f59e0b`)
- **Primary Glow**: `box-shadow: 0 0 25px rgba(245, 158, 11, 0.25)` (`.glow-amber`)
- **Borders**: `hsl(220 13% 18%)` — Division lines (`#262b36`)

---

## 3. Typography Standards

- **Body and UI Font**: `Inter`, sans-serif
  - Used for titles, navigation links, buttons, inputs, and modal dialogs.
  - Weights: `400` (Regular), `500` (Medium), `600` (SemiBold), `700` (Bold).
- **Code and Syntax Font**: `JetBrains Mono`, monospace
  - Used in Monaco Editor, code previews, prompt output areas, and token counters.
  - Weights: `400` (Regular), `500` (Medium), `700` (Bold).

---

## 4. Component Patterns and Hierarchy

### Buttons and Actions
- **Primary Button**: Amber background (`bg-primary`), dark text, subtle hover scale (`glow-amber`).
- **Outline Button**: Dark background with border (`border-border/80`), hover border primary (`hover:border-primary/50`).
- **Icon Buttons**: Always specify `size="icon"` and an explicit `aria-label` attribute (e.g. `aria-label="Open menu"`).

### Dialog Modals
- **Sizing**: `sm:max-w-2xl` for standard dialogs; `max-w-4xl max-h-[90vh]` for AI generators (PRD, Vibe, Agentic).
- **Header**: Icon, Title, and subtitle description.
- **Footer**: Cancel/Close button on left, primary action button on right.

### Notifications and Warnings
- **API Key Storage Warning**: In `AISettingsCard.tsx`, an amber alert notice and toast message inform users that keys remain in local browser cache, prompting them to keep external backups.

---

## 5. Animations and Transitions

- **Page Transitions**: Framer Motion `motion.div` with fade-in and vertical slide (`y: 20 -> y: 0`).
- **Route Loading Fallback**: A static, hook-free `<PageFallback />` spinner component is rendered inside `<Suspense>` while lazy routes load.
- **Hover Micro-Interactions**: Smooth scale transforms (`hover:scale-[1.02]`) and border color transitions (`transition-colors duration-200`).
- **Loading States**: Animated spinner (`<Loader2 className="animate-spin" />`) with disabled state on active buttons.
