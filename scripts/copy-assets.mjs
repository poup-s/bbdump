#!/usr/bin/env node
// Copies the main process assets (tray icons) next to the compiled code. Node instead of
// mkdir/cp, so the build also runs on Windows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.cpSync(path.join(root, 'src/main/assets'), path.join(root, 'dist/main/assets'), { recursive: true });
