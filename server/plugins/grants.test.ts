import { describe, it, expect, afterEach, beforeEach } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PLUGIN_CAPABILITIES,
  isPluginCapability,
  setPluginGrants,
  getPluginGrants,
  allPluginGrants,
  clearPluginGrants,
  assertGranted,
  grantLedgerPath,
  readGrantLedger,
  acknowledgeGrants,
  resolveGrantsForRow,
  resetPluginGrants,
} from './grants.js';

describe('isPluginCapability', () => {
  it.each(PLUGIN_CAPABILITIES)('accepts the known capability "%s"', (cap) => {
    expect(isPluginCapability(cap)).toBe(true);
  });

  it.each([
    ['an unknown string', 'policy.deny'],
    ['not a string', 42],
    ['undefined', undefined],
    ['null', null],
    ['an object', {}],
  ])('rejects %s', (_label, value) => {
    expect(isPluginCapability(value)).toBe(false);
  });
});

describe('in-memory grant map', () => {
  beforeEach(() => {
    resetPluginGrants();
  });

  it('getPluginGrants is empty for a plugin with nothing recorded', () => {
    expect(getPluginGrants('nobody')).toEqual([]);
  });

  it('setPluginGrants records the effective set, readable back', () => {
    setPluginGrants('demo', ['http.route', 'facts.define']);
    expect(getPluginGrants('demo').sort()).toEqual(['facts.define', 'http.route']);
  });

  it('setPluginGrants replaces any previous set for that id', () => {
    setPluginGrants('demo', ['http.route']);
    setPluginGrants('demo', ['ui.panel']);
    expect(getPluginGrants('demo')).toEqual(['ui.panel']);
  });

  it('allPluginGrants reports every recorded plugin', () => {
    setPluginGrants('a', ['http.route']);
    setPluginGrants('b', ['ui.panel', 'facts.define']);
    expect(allPluginGrants()).toEqual({
      a: ['http.route'],
      b: ['ui.panel', 'facts.define'],
    });
  });

  it('clearPluginGrants drops a plugin and leaves others alone', () => {
    setPluginGrants('a', ['http.route']);
    setPluginGrants('b', ['ui.panel']);
    clearPluginGrants('a');
    expect(getPluginGrants('a')).toEqual([]);
    expect(getPluginGrants('b')).toEqual(['ui.panel']);
  });
});

describe('assertGranted', () => {
  beforeEach(() => {
    resetPluginGrants();
  });

  it('passes silently when the capability is granted', () => {
    setPluginGrants('demo', ['http.route']);
    expect(() => assertGranted('demo', 'http.route')).not.toThrow();
  });

  it('throws naming the plugin, the capability, and the manifest fix for an undeclared grant', () => {
    expect(() => assertGranted('spendcap', 'policy.intercept')).toThrow(
      /plugin "spendcap": capability "policy\.intercept" is not granted/,
    );
    expect(() => assertGranted('spendcap', 'policy.intercept')).toThrow(
      /grants: \[policy\.intercept\]/,
    );
  });

  it("throws for a capability not in this plugin's granted set, even if it holds others", () => {
    setPluginGrants('demo', ['http.route']);
    expect(() => assertGranted('demo', 'ui.panel')).toThrow(/"demo"/);
    expect(() => assertGranted('demo', 'ui.panel')).toThrow(/"ui\.panel"/);
  });
});

describe('grant ledger (file-backed)', () => {
  let tmpDir: string;
  let manifestPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-grants-'));
    manifestPath = path.join(tmpDir, 'octomux.yml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('grantLedgerPath is co-located with the manifest', () => {
    expect(grantLedgerPath(manifestPath)).toBe(path.join(tmpDir, 'plugin-grants.json'));
  });

  it('readGrantLedger is empty when no ledger file exists yet', () => {
    expect(readGrantLedger(manifestPath)).toEqual({});
  });

  it('readGrantLedger is empty (with a warn, not a throw) for unparseable JSON', () => {
    fs.writeFileSync(grantLedgerPath(manifestPath), 'not json{{{', 'utf-8');
    expect(readGrantLedger(manifestPath)).toEqual({});
  });

  it('readGrantLedger is empty for a JSON file that is not an object (e.g. an array)', () => {
    fs.writeFileSync(grantLedgerPath(manifestPath), '[1,2,3]', 'utf-8');
    expect(readGrantLedger(manifestPath)).toEqual({});
  });

  it('readGrantLedger filters out entries that are not a valid capability name', () => {
    fs.writeFileSync(
      grantLedgerPath(manifestPath),
      JSON.stringify({ demo: ['http.route', 'not.a.capability', 'ui.panel'] }),
      'utf-8',
    );
    expect(readGrantLedger(manifestPath)).toEqual({ demo: ['http.route', 'ui.panel'] });
  });

  it('acknowledgeGrants writes the ledger atomically and readGrantLedger reads it back', () => {
    acknowledgeGrants(manifestPath, 'demo', ['http.route', 'ui.panel']);
    expect(readGrantLedger(manifestPath)).toEqual({ demo: ['http.route', 'ui.panel'] });
    // no leftover temp files
    const files = fs.readdirSync(tmpDir);
    expect(files).toEqual(['plugin-grants.json']);
  });

  it('acknowledgeGrants de-dupes the recorded set', () => {
    acknowledgeGrants(manifestPath, 'demo', ['http.route', 'http.route']);
    expect(readGrantLedger(manifestPath)).toEqual({ demo: ['http.route'] });
  });

  it('acknowledgeGrants preserves other plugins already in the ledger', () => {
    acknowledgeGrants(manifestPath, 'a', ['http.route']);
    acknowledgeGrants(manifestPath, 'b', ['ui.panel']);
    expect(readGrantLedger(manifestPath)).toEqual({ a: ['http.route'], b: ['ui.panel'] });
  });

  it('acknowledgeGrants swallows a write failure (logs, does not throw)', () => {
    const badManifestPath = path.join(tmpDir, 'missing-subdir', 'octomux.yml');
    expect(() => acknowledgeGrants(badManifestPath, 'demo', ['http.route'])).not.toThrow();
  });
});

describe('resolveGrantsForRow', () => {
  let tmpDir: string;
  let manifestPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-grants-resolve-'));
    manifestPath = path.join(tmpDir, 'octomux.yml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('first sight (no ledger entry): grants everything declared and records it', () => {
    const result = resolveGrantsForRow(manifestPath, 'demo', ['http.route', 'ui.panel']);
    expect(result).toEqual({ effective: ['http.route', 'ui.panel'], pending: [] });
    expect(readGrantLedger(manifestPath)).toEqual({ demo: ['http.route', 'ui.panel'] });
  });

  it('first sight with undeclared/undefined grants: effective is empty and recorded as empty', () => {
    const result = resolveGrantsForRow(manifestPath, 'demo', undefined);
    expect(result).toEqual({ effective: [], pending: [] });
    expect(readGrantLedger(manifestPath)).toEqual({ demo: [] });
  });

  it('de-dupes the declared list', () => {
    const result = resolveGrantsForRow(manifestPath, 'demo', ['http.route', 'http.route']);
    expect(result).toEqual({ effective: ['http.route'], pending: [] });
  });

  it('narrowing (declared subset of acknowledged): grants the narrower set and re-records it', () => {
    acknowledgeGrants(manifestPath, 'demo', ['http.route', 'ui.panel', 'facts.define']);
    const result = resolveGrantsForRow(manifestPath, 'demo', ['http.route']);
    expect(result).toEqual({ effective: ['http.route'], pending: [] });
    expect(readGrantLedger(manifestPath)).toEqual({ demo: ['http.route'] });
  });

  it('unchanged (declared equals acknowledged): grants the same set', () => {
    acknowledgeGrants(manifestPath, 'demo', ['http.route']);
    const result = resolveGrantsForRow(manifestPath, 'demo', ['http.route']);
    expect(result).toEqual({ effective: ['http.route'], pending: [] });
  });

  it('widening (declared adds something new): grants only the intersection, the rest is pending, and does not acknowledge', () => {
    acknowledgeGrants(manifestPath, 'demo', ['http.route']);
    const result = resolveGrantsForRow(manifestPath, 'demo', ['http.route', 'policy.intercept']);
    expect(result).toEqual({ effective: ['http.route'], pending: ['policy.intercept'] });
    // ledger is untouched — the new grant is not silently approved
    expect(readGrantLedger(manifestPath)).toEqual({ demo: ['http.route'] });
  });

  it('a widening row that removes some grants and adds others: only the still-acknowledged ones are effective', () => {
    acknowledgeGrants(manifestPath, 'demo', ['http.route', 'ui.panel']);
    const result = resolveGrantsForRow(manifestPath, 'demo', ['ui.panel', 'policy.intercept']);
    expect(result).toEqual({ effective: ['ui.panel'], pending: ['policy.intercept'] });
  });

  it('never throws even when the ledger write fails', () => {
    const badManifestPath = path.join(tmpDir, 'missing-subdir', 'octomux.yml');
    let result: ReturnType<typeof resolveGrantsForRow> | undefined;
    expect(() => {
      result = resolveGrantsForRow(badManifestPath, 'demo', ['http.route']);
    }).not.toThrow();
    expect(result).toEqual({ effective: ['http.route'], pending: [] });
  });
});
