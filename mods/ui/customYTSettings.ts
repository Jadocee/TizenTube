import { SettingActionRenderer, SettingsCategory } from './ytUI.js';
import { t } from 'i18next';
import type { Renderer } from '../types/youtube';

function PatchSettings(settingsObject: { items: Renderer[] }): void {
    // JSON.parse is patched globally, so this is reached with every object the
    // app ever parses and the declared type guarantees nothing at runtime. The
    // caller tests title.runs, which says nothing about `items`.
    if (!Array.isArray(settingsObject?.items)) return;
    // Idempotent: the settings response can be parsed more than once.
    if (settingsObject.items.some((i: any) => i?.settingCategoryCollectionRenderer?.categoryId === 'tizentube_category')) return;

    const tizentubeOpenAction = SettingActionRenderer(
        t('settings.ttSettings.title'),
        'tizentube_open_action',
        {
            customAction: {
                action: 'TT_SETTINGS_SHOW',
                parameters: []
            }
        },
        t('settings.ttSettings.summary'),
        'https://www.gstatic.com/ytlr/img/parent_code.png'
    )

    const tizenTubeCategory = SettingsCategory(
        'tizentube_category',
        [tizentubeOpenAction]
    );
    // Add it as the first item in the settings object
    settingsObject.items.unshift(tizenTubeCategory);

}

export {
    PatchSettings
}