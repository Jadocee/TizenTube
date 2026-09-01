// The config the runtime reads, and the command sink it writes to.
export const store = {
    captionsDefault: 'leave',
    captionsOnChannels: [],
    captionsOffChannels: [],
};
export const configRead = (k) => store[k];

/** Every command the runtime dispatched, in order. */
export const commands = [];
export default function resolveCommand(command) {
    commands.push(command);
}
