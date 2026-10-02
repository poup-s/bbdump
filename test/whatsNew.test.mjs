// "What's new" tour: who sees it, and that every slide has its screenshot, area and texts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const { buildSync } = require('esbuild');
const load = (file) => {
  const out = buildSync({ entryPoints: [path.join(root, file)], bundle: true, write: false, format: 'cjs', platform: 'node' });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
};
const { compareVersions, shouldShowWhatsNew, SLIDES, markOf, cameraFor, ringFor, WHATS_NEW_VERSION } = load('src/renderer/src/whatsNew.ts');
const { SHOT_MARKS } = load('src/renderer/src/whatsNewMarks.ts');
const { translations } = load('src/renderer/src/i18n.ts');
const { sanitizeAppConfig } = require(path.join(root, 'dist/main/configHelper.js'));

describe('who sees the tour', () => {
  test('versions compare by number, not as text', () => {
    assert.equal(compareVersions('1.0.2', '1.1.0'), -1);
    assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
    assert.equal(compareVersions('1.1.0', '1.1'), 0);
  });
  test('shown after updating from 1.0.x, not on configurations made by 1.1', () => {
    assert.equal(shouldShowWhatsNew('1.0.0'), true);
    assert.equal(shouldShowWhatsNew(WHATS_NEW_VERSION), false);
    assert.equal(shouldShowWhatsNew('1.2.0'), false);
    assert.equal(shouldShowWhatsNew(undefined), false);
    assert.equal(shouldShowWhatsNew(null), false);
  });
  test('the config keeps a valid seen version and drops anything else', () => {
    assert.equal(sanitizeAppConfig({ databases: [], whatsNewSeen: '1.0.0' }).whatsNewSeen, '1.0.0');
    assert.equal(sanitizeAppConfig({ databases: [], whatsNewSeen: 'yes' }).whatsNewSeen, undefined);
    assert.equal(sanitizeAppConfig({ databases: [] }).whatsNewSeen, undefined);
  });
});

describe('every slide is complete, in both languages', () => {
  const get = (lang, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), translations[lang]);
  for (const lang of ['en', 'fr']) {
    test(`${lang}: texts, screenshots and measured areas`, () => {
      for (const key of ['badge', 'skip', 'back', 'next', 'done', 'pause', 'play', 'prevStep', 'nextStep']) assert.equal(typeof get(lang, `whatsNew.${key}`), 'string', key);
      for (const slide of SLIDES) {
        for (const part of ['eyebrow', 'title', 'body']) assert.equal(typeof get(lang, `whatsNew.slides.${slide.id}.${part}`), 'string', `${slide.id}.${part}`);
        if (slide.beats === 'scene') continue;
        for (const beat of slide.beats) {
          for (const shot of [beat.shot, beat.overlay].filter(Boolean)) {
            assert.ok(fs.existsSync(path.join(root, `src/renderer/public/whats-new/${lang}/${shot}.webp`)), `${lang}/${shot}.webp`);
          }
          if (beat.mark) {
            const rect = markOf(lang, beat);
            assert.ok(rect, `${lang} ${beat.shot}.${beat.mark} measured`);
            const [x, y, w, h] = rect;
            assert.ok(x >= -1 && y >= -1 && w > 0 && h > 0 && x + w <= 101 && y + h <= 101, `${beat.shot}.${beat.mark} inside the capture`);
          }
          const labelKey = beat.mark ?? (beat.overlay ? 'confirm' : null);
          if (labelKey) assert.equal(typeof get(lang, `whatsNew.marks.${beat.shot}.${labelKey}`), 'string', `label ${beat.shot}.${labelKey}`);
        }
      }
    });
  }
  test('both languages measured the same areas', () => {
    assert.deepEqual(Object.keys(SHOT_MARKS.fr).sort(), Object.keys(SHOT_MARKS.en).sort());
  });
});

describe('camera', () => {
  test('a small area is zoomed, at most 1.4×, around its centre', () => {
    const cam = cameraFor([40, 40, 10, 5]);
    assert.equal(cam.scale, 1.4);
    assert.deepEqual([cam.originX, cam.originY], [45, 42.5]);
  });
  test('a wide area is not zoomed, and no area means no zoom', () => {
    assert.equal(cameraFor([5, 10, 90, 8]).scale, 1);
    assert.deepEqual(cameraFor(undefined), { scale: 1, originX: 50, originY: 50 });
  });
  test('the ring grows around the same centre', () => {
    assert.deepEqual(ringFor([40, 40, 10, 10], 1.2), [39, 39, 12, 12]);
  });
});
