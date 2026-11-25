import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const root = join(__dirname, '..');
const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  if (entry.name === 'node_modules' || entry.name === 'dist') return [];
  return entry.isDirectory() ? sources(path) : /\.(css|tsx?|html)$/.test(entry.name) ? [path] : [];
});

test('every CSS custom property the web app uses is defined, so none falls back to a hidden default', () => {
  const files = sources(root);
  const defined = new Set<string>();
  const used = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(--[a-z][\w-]*)\s*:/g)) defined.add(match[1]!);
    for (const match of text.matchAll(/['"`](--[a-z][\w-]*)['"`]/g)) defined.add(match[1]!);
    for (const match of text.matchAll(/var\(\s*(--[a-z][\w-]*)/g)) used.set(match[1]!, file);
  }
  expect(files.length).toBeGreaterThan(20);
  expect(defined.has('--ground')).toBe(true);
  expect([...used].filter(([name]) => !defined.has(name)).map(([name, file]) => `${name} in ${file}`)).toEqual([]);
});

test('the shared Score Summary panel is styled under one prefix, history-summary-', () => {
  for (const file of sources(root)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bogs\b|\bogs-/);
});
