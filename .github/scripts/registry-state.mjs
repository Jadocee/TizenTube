// Reads an `npm view <package> --json` packument on stdin and answers the two
// questions .github/scripts/npm-gate.sh has about a version it is considering
// publishing. Prints exactly one line:
//
//   present        that version is already on the registry
//   absent         it is not, and publishing it would not move `latest` backwards
//   older <ver>    it is not, but `latest` is already ahead of it
//   unknown        the input could not be understood
//
// SEPARATE FROM THE SHELL, ON PURPOSE. Both questions are semver questions, and
// semver is not string comparison:
//
//   - Build metadata is not part of a release's identity. The registry stores
//     1.2.3+ci.7 as 1.2.3, so a text match reports "not published" for a version
//     that is already taken, and the publish that follows is a guaranteed 403.
//   - "Is this version behind the latest one" needs precedence ordering, where
//     1.9.0 < 1.10.0 and 1.0.0-rc.1 < 1.0.0. Sorting those as strings gets both
//     backwards.
//
// No dependency is used because this runs in CI before anything is installed,
// and one comparator is smaller than the wiring to borrow someone else's.

/** Parses a semver string, discarding build metadata. Returns null if it is not one. */
function parse(value) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        String(value).trim(),
    );
    if (!m) return null;
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        pre: m[4] ? m[4].split('.') : null,
    };
}

/** Semver precedence: -1 if a < b, 0 if equal, 1 if a > b. */
function compare(a, b) {
    for (const part of ['major', 'minor', 'patch']) {
        if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
    }
    // A release outranks any prerelease of the same triple.
    if (!a.pre && !b.pre) return 0;
    if (!a.pre) return 1;
    if (!b.pre) return -1;
    const len = Math.max(a.pre.length, b.pre.length);
    for (let i = 0; i < len; i++) {
        const x = a.pre[i];
        const y = b.pre[i];
        // A shorter prerelease chain sorts first: 1.0.0-rc < 1.0.0-rc.1.
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const xNum = /^\d+$/.test(x);
        const yNum = /^\d+$/.test(y);
        if (xNum && yNum) {
            if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
        } else if (xNum !== yNum) {
            // Numeric identifiers always have lower precedence than alphanumeric.
            return xNum ? -1 : 1;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

const wanted = parse(process.argv[2] ?? '');
if (!wanted) {
    process.stdout.write('unknown\n');
    process.exit(0);
}

let raw = '';
process.stdin.on('data', (d) => {
    raw += d;
});
process.stdin.on('end', () => {
    let doc;
    try {
        doc = JSON.parse(raw);
    } catch {
        process.stdout.write('unknown\n');
        return;
    }
    if (!doc || typeof doc !== 'object') {
        process.stdout.write('unknown\n');
        return;
    }

    // npm prints `versions` as an array, but a packument with a single version
    // has been seen to come back as a bare string; accept both rather than
    // reporting "unknown" and falling back for a registry that answered fine.
    const versions = Array.isArray(doc.versions)
        ? doc.versions
        : doc.versions
          ? [doc.versions]
          : [];

    for (const v of versions) {
        const p = parse(v);
        if (p && compare(p, wanted) === 0) {
            process.stdout.write('present\n');
            return;
        }
    }

    const latest = doc['dist-tags']?.latest;
    const latestParsed = latest ? parse(latest) : null;
    if (latestParsed && compare(wanted, latestParsed) < 0) {
        process.stdout.write(`older ${latest}\n`);
        return;
    }
    process.stdout.write('absent\n');
});
