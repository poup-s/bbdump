#!/usr/bin/env node
// Stage the MCP server for packaging (electron-builder extraResources).
//
// Output: mcp-postgres/bundle/
//   index.js, tools/*.js ...   compiled server (from mcp-postgres/build, .js only)
//   package.json               keeps "type": "module" so Node/Electron load the files as ESM
//   package-lock.json
//   node_modules/              production dependencies only (npm ci --omit=dev)
//
// The layout keeps resources/mcp-postgres/index.js at the same place as in v1.0.x,
// so MCP client configs written by older versions keep pointing to a valid file.
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpDir = path.join(root, 'mcp-postgres');
const buildDir = path.join(mcpDir, 'build');
const outDir = path.join(mcpDir, 'bundle');

if (!fs.existsSync(path.join(buildDir, 'index.js'))) {
  console.error('mcp-postgres/build/index.js is missing: run "npm run build:mcp" first.');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// Compiled JavaScript only (no .d.ts / source maps).
fs.cpSync(buildDir, outDir, {
  recursive: true,
  filter: (src) => fs.statSync(src).isDirectory() || src.endsWith('.js'),
});

const pkg = JSON.parse(fs.readFileSync(path.join(mcpDir, 'package.json'), 'utf-8'));
const stagedPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  private: true,
  type: 'module',
  main: 'index.js',
  dependencies: pkg.dependencies,
  // Kept so package.json stays in sync with package-lock.json for `npm ci`;
  // --omit=dev below means none of them are installed.
  devDependencies: pkg.devDependencies,
  // Versions forced on dependencies of dependencies (the lock file was written with them)
  ...(pkg.overrides ? { overrides: pkg.overrides } : {}),
};
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(stagedPkg, null, 2) + '\n');
fs.copyFileSync(path.join(mcpDir, 'package-lock.json'), path.join(outDir, 'package-lock.json'));

execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: outDir, stdio: 'inherit' });
// Type declarations only, installed as peer dependencies (mysql2 asks for @types/node): no runtime code
fs.rmSync(path.join(outDir, 'node_modules', '@types'), { recursive: true, force: true });
// The web browsers' Microsoft sign-in library (21 MB), pulled by SQL Server's driver: never loaded
// by Node, which uses msal-node (and bbdump signs in to SQL Server with a password)
fs.rmSync(path.join(outDir, 'node_modules', '@azure', 'msal-browser'), { recursive: true, force: true });

// Sanity checks: no dev-only packages, entry point present, SQL Server's driver still loads.
for (const devDep of Object.keys(pkg.devDependencies || {})) {
  if (fs.existsSync(path.join(outDir, 'node_modules', devDep))) {
    throw new Error(`devDependency ${devDep} ended up in the MCP bundle`);
  }
}
if (!fs.existsSync(path.join(outDir, 'index.js'))) throw new Error('bundle/index.js missing');
execSync(`node -e "require('mssql')"`, { cwd: outDir, stdio: 'inherit' });

console.log(`MCP server bundled in ${path.relative(root, outDir)}`);
