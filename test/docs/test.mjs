// The documentation's own claims about the suite, checked against the suite.
//
// This exists because the same drift has now been repaired twice by hand. Every
// feature added a harness; every count in README.md, docs/BUILDING.md and
// test/README.md quietly went stale; and nothing failed, because prose is not
// executed.
//
// A number in the docs that nobody can trust is worse than no number: it is
// what a contributor uses to decide whether their run was complete. So the
// numbers are derived from test/run.mjs here, and a stale one fails the suite
// that the stale one describes.
//
// Deliberately narrow. It checks the claims that ARE mechanically checkable --
// counts and flags -- and says nothing about prose, so the docs stay free to
// explain things without having to satisfy a parser.
import { readRepo, checker } from '../lib/repo.mjs';

const { check, done } = checker();

const runner = readRepo('test', 'run.mjs');
// The HARNESSES array, brace-matched rather than sliced by line shape. It used
// to count lines starting with '    { name:', which meant a formatter wrapping
// one long row onto several lines made the suite look SMALLER than it is -- and
// this harness would then have reported the documentation as correct while it
// undercounted. An assertion that a reformat can silently weaken is not one.
const arrayAt = runner.indexOf('const HARNESSES = [');
if (arrayAt < 0) throw new Error('cannot find HARNESSES in test/run.mjs');
const open = runner.indexOf('[', arrayAt);
let depth = 0,
    close = -1;
for (let i = open; i < runner.length; i++) {
    if (runner[i] === '[') depth++;
    else if (runner[i] === ']' && --depth === 0) {
        close = i;
        break;
    }
}
if (close < 0) throw new Error('cannot brace-match HARNESSES in test/run.mjs');
const table = runner.slice(open, close + 1);
// One `name:` per row, however the row is wrapped.
const count = (table.match(/\bname:/g) || []).length;
const types = (table.match(/\btypes:\s*true/g) || []).length;
const browser = (table.match(/\bbrowser:\s*true/g) || []).length;
const bundle = (table.match(/\bneedsBundle:\s*true/g) || []).length;

check('the runner has harnesses to count', count > 0, true);
check('  ...and they are the ones the suite reports', count >= 20, true);

// Written as words in prose, so both spellings are accepted. The point is that
// SOME number is present and that it is the right one -- a doc that stopped
// mentioning a count would pass, which is fine: an absent claim cannot mislead.
const WORDS = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
];
const spellings = (n) => {
    const out = [String(n)];
    if (n < WORDS.length) out.push(WORDS[n]);
    if (n > 20 && n < 100) {
        const tens = [
            '',
            '',
            'twenty',
            'thirty',
            'forty',
            'fifty',
            'sixty',
            'seventy',
            'eighty',
            'ninety',
        ];
        const unit = n % 10;
        out.push(unit ? `${tens[Math.floor(n / 10)]}-${WORDS[unit]}` : tens[Math.floor(n / 10)]);
    }
    return out;
};

/** Every number that appears where a doc claims a harness count. */
function claimedCounts(text, pattern) {
    const found = [];
    for (const match of text.matchAll(pattern)) {
        found.push(match[1].toLowerCase());
    }
    return found;
}

// Every document that quotes a count. The root README is here because it
// drifted exactly like the other two and nothing was watching it.
const building = readRepo('docs', 'BUILDING.md');
const readme = readRepo('test', 'README.md');
const rootReadme = readRepo('README.md');
// The CI workflow explains its pinned Node version by naming how many harnesses
// need --experimental-strip-types. That is the same claim as BUILDING.md's and
// it had gone stale the same way, in the one file nobody reads for prose.
const workflow = readRepo('.github', 'workflows', 'build-release.yaml');

// "23 harnesses", "Eighteen regression harnesses", "twelve harnesses run under".
// Only a digit or a spelled-out number counts as a claim: matching any word
// before "harnesses" also catches "five BROWSER harnesses" and "only harnesses
// matching a name", neither of which is asserting a total.
const NUMBER_WORDS =
    'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|' +
    'thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|' +
    '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-(?:one|two|three|four|five|six|seven|eight|nine))?';
const HARNESS_CLAIM = new RegExp(
    `\\b(\\d+|${NUMBER_WORDS})\\s+(?:regression\\s+|browser\\s+)?harnesses`,
    'gi',
);

// Any of the four real counts is accepted anywhere, rather than working out
// which one a given sentence means -- that would be parsing prose. The cost is
// that a total mistyped as one of the other three still passes; the benefit is
// that the check never argues with a rewording. It catches the failure that
// actually happens: a number that matches nothing at all any more.
const wrongIn = (label, text) => {
    const valid = new Set([
        ...spellings(count),
        ...spellings(types),
        ...spellings(browser),
        ...spellings(bundle),
    ]);
    // Words that are not counts at all -- "the harnesses", "four harnesses fail"
    // in a troubleshooting line that names a different thing.
    const bad = claimedCounts(text, HARNESS_CLAIM).filter((c) => !valid.has(c));
    if (bad.length)
        console.log(
            `        ${label} claims: ${bad.join(', ')}  (real: total=${count} types=${types} browser=${browser} bundle=${bundle})`,
        );
    return bad;
};

check(`docs/BUILDING.md quotes only real counts`, wrongIn('BUILDING.md', building), []);
check(`test/README.md quotes only real counts`, wrongIn('test/README.md', readme), []);
check(`README.md quotes only real counts`, wrongIn('README.md', rootReadme), []);
check(`the CI workflow quotes only real counts`, wrongIn('build-release.yaml', workflow), []);

// The README's table has one row per harness. A feature that adds a harness and
// not a row leaves the table quietly incomplete, which is the specific way this
// document has gone wrong every time.
const tableRows = readme.split('\n').filter((line) => /^\|\s*`/.test(line)).length;
check('test/README.md documents every harness', tableRows, count);

// Both documents tell people to run the suite. If the command changes, the
// instruction is wrong everywhere at once.
check('BUILDING.md names the strict-skip variable', building.includes('TT_STRICT_SKIP'), true);
check('  ...and so does the runner', runner.includes('TT_STRICT_SKIP'), true);
check('  ...and CI actually sets it', /TT_STRICT_SKIP:\s*'?1'?/.test(workflow), true);

// Biome is the format and lint gate. A repository that ships a config nothing
// runs has a style guide, not a gate -- so the config, the scripts and the CI
// step are asserted to exist together.
const biome = readRepo('biome.json');
const rootPkg = JSON.parse(readRepo('package.json'));
check('the Biome config parses', typeof JSON.parse(biome).formatter, 'object');
check('  ...and CI runs it', /biome ci/.test(workflow), true);
check(
    '  ...with warnings failing the run',
    /biome ci[^\n]*--error-on-warnings/.test(workflow),
    true,
);
// The lint half deliberately did not gate for one commit, while every rule the
// recommended set reported was read. If it is ever switched off again that has
// to be a decision, not a flag left behind.
check('  ...and with the linter on', /biome ci[^\n]*--linter-enabled=false/.test(workflow), false);
for (const script of ['lint', 'format', 'check']) {
    check(`  ...and "pnpm ${script}" exists`, typeof rootPkg.scripts[script], 'string');
}
check(
    'BUILDING.md tells contributors how to run it',
    /pnpm (run )?check|biome/.test(building),
    true,
);

done();
