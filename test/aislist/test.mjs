// Parsing and matching the AiSList channel lists.
//
// sample.txt is a real slice of the published blocklist -- its actual header
// plus the entries that exercise the two things a naive parser gets wrong.
//
// The format header claims entries may be either "@channelhandle" or
// "UCxxxxxxxxxxxxxxxx". MEASURED against the real files, both are 100% handles:
// 20,982 blocklist entries and 924 warnlist entries, zero channel ids. The UC
// branch is still parsed and asserted, because the header says it may appear.
//
// The trap the header does NOT mention: 498 of those handles are percent-encoded
// or non-ASCII. A tile's subtitle carries the DECODED form, so matching raw
// strings would silently miss every one of them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checker } from '../lib/repo.mjs';
import {
    parseList, indexHasChannel, normaliseHandle, readLastModified,
    serialiseIndex, deserialiseIndex, emptyIndex,
} from './aisListParse.generated.mts';

const { check, done } = checker();
const SAMPLE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sample.txt'), 'utf8');
const index = parseList(SAMPLE);

// --- the real file --------------------------------------------------------
check('comments and blanks are not entries', index.count > 0 && index.count < SAMPLE.split('\n').length, true);
check('the header date is read', /^\d{4}-\d{2}-\d{2}$/.test(index.lastModified || ''), true);
// The count is the real invariant: exactly the lines that open with @ or UC
// become entries, and nothing else does. (The explicit `!`/`#` comment guard in
// the parser is belt and braces rather than load-bearing -- the @/UC dispatch
// already rejects a comment line -- so this asserts the property that matters
// instead of pretending to cover a branch no input can reach.)
const entryLines = SAMPLE.split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('@') || /^UC\S{8,}$/.test(l));
check('exactly the entry lines are parsed', index.count, entryLines.length);

// --- percent-encoded handles ----------------------------------------------
// This is the assertion the whole parser exists for: the file stores
// "@DerR%C3%A4cheresp" and a tile says "@DerRächeresp".
const encoded = SAMPLE.split('\n').filter((l) => l.startsWith('@') && l.includes('%'));
check('the fixture actually contains encoded handles', encoded.length > 0, true);
let missed = null;
for (const raw of encoded) {
    const decoded = decodeURIComponent(raw);
    if (!indexHasChannel(index, { handle: decoded })) missed = raw;
}
check('every encoded handle matches its decoded form', missed, null);

// --- case ------------------------------------------------------------------
const anyHandle = [...index.handles][0];
check('matching is case-insensitive', indexHasChannel(index, { handle: anyHandle.toUpperCase() }), true);
check('  ...and the stored form is folded', anyHandle, anyHandle.toLowerCase());

// --- normalisation ---------------------------------------------------------
check('a handle is folded', normaliseHandle('@ChanName'), '@channame');
check('a bare name is not a handle', normaliseHandle('ChanName'), null);
check('an encoded handle is decoded', normaliseHandle('@Espa%C3%B1ol'), '@español');
// A community-edited list can contain a bare % that decodeURIComponent throws
// on. That must cost the one entry's decoding, not the whole parse.
check('a malformed escape falls back rather than throwing', normaliseHandle('@100%'), '@100%');
check('null is not a handle', normaliseHandle(null), null);
check('an empty string is not', normaliseHandle(''), null);

// --- misses ----------------------------------------------------------------
check('a channel not on the list does not match', indexHasChannel(index, { handle: '@definitelynotonthelist' }), false);
check('an empty index matches nothing', indexHasChannel(emptyIndex(), { handle: anyHandle }), false);
check('a null channel matches nothing', indexHasChannel(index, null), false);
check('a channel with only an id does not match a handle list',
      indexHasChannel(index, { id: 'UC123456789012345678' }), false);

// --- the UC form the header promises ---------------------------------------
const withIds = parseList('! header\nUC1234567890abcdefgh\n@handle\n');
check('a UC id is parsed', withIds.ids.has('UC1234567890abcdefgh'), true);
check('  ...and matches', indexHasChannel(withIds, { id: 'UC1234567890abcdefgh' }), true);
check('  ...alongside the handle', withIds.handles.has('@handle'), true);

// --- storage round trip ----------------------------------------------------
// Sets do not survive JSON, so the cache has to serialise them explicitly.
const round = deserialiseIndex(serialiseIndex(index));
check('an index round-trips', round.handles.size, index.handles.size);
check('  ...keeping the date', round.lastModified, index.lastModified);
check('  ...and still matches', indexHasChannel(round, { handle: anyHandle }), true);
check('junk deserialises to null', deserialiseIndex('not json'), null);
check('null deserialises to null', deserialiseIndex(null), null);

// --- junk ------------------------------------------------------------------
let threw = null;
for (const v of [null, undefined, 0, [], {}, NaN, true, '']) {
    try { parseList(v); indexHasChannel(v, v); normaliseHandle(v); readLastModified(v); deserialiseIndex(v); }
    catch (e) { threw = `${JSON.stringify(v)} threw ${e.message}`; }
}
check('junk never throws', threw, null);
check('a non-string parses to an empty index', parseList(null).count, 0);

done();
