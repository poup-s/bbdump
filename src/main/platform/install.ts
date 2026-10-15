/**
 * Install plans and installs for the onboarding, dispatched to the OS adapter.
 * Never throws: failures come back as { success: false, error, manualCommand }.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  SetupComponent, SetupEnvironment, SetupInstallPlan, SetupInstallResult, SetupProgress, SetupStage,
} from '../../types/setup';
import { detectEnvironment, installFamily } from './environment';
import {
  buildLinuxScript, isValidUsername, parseStepLine, runScriptWithPkexec, sudoCommand, type LinuxComponent,
} from './linux';
import { defaultBrewPath, macosCommand, macosSteps, runBrew } from './macos';
import {
  WINGET_CLIENT_MAJORS, serverOptionFile, windowsCommand, windowsServiceName, wingetClientToolsArgs, wingetOutcome, wingetServerArgs,
} from './windows';
import { addNewestPgBinToPath, windowsPgServers } from './windowsPg';
import { defaultWhich, isPortOpen, run } from './probe';

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

  // Windows (beta): the client tools, or the server with them, through winget when it is there
  return {
    component,
    automatic: component !== 'homebrew' && env.packageManager?.id === 'winget',
    command: windowsCommand(component),
  };
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

/** Whether runInstall goes ahead: a supported system where bbdump can install it itself */
export function canRunInstall(env: SetupEnvironment, plan: SetupInstallPlan): boolean {
  return plan.automatic && env.supported;
}

export async function runInstall(
  component: SetupComponent,
  onProgress: (progress: SetupProgress) => void,
  options: { windowsMajors?: readonly string[] } = {},
): Promise<SetupInstallResult> {
  if (installing) return { success: false, error: 'Another installation is already running' };
  installing = true;
  try {
    const env = await getEnvironment(10000);
    const plan = planFor(component, env);
    const progress: ProgressFn = (percent, message, stage) => onProgress({ component, percent, message, stage });

    if (!canRunInstall(env, plan)) {
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
    if (env.os === 'windows') {
      outcome = component === 'server'
        ? await installWindowsServer(env, progress)
        : await installWindowsClientTools(env, progress, options.windowsMajors);
    } else if (env.os === 'macos') {
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

/**
 * PostgreSQL's client tools on Windows: winget runs the EDB installer (Windows asks once for
 * administrator rights), newest version winget has first. Then their folder joins PATH.
 */
async function installWindowsClientTools(
  env: SetupEnvironment,
  progress: ProgressFn,
  majors: readonly string[] = WINGET_CLIENT_MAJORS,
): Promise<{ success: boolean; error?: string }> {
  const winget = env.packageManager?.path;
  if (!winget) return { success: false, error: 'winget is not available on this computer' };
  for (const major of majors) {
    progress(10, `winget install PostgreSQL ${major} (client tools)`, 'packages');
    const run = await runWinget(winget, wingetClientToolsArgs(major), progress);
    const outcome = wingetOutcome(run.code, run.output);
    if (outcome === 'installed') {
      addNewestPgBinToPath();
      return { success: true };
    }
    if (outcome === 'not-found') continue;
    if (outcome === 'cancelled') return { success: false, error: 'The administrator prompt was refused: nothing was installed.' };
    const tail = run.output.trim().split(/\r?\n/).slice(-5).join('\n');
    return { success: false, error: `winget could not install PostgreSQL ${major}${tail ? `:\n${tail}` : ''}` };
  }
  return { success: false, error: 'winget has no PostgreSQL package for this computer' };
}

/** Runs winget without a shell window; its last meaningful line is shown as progress */
async function runWinget(winget: string, args: string[], progress: ProgressFn): Promise<{ code: number | null; output: string }> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(winget, args, { windowsHide: true });
    const timer = setTimeout(() => child.kill(), 20 * 60 * 1000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      // winget redraws its progress bar with \r: show the last meaningful line
      const line = chunk.toString().split(/[\r\n]+/).map(l => l.trim()).filter(l => /[a-z]{3}/i.test(l)).pop();
      if (line) progress(40, line.slice(0, 160), 'packages');
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, output: `${output}\n${error.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await isPortOpen(port, 'localhost', 1500)) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

/**
 * The PostgreSQL server on Windows: winget runs the EDB installer with an option file (server
 * and command line tools, a service started with Windows). bbdump generates the "postgres"
 * password and keeps it encrypted; Windows asks once for administrator rights. A server
 * already installed but stopped is started instead.
 */
async function installWindowsServer(env: SetupEnvironment, progress: ProgressFn): Promise<{ success: boolean; error?: string }> {
  if (env.server.installed && !env.server.running) return startWindowsServer(env.server.port, progress);
  if (env.server.running) {
    return { success: false, error: 'PostgreSQL already runs on this computer: give bbdump the password of its "postgres" user' };
  }
  const winget = env.packageManager?.path;
  if (!winget) return { success: false, error: 'winget is not available on this computer' };

  const { saveLocalServerCredential } = await import('../localServerCredential');
  const password = crypto.randomBytes(18).toString('base64url');
  // Saved first: the server must stay reachable even if bbdump stops during the install
  saveLocalServerCredential({ user: 'postgres', password });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-pg-'));
  const optionFile = path.join(dir, 'postgresql.opt');
  try {
    fs.writeFileSync(optionFile, serverOptionFile(password, env.server.port), { encoding: 'utf8', mode: 0o600 });
    for (const major of WINGET_CLIENT_MAJORS) {
      progress(10, `winget install PostgreSQL ${major} (server)`, 'packages');
      const run = await runWinget(winget, wingetServerArgs(major, optionFile), progress);
      const outcome = wingetOutcome(run.code, run.output);
      if (outcome === 'not-found') continue;
      if (outcome === 'cancelled') return { success: false, error: 'The administrator prompt was refused: nothing was installed.' };
      if (outcome === 'failed') {
        const tail = run.output.trim().split(/\r?\n/).slice(-5).join('\n');
        return { success: false, error: `winget could not install PostgreSQL ${major}${tail ? `:\n${tail}` : ''}` };
      }
      addNewestPgBinToPath();
      progress(85, `Waiting for PostgreSQL ${major} on port ${env.server.port}`, 'waitReady');
      if (!(await waitForPort(env.server.port, 60000))) {
        return { success: false, error: `PostgreSQL ${major} is installed but does not answer on port ${env.server.port}` };
      }
      return { success: true };
    }
    return { success: false, error: 'winget has no PostgreSQL package for this computer' };
  } finally {
    // The option file holds the password: never left behind
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Starts the newest PostgreSQL service; sc.exe needs administrator rights (one Windows prompt) */
async function startWindowsServer(port: number, progress: ProgressFn): Promise<{ success: boolean; error?: string }> {
  const major = windowsPgServers()[0]?.major;
  if (!major) return { success: false, error: 'No PostgreSQL server found in Program Files' };
  const service = windowsServiceName(major);
  progress(30, `Starting the ${service} service`, 'service');
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await run(powershell, [
    '-NoProfile', '-NonInteractive', '-Command',
    `Start-Process -FilePath sc.exe -ArgumentList 'start','${service}' -Verb RunAs -WindowStyle Hidden -Wait`,
  ], 120000);
  if (!result.ok && /cancel|annul/i.test(result.stderr)) {
    return { success: false, error: 'The administrator prompt was refused: PostgreSQL was not started.' };
  }
  progress(70, `Waiting for PostgreSQL on port ${port}`, 'waitReady');
  if (await waitForPort(port, 30000)) return { success: true };
  return { success: false, error: `The ${service} service did not start${result.stderr.trim() ? `:\n${result.stderr.trim().slice(-300)}` : ''}` };
}

/** Windows: the client tools of one PostgreSQL version (a backup needs that version's pg_dump) */
export async function installWindowsPgClient(major: string): Promise<SetupInstallResult> {
  if (process.platform !== 'win32' || !/^\d{2}$/.test(major)) return { success: false, error: 'Not available on this system' };
  // The toast says it is running: no progress to show
  return runInstall('client-tools', () => {}, { windowsMajors: [major] });
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
