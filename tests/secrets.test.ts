import { describe, it, expect } from 'vitest';
import {
  parseDotenv,
  serializeDotenv,
  parseJson,
  serializeJson,
  detectFormat,
  computeChecksum,
  diffSecrets,
  filterSecrets,
  SecretFormat,
  type SecretEntry,
} from '../src/core/secrets.js';

const entry = (key: string, value: string): SecretEntry => ({ key, value, isSecret: true });

describe('parseDotenv', () => {
  it('parses plain KEY=value pairs and skips comments and blank lines', () => {
    const { entries } = parseDotenv(['# a comment', '', 'FOO=bar', 'BAZ=qux', ''].join('\n'));

    expect(entries).toEqual([entry('FOO', 'bar'), entry('BAZ', 'qux')]);
  });

  it('parses the export prefix', () => {
    const { entries } = parseDotenv('export FOO=bar\nexport  BAZ = qux\n');

    expect(entries).toEqual([entry('FOO', 'bar'), entry('BAZ', 'qux')]);
  });

  it('strips surrounding single and double quotes', () => {
    const { entries } = parseDotenv('A="double"\nB=\'single\'\n');

    expect(entries).toEqual([entry('A', 'double'), entry('B', 'single')]);
  });

  it('keeps an empty value instead of dropping the entry', () => {
    const { entries } = parseDotenv('DEBUG=\nFOO=bar\n');

    expect(entries).toEqual([entry('DEBUG', ''), entry('FOO', 'bar')]);
  });

  it('captures an inline comment after an unquoted value', () => {
    const { entries } = parseDotenv('PORT=3000 # local dev port\n');

    expect(entries).toEqual([{ key: 'PORT', value: '3000', comment: 'local dev port', isSecret: true }]);
  });

  it('does not treat # inside quotes as a comment', () => {
    const { entries } = parseDotenv('PASSWORD="pa # ss"\nHASH=\'a # b\'\n');

    expect(entries).toEqual([entry('PASSWORD', 'pa # ss'), entry('HASH', 'a # b')]);
  });

  it('unescapes \\n, \\t and escaped quotes', () => {
    const { entries } = parseDotenv('MULTI="line1\\nline2"\nTAB="a\\tb"\nQUOTE="say \\"hi\\""\n');

    expect(entries).toEqual([
      entry('MULTI', 'line1\nline2'),
      entry('TAB', 'a\tb'),
      entry('QUOTE', 'say "hi"'),
    ]);
  });

  it('ignores lines that are not assignments', () => {
    const { entries } = parseDotenv('just some prose\nFOO=bar\n');

    expect(entries).toEqual([entry('FOO', 'bar')]);
  });
});

describe('serializeDotenv', () => {
  it('writes one KEY=value per line with a trailing newline', () => {
    const output = serializeDotenv([entry('FOO', 'bar'), entry('BAZ', 'qux')]);

    expect(output).toBe('FOO=bar\nBAZ=qux\n');
  });

  it('quotes values that contain spaces or shell special characters', () => {
    const output = serializeDotenv([entry('MSG', 'hello world'), entry('URL', 'https://x.dev?a=1&b=2')]);

    expect(output).toContain('MSG="hello world"');
    expect(output).toContain('URL="https://x.dev?a=1&b=2"');
  });

  it('writes comments above the entry', () => {
    const output = serializeDotenv([{ key: 'FOO', value: 'bar', comment: 'note', isSecret: true }]);

    expect(output).toBe('# note\nFOO=bar\n');
  });
});

describe('dotenv round-trip', () => {
  const trickyValues = [
    'simple',
    'has space',
    'has # hash',
    'quote " inside',
    "single ' inside",
    'back\\slash',
    'line\nbreak',
    'tab\there',
    '',
  ];

  for (const value of trickyValues) {
    it(`preserves ${JSON.stringify(value)}`, () => {
      const serialized = serializeDotenv([entry('KEY', value)]);
      const { entries } = parseDotenv(serialized);

      expect(entries).toHaveLength(1);
      expect(entries[0]!.value).toBe(value);
    });
  }
});

describe('json helpers', () => {
  it('parses a flat JSON object into string entries', () => {
    expect(parseJson('{"PORT": 3000, "DEBUG": true}')).toEqual([
      entry('PORT', '3000'),
      entry('DEBUG', 'true'),
    ]);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseJson('{nope')).toThrow(/Invalid JSON/);
  });

  it('serializes entries as pretty JSON with a trailing newline', () => {
    expect(serializeJson([entry('A', '1')])).toBe('{\n  "A": "1"\n}\n');
  });
});

describe('detectFormat', () => {
  it('maps extensions to formats', () => {
    expect(detectFormat('.env')).toBe(SecretFormat.DOTENV);
    expect(detectFormat('config.env')).toBe(SecretFormat.DOTENV);
    expect(detectFormat('secrets.yaml')).toBe(SecretFormat.YAML);
    expect(detectFormat('secrets.yml')).toBe(SecretFormat.YAML);
    expect(detectFormat('secrets.json')).toBe(SecretFormat.JSON);
    expect(detectFormat('export.sh')).toBe(SecretFormat.SHELL);
  });

  it('defaults to dotenv for unknown extensions', () => {
    expect(detectFormat('secrets.txt')).toBe(SecretFormat.DOTENV);
  });
});

describe('computeChecksum', () => {
  it('is stable regardless of entry order', () => {
    expect(computeChecksum([entry('A', '1'), entry('B', '2')])).toBe(
      computeChecksum([entry('B', '2'), entry('A', '1')])
    );
  });

  it('changes when a value changes', () => {
    expect(computeChecksum([entry('A', '1')])).not.toBe(computeChecksum([entry('A', '2')]));
  });

  it('changes when a key is added', () => {
    expect(computeChecksum([entry('A', '1')])).not.toBe(
      computeChecksum([entry('A', '1'), entry('B', '2')])
    );
  });
});

describe('diffSecrets', () => {
  it('classifies added, removed, modified and unchanged entries', () => {
    const diff = diffSecrets(
      [entry('SAME', 'x'), entry('CHANGED', 'old'), entry('GONE', 'bye')],
      [entry('SAME', 'x'), entry('CHANGED', 'new'), entry('NEW', 'hi')]
    );

    expect(diff.added).toEqual([entry('NEW', 'hi')]);
    expect(diff.removed).toEqual([entry('GONE', 'bye')]);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]!.old.value).toBe('old');
    expect(diff.modified[0]!.new.value).toBe('new');
    expect(diff.unchanged).toEqual([entry('SAME', 'x')]);
  });
});

describe('filterSecrets', () => {
  const entries = [entry('DB_HOST', 'a'), entry('DB_PORT', 'b'), entry('API_KEY', 'c')];

  it('returns everything when no patterns are given', () => {
    expect(filterSecrets(entries, [])).toEqual(entries);
  });

  it('supports * and ? globs', () => {
    expect(filterSecrets(entries, ['DB_*']).map((e) => e.key)).toEqual(['DB_HOST', 'DB_PORT']);
    expect(filterSecrets(entries, ['DB_HOS?']).map((e) => e.key)).toEqual(['DB_HOST']);
    expect(filterSecrets(entries, ['*_KEY']).map((e) => e.key)).toEqual(['API_KEY']);
  });
});
