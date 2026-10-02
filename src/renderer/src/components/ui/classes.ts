/**
 * Shared look of the app forms and dialogs (same vocabulary as the onboarding: thin borders,
 * rounded corners, one green accent). Light and dark through Tailwind's `dark:` variants.
 */
export const inputClass = [
  'w-full h-9 px-3 rounded-lg text-sm outline-none',
  'border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900',
  'text-gray-900 dark:text-zinc-100 placeholder:text-gray-400 dark:placeholder:text-zinc-500',
  'transition-[border-color,box-shadow] duration-150',
  'focus:border-emerald-500 dark:focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20',
  'disabled:opacity-60 disabled:cursor-not-allowed',
].join(' ');

/** Technical values (hosts, ports, paths, URLs) */
export const monoInputClass = `${inputClass} font-mono text-[13px]`;

export const selectClass = `${inputClass} pr-8 cursor-pointer`;

const buttonBase = 'inline-flex items-center justify-center gap-1.5 h-9 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed';

export const btnPrimary = [
  buttonBase, 'min-w-[7rem] px-4',
  'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white',
  'disabled:opacity-40 active:translate-y-px',
].join(' ');

export const btnDanger = [
  buttonBase, 'min-w-[7rem] px-4',
  'bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500',
  'disabled:opacity-40 active:translate-y-px',
].join(' ');

export const btnSecondary = [
  buttonBase, 'px-3 font-normal',
  'border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900',
  'text-gray-700 dark:text-zinc-200 hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-50',
].join(' ');

export const btnGhost = [
  buttonBase, 'px-3 font-normal',
  'text-gray-600 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800 hover:text-gray-900 dark:hover:text-zinc-100',
  'disabled:opacity-50',
].join(' ');

/** Quiet surface for grouped content inside a dialog */
export const panelClass = 'rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50/70 dark:bg-zinc-800/30';
