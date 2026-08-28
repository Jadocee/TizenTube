import { configChangeEmitter, configRead } from '../config.js';
import { setStyleBlock } from './styleSheet.js';

function updateStyle() {
    setStyleBlock('theme', `
    ytlr-guide-response yt-focus-container {
        background-color: ${configRead('focusContainerColor')};
    }

    #container {
        background-color: ${configRead('routeColor')} !important;
    }
`);
};

configChangeEmitter.addEventListener('configChange', (e) => {
    if (e.detail.key === 'focusContainerColor' || e.detail.key === 'routeColor') {
        updateStyle();
    }
});

updateStyle();
export default updateStyle;
