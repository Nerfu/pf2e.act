import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activityChoicePalette } from '../../scripts/activity-colors.mjs';

const ID = 'pf2e-exploration-activities';
const actor = {
  id: 'player1', name: 'Очень тёмное имя', isOwner: true, img: 'avatar.png',
  skills: {}, getFlag: (_id, key) => key === 'current' ? {
    sessionId: 'palette-test', chosenAt: 1, choice: { activityId: 'scout' },
  } : false,
};
const session = { phase: 'open', id: 'palette-test', actorIds: [actor.id], partyId: 'party' };
const player = { id: 'u1', isGM: false, character: actor, color: '#000000' };
const gm = { id: 'gm', isGM: true };
globalThis.foundry = { applications: { api: { ApplicationV2: class {} } } };
globalThis.game = {
  user: player, users: [player, gm],
  actors: { get: id => id === actor.id ? actor : null, party: { members: [actor] } },
  settings: { get: () => session },
  i18n: { localize: key => key.replace(`${ID}.`, ''), lang: 'ru' },
};
globalThis.ui = { notifications: { warn(){}, info(){}, error(){} } };

const { ActivityWindow, MasterWindow } = await import('../../scripts/ui.mjs');
const { resultsSummary } = await import('../../scripts/controller.mjs');
const css = readFileSync(new URL('../../styles/module.css', import.meta.url), 'utf8');

function makeActivityHTML(color) {
  player.color = color;
  return new ActivityWindow().contentHTML();
}

test('black and navy usernames retain EXACT original color and border; badge background is muted and lighter', () => {
  for (const color of ['#000000', '#17284b', '#123']) {
    const palette = activityChoicePalette(color);
    assert.equal(palette.border, color);
    assert.match(palette.background, /^#[a-f\d]{6}$/);
    assert.ok(['#b8bdc5', '#d4d8de'].includes(palette.background));
    const html = makeActivityHTML(color);
    assert.ok(html.includes(`--pf2e-ea-choice-border:${color}`));
    assert.ok(html.includes(`color:${color}`));
    assert.ok(html.includes(`--pf2e-ea-choice-bg:${palette.background}`));
  }
});

test('light and bright player colors keep original text and receive a dark, subdued background', () => {
  for (const color of ['#ffffff', '#ecc267', '#61ce85', '#f00']) {
    const palette = activityChoicePalette(color);
    assert.ok(['#242a32', '#0e1217'].includes(palette.background), `${color} -> ${palette.background}`);
    assert.equal(palette.border, color);
    const html = makeActivityHTML(color);
    assert.ok(html.includes(`color:${color}`));
  }
});

test('fallback without valid player color stays neutral and safe', () => {
  const palette = activityChoicePalette('var(--color-text-primary, currentColor)');
  assert.equal(palette.border, 'transparent');
  assert.match(palette.background, /^rgba\(/);
});

test('changes are scoped exclusively to activity buttons, never GM picker or chat reports', () => {
  const html = makeActivityHTML('#000000');
  assert.match(html, /class="pf2e-ea-choice" style="--pf2e-ea-choice-bg:/);
  assert.match(css, /\.pf2e-ea-activity-button \.pf2e-ea-choice\s*\{/);
  assert.match(css, /\.pf2e-ea-activity-button:disabled \.pf2e-ea-button-header\s*\{/);
  const gmNameColor = '#000000';
  game.user = gm;
  const gmWindow = new MasterWindow().contentHTML();
  assert.ok(gmWindow.includes(`color:${gmNameColor}`));
  assert.doesNotMatch(gmWindow, /--pf2e-ea-choice-bg|pf2e-ea-choice/);
  const report = resultsSummary([{ actor, choice:{activityId:'scout'} }], new Map());
  assert.doesNotMatch(report, /--pf2e-ea-choice-bg|pf2e-ea-choice/);
  assert.ok(report.includes(`color:${gmNameColor}`));
  game.user = player;
});
