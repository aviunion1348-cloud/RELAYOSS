/** Design-system primitives. Small, composable, no external UI dependency. */
import { forwardRef, type ReactNode, type ButtonHTMLAttributes, type HTMLAttributes } from 'react';
import { Icons } from './icons';
import { cls } from '../lib/cls';

/* ------------------------------------------------------------------ button */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
  size?: 'xs' | 'sm' | 'md';
  icon?: keyof typeof Icons;
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', icon, loading, className, children, ...rest },
  ref,
) {
  const Icon = icon ? (Icons[icon] as React.ComponentType<{ size?: number; className?: string }>) : null;
  return (
    <button
      ref={ref}
      {...rest}
      disabled={rest.disabled || loading}
      className={cls(
        'inline-flex select-none items-center justify-center gap-1.5 rounded-lg border font-medium transition-all',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'xs' && 'h-7 px-2 text-[11px]',
        size === 'sm' && 'h-8 px-2.5 text-[12.5px]',
        size === 'md' && 'h-9.5 px-3.5 text-[13px]',
        /*
         * Dark ink text on gold, not white on gold: at this lightness white
         * fails contrast, and this is the primary action of the whole product.
         */
        variant === 'primary' &&
          'border-gold-400/70 bg-gradient-to-b from-gold-300 to-gold-500 text-ink-950 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.45),0_6px_20px_-8px_rgb(212_164_76/0.85)] hover:from-gold-200 hover:to-gold-400 active:translate-y-px',
        variant === 'secondary' &&
          'border-ink-600 bg-ink-750/70 text-mist-200 backdrop-blur-md hover:border-gold-600/45 hover:bg-ink-700/80 hover:text-white active:translate-y-px',
        variant === 'ghost' && 'border-transparent bg-transparent text-mist-400 hover:bg-ink-750/70 hover:text-gold-200',
        variant === 'danger' && 'border-rose-500/40 bg-rose-500/12 text-rose-400 hover:bg-rose-500/20 hover:text-rose-300',
        variant === 'success' && 'border-mint-500/40 bg-mint-500/12 text-mint-400 hover:bg-mint-500/20',
        className,
      )}
    >
      {loading ? <Icons.Loader2 size={13} className="animate-spin" /> : Icon ? <Icon size={size === 'xs' ? 12 : 14} /> : null}
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------- badge */
export function Badge({
  children, tone = 'neutral', dot, className, mono,
}: { children: ReactNode; tone?: string; dot?: boolean; className?: string; mono?: boolean }) {
  const tones: Record<string, string> = {
    neutral: 'border-ink-500 bg-ink-750 text-mist-300',
    iris: 'border-gold-500/35 bg-gold-500/10 text-gold-300',
    mint: 'border-mint-500/30 bg-mint-500/10 text-mint-400',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    rose: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
    sky: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
    outline: 'border-ink-500 bg-transparent text-mist-400',
  };
  return (
    <span
      className={cls(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium leading-none tracking-tight',
        mono && 'font-mono tabular',
        tones[tone] ?? tones.neutral,
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export const PRIORITY_TONE: Record<string, string> = { urgent: 'rose', high: 'amber', medium: 'sky', low: 'neutral' };
export const STATUS_TONE: Record<string, string> = {
  backlog: 'neutral', todo: 'neutral', in_progress: 'iris', review: 'amber', blocked: 'rose', done: 'mint', cancelled: 'outline',
};
export const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog', todo: 'Ready', in_progress: 'In Progress', review: 'In Review', blocked: 'Blocked', done: 'Shipped', cancelled: 'Cancelled',
};
export const HEALTH_TONE: Record<string, string> = { healthy: 'mint', watch: 'amber', at_risk: 'rose', churn: 'rose', on_track: 'mint', critical: 'rose' };
export const RISK_TONE: Record<string, string> = { low: 'neutral', medium: 'sky', high: 'amber', critical: 'rose' };

/* ------------------------------------------------------------------ avatar */
export function Avatar({ name, initials, color, size = 22, ring }: { name: string; initials: string; color: string; size?: number; ring?: boolean }) {
  return (
    <span
      title={name}
      style={{ background: `color-mix(in oklab, ${color} 24%, #0a0908)`, color, width: size, height: size, fontSize: size * 0.42 }}
      className={cls('inline-grid shrink-0 place-items-center rounded-full font-semibold tracking-tight', ring && 'ring-1 ring-ink-600')}
    >
      {initials || name.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function AvatarStack({ people, max = 3, size = 20 }: { people: Array<{ initials: string; color: string; name: string }>; max?: number; size?: number }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map((p) => (
        <span key={p.name} className="rounded-full ring-2 ring-ink-850">
          <Avatar {...p} size={size} />
        </span>
      ))}
      {rest > 0 && (
        <span className="grid place-items-center rounded-full bg-ink-700 text-[9.5px] font-semibold text-mist-400 ring-2 ring-ink-850" style={{ width: size, height: size }}>
          +{rest}
        </span>
      )}
    </span>
  );
}

/* -------------------------------------------------------------------- card */
export function Card({
  children, className, hover, hero, ...rest
}: HTMLAttributes<HTMLDivElement> & { hover?: boolean; hero?: boolean }) {
  /*
   * Three levels of presence, and only three, so a screen never becomes a field
   * of equally-important boxes:
   *
   *   hero    one per screen — the thing the reader came for
   *   hover   interactive: lifts 2px and its hairline brightens
   *   plain   a container, deliberately quiet
   *
   * The gradient hairline (`edge`) is what separates these from a wireframe:
   * a flat 1px border reads as a mockup, while a border that brightens towards
   * one corner reads as a lit edge.
   */
  return (
    <div
      {...rest}
      className={cls(
        'edge rounded-xl',
        hero ? 'surface-hero' : 'surface',
        hover && 'surface-hover lift edge-hover',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionHeader({
  title, subtitle, right, icon, className,
}: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; icon?: keyof typeof Icons; className?: string }) {
  const Icon = icon ? (Icons[icon] as React.ComponentType<{ size?: number; className?: string }>) : null;
  return (
    <div className={cls('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white">
          {Icon ? (
            <Icon size={14} className="text-gold-500" />
          ) : (
            <span className="h-3 w-[2px] rounded-full bg-gold-500/70" />
          )}
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 text-[11.5px] leading-relaxed text-mist-500">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */
export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cls(
        'h-8 w-full rounded-lg border border-ink-600 bg-ink-850 px-2.5 text-[12.5px] text-mist-200 placeholder:text-mist-500/70',
        'transition-colors focus:border-gold-500/60 focus:outline-none focus:ring-2 focus:ring-gold-500/20',
        className,
      )}
    />
  );
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={cls(
        'w-full resize-none rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-2 text-[12.5px] leading-relaxed text-mist-200 placeholder:text-mist-500/70',
        'transition-colors focus:border-gold-500/60 focus:outline-none focus:ring-2 focus:ring-gold-500/20',
        className,
      )}
    />
  );
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...rest}
        className={cls(
          'h-8 w-full appearance-none rounded-lg border border-ink-600 bg-ink-850 pl-2.5 pr-7 text-[12.5px] text-mist-200',
          'transition-colors focus:border-gold-500/60 focus:outline-none focus:ring-2 focus:ring-gold-500/20',
          className,
        )}
      >
        {children}
      </select>
      <Icons.ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-mist-500" />
    </div>
  );
}

/* ------------------------------------------------------------------ toggles */
export function Segmented<T extends string>({
  options, value, onChange, size = 'sm',
}: { options: Array<{ value: T; label: string; icon?: keyof typeof Icons }>; value: T; onChange: (v: T) => void; size?: 'xs' | 'sm' }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-ink-600 bg-ink-850 p-0.5">
      {options.map((o) => {
        const Icon = o.icon ? (Icons[o.icon] as React.ComponentType<{ size?: number }>) : null;
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={cls(
              'inline-flex items-center gap-1.5 rounded-md font-medium transition-all',
              size === 'xs' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-[12px]',
              active ? 'bg-ink-700 text-white shadow-[inset_0_1px_0_0_rgb(255_255_255/0.06)]' : 'text-mist-500 hover:text-mist-300',
            )}
          >
            {Icon && <Icon size={12} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ meters */
export function Progress({ value, tone = 'iris', className, height = 4 }: { value: number; tone?: string; className?: string; height?: number }) {
  const colors: Record<string, string> = {
    iris: 'bg-iris-500', mint: 'bg-mint-500', amber: 'bg-amber-500', rose: 'bg-rose-500', sky: 'bg-sky-500', mist: 'bg-mist-500',
  };
  return (
    <div className={cls('w-full overflow-hidden rounded-full bg-ink-700/80 ring-1 ring-inset ring-white/[0.04]', className)} style={{ height }}>
      <div
        className={cls('h-full rounded-full transition-[width] duration-500', colors[tone] ?? colors.iris)}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function Ring({ value, size = 44, stroke = 3.5, tone = '#d4a44c', label }: { value: number; size?: number; stroke?: number; tone?: string; label?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.min(100, Math.max(0, value)) / 100) * c;
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-ink-600" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={offset} className="transition-[stroke-dashoffset] duration-700"
        />
      </svg>
      <span className="absolute text-[10.5px] font-semibold tabular text-white">{label ?? `${value}%`}</span>
    </div>
  );
}

export function Sparkline({ values, tone = '#d4a44c', height = 28, width = 96 }: { values: number[]; tone?: string; height?: number; width?: number }) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * width},${height - ((v - min) / span) * (height - 4) - 2}`);
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={pts.join(' ')} fill="none" stroke={tone} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ misc --- */
export function Dot({ tone = 'mint', pulse }: { tone?: string; pulse?: boolean }) {
  const colors: Record<string, string> = { mint: 'bg-mint-500', amber: 'bg-amber-500', rose: 'bg-rose-500', iris: 'bg-iris-500', mist: 'bg-mist-500', sky: 'bg-sky-500' };
  return <span className={cls('size-1.5 rounded-full', colors[tone], pulse && 'pulse-dot')} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-ink-500 bg-ink-800 px-1 py-0.5 font-mono text-[10px] text-mist-400">{children}</kbd>;
}

export function Empty({ icon = 'Inbox', title, hint }: { icon?: keyof typeof Icons; title: string; hint?: string }) {
  const Icon = Icons[icon] as React.ComponentType<{ size?: number; className?: string }>;
  return (
    <div className="grid place-items-center gap-2 px-6 py-12 text-center">
      <span className="grid size-10 place-items-center rounded-xl border border-ink-600 bg-ink-800 text-mist-500">
        <Icon size={18} />
      </span>
      <p className="text-[12.5px] font-medium text-mist-300">{title}</p>
      {hint && <p className="max-w-[36ch] text-[11.5px] leading-relaxed text-mist-500">{hint}</p>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cls('shimmer rounded-md ring-1 ring-inset ring-white/[0.03]', className)} />;
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span className="pointer-events-none absolute -top-8 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border border-ink-500 bg-ink-800 px-2 py-1 text-[10.5px] text-mist-200 opacity-0 shadow-xl transition-opacity group-hover/tt:opacity-100">
        {label}
      </span>
    </span>
  );
}

const TONE_TEXT: Record<string, string> = {
  iris: 'text-iris-300',
  mint: 'text-mint-400',
  amber: 'text-amber-400',
  rose: 'text-rose-400',
  sky: 'text-sky-400',
  mist: 'text-mist-400',
};

export function Stat({
  label, value, sub, tone, icon, trend,
}: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; icon?: keyof typeof Icons; trend?: ReactNode }) {
  const Icon = icon ? (Icons[icon] as React.ComponentType<{ size?: number; className?: string }>) : null;
  return (
    <Card className="group p-3.5" hover>
      <div className="flex items-start justify-between gap-2">
        <p className="eyebrow">{label}</p>
        {Icon && (
          <Icon
            size={13}
            className={cls('shrink-0 transition-transform duration-300 group-hover:scale-110', TONE_TEXT[tone ?? ''] ?? 'text-mist-500')}
          />
        )}
      </div>
      <p className="metric mt-2 text-[26px] font-semibold leading-none text-white">{value}</p>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-mist-500">{trend}{sub}</div>
    </Card>
  );
}
