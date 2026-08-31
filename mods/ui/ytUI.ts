import resolveCommand from '../resolveCommand.js';
import { t } from 'i18next';
import type {
    Command,
    CompactLinkRenderer,
    ModalHeader,
    QueuedTile,
    Renderer,
    TextRuns,
    Thumbnail
} from '../types/youtube';

/** A command whose payload is one of YouTube's own untyped popup trees. */
interface PopupCommand extends Command {
    openPopupAction: Record<string, any>;
}

/** The text of a `buttonItem` row. */
interface ButtonItemTitle {
    title: string;
    subtitle?: string;
}

/** The icons of a `buttonItem` row. */
interface ButtonItemIcon {
    icon?: string;
    secondaryIcon?: string;
}

/** What `longPressData` needs off a tile to build its menu. */
interface LongPressSource {
    videoId: string;
    thumbnails: Thumbnail[];
    title: string;
    subtitle: string;
    watchEndpointData: { playlistId?: string; [key: string]: any };
    item: any;
    /** Rows the caller wants after the four standard ones. Appended last so a
     *  destructive action is never adjacent to Play, which is index 0 and the
     *  one a stray press lands on. */
    extraRows?: any[];
}

/** A category in YouTube's own settings list. */
interface SettingCategory {
    settingCategoryCollectionRenderer: {
        items: Renderer[];
        categoryId: string;
        focused: boolean;
        trackingParams: string;
        title?: TextRuns;
    };
}

// Chained SponsorBlock skips can fire the same toast twice in a second, which
// on a TV means two overlapping banners across the subtitle area. Opt-in,
// because that rationale is specific to SponsorBlock: applied to every caller
// it also swallowed unrelated confirmations, so queueing the same video twice
// in three seconds silently showed nothing the second time.
let lastToast = { key: '', at: 0 };

function showToast(title: string, subtitle: string, thumbnails?: Thumbnail[] | null, coalesce = false): void {
    const key = `${title}\u0000${subtitle}`;
    const now = Date.now();
    if (coalesce && key === lastToast.key && now - lastToast.at < 3000) return;

    const toastCmd: PopupCommand = {
        openPopupAction: {
            popupType: 'TOAST',
            popup: {
                overlayToastRenderer: {
                    title: {
                        simpleText: title
                    },
                    subtitle: {
                        simpleText: subtitle
                    }
                }
            }
        }
    }

    if (thumbnails) {
        toastCmd.openPopupAction.popup.overlayToastRenderer.image = { thumbnails };
    }
    resolveCommand(toastCmd);
    // Armed on delivery, not on entry: a toast that never reached
    // resolveCommand used to suppress the next real one.
    if (coalesce) lastToast = { key, at: now };
}

function OverlayPanelHeaderRenderer(title: string, subtitle: string, thumbnails: Thumbnail[]) {
    return {
        overlayPanelHeaderRenderer: {
            title: {
                simpleText: title
            },
            subtitle: {
                simpleText: subtitle
            },
            image: {
                thumbnails: thumbnails
            },
            style: "OVERLAY_PANEL_HEADER_STYLE_VIDEO_THUMBNAIL"
        }
    }
}

function Modal(header: ModalHeader, content: Renderer, id: string, update?: unknown): Command {
    const titleSubtitleObj = typeof header === 'string' ? { title: header, subtitle: '' } : header;
    const overlayPanelHeaderRenderer: Record<string, any> = (header as Exclude<ModalHeader, string>).overlayPanelHeaderRenderer || {
        title: {
            simpleText: titleSubtitleObj.title
        }
    };
    const modalCmd: PopupCommand = {
        openPopupAction: {
            popupType: 'MODAL',
            popup: {
                overlaySectionRenderer: {
                    overlay: {
                        overlayTwoPanelRenderer: {
                            actionPanel: {
                                overlayPanelRenderer: {
                                    header: {
                                        overlayPanelHeaderRenderer
                                    },
                                    content
                                }
                            },
                            backButton: {
                                buttonRenderer: {
                                    accessibilityData: {
                                        accessibilityData: {
                                            label: t('common.back')
                                        }
                                    },
                                    command: {
                                        signalAction: {
                                            signal: 'POPUP_BACK'
                                        }
                                    }
                                }
                            }
                        }
                    },
                    dismissalCommand: {
                        signalAction: {
                            signal: 'POPUP_BACK'
                        }
                    }
                }
            },
            uniqueId: id
        }
    }

    if (titleSubtitleObj.subtitle) {
        modalCmd.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.actionPanel.overlayPanelRenderer.header.overlayPanelHeaderRenderer.subtitle = {
            simpleText: titleSubtitleObj.subtitle
        };
    }

    if (update) {
        modalCmd.openPopupAction.shouldMatchUniqueId = true;
        modalCmd.openPopupAction.updateAction = true;
    }

    return modalCmd;
}

function showModal(header: ModalHeader, content: Renderer, id: string, update?: unknown): void {
    const modalCmd = Modal(header, content, id, update);

    resolveCommand(modalCmd);
}

function overlayPanelItemListRenderer(items: Renderer[], selectedIndex?: number) {
    return {
        overlayPanelItemListRenderer: {
            items,
            selectedIndex
        }
    }
};

function buttonItem(title: ButtonItemTitle, icon: ButtonItemIcon | null | undefined, commands: Command[]): CompactLinkRenderer {
    const button: CompactLinkRenderer = {
        compactLinkRenderer: {
            serviceEndpoint: {
                commandExecutorCommand: {
                    commands
                }
            }
        }
    }

    button.compactLinkRenderer.title = {
        simpleText: title.title
    }

    if (title.subtitle) {
        button.compactLinkRenderer.subtitle = {
            simpleText: title.subtitle
        }
    }

    if (icon) {
        button.compactLinkRenderer.icon = {
            iconType: icon.icon,
        }
    }

    if (icon && icon.secondaryIcon) {
        button.compactLinkRenderer.secondaryIcon = {
            iconType: icon.secondaryIcon,
        }
    }

    return button;
}


function timelyAction(text: string, icon: string, command: Command, triggerTimeMs: number, timeoutMs: number) {
    return {
        timelyActionRenderer: {
            actionButtons: [
                {
                    buttonRenderer: {
                        isDisabled: false,
                        text: {
                            runs: [
                                {
                                    text: text
                                }
                            ]
                        },
                        icon: {
                            iconType: icon
                        },
                        trackingParams: null,
                        command
                    }
                }
            ],
            triggerTimeMs,
            timeoutMs,
            type: ''
        }
    }

}

function longPressData(data: LongPressSource): Command {
    const isWatchLaterItem = data.watchEndpointData.playlistId === 'WL';
    const watchLaterAction = isWatchLaterItem ? {
        removedVideoId: data.videoId,
        action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID'
    } : {
        addedVideoId: data.videoId,
        action: 'ACTION_ADD_VIDEO'
    };

    return {
        clickTrackingParams: null,
        showMenuCommand: {
            contentId: data.videoId,
            thumbnail: {
                thumbnails: data.thumbnails
            },
            title: {
                simpleText: data.title
            },
            subtitle: {
                simpleText: data.subtitle
            },
            menu: {
                menuRenderer: {
                    items: [
                        MenuNavigationItemRenderer(t('longPress.play'), {
                            clickTrackingParams: null,
                            watchEndpoint: data.watchEndpointData
                        }),
                        MenuServiceItemRenderer(isWatchLaterItem ? t('longPress.removeFromWatchLater') : t('longPress.saveToWatchLater'), {
                            clickTrackingParams: null,
                            commandMetadata: {
                                webCommandMetadata: {
                                    sendPost: true,
                                    apiUrl: '/youtubei/v1/browse/edit_playlist'
                                }
                            },
                            playlistEditEndpoint: {
                                playlistId: 'WL',
                                actions: [watchLaterAction]
                            }
                        }),
                        MenuNavigationItemRenderer(t('longPress.saveToPlaylist'), {
                            clickTrackingParams: null,
                            addToPlaylistEndpoint: {
                                videoId: data.videoId
                            }
                        }),
                        MenuServiceItemRenderer(t('longPress.addToQueue'), {
                            clickTrackingParams: null,
                            playlistEditEndpoint: {
                                customAction: {
                                    action: 'ADD_TO_QUEUE',
                                    parameters: data.item
                                }
                            }
                        }),
                        ...(Array.isArray(data.extraRows) ? data.extraRows : []),
                    ],
                    trackingParams: null,
                    accessibility: {
                        accessibilityData: {
                            label: t('longPress.videoOptions')
                        }
                    }
                }
            }
        }
    }
}

function MenuServiceItemRenderer(text: string, serviceEndpoint: Command) {
    return {
        menuServiceItemRenderer: {
            text: {
                runs: [
                    {
                        text
                    }
                ]
            },
            serviceEndpoint,
            trackingParams: null
        }
    };
}

function MenuNavigationItemRenderer(text: string, navigateEndpoint: Command) {
    return {
        menuNavigationItemRenderer: {
            text: {
                runs: [
                    {
                        text
                    }
                ]
            },
            navigationEndpoint: navigateEndpoint,
            trackingParams: null
        }
    }
}

function SettingsCategory(categoryId: string, items: Renderer[], title?: string): SettingCategory {
    const category: SettingCategory = {
        settingCategoryCollectionRenderer: {
            items,
            categoryId,
            focused: false,
            trackingParams: "null"
        }
    }

    if (title) {
        category.settingCategoryCollectionRenderer.title = {
            runs: [
                {
                    text: title
                }
            ]
        };
    }

    return category;
}

function SettingActionRenderer(title: string, itemId: string, serviceEndpoint: Command, summary: string, thumbnail: string) {
    return {
        settingActionRenderer: {
            title: {
                runs: [
                    {
                        text: title
                    }
                ]
            },
            serviceEndpoint,
            summary: {
                runs: [
                    {
                        text: summary
                    }
                ]
            },
            trackingParams: "null",
            actionLabel: {
                runs: [
                    {
                        text: title
                    }
                ]
            },
            itemId,
            thumbnail: {
                thumbnails: [
                    {
                        url: thumbnail
                    }
                ]
            }
        }
    }
}

function scrollPaneRenderer(items: Renderer[]) {
    return {
        scrollPaneRenderer: {
            content: scrollPaneItemListRenderer(items)
        }
    }
}

function scrollPaneItemListRenderer(items: Renderer[]) {
    return {
        scrollPaneItemListRenderer: {
            items
        }
    }
}

function overlayMessageRenderer(simpleText: string) {
    return {
        overlayMessageRenderer: {
            title: {
                simpleText
            }
        }
    }
}

function ShelfRenderer(simpleText: string, items: Renderer[], selectedIndex = 0) {
    return {
        shelfRenderer: {
            shelfHeaderRenderer: {
                title: {
                    simpleText
                }
            },
            tvhtml5ShelfRendererType: "TVHTML5_SHELF_RENDERER_TYPE_GRID",
            content: {
                horizontalListRenderer: {
                    items,
                    selectedIndex,
                    visibleItemCount: 3
                }
            }
        }
    }
}

function TileRenderer(simpleText: string, onSelectCommand: Command): QueuedTile {
    return {
        tileRenderer: {
            contentType: "TILE_CONTENT_TYPE_VIDEO",
            metadata: {
                tileMetadataRenderer: {
                    title: {
                        simpleText
                    }
                }
            },
            onSelectCommand,
            style: "TILE_STYLE_YTLR_DEFAULT"
        }
    }
}

function QrCodeRenderer(url: string) {
    return {
        qrCodeRenderer: {
            qrCodeImage: {
                thumbnails: [
                    {
                        url
                    }
                ]
            },
            style: "QR_CODE_RENDERER_STYLE_ATA_SIDESHEET",
            trackingParams: null
        }
    }
}

function ButtonRenderer(disabled: boolean, text: string, iconType: string, command: Command) {
    return {
        isDisabled: disabled,
        text: {
            runs: [
                {
                    text: text
                }
            ]
        },
        icon: {
            iconType
        },
        command: command,
        trackingParams: null
    };
}

export {
    showToast,
    Modal,
    OverlayPanelHeaderRenderer,
    showModal,
    buttonItem,
    overlayPanelItemListRenderer,
    overlayMessageRenderer,
    timelyAction,
    scrollPaneRenderer,
    scrollPaneItemListRenderer,
    longPressData,
    MenuServiceItemRenderer,
    SettingsCategory,
    SettingActionRenderer,
    ShelfRenderer,
    TileRenderer,
    QrCodeRenderer,
    ButtonRenderer
}
