/**
 * Install plans and installs for the onboarding, dispatched to the OS adapter.
 * Never throws: failures come back as { success: false, error, manualCommand }.
 */
import * as os from 'os';
import type {
  SetupComponent, SetupEnvironment, SetupInstallPlan, SetupInstallResult, SetupProgress, SetupStage,
} from '../../types/setup';
import { detectEnvironment, installFamily } from './environment';
import {
  buildLinuxScript, isValidUsername, parseStepLine, runScriptWithPkexec, sudoCommand, type LinuxComponent,
} from './linux';
import { defaultBrewPath, macosCommand, macosSteps, runBrew } from './macos';
import { windowsCommand } from './windows';
import { defaultWhich } from './probe';

export const SETUP_COMPONENTS: readonly SetupComponent[] = ['homebrew', 'client-tools', 'server'];

export function isSetupComponent(value: unknown): value is SetupComponent {
  return typeof value === 'string' && (SETUP_COMPONENTS as readonly string[]).includes(value);
}

function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/** Builds the plan for a component from an already detected environment. Pure. */
export function planFor(component: SetupComponent, env: SetupEnvironment, user = currentUser()): SetupInstallPlan {
  if (env.os === 'macos') {
    const brew = env.homebrew?.path || env.packageManager?.path || defaultBrewPath(env.arch);
    return {
      component,
      // Homebrew itself: bbdump opens Terminal with the official script
      automatic: component === 'homebrew' ? true : env.canAutoInstall,
      command: macosCommand(component, brew),
    };
  }

  if (env.os === 'linux') {
    if (component === 'homebrew') return { component, automatic: false, command: '' };
    const family = installFamily(env);
    let command = '';
    try {
      command = family === 'unknown' ? '' : sudoCommand(buildLinuxScript(component, family, user));
    } catch {
      command = '';
    }
    return { component, automatic: env.canAutoInstall && command !== '', command };
  }

  return { component, automatic: false, command: windowsCommand(component) };
}

type ProgressFn = (percent: number, message: string, stage?: SetupStage) => void;

/** Stage of a Linux script step, from the percent its `step` line carries (see buildLinuxScript). */
export function linuxStage(percent: number): SetupStage {
  if (percent >= 100) return 'done';
  if (percent >= 90) return 'role';
  if (percent >= 75) return 'waitReady';
  if (percent >= 60) return 'service';
  if (percent >= 50) return 'initdb';
  return 'packages';
}

let lastEnvironment: { env: SetupEnvironment; at: number } | null = null;

async function freshEnvironment(): Promise<SetupEnvironment> {
  const env = await detectEnvironment();
  lastEnvironment = { env, at: Date.now() };
  return env;
}

/** Cached for a few seconds: the onboarding asks for a plan right after detecting. */
export async function getEnvironment(maxAgeMs = 0): Promise<SetupEnvironment> {
  if (maxAgeMs > 0 && lastEnvironment && Date.now() - lastEnvironment.at < maxAgeMs) {
    return lastEnvironment.env;
  }
  return freshEnvironment();
}

export async function getInstallPlan(component: SetupComponent): Promise<SetupInstallPlan> {
  return planFor(component, await getEnvironment(10000));
}

let installing = false;

export async function runInstall(
  component: SetupComponent,
  onProgress: (progress: SetupProgress) => void,
): Promise<SetupInstallResult> {
  if (installing) return { success: false, error: 'Another installation is already running' };
  installing = true;
  try {
    const env = await getEnvironment(10000);
    const plan = planFor(component, env);
    const progress: ProgressFn = (percent, message, stage) => onProgress({ component, percent, message, stage });

    if (!env.supported || !plan.automatic) {
      return {
        success: false,
        error: env.supported
          ? 'bbdump cannot install this automatically on this system'
          : `${env.osLabel} is not supported yet`,
        manualCommand: plan.command || undefined,
        environment: env,
      };
    }

    let outcome: { success: boolean; error?: string };
    if (env.os === 'macos') {
      outcome = await installMacos(component, env, progress);
    } else {
      outcome = await installLinux(component as LinuxComponent, env, progress);
    }

    progress(-1, 'Checking the result', 'checking');
    const after = await freshEnvironment();
    if (outcome.success) progress(100, 'Done', 'done');
    return {
      ...outcome,
      ...(outcome.success && component !== 'homebrew' ? {} : { manualCommand: plan.command || undefined }),
      environment: after,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    installing = false;
  }
}

async function installMacos(
  component: SetupComponent,
  env: SetupEnvironment,
  progress: ProgressFn,
): Promise<{ success: boolean; error?: string }> {
  if (component === 'homebrew') {
    // Homebrew's installer needs a TTY for sudo: it runs in a Terminal window
    const { installHomebrew } = await import('../tools/toolInstaller');
    progress(50, 'Opening Terminal with the Homebrew installer', 'terminal');
    const result = await installHomebrew(() => { /* messages below are the English ones */ });
    if (!result.success) return { success: false, error: 'Could not open Terminal' };
    progress(100, 'Terminal opened: finish the Homebrew installation there, then check again', 'terminal');
    return { success: true };
  }

  const brew = env.homebrew?.path || env.packageManager?.path;
  if (!brew) return { success: false, error: 'Homebrew is not installed' };

  const steps = macosSteps(component, brew);
  let percent = 5;
  for (const [index, step] of steps.entries()) {
    const label = step.slice(1).join(' ');
    percent = Math.round(5 + (index * 90) / steps.length);
    const stage: SetupStage = step[1] === 'services' ? 'service' : 'packages';
    progress(percent, `brew ${label}`, stage);
    const result = await runBrew(step, (line) => progress(percent, line, stage));
    if (result.code !== 0) {
      const tail = result.output.trim().split('\n').slice(-5).join('\n');
      return { success: false, error: `brew ${label} failed${tail ? `:\n${tail}` : ''}` };
    }
  }
  return { success: true };
}

async function installLinux(
  component: LinuxComponent,
  env: SetupEnvironment,
  progress: ProgressFn,
): Promise<{ success: boolean; error?: string }> {
  const user = currentUser();
  if (component === 'server' && !isValidUsername(user)) {
    return { success: false, error: `The user name "${user}" cannot be used for a PostgreSQL role` };
  }
  const pkexec = await defaultWhich('pkexec');
  if (!pkexec) return { success: false, error: 'pkexec is not available' };

  const script = buildLinuxScript(component, installFamily(env), user);
  progress(5, 'Waiting for your password', 'password');
  let percent = 5;
  let stage: SetupStage = 'password';
  const result = await runScriptWithPkexec(script, pkexec, (line) => {
    const step = parseStepLine(line);
    if (step) {
      percent = step.percent;
      stage = linuxStage(step.percent);
      progress(step.percent, step.message, stage);
    } else {
      progress(percent, line, stage);
    }
  });

  if (result.cancelled) {
    return { success: false, error: 'Authentication was cancelled or failed: nothing was installed' };
  }
  if (result.code !== 0) {
    const tail = result.output.trim().split('\n').slice(-5).join('\n');
    return { success: false, error: `Installation failed (exit code ${result.code})${tail ? `:\n${tail}` : ''}` };
  }
  return { success: true };
}
