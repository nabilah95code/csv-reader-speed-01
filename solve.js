// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly the reference reader's
// {columns, rows, errors} for every input {text, header}, but reads the text in slices
// instead of a character at a time. One left-to-right pass; indexOf finds the next comma,
// quote or line break natively, and only the genuinely awkward fields (stray CRs, doubled
// quotes, CRs inside quotes) fall back to piecing a value together from parts.
//
// The reading policy is the reference's own, unchanged:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside
//     it one quote, and each CRLF or lone CR inside it read as LF; what follows its closing
//     quote, up to the next comma or line break, is appended as it stands (quote_junk, when
//     the field ends); a quote that never closes is a literal character, and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (short_row, with
//     fields: its count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every
//     LF, CRLF and lone CR inside a quoted field counted), row its record's index in rows
//     (null for the header), in the order met.

const COMMA_END = 0;
const BREAK_END = 1;
const TEXT_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // A text with no CR anywhere takes the tighter loops below: no stray_cr can occur and
  // no quoted segment needs its CRs rewritten.
  const hasCR = text.indexOf('\r') !== -1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field (or the tail of one) starting at pos. seedParts, when given,
  // holds value pieces already read (a literal quote, or a quoted value junk is appended
  // to); added counts only the characters this read itself keeps.
  function readUnquoted(seedParts) {
    let parts = seedParts;
    let added = 0;
    let ended = TEXT_END;
    if (!hasCR) {
      // No CR in the text: only a comma or an LF can end the field.
      for (;;) {
        const iComma = text.indexOf(',', pos);
        const iLf = text.indexOf('\n', pos);
        let end = len;
        let kind = TEXT_END;
        if (iComma !== -1 && iComma < end) { end = iComma; kind = COMMA_END; }
        if (iLf !== -1 && iLf < end) { end = iLf; kind = BREAK_END; }
        if (end > pos) {
          const seg = text.slice(pos, end);
          if (parts === null) parts = [seg]; else parts.push(seg);
          added += seg.length;
        }
        if (kind === COMMA_END) { pos = end + 1; ended = COMMA_END; break; }
        if (kind === BREAK_END) { pos = end + 1; line += 1; ended = BREAK_END; break; }
        pos = end;
        break;
      }
      const v = parts === null ? '' : parts.length === 1 ? parts[0] : parts.join('');
      return { value: v, ended, added };
    }
    for (;;) {
      const iComma = text.indexOf(',', pos);
      const iLf = text.indexOf('\n', pos);
      const iCr = text.indexOf('\r', pos);
      let end = len;
      let kind = TEXT_END;
      if (iComma !== -1 && iComma < end) { end = iComma; kind = COMMA_END; }
      if (iLf !== -1 && iLf < end) { end = iLf; kind = BREAK_END; }
      if (iCr !== -1 && iCr < end) { end = iCr; kind = 3; }
      if (end > pos) {
        const seg = text.slice(pos, end);
        if (parts === null) parts = [seg]; else parts.push(seg);
        added += seg.length;
      }
      if (kind === TEXT_END) { pos = end; ended = TEXT_END; break; }
      if (kind === COMMA_END) { pos = end + 1; ended = COMMA_END; break; }
      if (kind === BREAK_END) { pos = end + 1; line += 1; ended = BREAK_END; break; }
      // A CR: with an LF after it, the record ends; on its own it is dropped (stray_cr)
      // and the field goes on.
      if (text.charCodeAt(end + 1) === 10) { pos = end + 2; line += 1; ended = BREAK_END; break; }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = end + 1;
    }
    const value = parts === null ? '' : parts.length === 1 ? parts[0] : parts.join('');
    return { value, ended, added };
  }

  // Pushes the quoted content text[a..b) onto parts, counting the lines in it. A CR or a
  // CRLF inside quotes is one LF in the value and one line on the count.
  function pushQuotedSegment(parts, a, b) {
    if (b <= a) return;
    const iCr = hasCR ? text.indexOf('\r', a) : -1;
    if (iCr === -1 || iCr >= b) {
      // No CR in range: the segment stands as it is; count its LFs.
      let n = 0;
      let i = a;
      for (;;) {
        const j = text.indexOf('\n', i);
        if (j === -1 || j >= b) break;
        n += 1;
        i = j + 1;
      }
      line += n;
      parts.push(text.slice(a, b));
      return;
    }
    let built = '';
    let i = a;
    while (i < b) {
      const c = text[i];
      if (c === '\r') {
        built += '\n';
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        continue;
      }
      if (c === '\n') line += 1;
      built += c;
      i += 1;
    }
    parts.push(built);
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let segStart = pos + 1;
    let scan = pos + 1;
    for (;;) {
      const q = text.indexOf('"', scan);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is
        // read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted(['"']);
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, and the field goes on.
        if (parts === null) parts = [];
        pushQuotedSegment(parts, segStart, q);
        parts.push('"');
        scan = q + 2;
        segStart = scan;
        continue;
      }
      if (parts === null) parts = [];
      pushQuotedSegment(parts, segStart, q);
      const value = parts.length === 1 ? parts[0] : parts.join('');
      pos = q + 1;
      if (pos >= len) return { value, ended: TEXT_END };
      const c = text.charCodeAt(pos);
      if (c === 44) { pos += 1; return { value, ended: COMMA_END }; }
      if (c === 10) { pos += 1; line += 1; return { value, ended: BREAK_END }; }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; return { value, ended: BREAK_END }; }
      // What follows the closing quote is appended as it stands.
      const junk = readUnquoted([value]);
      if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junk;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted(null);
      fields.push(field.value);
    } while (field.ended === COMMA_END);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
