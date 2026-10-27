import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CsvError, parseCsv, parseTable, toCsv } from '../src/csv';

test('parses quoted fields, escaped quotes, line breaks and CRLF', () => {
  const text = '﻿id,note\r\n1,"a, b"\r\n2,"say ""hi"""\n3,"line\nbreak"\n\n';
  assert.deepEqual(parseCsv(text), [
    ['id', 'note'],
    ['1', 'a, b'],
    ['2', 'say "hi"'],
    ['3', 'line\nbreak'],
  ]);
});

test('round-trips through toCsv', () => {
  const rows = [
    ['a', 'b,c', 'd"e'],
    ['', 'x\ny', 'plain'],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('parseTable validates the header and row widths', () => {
  assert.throws(() => parseTable(''), CsvError);
  assert.throws(() => parseTable('a,a\n1,2\n'), /appears more than once/);
  assert.throws(() => parseTable('a,\n1,2\n'), /needs a name/);
  assert.throws(() => parseTable('a,b\n1\n'), /Row 2 has 1 fields/);
  assert.throws(() => parseTable('a,b\n"1,2\n'), /inside a quoted field/);
  assert.deepEqual(parseTable(' a , b\n1,2\n'), { header: ['a', 'b'], rows: [['1', '2']] });
});
