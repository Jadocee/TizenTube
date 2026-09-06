// Every TizenTube setting is toggled through resolveCommand, and this is the
// path that silently disabled all of them.
//
// A settings row's commands are ALWAYS wrapped: ytUI's buttonItem puts them in a
// `commandExecutorCommand`. A boolean toggle emits two of them --
// setClientSettingEndpoint to write the config, then a customAction to redraw
// the menu. The wrapper handles both at its top level, but the loop that walks a
// commandExecutorCommand used to re-implement only the customAction family and
// hand everything else to YouTube's own resolver, which has never heard of these
// settings. So the write vanished, the redraw ran and read back an unchanged
// value, and every switch in the menu looked stuck -- responding to presses,
// never changing.
//
// The two dispatch tables are now one: sub-commands go back through the wrapper.
import { patchResolveCommand } from './mod.generated.mts';
import * as stubs from './stubs.mjs';
import { checker } from '../lib/repo.mjs';

const { check, done } = checker();

/** Installs the wrapper on a fake _yttv registry and returns what it wrapped. */
function install() {
    stubs.writes.length = 0;
    stubs.redraws.length = 0;
    const passedToYouTube = [];
    globalThis.window = {
        _yttv: {
            Bx: {
                instance: {
                    resolveCommand(cmd) {
                        passedToYouTube.push(cmd);
                        return 'from-youtube';
                    },
                },
            },
        },
    };
    globalThis.document = { querySelector: () => null };
    patchResolveCommand();
    return {
        resolve: (cmd) => window._yttv.Bx.instance.resolveCommand(cmd),
        passedToYouTube,
    };
}

const wrapped = (commands) => ({ commandExecutorCommand: { commands } });
const settingWrite = (item, value) => ({
    setClientSettingEndpoint: {
        settingDatas: [{ clientSettingEnum: { item }, boolValue: value }],
    },
});

// --- the regression ----------------------------------------------------------
// Exactly the pair of commands a toggle row emits, in the wrapper the row uses.
{
    const app = install();
    stubs.store.enableAdBlock = true;
    app.resolve(
        wrapped([
            settingWrite('enableAdBlock', false),
            { customAction: { action: 'SETTINGS_UPDATE', parameters: [0] } },
        ]),
    );
    check('a wrapped toggle writes the setting', stubs.writes, [
        { key: 'enableAdBlock', value: false },
    ]);
    check('  ...so the config actually changed', stubs.store.enableAdBlock, false);
    // The redraw was always handled; the point is that it now redraws over a
    // value that moved.
    check('  ...and the menu is redrawn afterwards', stubs.redraws.length, 1);
    check('  ...by the root settings menu', stubs.redraws[0].kind, 'modernUI');
    // The whole failure was this: handed to a resolver that does not know these
    // settings exist.
    check(
        '  ...without handing the write to YouTube',
        app.passedToYouTube.some((c) => c.setClientSettingEndpoint),
        false,
    );
}

// A toggle turning something ON, not just off, and one whose redraw is the
// submenu path rather than the root menu.
{
    const app = install();
    stubs.store.enableSponsorBlock = false;
    app.resolve(
        wrapped([
            settingWrite('enableSponsorBlock', true),
            { customAction: { action: 'OPTIONS_SHOW', parameters: { options: [], update: true } } },
        ]),
    );
    check('a wrapped toggle switching on writes too', stubs.store.enableSponsorBlock, true);
    check('  ...and redraws the submenu', stubs.redraws[0].kind, 'optionShow');
}

// --- an unwrapped command still works ---------------------------------------
// The top-level path was never broken; it is asserted so a fix that moved the
// handling into the loop instead of sharing it would be caught.
{
    const app = install();
    stubs.store.enableAdBlock = true;
    app.resolve(settingWrite('enableAdBlock', false));
    check('a bare setting write still applies', stubs.store.enableAdBlock, false);
}

// --- the two paths agree -----------------------------------------------------
// The property the bug violated, stated directly: a command means the same thing
// whether it arrives alone or inside a commandExecutorCommand.
{
    const bare = install();
    stubs.store.enableAdBlock = true;
    bare.resolve(settingWrite('enableAdBlock', false));
    const bareResult = { ...stubs.store };

    const nested = install();
    stubs.store.enableAdBlock = true;
    nested.resolve(wrapped([settingWrite('enableAdBlock', false)]));
    check('wrapping a command does not change what it does', { ...stubs.store }, bareResult);
}

// --- things that are not ours still reach YouTube ----------------------------
{
    const app = install();
    app.resolve(wrapped([{ watchEndpoint: { videoId: 'abc123' } }]));
    check(
        'an unrecognised sub-command still reaches YouTube',
        app.passedToYouTube.some((c) => c.watchEndpoint?.videoId === 'abc123'),
        true,
    );
}

// --- a nested executor must not recurse forever ------------------------------
// YouTube does not emit this shape, but the wrapper sees whatever the page hands
// it, and recursing on it would hang the app rather than fail.
{
    const app = install();
    const self = { commandExecutorCommand: { commands: [] } };
    self.commandExecutorCommand.commands.push(self);
    let threw = null;
    try {
        app.resolve(self);
    } catch (e) {
        threw = e;
    }
    check('a self-nesting executor does not hang or throw', threw, null);
}

done();
